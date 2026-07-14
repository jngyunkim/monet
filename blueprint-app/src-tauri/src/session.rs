use serde::Serialize;
use serde_json::Value;
use std::fs;
use std::path::{Path, PathBuf};

#[derive(Serialize, Clone)]
pub struct SessionMeta {
    pub id: String,
    pub path: String,
    pub project: String,
    pub title: String,
    pub modified: u64,
    pub message_count: usize,
}

fn projects_dir() -> Option<PathBuf> {
    dirs::home_dir().map(|h| h.join(".claude").join("projects"))
}

/// Scan ~/.claude/projects for every *.jsonl session and build display metadata.
pub fn list_sessions() -> Vec<SessionMeta> {
    let mut out = Vec::new();
    let base = match projects_dir() {
        Some(b) => b,
        None => return out,
    };
    let entries = match fs::read_dir(&base) {
        Ok(e) => e,
        Err(_) => return out,
    };
    for proj in entries.flatten() {
        let pdir = proj.path();
        if !pdir.is_dir() {
            continue;
        }
        let files = match fs::read_dir(&pdir) {
            Ok(f) => f,
            Err(_) => continue,
        };
        for f in files.flatten() {
            let p = f.path();
            if p.extension().and_then(|e| e.to_str()) != Some("jsonl") {
                continue;
            }
            if let Some(meta) = read_session_meta(&p) {
                // Skip empty / trivial sessions.
                if meta.message_count > 0 {
                    out.push(meta);
                }
            }
        }
    }
    out.sort_by(|a, b| b.modified.cmp(&a.modified));
    out
}

fn read_session_meta(path: &Path) -> Option<SessionMeta> {
    let content = fs::read_to_string(path).ok()?;
    let modified = fs::metadata(path)
        .ok()
        .and_then(|m| m.modified().ok())
        .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
        .map(|d| d.as_secs())
        .unwrap_or(0);

    let mut ai_title: Option<String> = None;
    let mut first_user: Option<String> = None;
    let mut cwd: Option<String> = None;
    let mut count = 0usize;

    for line in content.lines() {
        let v: Value = match serde_json::from_str(line) {
            Ok(v) => v,
            Err(_) => continue,
        };
        let t = v.get("type").and_then(|x| x.as_str()).unwrap_or("");
        match t {
            "ai-title" => {
                if ai_title.is_none() {
                    ai_title = v
                        .get("aiTitle")
                        .and_then(|x| x.as_str())
                        .map(|s| s.to_string());
                }
            }
            "user" => {
                count += 1;
                if cwd.is_none() {
                    cwd = v.get("cwd").and_then(|x| x.as_str()).map(|s| s.to_string());
                }
                if first_user.is_none()
                    && !v.get("isMeta").and_then(|x| x.as_bool()).unwrap_or(false)
                {
                    if let Some(txt) = user_text(&v) {
                        let trimmed = txt.trim();
                        if !trimmed.is_empty() && !trimmed.starts_with('<') {
                            first_user = Some(trimmed.chars().take(80).collect());
                        }
                    }
                }
            }
            "assistant" => {
                count += 1;
                if cwd.is_none() {
                    cwd = v.get("cwd").and_then(|x| x.as_str()).map(|s| s.to_string());
                }
            }
            _ => {}
        }
    }

    let id = path
        .file_stem()
        .and_then(|s| s.to_str())
        .unwrap_or("")
        .to_string();
    let project = cwd
        .as_ref()
        .and_then(|c| {
            Path::new(c)
                .file_name()
                .and_then(|n| n.to_str())
                .map(|s| s.to_string())
        })
        .or_else(|| {
            path.parent()
                .and_then(|p| p.file_name())
                .and_then(|n| n.to_str())
                .map(|s| s.to_string())
        })
        .unwrap_or_else(|| "unknown".to_string());
    let title = ai_title
        .or(first_user)
        .unwrap_or_else(|| "(untitled session)".to_string());

    Some(SessionMeta {
        id,
        path: path.to_string_lossy().to_string(),
        project,
        title,
        modified,
        message_count: count,
    })
}

/// Resolve a source's text. Notion sources are stored as raw `.md` files;
/// Claude Code sessions are `.jsonl` and need transcript extraction.
pub fn resolve_transcript(path: &str) -> Result<String, String> {
    if path.ends_with(".md") {
        fs::read_to_string(path).map_err(|e| e.to_string())
    } else {
        extract_transcript(path)
    }
}

