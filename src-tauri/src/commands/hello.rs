//! Windows Hello unlock commands (real impl on Windows; stubs elsewhere).

use super::State;
use crate::dto::UnlockOutcome;
use crate::error::AgateResult;
#[cfg(not(target_os = "windows"))]
use crate::error::{AgateError, ErrorKind};
#[cfg(target_os = "windows")]
use crate::hello;
use crate::secrets;

#[tauri::command]
pub async fn hello_available() -> bool {
    #[cfg(target_os = "windows")]
    {
        hello::available().await
    }
    #[cfg(not(target_os = "windows"))]
    {
        false
    }
}

#[tauri::command]
pub async fn hello_enable(state: State<'_>) -> AgateResult<()> {
    #[cfg(target_os = "windows")]
    {
        hello::enable(&state).await
    }
    #[cfg(not(target_os = "windows"))]
    {
        let _ = &state;
        Err(AgateError::new(ErrorKind::Internal, "Windows Hello is only available on Windows."))
    }
}

#[tauri::command]
pub async fn hello_disable(state: State<'_>) -> AgateResult<()> {
    // Cross-platform: forget the stored VMK + clear the flag (no Hello API needed).
    secrets::delete_hello_blob()?;
    state.config.lock().await.hello_configured = false;
    state.save_config().await
}

#[tauri::command]
pub async fn hello_unlock(
    state: State<'_>,
    window: tauri::WebviewWindow,
) -> AgateResult<Vec<UnlockOutcome>> {
    #[cfg(target_os = "windows")]
    {
        hello::unlock_all(&state, &window).await
    }
    #[cfg(not(target_os = "windows"))]
    {
        let _ = (&state, &window);
        Err(AgateError::new(ErrorKind::Internal, "Windows Hello is only available on Windows."))
    }
}
