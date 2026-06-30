mod cache;
mod design;
mod diagram;
mod glossary;
mod imported;
mod session;
mod util;

use design::DesignDoc;
use diagram::{DepStatus, DiagramSet};
use glossary::GlossarySet;
use session::SessionMeta;

const DEFAULT_MODEL: &str = "sonnet";

fn lang_of(lang: Option<String>) -> String {
    match lang.as_deref() {
        Some("ko") => "ko".to_string(),
        _ => "en".to_string(),
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
    tauri::async_runtime::spawn_blocking(move || session::resolve_transcript(&path))
        .await
        .map_err(|e| e.to_string())?
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

/// Return cached diagrams for a session without invoking Claude. Returns null
/// when nothing is cached, so the UI can show an explicit "Generate" button.
#[tauri::command]
async fn cached_diagrams(path: String, lang: Option<String>) -> Option<DiagramSet> {
    let lang = lang_of(lang);
    tauri::async_runtime::spawn_blocking(move || {
        let mtime = cache::mtime_of(&path);
        cache::load(&format!("diagrams-{lang}"), &path, mtime)
    })
    .await
    .ok()
    .flatten()
}

#[tauri::command]
async fn generate_diagrams(
    path: String,
    force: bool,
    model: Option<String>,
    lang: Option<String>,
) -> Result<DiagramSet, String> {
    let model = resolve_model(model);
    let lang = lang_of(lang);
    tauri::async_runtime::spawn_blocking(move || {
        let mtime = cache::mtime_of(&path);
        let ns = format!("diagrams-{lang}");
        if !force {
            if let Some(cached) = cache::load(&ns, &path, mtime) {
                return Ok(cached);
            }
        }
        let transcript = session::resolve_transcript(&path)?;
        if transcript.trim().is_empty() {
            return Err("This source has no readable text.".to_string());
        }
        let set = diagram::generate(&transcript, &model, &lang)?;
        cache::save(&ns, &path, mtime, &set);
        Ok(set)
    })
    .await
    .map_err(|e| e.to_string())?
}

/// Cached glossary for a session without invoking Claude (null when none).
#[tauri::command]
async fn cached_glossary(path: String, lang: Option<String>) -> Option<GlossarySet> {
    let lang = lang_of(lang);
    tauri::async_runtime::spawn_blocking(move || {
        let mtime = cache::mtime_of(&path);
        cache::load(&format!("glossary-{lang}"), &path, mtime)
    })
    .await
    .ok()
    .flatten()
}

#[tauri::command]
async fn generate_glossary(
    path: String,
    force: bool,
    model: Option<String>,
    lang: Option<String>,
) -> Result<GlossarySet, String> {
    let model = resolve_model(model);
    let lang = lang_of(lang);
    tauri::async_runtime::spawn_blocking(move || {
        let mtime = cache::mtime_of(&path);
        let ns = format!("glossary-{lang}");
        if !force {
            if let Some(cached) = cache::load(&ns, &path, mtime) {
                return Ok(cached);
            }
        }
        let transcript = session::resolve_transcript(&path)?;
        if transcript.trim().is_empty() {
            return Err("This source has no readable text.".to_string());
        }
        let set = glossary::generate(&transcript, &model, &lang)?;
        cache::save(&ns, &path, mtime, &set);
        Ok(set)
    })
    .await
    .map_err(|e| e.to_string())?
}

/// Cached design levels for a source without invoking Claude (null when none).
#[tauri::command]
async fn cached_design(path: String, lang: Option<String>) -> Option<DesignDoc> {
    let lang = lang_of(lang);
    tauri::async_runtime::spawn_blocking(move || {
        let mtime = cache::mtime_of(&path);
        cache::load(&format!("design-{lang}"), &path, mtime)
    })
    .await
    .ok()
    .flatten()
}

#[tauri::command]
async fn generate_design(
    path: String,
    force: bool,
    model: Option<String>,
    lang: Option<String>,
) -> Result<DesignDoc, String> {
    let model = resolve_model(model);
    let lang = lang_of(lang);
    tauri::async_runtime::spawn_blocking(move || {
        let mtime = cache::mtime_of(&path);
        let ns = format!("design-{lang}");
        if !force {
            if let Some(cached) = cache::load(&ns, &path, mtime) {
                return Ok(cached);
            }
        }
        let transcript = session::resolve_transcript(&path)?;
        if transcript.trim().is_empty() {
            return Err("This source has no readable text.".to_string());
        }
        let doc = design::generate(&transcript, &model, &lang)?;
        cache::save(&ns, &path, mtime, &doc);
        Ok(doc)
    })
    .await
    .map_err(|e| e.to_string())?
}

// ---------- Imported link sources ----------

/// Fetch a GitHub / Notion / web link by delegating to the local Claude CLI
/// (gh + WebFetch), saving it as a local source. No API keys required.
#[tauri::command]
async fn import_link(url: String) -> Result<SessionMeta, String> {
    tauri::async_runtime::spawn_blocking(move || imported::import(&url))
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
            check_deps,
            cached_diagrams,
            generate_diagrams,
            cached_glossary,
            generate_glossary,
            cached_design,
            generate_design,
            import_link,
            delete_session
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
