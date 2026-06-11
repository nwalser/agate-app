//! Bitwarden Send (ephemeral shares) — list, create (text + file), and revoke
//! across every unlocked connection. All crypto + API is the official SDK
//! (`client.sends()`), so this is not hand-rolled. File Sends add an upload step:
//! the server picks a backend (Direct → SDK; Azure → a pre-signed URL we PUT to),
//! and a failed upload rolls back the just-created (byte-less) Send.

use bitwarden_pm::PasswordManagerClient;
use bitwarden_send::{
    CreateFileSendResponse, FileUploadType, SendAddRequest, SendAuthType, SendFileView, SendId,
    SendTextView, SendType, SendViewType,
};
use chrono::{Duration, Utc};
use tauri_plugin_dialog::DialogExt;

use crate::dto::{
    SendCreateInput, SendCreated, SendExpiry, SendFileCreateInput, SendSummary, ServerConfig,
};
use crate::error::{AgateError, AgateResult, ErrorKind};
use crate::server;
use crate::state::AppState;

use super::reads::client_for;

/// Server label for an account (mirrors the read path's labelling).
async fn label_for(state: &AppState, email: &str) -> String {
    let cfg = state.config.lock().await;
    cfg.accounts
        .iter()
        .find(|a| a.email == email)
        .map(|a| server::server_label(&a.server))
        .unwrap_or_else(|| email.to_string())
}

fn send_type_name(t: SendType) -> &'static str {
    match t {
        SendType::Text => "text",
        SendType::File => "file",
    }
}