/// Extract a clean text transcript (user + assistant text only) from a session,
/// dropping tool calls, tool results, file snapshots, and system noise.
pub fn extract_transcript(path: &str) -> Result<String, String> {
    let content = fs::read_to_string(path).map_err(|e| e.to_string())?;
    let mut out = String::new();
    for line in content.lines() {
        let v: Value = match serde_json::from_str(line) {
            Ok(v) => v,
            Err(_) => continue,
        };
        if v.get("isSidechain").and_then(|x| x.as_bool()).unwrap_or(false) {
            continue; // skip subagent chains
        }
        let t = v.get("type").and_then(|x| x.as_str()).unwrap_or("");
        match t {
            "user" => {
                if v.get("isMeta").and_then(|x| x.as_bool()).unwrap_or(false) {
                    continue;
                }
                if let Some(txt) = user_text(&v) {
                    let trimmed = txt.trim();
                    if trimmed.is_empty() || is_noise(trimmed) {
                        continue;
                    }
                    out.push_str("\n## User\n");
                    out.push_str(trimmed);
                    out.push('\n');
                }
            }
            "assistant" => {
                if let Some(txt) = assistant_text(&v) {
                    let trimmed = txt.trim();
                    if trimmed.is_empty() {
                        continue;
                    }
                    out.push_str("\n## Assistant\n");
                    out.push_str(trimmed);
                    out.push('\n');
                }
            }
            _ => {}
        }
    }
    Ok(out)
}

fn is_noise(s: &str) -> bool {
    s.starts_with("<command-")
        || s.starts_with("<local-command")
        || s.starts_with("Caveat:")
        || s.starts_with("<system-reminder>")
}

/// A single rendered transcript block. `kind` drives per-type UI in the webview.
#[derive(Serialize, Clone)]
pub struct Block {
    /// "user" | "assistant"
    pub role: String,
    /// "text" | "thinking" | "tool_use" | "tool_result"
    pub kind: String,
    #[serde(default)]
    pub text: String,
    /// Tool name (for tool_use).
    #[serde(skip_serializing_if = "Option::is_none")]
    pub tool: Option<String>,
    /// Short summary line (command, file path, …) for a collapsible header.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub subtitle: Option<String>,
    /// True when a tool_result reported an error.
    #[serde(default)]
    pub is_error: bool,
}

const MAX_BLOCK_CHARS: usize = 6000;

fn clamp(s: &str) -> String {
    if s.chars().count() > MAX_BLOCK_CHARS {
        let head: String = s.chars().take(MAX_BLOCK_CHARS).collect();
        format!("{head}\n… (truncated)")
    } else {
        s.to_string()
    }
}

/// Pull plain text out of a tool_result `content` (string, or array of text blocks).
fn result_text(content: &Value) -> String {
    if let Some(s) = content.as_str() {
        return s.to_string();
    }
    if let Some(arr) = content.as_array() {
        let mut parts = Vec::new();
        for b in arr {
            if let Some(t) = b.get("text").and_then(|x| x.as_str()) {
                parts.push(t.to_string());
            }
        }
        return parts.join("\n");
    }
    String::new()
}

/// A one-line summary of a tool call's most salient input.
fn tool_subtitle(tool: &str, input: &Value) -> Option<String> {
    let pick = |k: &str| input.get(k).and_then(|x| x.as_str()).map(|s| s.to_string());
    let s = match tool {
        "Bash" => pick("command"),
        "Read" | "Edit" | "Write" | "NotebookEdit" => pick("file_path"),
        "Grep" => pick("pattern"),
        "Glob" => pick("pattern"),
        "Task" => pick("description"),
        "WebFetch" => pick("url"),
        _ => None,
    }?;
    let one_line = s.lines().next().unwrap_or(&s);
    Some(one_line.chars().take(160).collect())
}

