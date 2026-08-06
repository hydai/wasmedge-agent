//! Guest-side shim for wasmedge-agent (PoC subset).
//!
//! PoC scope: `state` (persistent key-value + blobs) and `display` (stdout-based
//! rich output stubs). The host bridge (`spawn`, `msg`, `goal`, ...) lands in
//! Phase 1 per DESIGN.md §2.6.

pub mod display;
pub mod state;

pub use anyhow::{anyhow, bail, Context, Error, Result};
