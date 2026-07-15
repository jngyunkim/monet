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

/// The task instructions for each reflection mode. These are formative, not
/// evaluative: the goal is to keep the human an active participant, never to
/// grade a pass/fail.
fn reflect_task(mode: &str) -> &'static str {
    match mode {
        // Active recall by reconstruction: the user explains it in their own
        // words; we surface gaps without scoring.
        "teach_back" => "The user is explaining this component/system in their own words to solidify their understanding. You are a supportive study partner, NOT a grader — never give a score or a pass/fail. Compare their explanation against the document and reply in three short Markdown parts: **What you nailed** (what they got right), **Worth adding** (key points they missed or glossed over), and **Watch out** (any misconception to correct — omit this part if there is none). Be warm and concise. Ground every point in the document; do not introduce facts that are not in it.",
        // Recall in service of participation: turn understanding into the next
        // move rather than testing the past.
        "propose_next" => "The user is proposing what to change or build next in this system. Do NOT implement it or write code. Help them think it through and reply in concise Markdown covering: how their idea fits (or fights) the current structure, which parts of the system it would touch, what constraints or opportunities the existing design creates, and any risk or sharper alternative worth weighing. Ground everything in the document. If their proposal rests on a misunderstanding of the current design, gently point that out first.",
        _ => "Respond helpfully and concisely in Markdown, grounded in the document.",
    }
}

/// A reflection turn: the user reconstructs their understanding (`teach_back`)
/// or proposes the next change (`propose_next`), and Claude responds with
/// formative feedback grounded in the source. Shares the document + history
/// resend strategy with `answer`.
pub fn reflect(
    transcript: &str,
    focus: &str,
    mode: &str,
    history: &[Turn],
    input: &str,
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

    let focus_clause = if focus.trim().is_empty() {
        String::new()
    } else {
        format!("The user is focused on this part of the system: \"{}\".\n\n", focus.trim())
    };

    let prompt = format!(
        "{}\n\n===== DOCUMENT =====\n{}\n===== END DOCUMENT =====\n\n{}{}The user's input:\n{}{}",
        reflect_task(mode),
        tail_chars(transcript, MAX_TRANSCRIPT_CHARS),
        focus_clause,
        if convo.is_empty() {
            String::new()
        } else {
            format!("Conversation so far:\n{convo}\n")
        },
        input.trim(),
        lang_clause(lang),
    );
    run_claude_text(&prompt, model)
}
