mod ask;
mod cache;
mod diagram;
mod forest;
mod glossary;
mod imported;
mod session;
mod util;

use ask::Turn;
use diagram::DepStatus;
use forest::{Forest, Tree};
use session::SessionMeta;

const DEFAULT_MODEL: &str = "sonnet";

fn lang_of(lang: Option<String>) -> String {
    match lang.as_deref() {
        Some("ko") => "ko".to_string(),
        _ => "en".to_string(),
    }
}

/// Resolve any source to its text: link sources fetch their URLs dynamically;
/// Notion/web `.md` are raw; Claude Code `.jsonl` are transcript-extracted.
fn source_transcript(path: &str) -> Result<String, String> {
    if imported::is_link_source(path) {
        imported::resolve(path)
    } else {
        session::resolve_transcript(path)
    }
}

/// Only allow the three speed/quality tiers the UI exposes; fall back to the
/// default for anything unexpected.
fn resolve_model(model: Option<String>) -> String {
    match model.as_deref() {
        Some("haiku") | Some("sonnet") | Some("opus") => model.unwrap(),
        _ => DEFAULT_MODEL.to_string(),
    }
}

#[tauri::command]
async fn list_sessions() -> Vec<SessionMeta> {
    tauri::async_runtime::spawn_blocking(|| {
        let mut all = session::list_sessions();
        all.extend(imported::list_sources());
        all.sort_by(|a, b| b.modified.cmp(&a.modified));
        all
    })
    .await
    .unwrap_or_default()
}

#[tauri::command]
async fn get_transcript(path: String) -> Result<String, String> {
    tauri::async_runtime::spawn_blocking(move || source_transcript(&path))
        .await
        .map_err(|e| e.to_string())?
}

/// Structured messages for the (display-only) Transcript tab. Empty for link /
/// markdown sources, which the UI renders from `get_transcript` instead.
#[tauri::command]
async fn get_messages(path: String) -> Vec<session::Block> {
    tauri::async_runtime::spawn_blocking(move || {
        if imported::is_link_source(&path) || path.ends_with(".md") {
            Vec::new()
        } else {
            session::extract_blocks(&path)
        }
    })
    .await
    .unwrap_or_default()
}

#[tauri::command]
async fn check_deps() -> DepStatus {
    tauri::async_runtime::spawn_blocking(diagram::check_deps)
        .await
        .unwrap_or(DepStatus {
            claude: false,
            python: false,
            graphviz: false,
            diagrams_pkg: false,
        })
}

/// Cached forest (overview + tree list) for a source, null when not generated.
#[tauri::command]
async fn cached_forest(path: String, lang: Option<String>) -> Option<Forest> {
    let lang = lang_of(lang);
    tauri::async_runtime::spawn_blocking(move || {
        let mtime = cache::mtime_of(&path);
        cache::load(&format!("forest-{lang}"), &path, mtime)
    })
    .await
    .ok()
    .flatten()
}

/// Generate the forest (big-picture overview + the trees to explore) in one
/// Claude call, caching it. `force` bypasses the cache.
#[tauri::command]
async fn generate_forest(
    path: String,
    force: bool,
    model: Option<String>,
    lang: Option<String>,
) -> Result<Forest, String> {
    let model = resolve_model(model);
    let lang = lang_of(lang);
    tauri::async_runtime::spawn_blocking(move || {
        let mtime = cache::mtime_of(&path);
        let ns = format!("forest-{lang}");
        if !force {
            if let Some(cached) = cache::load(&ns, &path, mtime) {
                return Ok(cached);
            }
        }
        let transcript = source_transcript(&path)?;
        if transcript.trim().is_empty() {
            return Err("This source has no readable text.".to_string());
        }
        let forest = forest::generate_forest(&transcript, &model, &lang)?;
        cache::save(&ns, &path, mtime, &forest);
        Ok(forest)
    })
    .await
    .map_err(|e| e.to_string())?
}

/// Cached detail for one tree (keyed by its id), null when not yet generated.
#[tauri::command]
async fn cached_tree(path: String, tree_id: String, lang: Option<String>) -> Option<Tree> {
    let lang = lang_of(lang);
    tauri::async_runtime::spawn_blocking(move || {
        let mtime = cache::mtime_of(&path);
        cache::load(&format!("tree-{tree_id}-{lang}"), &path, mtime)
    })
    .await
    .ok()
    .flatten()
}

/// Generate the in-depth view of one tree (component/topic), caching it by id.
#[tauri::command]
async fn generate_tree(
    path: String,
    tree_id: String,
    tree_name: String,
    force: bool,
    model: Option<String>,
    lang: Option<String>,
) -> Result<Tree, String> {
    let model = resolve_model(model);
    let lang = lang_of(lang);
    tauri::async_runtime::spawn_blocking(move || {
        let mtime = cache::mtime_of(&path);
        let ns = format!("tree-{tree_id}-{lang}");
        if !force {
            if let Some(cached) = cache::load(&ns, &path, mtime) {
                return Ok(cached);
            }
        }
        let transcript = source_transcript(&path)?;
        if transcript.trim().is_empty() {
            return Err("This source has no readable text.".to_string());
        }
        let tree = forest::generate_tree(&transcript, &tree_name, &model, &lang)?;
        cache::save(&ns, &path, mtime, &tree);
        Ok(tree)
    })
    .await
    .map_err(|e| e.to_string())?
}

