use std::path::PathBuf;

/// Resolve an executable by name. A GUI app launched from Finder has a minimal
/// PATH that usually omits ~/.local/bin, Homebrew, etc., so we probe common
/// install locations explicitly before falling back to the bare name (which
/// works under `tauri dev` where the terminal PATH is inherited).
pub fn find_bin(name: &str) -> Option<String> {
    let mut candidates: Vec<PathBuf> = Vec::new();
    if let Some(home) = dirs::home_dir() {
        candidates.push(home.join(".local/bin").join(name));
        candidates.push(home.join(".claude/local").join(name));
        candidates.push(home.join(".cargo/bin").join(name));
    }
    for base in ["/opt/homebrew/bin", "/usr/local/bin", "/usr/bin", "/bin"] {
        candidates.push(PathBuf::from(base).join(name));
    }
    for c in candidates {
        if c.is_file() {
            return Some(c.to_string_lossy().to_string());
        }
    }
    // Fall back to letting the OS resolve it via PATH.
    if which_on_path(name) {
        return Some(name.to_string());
    }
    None
}

fn which_on_path(name: &str) -> bool {
    if let Ok(path) = std::env::var("PATH") {
        for dir in path.split(':') {
            if std::path::Path::new(dir).join(name).is_file() {
                return true;
            }
        }
    }
    false
}

/// An augmented PATH string that includes common bin dirs, for passing to
/// child processes so that tools like `dot` (graphviz) resolve correctly.
pub fn augmented_path() -> String {
    let mut parts: Vec<String> = Vec::new();
    if let Some(home) = dirs::home_dir() {
        parts.push(home.join(".local/bin").to_string_lossy().to_string());
    }
    for base in ["/opt/homebrew/bin", "/usr/local/bin", "/usr/bin", "/bin"] {
        parts.push(base.to_string());
    }
    if let Ok(existing) = std::env::var("PATH") {
        parts.push(existing);
    }
    parts.join(":")
}
