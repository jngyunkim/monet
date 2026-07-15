use crate::session::SessionMeta;
use crate::util::{app_data_dir, augmented_path, find_bin, work_dir};
use serde::{Deserialize, Serialize};
use std::collections::hash_map::DefaultHasher;
use std::fs;
use std::hash::{Hash, Hasher};
use std::io::Write;
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};

/// A link source: one or more URLs (GitHub / Notion / web) whose content is
/// fetched dynamically at generation time rather than stored up front.
#[derive(Serialize, Deserialize, Clone)]
struct Manifest {
    title: String,
    urls: Vec<String>,
}

pub fn sources_dir() -> PathBuf {
    app_data_dir().join("link-sources")
}

fn slug_id(urls: &[String]) -> String {
    let mut sorted = urls.to_vec();
    sorted.sort();
    let mut h = DefaultHasher::new();
    sorted.join("\n").hash(&mut h);
    format!("{:016x}", h.finish())
}

/// True for the link-manifest files this module owns.
pub fn is_link_source(path: &str) -> bool {
    path.ends_with(".links.json")
}

fn provider_of(url: &str) -> &'static str {
    if url.contains("github.com") {
        "GitHub"
    } else if url.contains("notion.so") || url.contains("notion.site") {
        "Notion"
    } else {
        "Web"
    }
}

fn providers_label(urls: &[String]) -> String {
    let mut seen: Vec<&str> = Vec::new();
    for u in urls {
        let p = provider_of(u);
        if !seen.contains(&p) {
            seen.push(p);
        }
    }
    seen.join(" + ")
}

fn derive_title(urls: &[String]) -> String {
    // A readable default title without fetching: GitHub owner/repo, Notion slug.
    let first = urls.first().cloned().unwrap_or_default();
    let base = if first.contains("github.com") {
        first
            .split("github.com/")
            .nth(1)
            .map(|s| s.split('/').take(2).collect::<Vec<_>>().join("/"))
            .unwrap_or(first.clone())
    } else {
        first
            .trim_end_matches('/')
            .rsplit('/')
            .next()
            .unwrap_or(&first)
            .replace('-', " ")
    };
    if urls.len() > 1 {
        format!("{base} (+{} more)", urls.len() - 1)
    } else {
        base
    }
}

/// Create a link source from one or more URLs. Content is fetched lazily.
pub fn create_source(urls: Vec<String>, title: Option<String>) -> Result<SessionMeta, String> {
    let urls: Vec<String> = urls
        .into_iter()
        .map(|u| u.trim().to_string())
        .filter(|u| u.starts_with("http"))
        .collect();
    if urls.is_empty() {
        return Err("Please paste at least one http(s) URL.".to_string());
    }
    let title = title
        .map(|t| t.trim().to_string())
        .filter(|t| !t.is_empty())
        .unwrap_or_else(|| derive_title(&urls));

    let dir = sources_dir();
    fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    let id = slug_id(&urls);
    let file = dir.join(format!("{id}.links.json"));
    let manifest = Manifest {
        title: title.clone(),
        urls: urls.clone(),
    };
    fs::write(
        &file,
        serde_json::to_string_pretty(&manifest).map_err(|e| e.to_string())?,
    )
    .map_err(|e| e.to_string())?;

    Ok(SessionMeta {
        id: format!("link:{id}"),
        path: file.to_string_lossy().to_string(),
        project: providers_label(&urls),
        title,
        modified: now_secs(),
        message_count: urls.len(),
    })
}

pub fn list_sources() -> Vec<SessionMeta> {
    let dir = sources_dir();
    let mut out = Vec::new();
    let entries = match fs::read_dir(&dir) {
        Ok(e) => e,
        Err(_) => return out,
    };
    for e in entries.flatten() {
        let p = e.path();
        let name = p.file_name().and_then(|n| n.to_str()).unwrap_or("");
        if !name.ends_with(".links.json") {
            continue;
        }
        let manifest: Manifest = match fs::read_to_string(&p)
            .ok()
            .and_then(|s| serde_json::from_str(&s).ok())
        {
            Some(m) => m,
            None => continue,
        };
        let modified = fs::metadata(&p)
            .ok()
            .and_then(|m| m.modified().ok())
            .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
            .map(|d| d.as_secs())
            .unwrap_or(0);
        let id = name.trim_end_matches(".links.json").to_string();
        out.push(SessionMeta {
            id: format!("link:{id}"),
            path: p.to_string_lossy().to_string(),
            project: providers_label(&manifest.urls),
            title: manifest.title,
            modified,
            message_count: manifest.urls.len(),
        });
    }
    out
}

fn fetched_path(manifest_path: &str) -> PathBuf {
    PathBuf::from(manifest_path.replace(".links.json", ".fetched.md"))
}

