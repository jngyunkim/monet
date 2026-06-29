use crate::diagram::DiagramSet;
use std::collections::hash_map::DefaultHasher;
use std::fs;
use std::hash::{Hash, Hasher};
use std::path::PathBuf;

fn cache_dir() -> PathBuf {
    dirs::cache_dir()
        .unwrap_or_else(std::env::temp_dir)
        .join("blueprint")
}

/// Cache key is derived from the session path plus its mtime, so a changed
/// session naturally invalidates its cached diagrams.
fn cache_file(path: &str, mtime: u64) -> PathBuf {
    let mut h = DefaultHasher::new();
    path.hash(&mut h);
    mtime.hash(&mut h);
    cache_dir().join(format!("{:016x}.json", h.finish()))
}

pub fn load(path: &str, mtime: u64) -> Option<DiagramSet> {
    let f = cache_file(path, mtime);
    let content = fs::read_to_string(f).ok()?;
    serde_json::from_str(&content).ok()
}

pub fn save(path: &str, mtime: u64, set: &DiagramSet) {
    let dir = cache_dir();
    if fs::create_dir_all(&dir).is_err() {
        return;
    }
    if let Ok(json) = serde_json::to_string(set) {
        let _ = fs::write(cache_file(path, mtime), json);
    }
}

pub fn mtime_of(path: &str) -> u64 {
    fs::metadata(path)
        .ok()
        .and_then(|m| m.modified().ok())
        .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
        .map(|d| d.as_secs())
        .unwrap_or(0)
}
