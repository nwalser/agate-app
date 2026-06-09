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
