use std::path::{Path, PathBuf};

/// Move data from an older app directory into its current location. Existing
/// files in `current` always win, so upgrading never overwrites newer data.
pub(crate) fn migrate_legacy_dir(legacy: &Path, current: &Path) {
    if !legacy.exists() || legacy == current {
        return;
    }
    if !current.exists() && std::fs::rename(legacy, current).is_ok() {
        return;
    }
    if std::fs::create_dir_all(current).is_err() {
        return;
    }
    let Ok(entries) = std::fs::read_dir(legacy) else {
        return;
    };
    for entry in entries.flatten() {
        let source = entry.path();
        let destination = current.join(entry.file_name());
        if source.is_dir() {
            migrate_legacy_dir(&source, &destination);
        } else if destination.exists() {
            let _ = std::fs::remove_file(&source);
        } else if std::fs::rename(&source, &destination).is_err()
            && std::fs::copy(&source, &destination).is_ok()
        {
            let _ = std::fs::remove_file(&source);
        }
    }
    let _ = std::fs::remove_dir(legacy);
}

fn legacy_app_cache_dir() -> PathBuf {
    dirs::cache_dir()
        .unwrap_or_else(std::env::temp_dir)
        .join("blueprint")
}

fn legacy_app_data_dir() -> PathBuf {
    dirs::data_dir()
        .unwrap_or_else(std::env::temp_dir)
        .join("blueprint")
}

pub(crate) fn legacy_work_dir() -> PathBuf {
    legacy_app_cache_dir().join("work")
}

pub(crate) fn app_cache_dir() -> PathBuf {
    let base = dirs::cache_dir().unwrap_or_else(std::env::temp_dir);
    let current = base.join("monet");
    migrate_legacy_dir(&legacy_app_cache_dir(), &current);
    current
}

pub(crate) fn app_data_dir() -> PathBuf {
    let base = dirs::data_dir().unwrap_or_else(std::env::temp_dir);
    let current = base.join("monet");
    migrate_legacy_dir(&legacy_app_data_dir(), &current);
    current
}

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

/// An isolated, non-protected working directory for spawned `claude` processes.
/// Without an explicit cwd, claude treats the inherited directory (which can be
/// the user's home) as the project and enumerates it — tripping macOS privacy
/// prompts for Photos, Music, Desktop, etc. Pointing it at an empty cache dir
/// avoids touching any protected location.
pub fn work_dir() -> std::path::PathBuf {
    let d = app_cache_dir().join("work");
    let _ = std::fs::create_dir_all(&d);
    d
}

/// An instruction appended to generation prompts so natural-language output is
/// written in the user's preferred language. Code, identifiers, and proper
/// nouns are kept as-is. Empty for English (the model's default here).
pub fn lang_clause(lang: &str) -> &'static str {
    match lang {
        "ko" => "\n\nIMPORTANT: Write all natural-language text (titles, explanations, definitions, content) in Korean. Keep code, identifiers, file paths, and proper nouns unchanged.",
        _ => "",
    }
}

/// Return the last `max` bytes of `s`, snapped forward to a UTF-8 char boundary
/// so slicing never panics on multi-byte characters.
pub fn tail_chars(s: &str, max: usize) -> &str {
    if s.len() <= max {
        return s;
    }
    let mut start = s.len() - max;
    while start < s.len() && !s.is_char_boundary(start) {
        start += 1;
    }
    &s[start..]
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

#[cfg(test)]
mod tests {
    use super::migrate_legacy_dir;
    use std::fs;

    #[test]
    fn migrates_legacy_directory_without_overwriting_new_data() {
        let root = std::env::temp_dir().join(format!(
            "monet-migration-test-{}-{}",
            std::process::id(),
            std::thread::current().name().unwrap_or("unnamed")
        ));
        let legacy = root.join("blueprint");
        let current = root.join("monet");
        fs::create_dir_all(&legacy).unwrap();
        fs::create_dir_all(&current).unwrap();
        fs::write(legacy.join("legacy.json"), "legacy").unwrap();
        fs::write(legacy.join("shared.json"), "old").unwrap();
        fs::write(current.join("shared.json"), "new").unwrap();

        migrate_legacy_dir(&legacy, &current);

        assert_eq!(fs::read_to_string(current.join("legacy.json")).unwrap(), "legacy");
        assert_eq!(fs::read_to_string(current.join("shared.json")).unwrap(), "new");
        assert!(!legacy.exists());
        let _ = fs::remove_dir_all(root);
    }
}