fn mtime(p: &Path) -> u64 {
    fs::metadata(p)
        .ok()
        .and_then(|m| m.modified().ok())
        .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
        .map(|d| d.as_secs())
        .unwrap_or(0)
}

/// Resolve a link source to text, fetching the URLs' current content (cached
/// alongside the manifest so the three tabs don't each re-fetch).
pub fn resolve(manifest_path: &str) -> Result<String, String> {
    let manifest: Manifest = fs::read_to_string(manifest_path)
        .ok()
        .and_then(|s| serde_json::from_str(&s).ok())
        .ok_or("could not read link source")?;

    let fetched = fetched_path(manifest_path);
    if fetched.exists() && mtime(&fetched) >= mtime(Path::new(manifest_path)) {
        if let Ok(cached) = fs::read_to_string(&fetched) {
            if !cached.trim().is_empty() {
                return Ok(cached);
            }
        }
    }
    let content = fetch_combined(&manifest.urls)?;
    let _ = fs::write(&fetched, &content);
    Ok(content)
}

/// Mark a source for re-fetch on next generation by bumping the manifest mtime,
/// which also invalidates any cached generations keyed by path+mtime.
pub fn refresh(manifest_path: &str) -> Result<(), String> {
    if !is_link_source(manifest_path) {
        return Err("not a link source".to_string());
    }
    let content = fs::read_to_string(manifest_path).map_err(|e| e.to_string())?;
    fs::write(manifest_path, content).map_err(|e| e.to_string()) // rewrite -> new mtime
}

const FETCH_PROMPT: &str = r#"Fetch the full content of EACH URL listed below so it can be read as design documentation, and output them concatenated.
- For GitHub URLs use the `gh` CLI (already authenticated): a file/blob -> its contents; a pull request -> title, description, and changed files; a repo root -> the README.
- For Notion URLs use the Notion MCP connector tools (e.g. the Notion fetch tool). NEVER use WebFetch for Notion — it only returns a login page.
- For any other URL use WebFetch.
Precede each document with a line `# Source: <url>`. Output ONLY the fetched content as Markdown — no commentary.

URLs:
"#;

/// Delegate fetching to the local Claude CLI. MCP is left ON (no
/// --strict-mcp-config) so a locally-registered Notion MCP is available; we
/// allow gh, WebFetch, and the `notion` MCP server.
fn fetch_combined(urls: &[String]) -> Result<String, String> {
    let bin = find_bin("claude").ok_or("Claude Code CLI ('claude') not found.")?;
    let prompt = format!("{FETCH_PROMPT}{}", urls.join("\n"));

    let mut child = Command::new(&bin)
        .arg("-p")
        .arg("--output-format")
        .arg("json")
        .arg("--model")
        .arg("sonnet")
        // Allow gh, WebFetch, and the Notion connector. The claude.ai Notion
        // connector surfaces in headless mode as the `claude_ai_Notion` MCP
        // server; we also allow a locally-registered `notion` server as a
        // fallback. Allowing a server prefix permits all of its tools.
        .arg("--allowedTools")
        .arg("Bash(gh:*)")
        .arg("WebFetch")
        .arg("mcp__claude_ai_Notion")
        .arg("mcp__notion")
        .current_dir(work_dir())
        .env("PATH", augmented_path())
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .map_err(|e| format!("failed to launch claude: {e}"))?;
    child
        .stdin
        .take()
        .ok_or("could not open claude stdin")?
        .write_all(prompt.as_bytes())
        .map_err(|e| format!("failed to send prompt: {e}"))?;
    let out = child
        .wait_with_output()
        .map_err(|e| format!("claude did not finish: {e}"))?;
    if !out.status.success() {
        return Err(format!(
            "claude exited with an error: {}",
            String::from_utf8_lossy(&out.stderr)
        ));
    }
    let stdout = String::from_utf8_lossy(&out.stdout);
    let v: serde_json::Value =
        serde_json::from_str(&stdout).map_err(|e| format!("could not parse claude output: {e}"))?;
    let body = v
        .get("result")
        .and_then(|x| x.as_str())
        .unwrap_or("")
        .trim()
        .to_string();
    if body.is_empty() {
        return Err("Claude returned no content for those links.".to_string());
    }
    Ok(body)
}

fn now_secs() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn labels_and_titles() {
        assert_eq!(providers_label(&["https://github.com/a/b".into()]), "GitHub");
        assert_eq!(
            providers_label(&[
                "https://github.com/a/b".into(),
                "https://notion.so/x".into()
            ]),
            "GitHub + Notion"
        );
        assert_eq!(derive_title(&["https://github.com/moloco/mvp".into()]), "moloco/mvp");
    }

    #[test]
    fn detects_link_source() {
        assert!(is_link_source("/x/abc.links.json"));
        assert!(!is_link_source("/x/abc.jsonl"));
    }
}
