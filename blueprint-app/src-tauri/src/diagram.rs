use crate::util::{augmented_path, find_bin, work_dir};
use serde::{Deserialize, Serialize};
use std::collections::HashSet;
use std::fs;
use std::io::Write;
use std::process::{Command, Stdio};
use std::sync::mpsc;
use std::sync::{Mutex, OnceLock};
use std::time::Duration;

/// Hard ceiling for a single `claude` call, so a hung generation can't run
/// forever even if the user never cancels.
const CLAUDE_TIMEOUT: Duration = Duration::from_secs(300);

/// PIDs of `claude` child processes currently running, so the UI can cancel
/// them (and so a timeout can kill them). One generation runs at a time, but a
/// set keeps this robust if that ever changes.
fn active_pids() -> &'static Mutex<HashSet<u32>> {
    static PIDS: OnceLock<Mutex<HashSet<u32>>> = OnceLock::new();
    PIDS.get_or_init(|| Mutex::new(HashSet::new()))
}

fn register_pid(pid: u32) {
    if let Ok(mut s) = active_pids().lock() {
        s.insert(pid);
    }
}

fn unregister_pid(pid: u32) {
    if let Ok(mut s) = active_pids().lock() {
        s.remove(&pid);
    }
}

fn kill_pid(pid: u32) {
    let _ = Command::new("kill")
        .arg("-KILL")
        .arg(pid.to_string())
        .output();
}

/// Kill every running `claude` child. Returns how many were signalled.
pub fn cancel_all() -> usize {
    let pids: Vec<u32> = active_pids()
        .lock()
        .map(|s| s.iter().copied().collect())
        .unwrap_or_default();
    for &pid in &pids {
        kill_pid(pid);
    }
    pids.len()
}

#[derive(Serialize, Deserialize, Clone)]
pub struct Diagram {
    pub title: String,
    /// "mermaid" | "mingrammer"
    pub kind: String,
    pub source: String,
    #[serde(default)]
    pub explanation: String,
    /// Which design level this diagram illustrates: "High-level" | "Detailed"
    /// | "Implementation". Lets the Design tab show diagrams inline per level.
    #[serde(default)]
    pub level: String,
    /// Rendered HTML for mingrammer diagrams (inline <svg> or <img>). Empty for mermaid.
    #[serde(default)]
    pub rendered: String,
    /// When set, the diagram could not be rendered; holds a human-readable reason.
    #[serde(default)]
    pub unavailable: Option<String>,
}

#[derive(Serialize, Clone)]
pub struct DepStatus {
    pub claude: bool,
    pub python: bool,
    pub graphviz: bool,
    pub diagrams_pkg: bool,
}

/// Render every mingrammer diagram in place (mermaid is rendered in the webview).
pub fn render_diagrams(diagrams: &mut [Diagram]) {
    for d in diagrams.iter_mut() {
        if d.kind == "mingrammer" {
            match render_mingrammer(&d.source) {
                Ok(html) => d.rendered = html,
                Err(reason) => d.unavailable = Some(reason),
            }
        }
    }
}

pub fn check_deps() -> DepStatus {
    let python = find_bin("python3");
    let diagrams_pkg = python
        .as_ref()
        .map(|py| {
            Command::new(py)
                .arg("-c")
                .arg("import diagrams")
                .output()
                .map(|o| o.status.success())
                .unwrap_or(false)
        })
        .unwrap_or(false);
    DepStatus {
        claude: find_bin("claude").is_some(),
        python: python.is_some(),
        graphviz: find_bin("dot").is_some(),
        diagrams_pkg,
    }
}

const STRICT_JSON_SYSTEM: &str = "You are a strict JSON generator. Respond with ONLY a single valid JSON object matching the schema described in the user's message. Never add markdown code fences, prose, commentary, or conversation before or after the JSON.";

const ASSISTANT_SYSTEM: &str = "You are a helpful software-architecture assistant answering questions about the document the user provides. Answer in concise Markdown, grounded in the document; if the answer is not in the document, say so briefly. No preamble.";

const MERMAID_FIX_SYSTEM: &str = "You repair Mermaid diagram syntax. Respond with ONLY corrected, valid Mermaid source. Never add markdown code fences, prose, commentary, or anything before or after the diagram.";

