//! Data-transfer objects shared with the frontend.
//!
//! Rust is the single source of truth for the IPC shapes: `typegen.rs` exports
//! every DTO here (plus `error::AgateError`) to `src/lib/generated/dto.ts`,
//! which `src/lib/types.ts` re-exports. All closed sets are enums (serialized
//! as lowercase strings) — never bare strings — per CLAUDE.md.
//!
//! Split into cohesive submodules and re-exported flat, so every existing
//! `crate::dto::X` / `use crate::dto::{...}` across the crate keeps compiling.

mod auth;
mod autofill;
mod generator;
mod vault;

pub use auth::*;
pub use autofill::*;
pub use generator::*;
pub use vault::*;

#[cfg(test)]
mod typegen;
