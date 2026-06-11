//! Biometric unlock commands. Windows Hello on Windows (`hello.rs`); Touch ID /
//! polkit on macOS/Linux (`hello_unix.rs` — authored on Windows, UNVERIFIED on
//! those targets, see that file); a stub on any other platform.

use super::State;
use crate::dto::UnlockOutcome;
use crate::error::AgateResult;
#[cfg(not(any(target_os = "windows", target_os = "macos", target_os = "linux")))]
use crate::error::{AgateError, ErrorKind};
#[cfg(target_os = "windows")]
use crate::hello;
#[cfg(any(target_os = "macos", target_os = "linux"))]
use crate::hello_unix;
use crate::secrets;

#[tauri::command]
pub async fn hello_available() -> bool {
    #[cfg(target_os = "windows")]
    {
        hello::available().await
    }
    #[cfg(any(target_os = "macos", target_os = "linux"))]
    {
        hello_unix::available().await
    }
    #[cfg(not(any(target_os = "windows", target_os = "macos", target_os = "linux")))]
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
    #[cfg(any(target_os = "macos", target_os = "linux"))]
    {
        hello_unix::enable(&state).await
    }
    #[cfg(not(any(target_os = "windows", target_os = "macos", target_os = "linux")))]
    {
        let _ = &state;
        Err(AgateError::new(ErrorKind::Internal, "Biometric unlock isn't available on this platform."))
    }
}

#[tauri::command]
pub async fn hello_disable(state: State<'_>) -> AgateResult<()> {
    // Cross-platform: forget the stored VMK + clear the flag (no biometric API needed).
    secrets::delete_hello_blob()?;
    state.update_config(|cfg| cfg.hello_configured = false).await
}

#[tauri::command]
pub async fn hello_unlock(
    app: tauri::AppHandle,
    state: State<'_>,
    window: tauri::WebviewWindow,
) -> AgateResult<Vec<UnlockOutcome>> {
    // Mirror the decrypt animation on every window for the whole consent + login +
    // sync, then resolve it (see `unlock_all`).
    super::emit_unlock_started(&app);
    let res = {
        #[cfg(target_os = "windows")]
        {
            hello::unlock_all(&state, &window).await
        }
        #[cfg(any(target_os = "macos", target_os = "linux"))]
        {
            // macOS/Linux consent gates don't need the window handle.
            let _ = &window;
            hello_unix::unlock_all(&state).await
        }
        #[cfg(not(any(target_os = "windows", target_os = "macos", target_os = "linux")))]
        {
            let _ = (&state, &window);
            Err(AgateError::new(
                ErrorKind::Internal,
                "Biometric unlock isn't available on this platform.",
            ))
        }
    };
    super::emit_session_changed(&app);
    res
}
