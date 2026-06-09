//! App-unlock commands (configure / change / unlock-all / per-connection 2FA).

use zeroize::Zeroizing;

use super::State;
use crate::appunlock;
use crate::dto::{TwoFactorInput, UnlockOutcome};
use crate::error::AgateResult;

#[tauri::command]
pub async fn configure_app_unlock(state: State<'_>, app_password: String) -> AgateResult<()> {
    appunlock::configure(&state, Zeroizing::new(app_password)).await
}

#[tauri::command]
pub async fn change_app_unlock(state: State<'_>, new_password: String) -> AgateResult<()> {
    appunlock::change(&state, Zeroizing::new(new_password)).await
}

#[tauri::command]
pub async fn unlock_all(state: State<'_>, app_password: String) -> AgateResult<Vec<UnlockOutcome>> {
    appunlock::unlock_all(&state, Zeroizing::new(app_password)).await
}

#[tauri::command]
pub async fn unlock_connection_2fa(
    state: State<'_>,
    email: String,
    two_factor: TwoFactorInput,
) -> AgateResult<()> {
    appunlock::unlock_connection_2fa(&state, email, two_factor).await
}

#[tauri::command]
pub async fn send_connection_email_code(state: State<'_>, email: String) -> AgateResult<()> {
    appunlock::send_connection_email_code(&state, email).await
}
