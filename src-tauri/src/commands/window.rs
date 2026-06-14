//! Tray-popup window commands + launch-at-login (autostart) toggles.

use tauri_plugin_autostart::ManagerExt;

use crate::error::{AgateError, AgateResult};

/// The host OS's preferred UI locale (e.g. "de-DE"), used once on first run to
/// pick a default language. Falls back to "en" when the platform reports none.
/// Pure host query — no state, never fails.
#[tauri::command]
pub fn get_system_locale() -> String {
    sys_locale::get_locale().unwrap_or_else(|| "en".to_string())
}

/// Hide the tray quick-access popup (Escape key). Scoped to the calling
/// window and a no-op for any window other than the popup.
#[tauri::command]
pub fn hide_tray_window(window: tauri::WebviewWindow) {
    if window.label() == "tray" {
        let _ = window.hide();
    }
}

/// Re-show + refocus the tray popup after a focus-stealing flow (the Windows
/// Hello consent dialog) auto-hid it via the focus-loss handler. Scoped to the
/// calling window and a no-op for any window other than the popup.
#[tauri::command]
pub fn show_tray_window(window: tauri::WebviewWindow) {
    if window.label() == "tray" {
        let _ = window.show();
        let _ = window.set_focus();
    }
}

/// Pin (or release) the tray popup against the click-outside-to-hide behaviour.
/// The popup auto-hides on focus loss EXCEPT while a form view is open
/// (`pinned = true`) — a stray click must never discard half-typed input.
/// Driven by TrayApp; the hide itself lives in `tray::on_popup_focus_lost`.
#[tauri::command]
pub fn set_tray_pinned(app: tauri::AppHandle, pinned: bool) {
    use tauri::Manager;
    app.state::<crate::tray::TrayPopup>().set_pinned(pinned);
}

/// Whether Agate is registered to launch at login.
#[tauri::command]
pub fn get_autostart(app: tauri::AppHandle) -> AgateResult<bool> {
    app.autolaunch()
        .is_enabled()
        .map_err(|e| AgateError::internal(format!("Could not read autostart state: {e}")))
}

/// Enable or disable launch-at-login.
#[tauri::command]
pub fn set_autostart(app: tauri::AppHandle, enabled: bool) -> AgateResult<()> {
    let manager = app.autolaunch();
    let result = if enabled { manager.enable() } else { manager.disable() };
    result.map_err(|e| AgateError::internal(format!("Could not change autostart: {e}")))
}
