//! Persistent agent library. Cells `use agent_lib::prelude::*;`.
//!
//! - `prelude`: re-exports + built-in helpers (file IO, grep, walk, edit_exact).
//! - `helpers`: model-added modules arrive here via the `lib` tool parameter.
//! - `skills`: skills-as-crates re-export mount point (Phase 1).

pub mod helpers;
pub mod prelude;
pub mod skills;
