//! Tauri command wrappers, grouped by feature.
//!
//! Commands are thin: they validate input, delegate to a module (`appunlock`,
//! `connections`, `vault`, …), and return a typed `AgateResult`. No business logic
//! or SDK calls live here, and no command panics.

mod appunlock;
mod audit;
mod connections;
mod darkweb;
mod hello;
mod mutate;
mod scancache;
mod session;
mod update;
mod vault;
mod window;

pub use appunlock::*;
pub use audit::*;
pub use connections::*;
pub use darkweb::*;
pub use hello::*;
pub use mutate::*;
pub use scancache::*;
pub use session::*;
pub use update::*;
pub use vault::*;
pub use window::*;

/// Shared alias for the managed application state, used by every command.
pub type State<'a> = tauri::State<'a, crate::state::AppState>;
