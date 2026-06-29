use serde::de::DeserializeOwned;
use serde::Serialize;
use std::collections::hash_map::DefaultHasher;
use std::fs;
use std::hash::{Hash, Hasher};
use std::path::PathBuf;

fn cache_dir() -> PathBuf {
    dirs::cache_dir()
        .unwrap_or_else(std::env::temp_dir)
        .join("blueprint")
}

/// Cache key is derived from a namespace ("diagrams", "glossary", …) plus the
/// session path and its mtime, so a changed session naturally invalidates its
/// cached artifacts and different artifact kinds never collide.
fn cache_file(namespace: &str, path: &str, mtime: u64) -> PathBuf {
    let mut h = DefaultHasher::new();
    namespace.hash(&mut h);
    path.hash(&mut h);
    mtime.hash(&mut h);
    cache_dir().join(format!("{:016x}.json", h.finish()))
}

pub fn load<T: DeserializeOwned>(namespace: &str, path: &str, mtime: u64) -> Option<T> {
    let content = fs::read_to_string(cache_file(namespace, path, mtime)).ok()?;
    serde_json::from_str(&content).ok()
}

pub fn save<T: Serialize>(namespace: &str, path: &str, mtime: u64, value: &T) {
    if fs::create_dir_all(cache_dir()).is_err() {
        return;
    }
    if let Ok(json) = serde_json::to_string(value) {
        let _ = fs::write(cache_file(namespace, path, mtime), json);
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
