//! Rich-output stubs (PoC). Phase 1 replaces these with bridge `emit` events
//! (DESIGN.md §2.9); for the PoC they print a readable form to stdout so the
//! model and user still see the effect in the tool output.

use anyhow::Result;

/// Show a change made to a file. Prints a compact unified-style fragment.
pub fn diff(path: &str, old: &str, new: &str) -> Result<()> {
    println!("--- {path}");
    println!("+++ {path}");
    for line in old.lines() {
        println!("-{line}");
    }
    for line in new.lines() {
        println!("+{line}");
    }
    Ok(())
}
