use crate::diagram::run_claude_text;
use crate::util::{lang_clause, tail_chars};
use serde::Deserialize;

/// One prior turn in the Ask thread. role is "user" or "assistant".
#[derive(Deserialize)]
pub struct Turn {
    pub role: String,
    pub content: String,
}

const MAX_TRANSCRIPT_CHARS: usize = 160_000;
const MAX_HISTORY_TURNS: usize = 12;

/// Answer a follow-up question about the source, using the document as context
/// plus the prior conversation so the thread stays coherent (the headless CLI
/// is stateless, so we resend the document and recent history each turn).
pub fn answer(
    transcript: &str,
    history: &[Turn],
    question: &str,
    model: &str,
    lang: &str,
) -> Result<String, String> {
    let mut convo = String::new();
    let recent = if history.len() > MAX_HISTORY_TURNS {
        &history[history.len() - MAX_HISTORY_TURNS..]
    } else {
        history
    };
    for t in recent {
        let who = if t.role == "assistant" { "Assistant" } else { "User" };
        convo.push_str(&format!("{who}: {}\n\n", t.content));
    }

    let prompt = format!(
        "Answer the user's question about the following document. Use ONLY information in the document; if it is not covered, say so briefly. Answer in concise Markdown.\n\n===== DOCUMENT =====\n{}\n===== END DOCUMENT =====\n\n{}Question: {}{}",
        tail_chars(transcript, MAX_TRANSCRIPT_CHARS),
        if convo.is_empty() {
            String::new()
        } else {
            format!("Conversation so far:\n{convo}")
        },
        question.trim(),
        lang_clause(lang),
    );
    run_claude_text(&prompt, model)
}