/// List every unlocked connection's Sends (fetched + decrypted by the SDK),
/// stamped by owning account. A connection whose fetch fails is skipped (logged).
pub async fn list_sends(state: &AppState) -> AgateResult<Vec<SendSummary>> {
    let clients: Vec<(String, PasswordManagerClient)> = {
        let session = state.session.lock().await;
        session
            .connections
            .iter()
            .map(|(email, c)| (email.clone(), PasswordManagerClient(c.client.0.clone())))
            .collect()
    };

    let mut out = Vec::new();
    for (email, client) in clients {
        let label = label_for(state, &email).await;
        match client.sends().list().await {
            Ok(views) => {
                for v in views {
                    out.push(SendSummary {
                        id: v.id.map(|i| i.to_string()).unwrap_or_default(),
                        name: v.name,
                        send_type: send_type_name(v.r#type).to_string(),
                        disabled: v.disabled,
                        has_password: v.has_password,
                        access_count: v.access_count,
                        max_access_count: v.max_access_count,
                        deletion_date: v.deletion_date.to_rfc3339(),
                        expiration_date: v.expiration_date.map(|d| d.to_rfc3339()),
                        account_email: email.clone(),
                        account_label: label.clone(),
                    });
                }
            }
            Err(e) => log::warn!("listing sends failed for a connection: {e}"),
        }
    }
    Ok(out)
}

/// Revoke (delete) one Send in the given connection.
pub async fn delete_send(state: &AppState, account_email: &str, send_id: &str) -> AgateResult<()> {
    let client = client_for(state, account_email).await?;
    let id = send_id
        .parse::<SendId>()
        .map_err(|_| AgateError::bad_request("Invalid send id."))?;
    client
        .sends()
        .delete(id)
        .await
        .map_err(|e| AgateError::new(ErrorKind::Network, format!("Could not delete the Send: {e}")))
}

/// Lifespan of a new Send, measured from now, for each preset.
fn expiry_duration(e: SendExpiry) -> Duration {
    match e {
        SendExpiry::OneHour => Duration::hours(1),
        SendExpiry::OneDay => Duration::days(1),
        SendExpiry::TwoDays => Duration::days(2),
        SendExpiry::ThreeDays => Duration::days(3),
        SendExpiry::SevenDays => Duration::days(7),
        SendExpiry::ThirtyDays => Duration::days(30),
    }
}

/// The configured server for a connection (to build the public share link).
async fn server_for(state: &AppState, email: &str) -> AgateResult<ServerConfig> {
    let cfg = state.config.lock().await;
    cfg.accounts
        .iter()
        .find(|a| a.email == email)
        .map(|a| a.server.clone())
        .ok_or_else(|| AgateError::bad_request("Unknown connection."))
}

/// Build the SDK request shared by text + file Sends. `view_type` carries the
/// type-specific payload; everything else (auth, lifespan, caps) is common.
/// Deletion is the hard auto-delete; expiration stays unset so the Send is
/// reachable right up to deletion (one preset, one meaning). An empty/whitespace
/// password means "no password", not a blank one.
fn build_request(
    name: &str,
    view_type: SendViewType,
    expiry: SendExpiry,
    max_access_count: Option<u32>,
    password: Option<&str>,
    hide_email: bool,
) -> SendAddRequest {
    let auth = match password.map(str::trim).filter(|p| !p.is_empty()) {
        Some(p) => SendAuthType::Password { password: p.to_string() },
        None => SendAuthType::None,
    };
    SendAddRequest {
        name: name.to_string(),
        notes: None,
        view_type,
        max_access_count,
        disabled: false,
        hide_email,
        deletion_date: Utc::now() + expiry_duration(expiry),
        expiration_date: None,
        auth,
    }
}

/// Public share link from a freshly-created Send view. Missing access id / key
/// is an internal error rather than a broken URL.
fn link_for(server: &ServerConfig, access_id: Option<String>, key: Option<String>) -> AgateResult<String> {
    let access_id = access_id.ok_or_else(|| AgateError::internal("Send created without an access id."))?;
    let key = key.ok_or_else(|| AgateError::internal("Send created without a key."))?;
    Ok(server::send_link(server, &access_id, &key))
}

/// Create a text Send in the given connection and return its public share link.
/// The SDK generates the Send key, encrypts the payload, and posts it; we only
/// build the access URL from the returned access id + key (key stays in the URL
/// fragment, never reaching the server on access).
pub async fn create_send(state: &AppState, input: SendCreateInput) -> AgateResult<SendCreated> {
    let name = input.name.trim();
    if name.is_empty() {
        return Err(AgateError::bad_request("A Send needs a name."));
    }
    if input.text.is_empty() {
        return Err(AgateError::bad_request("A text Send needs some content."));
    }

    let client = client_for(state, &input.account_email).await?;
    let request = build_request(
        name,
        SendViewType::Text(SendTextView { text: Some(input.text.clone()), hidden: input.hidden }),
        input.expiry,
        input.max_access_count,
        input.password.as_deref(),
        input.hide_email,
    );

    let view = client.sends().create(request).await.map_err(|e| {
        AgateError::new(ErrorKind::Network, format!("Could not create the Send: {e}"))
    })?;

    let server = server_for(state, &input.account_email).await?;
    Ok(SendCreated {
        id: view.id.map(|i| i.to_string()).unwrap_or_default(),
        name: view.name,
        url: link_for(&server, view.access_id, view.key)?,
    })
}

/// Create a file Send: pick a file (native dialog, in the backend — no path
/// crosses IPC), create the Send server-side, encrypt the bytes with the Send
/// key, then upload them to the backend the server chose. Returns `Ok(None)` if
/// the user cancels the picker. A failed upload rolls back the byte-less Send so
/// no unopenable phantom is left behind.
pub async fn create_file_send(
    state: &AppState,
    app: &tauri::AppHandle,
    input: SendFileCreateInput,
) -> AgateResult<Option<SendCreated>> {
    let name = input.name.trim();
    if name.is_empty() {
        return Err(AgateError::bad_request("A Send needs a name."));
    }
    let client = client_for(state, &input.account_email).await?;

    let Some(picked) = app.dialog().file().blocking_pick_file() else {
        return Ok(None); // user cancelled the picker
    };
    let path = picked
        .into_path()
        .map_err(|e| AgateError::internal(format!("Could not resolve the chosen file: {e}")))?;
    let file_name = path
        .file_name()
        .map(|s| s.to_string_lossy().into_owned())
        .filter(|s| !s.is_empty())
        .ok_or_else(|| AgateError::bad_request("The chosen file has no name."))?;
    let bytes = std::fs::read(&path)
        .map_err(|e| AgateError::internal(format!("Could not read the chosen file: {e}")))?;
    if bytes.is_empty() {
        return Err(AgateError::bad_request("Cannot send an empty file."));
    }

    let request = build_request(
        name,
        SendViewType::File(SendFileView {
            id: None,
            file_name,
            size: Some(bytes.len().to_string()),
            size_name: None,
        }),
        input.expiry,
        input.max_access_count,
        input.password.as_deref(),
        input.hide_email,
    );

    let resp = client.sends().create_file_send(request).await.map_err(|e| {
        AgateError::new(ErrorKind::Network, format!("Could not create the Send: {e}"))
    })?;

    let send_view = resp.send.clone();
    let send_id = send_view
        .id
        .ok_or_else(|| AgateError::internal("Send created without an id."))?;

    // Encrypt the bytes under the Send key, then upload. On any failure, delete
    // the just-created Send (best-effort, loud) so it isn't left unopenable.
    let upload = encrypt_and_upload(&client, &resp, send_id, bytes).await;
    if let Err(e) = upload {
        if let Err(del) = client.sends().delete(send_id).await {
            log::warn!("could not roll back a file Send after an upload failure: {del}");
        }
        return Err(e);
    }

    let server = server_for(state, &input.account_email).await?;
    Ok(Some(SendCreated {
        id: send_id.to_string(),
        name: send_view.name,
        url: link_for(&server, send_view.access_id, send_view.key)?,
    }))
}

/// Encrypt the file bytes with the Send key and upload them to the backend the
/// server selected. Direct uploads go through the SDK; Azure uploads PUT the
/// bytes to the server-issued pre-signed URL (the SDK only implements Direct).
async fn encrypt_and_upload(
    client: &PasswordManagerClient,
    resp: &CreateFileSendResponse,
    send_id: SendId,
    bytes: Vec<u8>,
) -> AgateResult<()> {
    // Re-encrypt the decrypted view to recover an encrypted `Send`, which carries
    // the wrapped Send key `encrypt_buffer` needs (the key is reused, not rolled).
    let enc_send = client
        .sends()
        .encrypt(resp.send.clone())
        .map_err(|e| AgateError::new(ErrorKind::Crypto, format!("Could not encrypt the file: {e}")))?;
    let encrypted = client
        .sends()
        .encrypt_buffer(enc_send, &bytes)
        .map_err(|e| AgateError::new(ErrorKind::Crypto, format!("Could not encrypt the file: {e}")))?;

    match resp.file_upload_type {
        FileUploadType::Direct => client
            .sends()
            .upload_send_file(
                send_id,
                resp.file_id.clone(),
                resp.encrypted_file_name.clone(),
                encrypted,
            )
            .await
            .map_err(|e| AgateError::new(ErrorKind::Network, format!("File upload failed: {e}"))),
        FileUploadType::Azure => azure_block_put(&resp.url, encrypted).await,
    }
}

/// Single-shot Azure block-blob upload to a server-issued SAS URL (Bitwarden
/// cloud's file backend). The URL is already signed, so only the block-blob
/// headers are needed. Sends cap well under the single-PUT limit for this API
/// version, so no block splitting is required.
async fn azure_block_put(url: &str, bytes: Vec<u8>) -> AgateResult<()> {
    reqwest::Client::new()
        .put(url)
        .header("x-ms-blob-type", "BlockBlob")
        .header("x-ms-version", "2020-04-08")
        .body(bytes)
        .send()
        .await
        .and_then(|r| r.error_for_status())
        .map_err(|e| AgateError::new(ErrorKind::Network, format!("File upload failed: {e}")))?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn expiry_presets_map_to_expected_durations() {
        assert_eq!(expiry_duration(SendExpiry::OneHour), Duration::hours(1));
        assert_eq!(expiry_duration(SendExpiry::OneDay), Duration::days(1));
        assert_eq!(expiry_duration(SendExpiry::TwoDays), Duration::days(2));
        assert_eq!(expiry_duration(SendExpiry::ThreeDays), Duration::days(3));
        assert_eq!(expiry_duration(SendExpiry::SevenDays), Duration::days(7));
        assert_eq!(expiry_duration(SendExpiry::ThirtyDays), Duration::days(30));
    }

    #[test]
    fn no_password_means_no_auth_blank_or_set() {
        // Blank / whitespace password → no auth gate.
        let r = build_request("n", SendViewType::Text(SendTextView { text: Some("t".into()), hidden: false }), SendExpiry::OneDay, None, Some("   "), false);
        assert!(matches!(r.auth, SendAuthType::None));
        let r = build_request("n", SendViewType::Text(SendTextView { text: Some("t".into()), hidden: false }), SendExpiry::OneDay, None, None, false);
        assert!(matches!(r.auth, SendAuthType::None));
        // A real password → password auth.
        let r = build_request("n", SendViewType::Text(SendTextView { text: Some("t".into()), hidden: false }), SendExpiry::OneDay, None, Some("pw"), false);
        assert!(matches!(r.auth, SendAuthType::Password { .. }));
    }
}
