//! Vault read commands (sync / list / detail / TOTP / generators / QR scan).

use tauri::Manager;
use tauri_plugin_dialog::DialogExt;

use super::State;
use crate::dto::{
    Collection, ExportFormat, Folder, ItemDetail, PassphraseGenOptions, PasswordGenOptions,
    SendCreateInput, SendCreated, SendFileCreateInput, SendSummary, TotpCode, UsernameGenOptions,
    VaultItem,
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
pub async fn list_sends(state: State<'_>) -> AgateResult<Vec<SendSummary>> {
    vault::list_sends(&state).await
}

#[tauri::command]
pub async fn create_send(state: State<'_>, input: SendCreateInput) -> AgateResult<SendCreated> {
    vault::create_send(&state, input).await
}

/// Create a file Send: opens a native file picker, then encrypts + uploads the
/// chosen file. Returns null if the user cancels the picker.
#[tauri::command]
pub async fn create_file_send(
    app: tauri::AppHandle,
    state: State<'_>,
    input: SendFileCreateInput,
) -> AgateResult<Option<SendCreated>> {
    vault::create_file_send(&state, &app, input).await
}

#[tauri::command]
pub async fn delete_send(state: State<'_>, account_email: String, send_id: String) -> AgateResult<()> {
    vault::delete_send(&state, &account_email, &send_id).await
}

/// Download + decrypt one item attachment to the Downloads folder; returns the path.
#[tauri::command]
pub async fn download_attachment(
    app: tauri::AppHandle,
    state: State<'_>,
    account_email: String,
    item_id: String,
    attachment_id: String,
) -> AgateResult<String> {
    let (file_name, bytes) =
        vault::download_attachment(&state, &account_email, &item_id, &attachment_id).await?;
    let dir = app
        .path()
        .download_dir()
        .map_err(|e| AgateError::internal(format!("Could not find a Downloads folder: {e}")))?;
    // Strip any directory components from the server-provided name (no traversal).
    let safe = std::path::Path::new(&file_name)
        .file_name()
        .map(|s| s.to_string_lossy().into_owned())
        .filter(|s| !s.is_empty())
        .unwrap_or_else(|| "attachment".to_string());
    let path = dir.join(safe);
    std::fs::write(&path, bytes)
        .map_err(|e| AgateError::internal(format!("Could not write the attachment: {e}")))?;
    Ok(path.to_string_lossy().into_owned())
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

#[tauri::command]
pub async fn generate_username(
    state: State<'_>,
    options: UsernameGenOptions,
) -> AgateResult<String> {
    vault::generate_username(&state, options).await
}

/// Export every unlocked connection's items to a JSON/CSV file in the user's
/// Downloads directory; returns the written path. SECURITY: writes cleartext
/// secrets by deliberate user action (the UI warns first); the path is returned
/// so the user knows where the file is.
#[tauri::command]
pub async fn export_vault(
    app: tauri::AppHandle,
    state: State<'_>,
    format: ExportFormat,
) -> AgateResult<String> {
    let (content, ext) = vault::export_string(&state, format).await?;
    let dir = app
        .path()
        .download_dir()
        .map_err(|e| AgateError::internal(format!("Could not find a Downloads folder: {e}")))?;
    let secs = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0);
    let path = dir.join(format!("agate-vault-export-{secs}.{ext}"));
    std::fs::write(&path, content)
        .map_err(|e| AgateError::internal(format!("Could not write the export file: {e}")))?;
    Ok(path.to_string_lossy().into_owned())
}

/// Import items from a user-picked Bitwarden-compatible CSV into one connection.
/// Returns how many items were created. `account_email` targets a specific vault;
/// when absent/unknown it falls back to the first unlocked connection. Returns 0
/// if the user cancels the file picker.
#[tauri::command]
pub async fn import_vault(
    app: tauri::AppHandle,
    state: State<'_>,
    account_email: Option<String>,
) -> AgateResult<usize> {
    // Resolve the target connection before touching the filesystem.
    let target = {
        let session = state.session.lock().await;
        account_email
            .filter(|e| session.connections.contains_key(e))
            .or_else(|| session.connections.keys().next().cloned())
            .ok_or_else(AgateError::not_authenticated)?
    };

    let Some(file) = app.dialog().file().add_filter("CSV", &["csv"]).blocking_pick_file() else {
        return Ok(0); // user cancelled
    };
    let path = file
        .into_path()
        .map_err(|e| AgateError::internal(format!("Could not resolve the chosen file: {e}")))?;
    let content = std::fs::read_to_string(&path)
        .map_err(|e| AgateError::internal(format!("Could not read the import file: {e}")))?;

    let inputs = vault::parse_csv(&content)?;
    let mut count = 0usize;
    for input in inputs {
        match crate::mutate::save_item(&state, &target, input).await {
            Ok(()) => count += 1,
            // Skip a bad row rather than aborting the whole import; surface the
            // count to the user so a partial import is visible.
            Err(e) => log::warn!("import: skipping an item: {}", e.message),
        }
    }
    Ok(count)
}
