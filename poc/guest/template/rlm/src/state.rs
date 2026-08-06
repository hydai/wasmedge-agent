//! Persistent key-value state backed by `/agent/state/state.json` plus a blob
//! store under `/agent/state/blobs/`. Writes are atomic (tmp + rename). The
//! state directory can be overridden with `RLM_STATE_DIR` so unit tests can run
//! on a native target.

use std::fs;
use std::path::{Path, PathBuf};

use anyhow::{bail, Context, Result};
use serde::de::DeserializeOwned;
use serde::Serialize;
use serde_json::{Map, Value};

/// Soft limit for state.json (DESIGN.md §2.8). Larger values must use blobs.
const STATE_JSON_SOFT_LIMIT: usize = 8 * 1024 * 1024;

fn state_dir() -> PathBuf {
    match std::env::var("RLM_STATE_DIR") {
        Ok(dir) if !dir.is_empty() => PathBuf::from(dir),
        _ => PathBuf::from("/agent/state"),
    }
}

fn state_path() -> PathBuf {
    state_dir().join("state.json")
}

fn blobs_dir() -> PathBuf {
    state_dir().join("blobs")
}

fn load_map() -> Result<Map<String, Value>> {
    let path = state_path();
    let bytes = match fs::read(&path) {
        Ok(bytes) => bytes,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(Map::new()),
        Err(e) => return Err(e).with_context(|| format!("reading {}", path.display())),
    };
    let value: Value =
        serde_json::from_slice(&bytes).with_context(|| format!("parsing {}", path.display()))?;
    match value {
        Value::Object(map) => Ok(map),
        _ => bail!("{} is not a JSON object", path.display()),
    }
}

fn atomic_write(path: &Path, bytes: &[u8]) -> Result<()> {
    let dir = path
        .parent()
        .with_context(|| format!("{} has no parent directory", path.display()))?;
    fs::create_dir_all(dir).with_context(|| format!("creating {}", dir.display()))?;
    let tmp = path.with_extension("tmp");
    fs::write(&tmp, bytes).with_context(|| format!("writing {}", tmp.display()))?;
    fs::rename(&tmp, path).with_context(|| format!("renaming into {}", path.display()))?;
    Ok(())
}

fn save_map(map: &Map<String, Value>) -> Result<()> {
    let bytes = serde_json::to_vec_pretty(&Value::Object(map.clone()))?;
    if bytes.len() > STATE_JSON_SOFT_LIMIT {
        bail!(
            "state.json would be {} bytes (limit {}); store large values with rlm::state::put_blob",
            bytes.len(),
            STATE_JSON_SOFT_LIMIT
        );
    }
    atomic_write(&state_path(), &bytes)
}

/// Read a value by key. `Ok(None)` when the key does not exist.
pub fn get<T: DeserializeOwned>(key: &str) -> Result<Option<T>> {
    let map = load_map()?;
    match map.get(key) {
        None => Ok(None),
        Some(value) => {
            let typed = serde_json::from_value(value.clone())
                .with_context(|| format!("state key {key:?} does not match the requested type"))?;
            Ok(Some(typed))
        }
    }
}

/// Store a serializable value under a key.
pub fn set<T: Serialize>(key: &str, value: &T) -> Result<()> {
    let mut map = load_map()?;
    map.insert(key.to_string(), serde_json::to_value(value)?);
    save_map(&map)
}

/// Remove a key. Returns whether it existed.
pub fn remove(key: &str) -> Result<bool> {
    let mut map = load_map()?;
    let existed = map.remove(key).is_some();
    if existed {
        save_map(&map)?;
    }
    Ok(existed)
}

/// All keys, sorted.
pub fn keys() -> Result<Vec<String>> {
    let map = load_map()?;
    let mut keys: Vec<String> = map.keys().cloned().collect();
    keys.sort();
    Ok(keys)
}

fn blob_path(name: &str) -> Result<PathBuf> {
    if name.is_empty() || name.contains('/') || name.contains("..") {
        bail!("invalid blob name {name:?} (single path segment expected)");
    }
    Ok(blobs_dir().join(name))
}

/// Store raw bytes under `blobs/<name>`.
pub fn put_blob(name: &str, bytes: &[u8]) -> Result<()> {
    atomic_write(&blob_path(name)?, bytes)
}

/// Read raw bytes from `blobs/<name>`. `Ok(None)` when missing.
pub fn get_blob(name: &str) -> Result<Option<Vec<u8>>> {
    let path = blob_path(name)?;
    match fs::read(&path) {
        Ok(bytes) => Ok(Some(bytes)),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(None),
        Err(e) => Err(e).with_context(|| format!("reading {}", path.display())),
    }
}

/// All blob names, sorted.
pub fn list_blobs() -> Result<Vec<String>> {
    let dir = blobs_dir();
    let entries = match fs::read_dir(&dir) {
        Ok(entries) => entries,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(Vec::new()),
        Err(e) => return Err(e).with_context(|| format!("reading {}", dir.display())),
    };
    let mut names = Vec::new();
    for entry in entries {
        let entry = entry?;
        if entry.file_type()?.is_file() {
            if let Some(name) = entry.file_name().to_str() {
                if !name.ends_with(".tmp") {
                    names.push(name.to_string());
                }
            }
        }
    }
    names.sort();
    Ok(names)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::Mutex;

    // RLM_STATE_DIR is process-global; serialize tests that set it.
    static ENV_LOCK: Mutex<()> = Mutex::new(());

    fn with_temp_state<R>(name: &str, f: impl FnOnce() -> R) -> R {
        let _guard = ENV_LOCK.lock().unwrap();
        let dir = std::env::temp_dir().join(format!("rlm-state-test-{}-{name}", std::process::id()));
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(&dir).unwrap();
        std::env::set_var("RLM_STATE_DIR", &dir);
        let result = f();
        std::env::remove_var("RLM_STATE_DIR");
        let _ = fs::remove_dir_all(&dir);
        result
    }

    #[test]
    fn round_trip_and_keys() {
        with_temp_state("round_trip", || {
            assert_eq!(get::<u64>("missing").unwrap(), None);
            set("count", &42u64).unwrap();
            set("name", &"agent").unwrap();
            assert_eq!(get::<u64>("count").unwrap(), Some(42));
            assert_eq!(keys().unwrap(), vec!["count".to_string(), "name".to_string()]);
            assert!(remove("count").unwrap());
            assert_eq!(get::<u64>("count").unwrap(), None);
        });
    }

    #[test]
    fn blobs() {
        with_temp_state("blobs", || {
            put_blob("data.bin", b"hello").unwrap();
            assert_eq!(get_blob("data.bin").unwrap(), Some(b"hello".to_vec()));
            assert_eq!(list_blobs().unwrap(), vec!["data.bin".to_string()]);
            assert!(put_blob("../escape", b"x").is_err());
        });
    }
}
