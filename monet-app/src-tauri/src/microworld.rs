use crate::diagram::run_claude;
use crate::util::{lang_clause, tail_chars};
use serde::{Deserialize, Serialize};
use std::collections::{BTreeMap, HashSet};

const MAX_TRANSCRIPT_CHARS: usize = 160_000;

#[derive(Serialize, Deserialize, Clone, Debug)]
pub struct MicroworldRef {
    pub id: String,
    pub title: String,
    #[serde(default)]
    pub blurb: String,
}

#[derive(Serialize, Deserialize, Clone, Debug)]
pub struct MicroworldStep {
    pub label: String,
    pub detail: String,
    pub from: String,
    pub to: String,
    #[serde(default)]
    pub state: BTreeMap<String, String>,
}

#[derive(Serialize, Deserialize, Clone, Debug)]
pub struct Microworld {
    pub kind: String,
    pub title: String,
    pub intro: String,
    pub actors: Vec<String>,
    pub steps: Vec<MicroworldStep>,
}

fn json_slice(raw: &str) -> Result<&str, String> {
    let trimmed = raw.trim();
    match (trimmed.find('{'), trimmed.rfind('}')) {
        (Some(a), Some(b)) if b >= a => Ok(&trimmed[a..=b]),
        _ => Err("no JSON object found in model output".to_string()),
    }
}

fn validate(world: &Microworld) -> Result<(), String> {
    if world.kind != "steps" {
        return Err("microworld kind must be steps".to_string());
    }
    if world.title.trim().is_empty() || world.intro.trim().is_empty() {
        return Err("microworld title and intro are required".to_string());
    }
    if !(2..=8).contains(&world.actors.len()) {
        return Err("microworld must contain 2 to 8 actors".to_string());
    }
    if !(2..=12).contains(&world.steps.len()) {
        return Err("microworld must contain 2 to 12 steps".to_string());
    }
    let actors: HashSet<&str> = world.actors.iter().map(String::as_str).collect();
    if actors.len() != world.actors.len() || actors.iter().any(|a| a.trim().is_empty()) {
        return Err("microworld actors must be unique and non-empty".to_string());
    }
    for step in &world.steps {
        if !actors.contains(step.from.as_str()) || !actors.contains(step.to.as_str()) {
            return Err(format!(
                "microworld step '{}' references an unknown actor",
                step.label
            ));
        }
        if step.label.trim().is_empty() || step.detail.trim().is_empty() {
            return Err("microworld steps require a label and detail".to_string());
        }
    }
    Ok(())
}

fn parse_microworld(raw: &str) -> Result<Microworld, String> {
    let world = serde_json::from_str::<Microworld>(json_slice(raw)?)
        .map_err(|e| format!("could not parse microworld JSON: {e}"))?;
    validate(&world)?;
    Ok(world)
}

fn prompt(
    transcript: &str,
    tree_name: &str,
    title: &str,
    blurb: &str,
    lang: &str,
) -> String {
    format!(
        r#"Create one interactive step-through learning world about "{title}" within the component "{tree_name}". The world must be STRICTLY grounded in the document below.

The reader will move through the steps to observe how actors interact and how state changes. Produce:
- `kind`: exactly "steps".
- `title`: concise human-readable title.
- `intro`: one sentence telling the reader what to observe.
- `actors`: 2 to 8 actors that explicitly exist in the document.
- `steps`: 2 to 12 chronological steps. Every step has a short `label`, a grounded Markdown `detail`, `from` and `to` values copied exactly from `actors`, and `state` containing the complete state snapshot at that moment. State values MUST be short strings. Reuse the same state keys across steps where relevant so changes are visible.

Candidate description: {blurb}

CRITICAL: Use ONLY facts present in the document. Do not invent actors, state, APIs, or transitions. If the document is incomplete, make fewer steps and state the limitation in `detail`.

Output ONLY a single JSON object, with no markdown fence or surrounding prose, exactly matching:
{{"kind":"steps","title":"string","intro":"string","actors":["Actor"],"steps":[{{"label":"string","detail":"string","from":"Actor","to":"Actor","state":{{"key":"value"}}}}]}}

Here is the document:

"#,
        title = title,
        tree_name = tree_name,
        blurb = blurb,
    ) + &format!(
        "{}{}",
        tail_chars(transcript, MAX_TRANSCRIPT_CHARS),
        lang_clause(lang)
    )
}

pub fn generate(
    transcript: &str,
    tree_name: &str,
    title: &str,
    blurb: &str,
    model: &str,
    lang: &str,
) -> Result<Microworld, String> {
    let prompt = prompt(transcript, tree_name, title, blurb, lang);
    let mut last_err = String::new();
    for attempt in 0..2 {
        let result = run_claude(&prompt, model)?;
        match parse_microworld(&result) {
            Ok(world) => return Ok(world),
            Err(err) => {
                last_err = err;
                if attempt == 0 {
                    continue;
                }
            }
        }
    }
    Err(last_err)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_a_grounded_step_world() {
        let raw = r#"{
          "kind":"steps",
          "title":"Authorization flow",
          "intro":"Follow the code exchange.",
          "actors":["Browser","Server"],
          "steps":[
            {"label":"Request","detail":"Browser requests login.","from":"Browser","to":"Server","state":{"status":"requested"}},
            {"label":"Return","detail":"Server returns a code.","from":"Server","to":"Browser","state":{"status":"code-issued"}}
          ]
        }"#;

        let world = parse_microworld(raw).unwrap();
        assert_eq!(world.steps.len(), 2);
        assert_eq!(world.actors, vec!["Browser", "Server"]);
    }

    #[test]
    fn rejects_a_transition_to_an_unknown_actor() {
        let raw = r#"{
          "kind":"steps","title":"Flow","intro":"Observe.",
          "actors":["Client","Server"],
          "steps":[
            {"label":"One","detail":"First.","from":"Client","to":"Database","state":{"status":"one"}},
            {"label":"Two","detail":"Second.","from":"Server","to":"Client","state":{"status":"two"}}
          ]
        }"#;

        assert!(parse_microworld(raw).unwrap_err().contains("unknown actor"));
    }
}
