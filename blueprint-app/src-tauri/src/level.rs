use crate::diagram::{render_diagrams, run_claude, Diagram};
use crate::glossary::Term;
use crate::util::{lang_clause, tail_chars};
use serde::{Deserialize, Serialize};

/// One generated design level: prose + the diagrams and terms for THIS level.
#[derive(Serialize, Deserialize, Clone)]
pub struct LevelResult {
    /// Display name: "High-level" | "Detailed" | "Implementation".
    pub level: String,
    pub title: String,
    /// Markdown.
    pub content: String,
    pub diagrams: Vec<Diagram>,
    pub terms: Vec<Term>,
}

const MAX_TRANSCRIPT_CHARS: usize = 160_000;

/// Map a stable key (used in cache namespace + IPC) to its display name and the
/// focus instruction for that level.
pub fn level_spec(key: &str) -> Option<(&'static str, &'static str)> {
    match key {
        "high" => Some((
            "High-level",
            "the BIG PICTURE: the purpose, the problem being solved, and the main components/actors and how they relate at a glance.",
        )),
        "detailed" => Some((
            "Detailed",
            "HOW THE COMPONENTS INTERACT: data flow, key design decisions and their rationale, interfaces, sequencing, and trade-offs.",
        )),
        "impl" => Some((
            "Implementation",
            "CONCRETE IMPLEMENTATION SPECIFICS actually discussed: specific files, functions, APIs, schemas, configs, commands, and edge cases. If the document does not contain implementation detail, say so briefly instead of fabricating.",
        )),
        _ => None,
    }
}

/// Mermaid rules shared across prompts to cut down on syntax that fails to parse.
const MERMAID_RULES: &str = "For any `mermaid` diagram, keep it small and STRICTLY valid: start with one of `flowchart TD`, `sequenceDiagram`, `erDiagram`, or `stateDiagram-v2`; use simple alphanumeric node ids (no spaces); put EVERY node and edge label in double quotes; never use parentheses, semicolons, colons, '#', '<', '>', '@', backticks, or line breaks inside a label; one statement per line.";

fn build_prompt(transcript: &str, display: &str, focus: &str, lang: &str) -> String {
    format!(
        r#"You explain ONE level of a software design, STRICTLY grounded in the document below. Produce the "{display}" level: {focus}

Also produce, for THIS level only:
- `diagrams`: 0 to 2 diagrams that genuinely help understand THIS level (skip if prose is clearer). Prefer `kind:"mermaid"`. Use `kind:"mingrammer"` (Python `diagrams` library, `show=False`, `outformat="svg"`, `filename="diagram"`, import only from `diagrams`) ONLY for real cloud/infra topology. {mermaid}
- `terms`: the key technical terms, acronyms, tools, or jargon that appear IN THIS LEVEL's explanation (3 to 12), each with a 1-2 sentence definition reflecting how it is used in this document. Skip trivial/universally-known words.

CRITICAL: Use ONLY information present in the document. Do NOT invent, assume, or add outside knowledge. `content` is concise Markdown (headings, bullets, fenced code allowed). `title` is a short summary of this level for this specific document.

Output ONLY a single JSON object, NO markdown code fences and NO prose before or after, exactly matching:
{{"level":"{display}","title":"string","content":"string","diagrams":[{{"title":"string","kind":"mermaid","source":"string","explanation":"string"}}],"terms":[{{"term":"string","definition":"string","category":"string"}}]}}

Here is the document:

"#,
        display = display,
        focus = focus,
        mermaid = MERMAID_RULES,
    ) + &format!("{}{}", tail_chars(transcript, MAX_TRANSCRIPT_CHARS), lang_clause(lang))
}

pub fn generate(
    transcript: &str,
    level_key: &str,
    model: &str,
    lang: &str,
) -> Result<LevelResult, String> {
    let (display, focus) =
        level_spec(level_key).ok_or_else(|| format!("unknown level '{level_key}'"))?;
    let prompt = build_prompt(transcript, display, focus, lang);
    let mut last_err = String::new();
    for attempt in 0..2 {
        let result = run_claude(&prompt, model)?;
        match parse(&result) {
            Ok(mut lvl) => {
                if lvl.level.is_empty() {
                    lvl.level = display.to_string();
                }
                render_diagrams(&mut lvl.diagrams);
                return Ok(lvl);
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

fn parse(raw: &str) -> Result<LevelResult, String> {
    let trimmed = raw.trim();
    let inner = match (trimmed.find('{'), trimmed.rfind('}')) {
        (Some(a), Some(b)) if b >= a => &trimmed[a..=b],
        _ => return Err("no JSON object found in model output".to_string()),
    };
    serde_json::from_str::<LevelResult>(inner)
        .map_err(|e| format!("could not parse level JSON: {e}"))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_level_result() {
        let raw = r##"noise {"level":"High-level","title":"O","content":"# x",
          "diagrams":[{"title":"T","kind":"mermaid","source":"flowchart TD","explanation":"e"}],
          "terms":[{"term":"SQS","definition":"queue","category":"Service"}]} tail"##;
        let l = parse(raw).unwrap();
        assert_eq!(l.level, "High-level");
        assert_eq!(l.diagrams.len(), 1);
        assert_eq!(l.terms[0].term, "SQS");
    }

    #[test]
    fn level_keys_map() {
        assert_eq!(level_spec("high").unwrap().0, "High-level");
        assert_eq!(level_spec("detailed").unwrap().0, "Detailed");
        assert_eq!(level_spec("impl").unwrap().0, "Implementation");
        assert!(level_spec("nope").is_none());
    }
}
