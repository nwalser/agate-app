//! Vault read commands (sync / list / detail / TOTP / generators / strength).

use super::State;
use crate::dto::{
    Collection, Folder, ItemDetail, PassphraseGenOptions, PasswordGenOptions, TotpCode,
    UsernameGenOptions, VaultItem,
};
use crate::error::AgateResult;
use crate::{strength, vault};

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
pub async fn list_collections(state: State<'_>) -> AgateResult<Vec<Collection>> {
    vault::list_collections(&state).await
}

/// Distinct custom-field names across every unlocked vault — feeds the column
/// picker so a custom-field column is chosen, not blind-typed.
#[tauri::command]
pub async fn list_custom_field_names(state: State<'_>) -> AgateResult<Vec<String>> {
    vault::list_custom_field_names(&state).await
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

#[tauri::command]
pub async fn generate_username(
    state: State<'_>,
    options: UsernameGenOptions,
) -> AgateResult<String> {
    vault::generate_username(&state, options).await
}

/// "Password already used" count for the add/edit-form callout.
#[tauri::command]
pub async fn password_in_use(state: State<'_>, password: String) -> AgateResult<u32> {
    strength::password_in_use(&state, zeroize::Zeroizing::new(password)).await
}

/// zxcvbn strength score (0–4) for a candidate password — the add-form's
/// live strength meter. Pure compute (no vault access); `context` is the draft's
/// non-secret fields (username / website / name) fed as zxcvbn dictionary inputs.
#[tauri::command]
pub fn password_strength(password: String, context: Vec<String>) -> u8 {
    strength::password_strength(&zeroize::Zeroizing::new(password), &context)
}
