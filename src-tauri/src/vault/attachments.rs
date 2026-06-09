//! Attachment download. Fetches the encrypted blob from its (pre-signed) URL and
//! decrypts it with the item's key via the SDK. The command writes the decrypted
//! bytes to Downloads — user-initiated, same posture as export (the bytes are a
//! secret; nothing is logged). Upload is intentionally out of scope for now.

use bitwarden_pm::PasswordManagerClient;
use bitwarden_vault::CipherView;

use crate::error::{AgateError, AgateResult, ErrorKind};
use crate::state::AppState;

/// Download + decrypt one attachment. Returns `(file_name, decrypted_bytes)`.
pub async fn download_attachment(
    state: &AppState,
    account_email: &str,
    item_id: &str,
    attachment_id: &str,
) -> AgateResult<(String, Vec<u8>)> {
    // The client + the encrypted cipher (needed by decrypt_buffer) for this item.
    let (client, cipher) = {
        let session = state.session.lock().await;
        let conn = session
            .connections
            .get(account_email)
            .ok_or_else(AgateError::not_authenticated)?;
        let client = PasswordManagerClient(conn.client.0.clone());
        let cipher = conn
            .ciphers
            .iter()
            .find(|c| c.id.map(|i| i.to_string()).as_deref() == Some(item_id))
            .cloned()
            .ok_or_else(|| AgateError::bad_request("No such item."))?;
        (client, cipher)
    };

    // Decrypt to a view to read the attachment's URL + file name.
    let view: CipherView = client
        .0
        .internal
        .get_key_store()
        .decrypt(&cipher)
        .map_err(|e| AgateError::new(ErrorKind::Crypto, format!("decrypt failed: {e}")))?;
    let attachment = view
        .attachments
        .unwrap_or_default()
        .into_iter()
        .find(|a| a.id.as_deref() == Some(attachment_id))
        .ok_or_else(|| AgateError::bad_request("No such attachment."))?;
    let url = attachment
        .url
        .clone()
        .ok_or_else(|| AgateError::bad_request("Attachment has no download URL."))?;
    let file_name = attachment.file_name.clone().unwrap_or_else(|| "attachment".to_string());

    // Fetch the encrypted blob from its pre-signed URL.
    let bytes = reqwest::Client::new()
        .get(&url)
        .send()
        .await
        .and_then(|r| r.error_for_status())
        .map_err(|e| AgateError::new(ErrorKind::Network, format!("Attachment download failed: {e}")))?
        .bytes()
        .await
        .map_err(|e| AgateError::new(ErrorKind::Network, format!("Attachment read failed: {e}")))?;

    // Decrypt with the item's attachment key.
    let decrypted = client
        .vault()
        .attachments()
        .decrypt_buffer(cipher, attachment, &bytes)
        .map_err(|e| AgateError::new(ErrorKind::Crypto, format!("Attachment decrypt failed: {e}")))?;

    Ok((file_name, decrypted))
}
