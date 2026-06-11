//! App-unlock commands (configure / change / unlock-all / per-connection 2FA).

use zeroize::Zeroizing;

use super::State;
use crate::appunlock;
use crate::dto::{TwoFactorInput, UnlockOutcome};
use crate::error::AgateResult;

#[tauri::command]
pub async fn configure_app_unlock(
    app: tauri::AppHandle,
    state: State<'_>,
    app_password: String,
) -> AgateResult<()> {
    let res = appunlock::configure(&state, Zeroizing::new(app_password)).await;
    if res.is_ok() {
        super::emit_session_changed(&app);
    }
    res
}

#[tauri::command]
pub async fn change_app_unlock(state: State<'_>, new_password: String) -> AgateResult<()> {
    appunlock::change(&state, Zeroizing::new(new_password)).await
}

#[tauri::command]
pub async fn unlock_all(
    app: tauri::AppHandle,
    state: State<'_>,
    app_password: String,
) -> AgateResult<Vec<UnlockOutcome>> {
    // Mirror the decrypt animation on every window for the whole login + sync, then
    // resolve it — `session-changed` fires even on failure so a window that borrowed
    // the animation drops it rather than hanging on it.
    super::emit_unlock_started(&app);
    let res = appunlock::unlock_all(&state, Zeroizing::new(app_password)).await;
    super::emit_session_changed(&app);
    res
}

#[tauri::command]
pub async fn verify_app_password(state: State<'_>, password: String) -> AgateResult<bool> {
    appunlock::verify_app_password(&state, Zeroizing::new(password)).await
}

#[tauri::command]
pub async fn unlock_connection_2fa(
    app: tauri::AppHandle,
    state: State<'_>,
    email: String,
    two_factor: TwoFactorInput,
) -> AgateResult<()> {
    let res = appunlock::unlock_connection_2fa(&state, email, two_factor).await;
    if res.is_ok() {
        super::emit_session_changed(&app);
    }
    res
}

#[tauri::command]
pub async fn send_connection_email_code(state: State<'_>, email: String) -> AgateResult<()> {
    appunlock::send_connection_email_code(&state, email).await
}