/// Answer a follow-up question about the source (Ask tab), using the document
/// as context plus the prior conversation turns.
#[tauri::command]
async fn ask(
    path: String,
    history: Vec<Turn>,
    question: String,
    model: Option<String>,
    lang: Option<String>,
) -> Result<String, String> {
    let model = resolve_model(model);
    let lang = lang_of(lang);
    tauri::async_runtime::spawn_blocking(move || {
        let transcript = source_transcript(&path)?;
        if transcript.trim().is_empty() {
            return Err("This source has no readable text.".to_string());
        }
        ask::answer(&transcript, &history, &question, &model, &lang)
    })
    .await
    .map_err(|e| e.to_string())?
}

/// Try to repair mermaid that failed to render in the webview.
#[tauri::command]
async fn fix_mermaid(source: String, model: Option<String>) -> Result<String, String> {
    let model = resolve_model(model);
    tauri::async_runtime::spawn_blocking(move || diagram::fix_mermaid(&source, &model))
        .await
        .map_err(|e| e.to_string())?
}

/// Kill any in-flight headless `claude` process(es). Returns how many.
#[tauri::command]
async fn cancel_generation() -> usize {
    diagram::cancel_all()
}

// ---------- Imported link sources ----------

/// Create a link source from one or more GitHub / Notion / web URLs. Content is
/// fetched dynamically (via the local Claude CLI) at generation time — no keys.
#[tauri::command]
async fn import_link(urls: Vec<String>, title: Option<String>) -> Result<SessionMeta, String> {
    tauri::async_runtime::spawn_blocking(move || imported::create_source(urls, title))
        .await
        .map_err(|e| e.to_string())?
}

/// Force a link source to re-fetch its URLs on the next generation.
#[tauri::command]
async fn refresh_source(path: String) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || imported::refresh(&path))
        .await
        .map_err(|e| e.to_string())?
}

/// Resolve `path` to a canonical path, rejecting anything that does not live
/// under `base`. Both sides are canonicalized: on macOS canonicalize() resolves
/// the /Users firmlink to /System/Volumes/Data/Users, so comparing against a
/// non-canonical base would always fail.
fn resolve_within(path: &str, base: &std::path::Path) -> Result<std::path::PathBuf, String> {
    let base = base
        .canonicalize()
        .map_err(|e| format!("could not resolve projects dir: {e}"))?;
    let canonical = std::path::Path::new(path)
        .canonicalize()
        .map_err(|e| format!("session not found: {e}"))?;
    if !canonical.starts_with(&base) {
        return Err("refusing to delete a file outside ~/.claude/projects".to_string());
    }
    Ok(canonical)
}

/// Move a source to the OS trash (recoverable). Allows Claude Code sessions
/// (~/.claude/projects) and imported Notion sources (the app data dir).
#[tauri::command]
async fn delete_session(path: String) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || {
        let projects = dirs::home_dir()
            .map(|h| h.join(".claude").join("projects"))
            .ok_or("could not resolve home directory")?;
        let canonical = resolve_within(&path, &projects)
            .or_else(|_| resolve_within(&path, &imported::sources_dir()))
            .map_err(|_| {
                "refusing to delete a file outside the session or Notion source folders"
                    .to_string()
            })?;
        trash::delete(&canonical).map_err(|e| format!("could not move to Trash: {e}"))
    })
    .await
    .map_err(|e| e.to_string())?
}

#[cfg(test)]
mod tests {
    use super::resolve_within;
    use std::fs;

    #[test]
    fn accepts_file_inside_base_and_rejects_outside() {
        let root = std::env::temp_dir().join(format!("bp-del-{}", std::process::id()));
        let base = root.join("projects");
        let proj = base.join("proj");
        fs::create_dir_all(&proj).unwrap();
        let inside = proj.join("s.jsonl");
        fs::write(&inside, "{}").unwrap();
        let outside = root.join("evil.jsonl");
        fs::write(&outside, "{}").unwrap();

        assert!(resolve_within(inside.to_str().unwrap(), &base).is_ok());
        assert!(resolve_within(outside.to_str().unwrap(), &base).is_err());

        let _ = fs::remove_dir_all(&root);
    }
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_process::init())
        .plugin(tauri_plugin_updater::Builder::new().build())
        .plugin(tauri_plugin_opener::init())
        .invoke_handler(tauri::generate_handler![
            list_sessions,
            get_transcript,
            get_messages,
            check_deps,
            cached_forest,
            generate_forest,
            cached_tree,
            generate_tree,
            ask,
            fix_mermaid,
            cancel_generation,
            import_link,
            refresh_source,
            delete_session
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
