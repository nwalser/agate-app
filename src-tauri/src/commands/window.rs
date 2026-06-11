//! Window-chrome query command + launch-at-login (autostart) and
//! close-to-tray toggles.

use tauri_plugin_autostart::ManagerExt;

use super::State;
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

/// Whether closing the main window keeps Agate running in the tray.
#[tauri::command]
pub async fn get_close_to_tray(state: State<'_>) -> AgateResult<bool> {
    Ok(state.config.lock().await.close_to_tray)
}

/// Enable or disable close-to-tray (persisted; read by the main window's
/// close handler in `lib.rs`).
#[tauri::command]
pub async fn set_close_to_tray(state: State<'_>, enabled: bool) -> AgateResult<()> {
    state.update_config(|c| c.close_to_tray = enabled).await
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

/// Whether an autostart launch shows only the tray icon (the main window
/// stays hidden until summoned from the tray).
#[tauri::command]
pub async fn get_start_in_tray(state: State<'_>) -> AgateResult<bool> {
    Ok(state.config.lock().await.start_in_tray)
}

/// Enable or disable tray-only autostart. Config write first (rollback-able);
/// then, best-effort, refresh the OS autostart registration so it carries the
/// `--autostart` flag even if it was created before the flag existed — without
/// the flag a login launch is indistinguishable from a manual one and the
/// setting would silently never apply.
#[tauri::command]
pub async fn set_start_in_tray(
    app: tauri::AppHandle,
    state: State<'_>,
    enabled: bool,
) -> AgateResult<()> {
    state.update_config(|c| c.start_in_tray = enabled).await?;
    if enabled {
        let manager = app.autolaunch();
        match manager.is_enabled() {
            Ok(true) => {
                if let Err(e) = manager.enable() {
                    log::warn!("could not refresh the autostart registration: {e}");
                }
            }
            Ok(false) => {} // autostart off — nothing to refresh
            Err(e) => log::warn!("could not read the autostart state: {e}"),
        }
    }
    Ok(())
}
