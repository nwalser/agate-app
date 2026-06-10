//! Window-chrome query command + launch-at-login (autostart) toggle.

use tauri_plugin_autostart::ManagerExt;

use crate::dto;
use crate::error::{AgateError, AgateResult};
use crate::window;

/// The titlebar's window-control layout for this platform (Linux reads the
/// desktop's `button-layout`; others use a fixed default). Pure host query — no
/// state, never fails.
#[tauri::command]
pub fn window_controls_layout() -> dto::WindowControlsLayout {
    window::controls_layout()
}

/// Reveal + focus the main window (the tray popup's "Open Agate" button). The
/// popup itself hides automatically when the main window takes focus.
#[tauri::command]
pub fn show_main_window(app: tauri::AppHandle) {
    crate::tray::reveal_main(&app);
}

/// Hide the tray quick-access popup (Escape key). Scoped to the calling
/// window and a no-op for any window other than the popup.
#[tauri::command]
pub fn hide_tray_window(window: tauri::WebviewWindow) {
    if window.label() == "tray" {
        let _ = window.hide();
    }
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
