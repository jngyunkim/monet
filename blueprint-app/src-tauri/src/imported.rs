use crate::session::SessionMeta;
use crate::util::{augmented_path, find_bin, work_dir};
use std::collections::hash_map::DefaultHasher;
use std::fs;
use std::hash::{Hash, Hasher};
use std::io::Write;
use std::path::PathBuf;
use std::process::{Command, Stdio};

pub fn sources_dir() -> PathBuf {
    dirs::data_dir()
        .unwrap_or_else(std::env::temp_dir)
        .join("blueprint")
        .join("imported-sources")
}

fn slug_id(url: &str) -> String {
    let mut h = DefaultHasher::new();
    url.hash(&mut h);
    format!("{:016x}", h.finish())
}

const FETCH_PROMPT: &str = r#"Fetch the full content of the URL below and output it as clean Markdown so it can be read as a design document.
- For GitHub URLs, use the `gh` CLI (already authenticated). For a file/blob, output the file's contents. For a pull request, output its title, description, and the list of changed files. For a repository root, output the README.
- For Notion or any other web URL, use WebFetch.
Start with a single top-level `# ` heading for the document title. Output ONLY the content as Markdown — no commentary, no preamble.

URL: "#;

/// Fetch a URL's content by delegating to the local Claude Code CLI (using its
/// `gh` and WebFetch tools — no API keys needed), save it as a local markdown
/// source, and return its metadata.
pub fn import(url: &str) -> Result<SessionMeta, String> {
    let url = url.trim();
    if !url.starts_with("http") {
        return Err("Please paste a full URL (http/https).".to_string());
    }
    let bin = find_bin("claude")
        .ok_or("Claude Code CLI ('claude') not found; it powers link fetching.")?;

    let prompt = format!("{FETCH_PROMPT}{url}");
    let mut child = Command::new(&bin)
        .arg("-p")
        .arg("--output-format")
        .arg("json")
        .arg("--model")
        .arg("sonnet")
        .arg("--strict-mcp-config")
        .arg("--setting-sources")
        .arg("")
        .arg("--allowedTools")
        .arg("Bash(gh:*)")
        .arg("WebFetch")
        .arg("Bash(curl:*)")
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
        return Err("Claude returned no content for that link.".to_string());
    }

    let title = body
        .lines()
        .find(|l| l.starts_with("# "))
        .map(|l| l[2..].trim().to_string())
        .unwrap_or_else(|| url.to_string());

    let dir = sources_dir();
    fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    let id = slug_id(url);
    let file = dir.join(format!("{id}.md"));
    // Embed the source URL so the sidebar can label it by provider.
    let content = format!("<!-- Source: {url} -->\n{body}");
    fs::write(&file, content).map_err(|e| e.to_string())?;

    Ok(SessionMeta {
        id: format!("link:{id}"),
        path: file.to_string_lossy().to_string(),
        project: provider_of(url),
        title,
        modified: now_secs(),
        message_count: 0,
    })
}

/// List previously imported link sources for the sidebar.
pub fn list_sources() -> Vec<SessionMeta> {
    let dir = sources_dir();
    let mut out = Vec::new();
    let entries = match fs::read_dir(&dir) {
        Ok(e) => e,
        Err(_) => return out,
    };
    for e in entries.flatten() {
        let p = e.path();
        if p.extension().and_then(|x| x.to_str()) != Some("md") {
            continue;
        }
        let content = fs::read_to_string(&p).unwrap_or_default();
        let url = content
            .lines()
            .find_map(|l| l.strip_prefix("<!-- Source: ").and_then(|s| s.strip_suffix(" -->")))
            .unwrap_or("")
            .to_string();
        let title = content
            .lines()
            .find(|l| l.starts_with("# "))
            .map(|l| l[2..].trim().to_string())
            .unwrap_or_else(|| "Imported page".to_string());
        let modified = fs::metadata(&p)
            .ok()
            .and_then(|m| m.modified().ok())
            .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
            .map(|d| d.as_secs())
            .unwrap_or(0);
        let id = p.file_stem().and_then(|s| s.to_str()).unwrap_or("").to_string();
        out.push(SessionMeta {
            id: format!("link:{id}"),
            path: p.to_string_lossy().to_string(),
            project: provider_of(&url),
            title,
            modified,
            message_count: 0,
        });
    }
    out
}

fn provider_of(url: &str) -> String {
    if url.contains("github.com") {
        "GitHub".to_string()
    } else if url.contains("notion.so") || url.contains("notion.site") {
        "Notion".to_string()
    } else {
        "Imported".to_string()
    }
}

fn now_secs() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0)
}

#[cfg(test)]
mod tests {
    use super::provider_of;

    #[test]
    fn labels_provider() {
        assert_eq!(provider_of("https://github.com/a/b"), "GitHub");
        assert_eq!(provider_of("https://www.notion.so/x"), "Notion");
        assert_eq!(provider_of("https://example.com"), "Imported");
    }
}
