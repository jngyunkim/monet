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

    // `claude -p` runs in Monet's isolated cache directory. Claude records
    // those invocations as regular sessions too, but they contain Monet's own
    // generation prompts rather than a user's development conversation.
    let internal_work_dir = crate::util::work_dir();
    let legacy_internal_work_dir = crate::util::legacy_work_dir();
    if cwd
        .as_deref()
        .map(Path::new)
        .is_some_and(|session_cwd| {
            session_cwd == internal_work_dir.as_path()
                || session_cwd == legacy_internal_work_dir.as_path()
        })
    {
        return None;
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
    // Tool-bound assistant turns are usually operational narration ("Let me
    // inspect…", "Now I'll run…"). Keep only the latest one as a fallback in
    // case the session ends before Claude produces a final answer.
    let mut pending_tool_narration: Option<String> = None;
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
                    if let Some(pending) = pending_tool_narration.take() {
                        push_context_turn(&mut out, "Assistant", &pending);
                    }
                    push_context_turn(&mut out, "User", trimmed);
                }
            }
            "assistant" => {
                if let Some(txt) = assistant_text(&v) {
                    let trimmed = txt.trim();
                    if trimmed.is_empty() {
                        continue;
                    }
                    let tool_bound = v
                        .get("message")
                        .and_then(|m| m.get("stop_reason"))
                        .and_then(|x| x.as_str())
                        == Some("tool_use");
                    if tool_bound {
                        pending_tool_narration = Some(trimmed.to_string());
                    } else {
                        pending_tool_narration = None;
                        push_context_turn(&mut out, "Assistant", trimmed);
                    }
                }
            }
            _ => {}
        }
    }
    if let Some(pending) = pending_tool_narration {
        push_context_turn(&mut out, "Assistant", &pending);
    }
    Ok(out)
}

fn push_context_turn(out: &mut String, role: &str, text: &str) {
    out.push_str("\n## ");
    out.push_str(role);
    out.push('\n');
    out.push_str(text);
    out.push('\n');
}

fn is_noise(s: &str) -> bool {
    s.starts_with("<command-")
        || s.starts_with("<local-command")
        || s.starts_with("<task-notification")
        || s.starts_with("<tool-result")
        || s.starts_with("Caveat:")
        || s.starts_with("<system-reminder>")
        || s == "[Request interrupted by user]"
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
    /// Whether this block contributes to the compact Design / Ask context.
    pub context_relevant: bool,
}

