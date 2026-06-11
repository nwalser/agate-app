//! Tauri command wrappers, grouped by feature.
//!
//! Commands are thin: they validate input, delegate to a module (`appunlock`,
//! `connections`, `vault`, …), and return a typed `AgateResult`. No business logic
//! or SDK calls live here, and no command panics.

mod ai;
mod appunlock;
mod audit;
mod autofill;
mod cleanup;
mod connections;
mod darkweb;
mod hello;
mod mutate;
mod ocr;
mod scancache;
mod session;
mod update;
mod vault;
mod window;

pub use ai::*;
pub use appunlock::*;
pub use audit::*;
pub use autofill::*;
pub use cleanup::*;
pub use connections::*;
pub use darkweb::*;
pub use hello::*;
pub use mutate::*;
pub use ocr::*;
pub use scancache::*;
pub use session::*;
pub use update::*;
pub use vault::*;
pub use window::*;

/// Shared alias for the managed application state, used by every command.
pub type State<'a> = tauri::State<'a, crate::state::AppState>;

/// Broadcast that the session/connection state changed (lock, unlock, login,
/// logout, …) so every webview re-reads it — the tray popup stays visible
/// across these (it's pinned, never auto-hides) and must not keep rendering a
/// stale list. Best-effort: an emit failure is logged, never fails the command.
pub(crate) fn emit_session_changed(app: &tauri::AppHandle) {
    use tauri::Emitter;
    if let Err(err) = app.emit("agate://session-changed", ()) {
        log::warn!("session-changed broadcast failed: {err}");
    }
}

/// Broadcast that an unlock (app password or biometric) has STARTED — login +
/// sync are about to run. Every window mirrors the same decrypt animation while it
/// runs, so unlocking from the tray popup looks identical on the main window (and
/// vice-versa). Always paired with a trailing `session-changed` (even on failure)
/// so a window that borrowed the animation can resolve it. Best-effort.
pub(crate) fn emit_unlock_started(app: &tauri::AppHandle) {
    use tauri::Emitter;
    if let Err(err) = app.emit("agate://unlock-started", ()) {
        log::warn!("unlock-started broadcast failed: {err}");
    }
}