/// Run the local Claude Code CLI headless with the given system prompt, piping
/// `prompt` via stdin and returning the model's textual `result`. The child is
/// registered so it can be cancelled, and is killed if it exceeds the timeout.
fn run(prompt: &str, model: &str, system: &str) -> Result<String, String> {
    let bin = find_bin("claude").ok_or_else(|| {
        "Claude Code CLI ('claude') not found. Install it and make sure it is on your PATH."
            .to_string()
    })?;
    // Strip the full Claude Code environment (no MCP servers, no user/project
    // settings or hooks) to trim startup overhead and token cost.
    let mut child = Command::new(&bin)
        .arg("-p")
        .arg("--output-format")
        .arg("json")
        .arg("--model")
        .arg(model)
        .arg("--strict-mcp-config")
        .arg("--setting-sources")
        .arg("")
        .arg("--system-prompt")
        .arg(system)
        .current_dir(work_dir())
        .env("PATH", augmented_path())
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .map_err(|e| format!("failed to launch claude: {e}"))?;

    let pid = child.id();
    register_pid(pid);

    if let Err(e) = child
        .stdin
        .take()
        .ok_or_else(|| "could not open claude stdin".to_string())
        .and_then(|mut s| {
            s.write_all(prompt.as_bytes())
                .map_err(|e| format!("failed to send prompt: {e}"))
        })
    {
        kill_pid(pid);
        unregister_pid(pid);
        return Err(e);
    }

    // Wait on a helper thread (which also drains stdout/stderr) so we can apply
    // a timeout. On timeout we kill the child; the thread then unblocks.
    let (tx, rx) = mpsc::channel();
    std::thread::spawn(move || {
        let _ = tx.send(child.wait_with_output());
    });

    let out = match rx.recv_timeout(CLAUDE_TIMEOUT) {
        Ok(Ok(out)) => {
            unregister_pid(pid);
            out
        }
        Ok(Err(e)) => {
            unregister_pid(pid);
            return Err(format!("claude did not finish: {e}"));
        }
        Err(mpsc::RecvTimeoutError::Timeout) => {
            kill_pid(pid);
            unregister_pid(pid);
            return Err(format!(
                "Generation timed out after {}s and was stopped.",
                CLAUDE_TIMEOUT.as_secs()
            ));
        }
        Err(mpsc::RecvTimeoutError::Disconnected) => {
            unregister_pid(pid);
            return Err("claude worker disconnected".to_string());
        }
    };

    if !out.status.success() {
        // A non-zero exit after a kill is how cancellation surfaces.
        let stderr = String::from_utf8_lossy(&out.stderr);
        return Err(if stderr.trim().is_empty() {
            "Generation was stopped.".to_string()
        } else {
            format!("claude exited with an error: {stderr}")
        });
    }
    let stdout = String::from_utf8_lossy(&out.stdout);
    let v: serde_json::Value = serde_json::from_str(&stdout)
        .map_err(|e| format!("could not parse claude JSON output: {e}"))?;
    v.get("result")
        .and_then(|x| x.as_str())
        .map(|s| s.to_string())
        .ok_or_else(|| "claude output had no 'result' field".to_string())
}

/// Strict-JSON invocation: the model returns a single JSON object.
pub fn run_claude(prompt: &str, model: &str) -> Result<String, String> {
    run(prompt, model, STRICT_JSON_SYSTEM)
}

/// Free-text (Markdown) invocation, used by the Ask tab.
pub fn run_claude_text(prompt: &str, model: &str) -> Result<String, String> {
    run(prompt, model, ASSISTANT_SYSTEM)
}

/// Ask Claude to repair mermaid that failed to parse. Returns ONLY corrected
/// mermaid source (fences/prose stripped).
pub fn fix_mermaid(source: &str, model: &str) -> Result<String, String> {
    let prompt = format!(
        "The following Mermaid diagram fails to parse in mermaid.js. Return ONLY corrected, valid Mermaid source — no markdown code fences, no prose, no explanation. Preserve the original intent and node labels. Rules: put every node and edge label in double quotes; use simple alphanumeric node ids; avoid parentheses, semicolons, colons, '#', '<', '>', '@', and line breaks inside labels; one statement per line.\n\nMermaid source to fix:\n{source}"
    );
    let out = run(&prompt, model, MERMAID_FIX_SYSTEM)?;
    Ok(strip_fences(&out))
}

