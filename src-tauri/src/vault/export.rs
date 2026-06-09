//! Vault export. Decrypts every unlocked connection's (non-trashed) items and
//! serializes them to JSON (Agate's `ItemDetail` shape) or Bitwarden-compatible
//! CSV.
//!
//! SECURITY: this produces CLEARTEXT secrets. It is the one sanctioned exception
//! to "never put secrets in plaintext files" (CLAUDE.md) — strictly user-initiated
//! and warned about in the UI. The serializer here only builds the string; the
//! command writes it where the user is told (Downloads) and surfaces the path so
//! they can move or delete it. Nothing here is logged.

use bitwarden_pm::PasswordManagerClient;
use bitwarden_vault::{Cipher, CipherView};

use crate::dto::{ExportFormat, ItemDetail, ItemType};
use crate::error::{AgateError, AgateResult};
use crate::state::AppState;

use super::transform::view_to_detail;

/// Decrypt every unlocked connection's live items into `ItemDetail`s.
async fn collect_details(state: &AppState) -> AgateResult<Vec<ItemDetail>> {
    let snapshot: Vec<(String, PasswordManagerClient, Vec<Cipher>)> = {
        let session = state.session.lock().await;
        if session.connections.is_empty() {
            return Err(AgateError::not_authenticated());
        }
        session
            .connections
            .iter()
            .map(|(email, c)| {
                (email.clone(), PasswordManagerClient(c.client.0.clone()), c.ciphers.clone())
            })
            .collect()
    };

    let mut out = Vec::new();
    for (email, client, ciphers) in snapshot {
        let key_store = client.0.internal.get_key_store();
        for cipher in &ciphers {
            let decrypted: Result<CipherView, _> = key_store.decrypt(cipher);
            match decrypted {
                Ok(view) => {
                    // Trash is excluded from exports.
                    if view.deleted_date.is_some() {
                        continue;
                    }
                    out.push(view_to_detail(&view, &email, &email));
                }
                Err(e) => log::warn!("export: skipping item that failed to decrypt: {e}"),
            }
        }
    }
    Ok(out)
}

/// Build the export payload + its file extension for the chosen format.
pub async fn export_string(
    state: &AppState,
    format: ExportFormat,
) -> AgateResult<(String, &'static str)> {
    let details = collect_details(state).await?;
    match format {
        ExportFormat::Json => {
            let s = serde_json::to_string_pretty(&details)
                .map_err(|e| AgateError::internal(format!("export serialize failed: {e}")))?;
            Ok((s, "json"))
        }
        ExportFormat::Csv => Ok((to_csv(&details), "csv")),
    }
}

fn type_name(t: ItemType) -> &'static str {
    match t {
        ItemType::Login => "login",
        ItemType::SecureNote => "note",
        ItemType::Card => "card",
        ItemType::Identity => "identity",
        ItemType::SshKey => "sshkey",
        ItemType::Unknown => "unknown",
    }
}

/// Quote a CSV field when it contains a delimiter, quote, or newline (RFC 4180).
fn csv_escape(s: &str) -> String {
    if s.contains(|c| matches!(c, ',' | '"' | '\n' | '\r')) {
        format!("\"{}\"", s.replace('"', "\"\""))
    } else {
        s.to_string()
    }
}

/// Bitwarden-compatible CSV (login-centric columns). Non-login types still export
/// their name + notes so nothing is silently dropped.
fn to_csv(details: &[ItemDetail]) -> String {
    let mut out = String::from(
        "folder,favorite,type,name,notes,login_uri,login_username,login_password,login_totp\n",
    );
    for d in details {
        let (uri, user, pass, totp) = match &d.login {
            Some(l) => (
                l.uris.first().and_then(|u| u.uri.clone()).unwrap_or_default(),
                l.username.clone().unwrap_or_default(),
                l.password.clone().unwrap_or_default(),
                l.totp.clone().unwrap_or_default(),
            ),
            None => (String::new(), String::new(), String::new(), String::new()),
        };
        let cols = [
            d.folder_id.clone().unwrap_or_default(),
            if d.favorite { "1".to_string() } else { String::new() },
            type_name(d.item_type).to_string(),
            d.name.clone(),
            d.notes.clone().unwrap_or_default(),
            uri,
            user,
            pass,
            totp,
        ];
        let line: Vec<String> = cols.iter().map(|c| csv_escape(c)).collect();
        out.push_str(&line.join(","));
        out.push('\n');
    }
    out
}
