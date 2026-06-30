use crate::util::{augmented_path, find_bin, work_dir};
use serde::{Deserialize, Serialize};
use std::fs;
use std::io::Write;
use std::process::{Command, Stdio};

#[derive(Serialize, Deserialize, Clone)]
pub struct Diagram {
    pub title: String,
    /// "mermaid" | "mingrammer"
    pub kind: String,
    pub source: String,
    #[serde(default)]
    pub explanation: String,
    /// Rendered HTML for mingrammer diagrams (inline <svg> or <img>). Empty for mermaid.
    #[serde(default)]
    pub rendered: String,
    /// When set, the diagram could not be rendered; holds a human-readable reason.
    #[serde(default)]
    pub unavailable: Option<String>,
}

#[derive(Serialize, Deserialize, Clone)]
pub struct DiagramSet {
    pub diagrams: Vec<Diagram>,
}

#[derive(Serialize, Clone)]
pub struct DepStatus {
    pub claude: bool,
    pub python: bool,
    pub graphviz: bool,
    pub diagrams_pkg: bool,
}

const MAX_TRANSCRIPT_CHARS: usize = 400_000;

const PROMPT: &str = r#"You are a software-architecture visualizer. Read the following Claude Code design/architecture conversation and produce 1 to 3 diagrams that best help a reader UNDERSTAND the architecture and key design decisions discussed. Focus on structure, data flow, components, and important decisions — not on chit-chat.

Rules:
- Prefer `mermaid` for component relationships, flows, sequences, state machines, and entity relationships.
- Use `mingrammer` (the Python `diagrams` library) ONLY when the design is genuinely about cloud/infrastructure topology (services, queues, databases, load balancers, cloud providers). For mingrammer, the Python code MUST construct the diagram with `show=False`, `outformat="svg"`, and `filename="diagram"` (exactly that filename, no path, no extension). Import only from the `diagrams` package.
- Each diagram needs a short `title`, the `source`, and a 1-2 sentence `explanation` of what it shows.
- Keep mermaid syntactically valid. Do not wrap node labels in problematic characters.

Output ONLY a single JSON object, with NO markdown code fences and NO prose before or after, exactly matching this shape:
{"diagrams":[{"title":"string","kind":"mermaid","source":"string","explanation":"string"}]}

Here is the conversation transcript:

"#;

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

/// Build the full prompt (instructions + transcript), truncating very large
/// transcripts from the front so the most recent design discussion is kept.
fn build_prompt(transcript: &str, lang: &str) -> String {
    let body = if transcript.len() > MAX_TRANSCRIPT_CHARS {
        format!(
            "[...transcript truncated...]\n{}",
            crate::util::tail_chars(transcript, MAX_TRANSCRIPT_CHARS)
        )
    } else {
        transcript.to_string()
    };
    format!("{PROMPT}{body}{}", crate::util::lang_clause(lang))
}

/// Invoke the local Claude Code CLI in headless mode, piping the prompt via
/// stdin, and return the model's textual result.
pub fn run_claude(prompt: &str, model: &str) -> Result<String, String> {
    let bin = find_bin("claude").ok_or_else(|| {
        "Claude Code CLI ('claude') not found. Install it and make sure it is on your PATH."
            .to_string()
    })?;
    // This is a pure text-in / JSON-out task, so we strip the full Claude Code
    // environment: no MCP servers, no user/project settings or hooks, and a
    // minimal system prompt. That trims startup overhead and token cost.
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
        .arg("You are a strict JSON generator. Respond with ONLY a single valid JSON object matching the schema described in the user's message. Never add markdown code fences, prose, commentary, or conversation before or after the JSON.")
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
    let v: serde_json::Value = serde_json::from_str(&stdout)
        .map_err(|e| format!("could not parse claude JSON output: {e}"))?;
    v.get("result")
        .and_then(|x| x.as_str())
        .map(|s| s.to_string())
        .ok_or_else(|| "claude output had no 'result' field".to_string())
}

/// Extract the JSON object from a model response that may contain stray fences
/// or prose, then deserialize it into a DiagramSet.
fn parse_diagrams(raw: &str) -> Result<DiagramSet, String> {
    let trimmed = raw.trim();
    let inner = match (trimmed.find('{'), trimmed.rfind('}')) {
        (Some(a), Some(b)) if b >= a => &trimmed[a..=b],
        _ => return Err("no JSON object found in model output".to_string()),
    };
    serde_json::from_str::<DiagramSet>(inner)
        .map_err(|e| format!("could not parse diagram JSON: {e}"))
}

/// Full generation pipeline: transcript -> claude -> parse -> render mingrammer.
pub fn generate(transcript: &str, model: &str, lang: &str) -> Result<DiagramSet, String> {
    let prompt = build_prompt(transcript, lang);
    // One retry on parse failure (models occasionally add stray prose).
    let mut last_err = String::new();
    for attempt in 0..2 {
        let result = run_claude(&prompt, model)?;
        match parse_diagrams(&result) {
            Ok(mut set) => {
                for d in set.diagrams.iter_mut() {
                    if d.kind == "mingrammer" {
                        match render_mingrammer(&d.source) {
                            Ok(html) => d.rendered = html,
                            Err(reason) => d.unavailable = Some(reason),
                        }
                    }
                }
                return Ok(set);
            }
            Err(e) => {
                last_err = e;
                if attempt == 0 {
                    continue;
                }
            }
        }
    }
    Err(last_err)
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
    fn parses_clean_json() {
        let raw = r#"{"diagrams":[{"title":"T","kind":"mermaid","source":"graph TD; A-->B","explanation":"x"}]}"#;
        let set = parse_diagrams(raw).unwrap();
        assert_eq!(set.diagrams.len(), 1);
        assert_eq!(set.diagrams[0].kind, "mermaid");
    }

    #[test]
    fn parses_json_with_fences_and_prose() {
        let raw = "Here you go:\n```json\n{\"diagrams\":[{\"title\":\"T\",\"kind\":\"mermaid\",\"source\":\"graph TD; A-->B\",\"explanation\":\"x\"}]}\n```\nDone.";
        let set = parse_diagrams(raw).unwrap();
        assert_eq!(set.diagrams.len(), 1);
    }

    #[test]
    fn base64_matches_known_vector() {
        assert_eq!(base64_encode(b"Man"), "TWFu");
        assert_eq!(base64_encode(b"Ma"), "TWE=");
        assert_eq!(base64_encode(b"M"), "TQ==");
    }
}