/// Remove ``` fences and leading language hints a model may add around code.
fn strip_fences(s: &str) -> String {
    let t = s.trim();
    let t = t.strip_prefix("```mermaid").or_else(|| t.strip_prefix("```")).unwrap_or(t);
    let t = t.trim_start_matches('\n');
    let t = t.strip_suffix("```").unwrap_or(t);
    t.trim().to_string()
}

/// Run mingrammer/diagrams Python code in a temp dir and return rendered HTML.
fn render_mingrammer(source: &str) -> Result<String, String> {
    let py = find_bin("python3").ok_or("python3 is not installed")?;
    if find_bin("dot").is_none() {
        return Err("Graphviz ('dot') is not installed (needed for diagrams). Try: brew install graphviz".into());
    }
    // Verify the diagrams package is importable.
    let pkg_ok = Command::new(&py)
        .arg("-c")
        .arg("import diagrams")
        .env("PATH", augmented_path())
        .output()
        .map(|o| o.status.success())
        .unwrap_or(false);
    if !pkg_ok {
        return Err("Python 'diagrams' package not installed. Try: pip install diagrams".into());
    }

    let dir = std::env::temp_dir().join(format!(
        "blueprint-render-{}-{}",
        std::process::id(),
        std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|d| d.as_nanos())
            .unwrap_or(0)
    ));
    fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    let script = dir.join("gen.py");
    fs::write(&script, source).map_err(|e| e.to_string())?;

    let out = Command::new(&py)
        .arg("gen.py")
        .current_dir(&dir)
        .env("PATH", augmented_path())
        .output()
        .map_err(|e| format!("failed to run python: {e}"))?;
    if !out.status.success() {
        let _ = fs::remove_dir_all(&dir);
        return Err(format!(
            "diagrams script failed: {}",
            String::from_utf8_lossy(&out.stderr)
                .lines()
                .last()
                .unwrap_or("unknown error")
        ));
    }

    // Find the produced image (prefer svg).
    let rendered = read_rendered_image(&dir);
    let _ = fs::remove_dir_all(&dir);
    rendered.ok_or_else(|| "diagrams ran but produced no image file".to_string())
}

fn read_rendered_image(dir: &std::path::Path) -> Option<String> {
    let mut svg: Option<std::path::PathBuf> = None;
    let mut png: Option<std::path::PathBuf> = None;
    for e in fs::read_dir(dir).ok()?.flatten() {
        let p = e.path();
        match p.extension().and_then(|x| x.to_str()) {
            Some("svg") => svg = Some(p),
            Some("png") => png = Some(p),
            _ => {}
        }
    }
    if let Some(s) = svg {
        let content = fs::read_to_string(&s).ok()?;
        return Some(content);
    }
    if let Some(p) = png {
        let bytes = fs::read(&p).ok()?;
        let b64 = base64_encode(&bytes);
        return Some(format!(
            "<img alt=\"diagram\" style=\"max-width:100%\" src=\"data:image/png;base64,{b64}\" />"
        ));
    }
    None
}

fn base64_encode(bytes: &[u8]) -> String {
    const TABLE: &[u8; 64] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
    let mut out = String::with_capacity((bytes.len() + 2) / 3 * 4);
    for chunk in bytes.chunks(3) {
        let b = [
            chunk[0],
            *chunk.get(1).unwrap_or(&0),
            *chunk.get(2).unwrap_or(&0),
        ];
        let n = (b[0] as u32) << 16 | (b[1] as u32) << 8 | b[2] as u32;
        out.push(TABLE[((n >> 18) & 63) as usize] as char);
        out.push(TABLE[((n >> 12) & 63) as usize] as char);
        if chunk.len() > 1 {
            out.push(TABLE[((n >> 6) & 63) as usize] as char);
        } else {
            out.push('=');
        }
        if chunk.len() > 2 {
            out.push(TABLE[(n & 63) as usize] as char);
        } else {
            out.push('=');
        }
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn base64_matches_known_vector() {
        assert_eq!(base64_encode(b"Man"), "TWFu");
        assert_eq!(base64_encode(b"Ma"), "TWE=");
        assert_eq!(base64_encode(b"M"), "TQ==");
    }
}
