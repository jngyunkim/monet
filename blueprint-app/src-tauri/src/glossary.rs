use crate::diagram::run_claude;
use crate::util::tail_chars;
use serde::{Deserialize, Serialize};

#[derive(Serialize, Deserialize, Clone)]
pub struct Term {
    pub term: String,
    pub definition: String,
    #[serde(default)]
    pub category: String,
}

#[derive(Serialize, Deserialize, Clone)]
pub struct GlossarySet {
    pub terms: Vec<Term>,
}

const MAX_TRANSCRIPT_CHARS: usize = 400_000;

const PROMPT: &str = r#"You are a technical glossary builder. Read the following Claude Code design/architecture conversation and extract the key technical terms, acronyms, tools, services, libraries, and domain-specific jargon that appear in it.

For each term, write a concise (1-2 sentence) definition that reflects **how the term is actually used in THIS conversation's context** — not just a generic dictionary definition. If a term is project- or domain-specific, explain the role it plays here.

Rules:
- Between 5 and 25 terms, ordered roughly by how important they are to understanding the design.
- Optionally set a short `category` such as "Service", "Protocol", "Library", "Concept", "Tool", or "Acronym".
- Skip trivial or universally-known programming words; focus on terms a newcomer to this project would need explained.

Output ONLY a single JSON object, with NO markdown code fences and NO prose before or after, exactly matching this shape:
{"terms":[{"term":"string","definition":"string","category":"string"}]}

Here is the conversation transcript:

"#;

pub fn generate(transcript: &str, model: &str) -> Result<GlossarySet, String> {
    let prompt = format!("{PROMPT}{}", tail_chars(transcript, MAX_TRANSCRIPT_CHARS));
    let mut last_err = String::new();
    for attempt in 0..2 {
        let result = run_claude(&prompt, model)?;
        match parse(&result) {
            Ok(set) => return Ok(set),
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

fn parse(raw: &str) -> Result<GlossarySet, String> {
    let trimmed = raw.trim();
    let inner = match (trimmed.find('{'), trimmed.rfind('}')) {
        (Some(a), Some(b)) if b >= a => &trimmed[a..=b],
        _ => return Err("no JSON object found in model output".to_string()),
    };
    serde_json::from_str::<GlossarySet>(inner)
        .map_err(|e| format!("could not parse glossary JSON: {e}"))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_glossary_json() {
        let raw = r#"prefix {"terms":[{"term":"SQS","definition":"queue","category":"Service"}]} suffix"#;
        let set = parse(raw).unwrap();
        assert_eq!(set.terms.len(), 1);
        assert_eq!(set.terms[0].term, "SQS");
    }

    #[test]
    fn category_defaults_when_missing() {
        let raw = r#"{"terms":[{"term":"X","definition":"y"}]}"#;
        let set = parse(raw).unwrap();
        assert_eq!(set.terms[0].category, "");
    }
}