fn keep_pending_context(out: &mut [Block], pending: &mut Vec<usize>) {
    for index in pending.drain(..) {
        if let Some(block) = out.get_mut(index) {
            block.context_relevant = true;
        }
    }
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
    let mut pending_tool_narration = Vec::new();
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
                            keep_pending_context(&mut out, &mut pending_tool_narration);
                            out.push(Block {
                                role: "user".into(),
                                kind: "text".into(),
                                text: trimmed.to_string(),
                                tool: None,
                                subtitle: None,
                                is_error: false,
                                context_relevant: true,
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
                                            keep_pending_context(
                                                &mut out,
                                                &mut pending_tool_narration,
                                            );
                                            out.push(Block {
                                                role: "user".into(),
                                                kind: "text".into(),
                                                text: trimmed.to_string(),
                                                tool: None,
                                                subtitle: None,
                                                is_error: false,
                                                context_relevant: true,
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
                                        context_relevant: is_error,
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
                    let tool_bound = v
                        .get("message")
                        .and_then(|m| m.get("stop_reason"))
                        .and_then(|x| x.as_str())
                        == Some("tool_use");
                    let mut tool_narration = Vec::new();
                    let mut had_text = false;
                    for b in arr {
                        match b.get("type").and_then(|x| x.as_str()) {
                            Some("text") => {
                                if let Some(txt) = b.get("text").and_then(|x| x.as_str()) {
                                    if !txt.trim().is_empty() {
                                        had_text = true;
                                        out.push(Block {
                                            role: "assistant".into(),
                                            kind: "text".into(),
                                            text: txt.trim().to_string(),
                                            tool: None,
                                            subtitle: None,
                                            is_error: false,
                                            context_relevant: !tool_bound,
                                        });
                                        if tool_bound {
                                            tool_narration.push(out.len() - 1);
                                        }
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
                                        context_relevant: false,
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
                                    context_relevant: false,
                                });
                            }
                            _ => {}
                        }
                    }
                    if tool_bound && had_text {
                        pending_tool_narration = tool_narration;
                    } else if had_text {
                        pending_tool_narration.clear();
                    }
                }
            }
            _ => {}
        }
    }
    keep_pending_context(&mut out, &mut pending_tool_narration);
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
    fn generation_context_drops_tool_narration_and_notifications() {
        let dir = std::env::temp_dir().join(format!("bp-context-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let f = dir.join("s.jsonl");
        let lines = vec![
            r#"{"type":"user","message":{"role":"user","content":"design an auth flow"}}"#,
            r#"{"type":"assistant","message":{"role":"assistant","content":[{"type":"text","text":"Let me inspect the repository first."}],"stop_reason":"tool_use"}}"#,
            r#"{"type":"assistant","message":{"role":"assistant","content":[{"type":"tool_use","name":"Read","input":{"file_path":"secret.rs"}}],"stop_reason":"tool_use"}}"#,
            r#"{"type":"user","message":{"role":"user","content":[{"type":"tool_result","content":"large file dump"}]}}"#,
            r#"{"type":"assistant","message":{"role":"assistant","content":[{"type":"text","text":"The design uses a gateway before the service."}],"stop_reason":"end_turn"}}"#,
            r#"{"type":"user","message":{"role":"user","content":"<task-notification><status>completed</status></task-notification>"}}"#,
        ];
        std::fs::write(&f, lines.join("\n")).unwrap();

        let context = extract_transcript(f.to_str().unwrap()).unwrap();

        assert!(context.contains("design an auth flow"));
        assert!(context.contains("The design uses a gateway"));
        assert!(!context.contains("Let me inspect"));
        assert!(!context.contains("task-notification"));
        assert!(!context.contains("large file dump"));
    }

    #[test]
    fn structured_blocks_mark_design_context_relevance() {
        let dir = std::env::temp_dir().join(format!("monet-focused-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let f = dir.join("s.jsonl");
        let lines = vec![
            r#"{"type":"user","message":{"role":"user","content":"design an auth flow"}}"#,
            r#"{"type":"assistant","message":{"role":"assistant","content":[{"type":"text","text":"Let me inspect first."},{"type":"tool_use","name":"Read","input":{"file_path":"auth.rs"}}],"stop_reason":"tool_use"}}"#,
            r#"{"type":"user","message":{"role":"user","content":[{"type":"tool_result","content":"file dump"}]}}"#,
            r#"{"type":"assistant","message":{"role":"assistant","content":[{"type":"text","text":"The gateway validates the token."}],"stop_reason":"end_turn"}}"#,
            r#"{"type":"assistant","message":{"role":"assistant","content":[{"type":"tool_use","name":"Bash","input":{"command":"false"}}],"stop_reason":"tool_use"}}"#,
            r#"{"type":"user","message":{"role":"user","content":[{"type":"tool_result","content":"command failed","is_error":true}]}}"#,
        ];
        std::fs::write(&f, lines.join("\n")).unwrap();

        let blocks = extract_blocks(f.to_str().unwrap());

        assert!(blocks.iter().find(|b| b.text == "design an auth flow").unwrap().context_relevant);
        assert!(!blocks.iter().find(|b| b.text == "Let me inspect first.").unwrap().context_relevant);
        assert!(!blocks.iter().find(|b| b.tool.as_deref() == Some("Read")).unwrap().context_relevant);
        assert!(!blocks.iter().find(|b| b.text == "file dump").unwrap().context_relevant);
        assert!(blocks.iter().find(|b| b.text == "The gateway validates the token.").unwrap().context_relevant);
        assert!(blocks.iter().find(|b| b.text == "command failed").unwrap().context_relevant);
    }

    #[test]
    fn generation_context_keeps_last_tool_narration_when_session_is_interrupted() {
        let dir = std::env::temp_dir().join(format!("bp-context-end-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let f = dir.join("s.jsonl");
        let lines = vec![
            r#"{"type":"user","message":{"role":"user","content":"trace the deploy flow"}}"#,
            r#"{"type":"assistant","message":{"role":"assistant","content":[{"type":"text","text":"I found the deployment entrypoint and am checking its worker."}],"stop_reason":"tool_use"}}"#,
        ];
        std::fs::write(&f, lines.join("\n")).unwrap();

        let context = extract_transcript(f.to_str().unwrap()).unwrap();

        assert!(context.contains("trace the deploy flow"));
        assert!(context.contains("I found the deployment entrypoint"));
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

    #[test]
    fn hides_sessions_created_by_monets_internal_claude_runs() {
        let dir = std::env::temp_dir().join(format!("bp-internal-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let f = dir.join("s.jsonl");
        let cwd = crate::util::work_dir();
        let line = serde_json::json!({
            "type": "user",
            "message": { "role": "user", "content": "internal generation prompt" },
            "cwd": cwd,
        });
        std::fs::write(&f, line.to_string()).unwrap();

        assert!(read_session_meta(&f).is_none());
    }

    #[test]
    fn keeps_legacy_internal_claude_sessions_hidden_after_path_migration() {
        let dir =
            std::env::temp_dir().join(format!("monet-legacy-internal-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let f = dir.join("s.jsonl");
        let cwd = dirs::cache_dir()
            .unwrap_or_else(std::env::temp_dir)
            .join("blueprint")
            .join("work");
        let line = serde_json::json!({
            "type": "user",
            "message": { "role": "user", "content": "internal generation prompt" },
            "cwd": cwd,
        });
        std::fs::write(&f, line.to_string()).unwrap();

        assert!(read_session_meta(&f).is_none());
    }
}
