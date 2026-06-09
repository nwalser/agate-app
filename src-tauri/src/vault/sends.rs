//! Bitwarden Send (ephemeral shares) — list + revoke across every unlocked
//! connection. All crypto + API is the official SDK (`client.sends()`), so this
//! is not hand-rolled. Create/edit is a follow-up (needs the SendAddRequest +
//! public-URL construction); listing and deleting cover "see and revoke my shares".

use bitwarden_pm::PasswordManagerClient;
use bitwarden_send::{SendId, SendType};

use crate::dto::SendSummary;
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
