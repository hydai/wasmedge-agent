//! Common imports and built-in helpers for cells.

use std::fs;
use std::path::{Path, PathBuf};

pub use anyhow::{anyhow, bail, Context, Result};
pub use regex::Regex;
pub use rlm;
pub use serde::{Deserialize, Serialize};
pub use serde_json::{self, json, Value};
pub use std::collections::{BTreeMap, BTreeSet};

pub use crate::helpers;
pub use crate::skills;

/// Read a whole file as UTF-8 (lossy for invalid sequences).
pub fn read_to_string(path: impl AsRef<Path>) -> Result<String> {
    let path = path.as_ref();
    let bytes = fs::read(path).with_context(|| format!("reading {}", path.display()))?;
    Ok(String::from_utf8_lossy(&bytes).into_owned())
}

/// Read a file as lines.
pub fn read_lines(path: impl AsRef<Path>) -> Result<Vec<String>> {
    Ok(read_to_string(path)?.lines().map(str::to_string).collect())
}

/// Write a whole file, creating parent directories.
pub fn write_file(path: impl AsRef<Path>, contents: impl AsRef<[u8]>) -> Result<()> {
    let path = path.as_ref();
    if let Some(dir) = path.parent() {
        fs::create_dir_all(dir).with_context(|| format!("creating {}", dir.display()))?;
    }
    fs::write(path, contents).with_context(|| format!("writing {}", path.display()))
}

const SKIP_DIRS: [&str; 4] = [".git", "target", "node_modules", ".venv"];

/// All files under a root, skipping `.git`, `target`, `node_modules`, `.venv`.
pub fn walk(root: impl AsRef<Path>) -> Result<Vec<PathBuf>> {
    let mut files = Vec::new();
    let iter = walkdir::WalkDir::new(root.as_ref()).into_iter();
    for entry in iter.filter_entry(|e| {
        e.file_name()
            .to_str()
            .map(|name| !SKIP_DIRS.contains(&name))
            .unwrap_or(true)
    }) {
        let entry = entry?;
        if entry.file_type().is_file() {
            files.push(entry.into_path());
        }
    }
    files.sort();
    Ok(files)
}

/// One regex match inside a file.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct GrepHit {
    pub path: PathBuf,
    pub line_no: usize,
    pub line: String,
}

/// Regex-search all files under a root. Binary-ish lines are skipped silently.
pub fn grep(pattern: &str, root: impl AsRef<Path>) -> Result<Vec<GrepHit>> {
    let re = Regex::new(pattern).with_context(|| format!("invalid regex {pattern:?}"))?;
    let mut hits = Vec::new();
    for path in walk(root)? {
        let Ok(text) = fs::read_to_string(&path) else {
            continue;
        };
        for (idx, line) in text.lines().enumerate() {
            if re.is_match(line) {
                hits.push(GrepHit {
                    path: path.clone(),
                    line_no: idx + 1,
                    line: line.to_string(),
                });
            }
        }
    }
    Ok(hits)
}

/// Replace exactly one occurrence of `old` with `new` in a file and show the
/// change to the user. Errors when `old` matches zero or multiple times.
pub fn edit_exact(path: impl AsRef<Path>, old: &str, new: &str) -> Result<()> {
    let path = path.as_ref();
    let text = read_to_string(path)?;
    let matches = text.matches(old).count();
    if matches == 0 {
        bail!("edit_exact: old text not found in {}", path.display());
    }
    if matches > 1 {
        bail!(
            "edit_exact: old text matches {} times in {} (must be unique)",
            matches,
            path.display()
        );
    }
    let updated = text.replacen(old, new, 1);
    fs::write(path, &updated).with_context(|| format!("writing {}", path.display()))?;
    rlm::display::diff(&path.display().to_string(), old, new)
}
