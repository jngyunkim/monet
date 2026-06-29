mod cache;
mod diagram;
mod session;
mod util;

use diagram::{DepStatus, DiagramSet};
use session::SessionMeta;

const DEFAULT_MODEL: &str = "sonnet";

#[tauri::command]
async fn list_sessions() -> Vec<SessionMeta> {
    tauri::async_runtime::spawn_blocking(session::list_sessions)
        .await
        .unwrap_or_default()
}

#[tauri::command]
async fn get_transcript(path: String) -> Result<String, String> {
    tauri::async_runtime::spawn_blocking(move || session::extract_transcript(&path))
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

#[tauri::command]
async fn generate_diagrams(path: String, force: bool) -> Result<DiagramSet, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let mtime = cache::mtime_of(&path);
        if !force {
            if let Some(cached) = cache::load(&path, mtime) {
                return Ok(cached);
            }
        }
        let transcript = session::extract_transcript(&path)?;
        if transcript.trim().is_empty() {
            return Err("This session has no readable conversation text.".to_string());
        }
        let set = diagram::generate(&transcript, DEFAULT_MODEL)?;
        cache::save(&path, mtime, &set);
        Ok(set)
    })
    .await
    .map_err(|e| e.to_string())?
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .invoke_handler(tauri::generate_handler![
            list_sessions,
            get_transcript,
            check_deps,
            generate_diagrams
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
