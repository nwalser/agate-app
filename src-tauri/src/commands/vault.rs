//! Vault read commands (sync / list / detail / TOTP / generators / QR scan).

use super::State;
use crate::dto::{
    Folder, ItemDetail, PassphraseGenOptions, PasswordGenOptions, TotpCode, VaultItem,
};
use crate::error::{AgateError, AgateResult};
use crate::{qrscan, vault};

#[tauri::command]
pub async fn sync_vault(state: State<'_>, force: bool) -> AgateResult<()> {
    vault::sync(&state, force).await
}

#[tauri::command]
pub async fn list_items(state: State<'_>) -> AgateResult<Vec<VaultItem>> {
    vault::list_items(&state).await
}

#[tauri::command]
pub async fn list_folders(state: State<'_>) -> AgateResult<Vec<Folder>> {
    vault::list_folders(&state).await
}

#[tauri::command]
pub async fn item_detail(
    state: State<'_>,
    account_email: String,
    id: String,
) -> AgateResult<ItemDetail> {
    vault::item_detail(&state, &account_email, &id).await
}

#[tauri::command]
pub async fn item_totp(
    state: State<'_>,
    account_email: String,
    id: String,
) -> AgateResult<TotpCode> {
    vault::item_totp(&state, &account_email, &id).await
}

#[tauri::command]
pub async fn scan_totp_qr() -> AgateResult<String> {
    // Capture + decode is blocking/CPU-bound; keep it off the async runtime's
    // worker threads. The decoded otpauth URI is a secret — never logged.
    tokio::task::spawn_blocking(qrscan::scan_totp_qr)
        .await
        .map_err(|e| AgateError::internal(format!("Scan task failed: {e}")))?
}

#[tauri::command]
pub async fn generate_password(
    state: State<'_>,
    options: PasswordGenOptions,
) -> AgateResult<String> {
    vault::generate_password(&state, options).await
}

#[tauri::command]
pub async fn generate_passphrase(
    state: State<'_>,
    options: PassphraseGenOptions,
) -> AgateResult<String> {
    vault::generate_passphrase(&state, options).await
}