/// Parse a session into structured blocks for the (display-only) Transcript tab.
/// Unlike `extract_transcript`, this keeps thinking, tool calls, and tool results.
pub fn extract_blocks(path: &str) -> Vec<Block> {
    let content = match fs::read_to_string(path) {
        Ok(c) => c,
        Err(_) => return Vec::new(),
    };
    let mut out = Vec::new();
    for line in content.lines() {
        let v: Value = match serde_json::from_str(line) {
            Ok(v) => v,
            Err(_) => continue,
        };
        if v.get("isSidechain").and_then(|x| x.as_bool()).unwrap_or(false) {
            continue;
        }
        let t = v.get("type").and_then(|x| x.as_str()).unwrap_or("");
        let msg_content = v.get("message").and_then(|m| m.get("content"));
        match t {
            "user" => {
                if v.get("isMeta").and_then(|x| x.as_bool()).unwrap_or(false) {
                    continue;
                }
                match msg_content {
                    Some(Value::String(s)) => {
                        let trimmed = s.trim();
                        if !trimmed.is_empty() && !is_noise(trimmed) {
                            out.push(Block {
                                role: "user".into(),
                                kind: "text".into(),
                                text: trimmed.to_string(),
                                tool: None,
                                subtitle: None,
                                is_error: false,
                            });
                        }
                    }
                    Some(Value::Array(arr)) => {
                        for b in arr {
                            match b.get("type").and_then(|x| x.as_str()) {
                                Some("text") => {
                                    if let Some(txt) = b.get("text").and_then(|x| x.as_str()) {
                                        let trimmed = txt.trim();
                                        if !trimmed.is_empty() && !is_noise(trimmed) {
                                            out.push(Block {
                                                role: "user".into(),
                                                kind: "text".into(),
                                                text: trimmed.to_string(),
                                                tool: None,
                                                subtitle: None,
                                                is_error: false,
                                            });
                                        }
                                    }
                                }
                                Some("tool_result") => {
                                    let content = b.get("content").cloned().unwrap_or(Value::Null);
                                    let txt = result_text(&content);
                                    let is_error =
                                        b.get("is_error").and_then(|x| x.as_bool()).unwrap_or(false);
                                    out.push(Block {
                                        role: "user".into(),
                                        kind: "tool_result".into(),
                                        text: clamp(txt.trim()),
                                        tool: None,
                                        subtitle: None,
                                        is_error,
                                    });
                                }
                                _ => {}
                            }
                        }
                    }
                    _ => {}
                }
            }
            "assistant" => {
                if let Some(Value::Array(arr)) = msg_content {
                    for b in arr {
                        match b.get("type").and_then(|x| x.as_str()) {
                            Some("text") => {
                                if let Some(txt) = b.get("text").and_then(|x| x.as_str()) {
                                    if !txt.trim().is_empty() {
                                        out.push(Block {
                                            role: "assistant".into(),
                                            kind: "text".into(),
                                            text: txt.trim().to_string(),
                                            tool: None,
                                            subtitle: None,
                                            is_error: false,
                                        });
                                    }
                                }
                            }
                            Some("thinking") => {
                                let txt = b
                                    .get("thinking")
                                    .or_else(|| b.get("text"))
                                    .and_then(|x| x.as_str())
                                    .unwrap_or("");
                                if !txt.trim().is_empty() {
                                    out.push(Block {
                                        role: "assistant".into(),
                                        kind: "thinking".into(),
                                        text: clamp(txt.trim()),
                                        tool: None,
                                        subtitle: None,
                                        is_error: false,
                                    });
                                }
                            }
                            Some("tool_use") => {
                                let name = b
                                    .get("name")
                                    .and_then(|x| x.as_str())
                                    .unwrap_or("tool")
                                    .to_string();
                                let input = b.get("input").cloned().unwrap_or(Value::Null);
                                let subtitle = tool_subtitle(&name, &input);
                                let pretty = serde_json::to_string_pretty(&input)
                                    .unwrap_or_else(|_| "{}".to_string());
                                out.push(Block {
                                    role: "assistant".into(),
                                    kind: "tool_use".into(),
                                    text: clamp(&pretty),
                                    tool: Some(name),
                                    subtitle,
                                    is_error: false,
                                });
                            }
                            _ => {}
                        }
                    }
                }
            }
            _ => {}
        }
    }
    out
}

fn user_text(v: &Value) -> Option<String> {
    let content = v.get("message")?.get("content")?;
    if let Some(s) = content.as_str() {
        return Some(s.to_string());
    }
    if let Some(arr) = content.as_array() {
        let mut parts = Vec::new();
        for b in arr {
            if b.get("type").and_then(|x| x.as_str()) == Some("text") {
                if let Some(t) = b.get("text").and_then(|x| x.as_str()) {
                    parts.push(t.to_string());
                }
            }
        }
        if !parts.is_empty() {
            return Some(parts.join("\n"));
        }
    }
    None
}

fn assistant_text(v: &Value) -> Option<String> {
    let arr = v.get("message")?.get("content")?.as_array()?;
    let mut parts = Vec::new();
    for b in arr {
        if b.get("type").and_then(|x| x.as_str()) == Some("text") {
            if let Some(t) = b.get("text").and_then(|x| x.as_str()) {
                parts.push(t.to_string());
            }
        }
    }
    if parts.is_empty() {
        None
    } else {
        Some(parts.join("\n"))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn extracts_text_and_drops_tools() {
        let dir = std::env::temp_dir().join(format!("bp-test-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let f = dir.join("s.jsonl");
        let lines = vec![
            r#"{"type":"user","message":{"role":"user","content":"design a queue"},"cwd":"/a/b/myproj"}"#,
            r#"{"type":"assistant","message":{"role":"assistant","content":[{"type":"text","text":"Use SQS"},{"type":"tool_use","name":"Bash","input":{}}]}}"#,
            r#"{"type":"user","message":{"role":"user","content":[{"type":"tool_result","content":"x"}]}}"#,
            r#"{"type":"file-history-snapshot","snapshot":{}}"#,
        ];
        std::fs::write(&f, lines.join("\n")).unwrap();
        let t = extract_transcript(f.to_str().unwrap()).unwrap();
        assert!(t.contains("design a queue"));
        assert!(t.contains("Use SQS"));
        assert!(!t.contains("tool_result"));
        assert!(!t.contains("Bash"));
    }

    #[test]
    fn meta_skips_title_uses_cwd_for_project() {
        let dir = std::env::temp_dir().join(format!("bp-test2-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let f = dir.join("s.jsonl");
        let lines = vec![
            r#"{"type":"ai-title","aiTitle":"Queue Design"}"#,
            r#"{"type":"user","message":{"role":"user","content":"hi"},"cwd":"/Users/x/Moloco/mvp"}"#,
        ];
        std::fs::write(&f, lines.join("\n")).unwrap();
        let m = read_session_meta(&f).unwrap();
        assert_eq!(m.title, "Queue Design");
        assert_eq!(m.project, "mvp");
        assert_eq!(m.message_count, 1);
    }
}
