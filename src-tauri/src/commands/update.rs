//! Auto-updater commands (check + download/install/relaunch).

use tauri_plugin_updater::UpdaterExt;

use super::State;
use crate::error::{AgateError, AgateResult, ErrorKind};

/// Returns the available update version, or null if up to date.
#[tauri::command]
pub async fn check_update(app: tauri::AppHandle) -> AgateResult<Option<String>> {
    let updater = app.updater().map_err(|e| AgateError::internal(format!("updater: {e}")))?;
    match updater.check().await {
        Ok(Some(update)) => Ok(Some(update.version)),
        Ok(None) => Ok(None),
        Err(e) => Err(AgateError::new(ErrorKind::Network, format!("Update check failed: {e}"))),
    }
}

/// Download + install the available update, locking the vault first (Windows
/// force-exits to run the installer), then relaunch.
#[tauri::command]
pub async fn run_update(app: tauri::AppHandle, state: State<'_>) -> AgateResult<()> {
    // Lock the vault and drop all secret material (incl. the VMK) before the
    // installer runs.
    state.session.lock().await.clear_secrets();
    let updater = app.updater().map_err(|e| AgateError::internal(format!("updater: {e}")))?;
    let Some(update) = updater
        .check()
        .await
        .map_err(|e| AgateError::new(ErrorKind::Network, format!("Update check failed: {e}")))?
    else {
        return Ok(());
    };
    update
        .download_and_install(|_chunk, _total| {}, || {})
        .await
        .map_err(|e| AgateError::new(ErrorKind::Network, format!("Update install failed: {e}")))?;
    app.restart();
}
