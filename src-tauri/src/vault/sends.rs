//! Bitwarden Send (ephemeral shares) — list, create, and revoke across every
//! unlocked connection. All crypto + API is the official SDK (`client.sends()`),
//! so this is not hand-rolled. Create covers text Sends; file Sends (a separate
//! upload flow) are a follow-up.

use bitwarden_pm::PasswordManagerClient;
use bitwarden_send::{SendAddRequest, SendAuthType, SendId, SendTextView, SendType, SendViewType};
use chrono::{Duration, Utc};

use crate::dto::{SendCreateInput, SendCreated, SendExpiry, SendSummary, ServerConfig};
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

    // An empty/whitespace password means "no password", not a blank one.
    let auth = match input.password.as_deref().map(str::trim).filter(|p| !p.is_empty()) {
        Some(p) => SendAuthType::Password { password: p.to_string() },
        None => SendAuthType::None,
    };

    let request = SendAddRequest {
        name: name.to_string(),
        notes: None,
        view_type: SendViewType::Text(SendTextView {
            text: Some(input.text.clone()),
            hidden: input.hidden,
        }),
        max_access_count: input.max_access_count,
        disabled: false,
        hide_email: input.hide_email,
        // Deletion is the hard auto-delete; we leave expiration unset so the Send
        // stays reachable right up to deletion (one preset, one meaning).
        deletion_date: Utc::now() + expiry_duration(input.expiry),
        expiration_date: None,
        auth,
    };

    let view = client.sends().create(request).await.map_err(|e| {
        AgateError::new(ErrorKind::Network, format!("Could not create the Send: {e}"))
    })?;

    // A Send is useless without a link; treat a missing access id / key as an
    // internal error rather than handing back a broken URL.
    let access_id = view
        .access_id
        .ok_or_else(|| AgateError::internal("Send created without an access id."))?;
    let key = view
        .key
        .ok_or_else(|| AgateError::internal("Send created without a key."))?;
    let server = server_for(state, &input.account_email).await?;

    Ok(SendCreated {
        id: view.id.map(|i| i.to_string()).unwrap_or_default(),
        name: view.name,
        url: server::send_link(&server, &access_id, &key),
    })
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
}
