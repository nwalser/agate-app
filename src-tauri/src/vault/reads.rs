//! The provider-agnostic read path: sync, the unified item list, item detail,
//! TOTP, and folders.
//!
//! In the unified model every read aggregates across every unlocked connection
//! and stamps each row/detail with its owning connection (`account_email` + a
//! label), and every per-item operation routes by `(account_email, id)` to the
//! right `LiveConnection`. Provider-specific decrypt/transform code lives in
//! `providers::*`; this file only iterates, routes, and aggregates.

use std::collections::HashMap;

use bitwarden_pm::PasswordManagerClient;
use bitwarden_vault::CipherView;

use crate::dto::{Collection, Folder, ItemDetail, TotpCode, VaultItem};
use crate::error::{AgateError, AgateResult};
use crate::providers::LiveConnection;
use crate::state::AppState;

/// A fresh handle to one BITWARDEN connection's unlocked client, or a typed
/// error. Bitwarden-only call sites (the SDK write path, generators).
pub(crate) async fn client_for(state: &AppState, account_email: &str) -> AgateResult<PasswordManagerClient> {
    state
        .session
        .lock()
        .await
        .client_for(account_email)
        .ok_or_else(AgateError::not_authenticated)
}

/// Any unlocked Bitwarden client (for account-agnostic ops like generation), or
/// a throwaway.
pub(super) async fn any_or_throwaway(state: &AppState) -> PasswordManagerClient {
    let session = state.session.lock().await;
    session
        .connections
        .values()
        .find_map(LiveConnection::bitwarden).map_or_else(|| PasswordManagerClient::new(None), super::super::providers::bitwarden::BitwardenConnection::client_handle)
}

/// Snapshot of connection id → display label for the configured connections.
async fn label_map(state: &AppState) -> HashMap<String, String> {
    state
        .config
        .lock()
        .await
        .accounts
        .iter()
        .map(|a| (a.email.clone(), a.label()))
        .collect()
}

fn label_for(labels: &HashMap<String, String>, id: &str) -> String {
    labels.get(id).cloned().unwrap_or_else(|| id.to_string())
}

/// Sync every unlocked connection from its backing store, refreshing each
/// connection's cached material. Partial failures are logged; the whole sync
/// only errors if *no* connection synced.
pub async fn sync(state: &AppState, force: bool) -> AgateResult<()> {
    // Snapshot the per-connection sync inputs out of the lock (network follows).
    let bitwarden: Vec<(String, PasswordManagerClient)> = {
        let session = state.session.lock().await;
        if session.connections.is_empty() {
            return Err(AgateError::not_authenticated());
        }
        session
            .connections
            .iter()
            .filter_map(|(id, c)| c.bitwarden().map(|b| (id.clone(), b.client_handle())))
            .collect()
    };

    let mut first_err: Option<AgateError> = None;
    let mut any_ok = false;
    let mut results = Vec::new();
    for (id, client) in bitwarden {
        match crate::providers::bitwarden::sync_connection(&client, force).await {
            Ok(synced) => {
                any_ok = true;
                results.push((id, synced));
            }
            Err(e) => {
                log::warn!("sync failed for a connection: {}", e.message);
                if first_err.is_none() {
                    first_err = Some(e);
                }
            }
        }
    }

    {
        let mut session = state.session.lock().await;
        for (id, synced) in results {
            if let Some(b) = session.connections.get_mut(&id).and_then(LiveConnection::bitwarden_mut) {
                b.ciphers = synced.ciphers;
                b.folders = synced.folders;
                b.collections = synced.collections;
                b.organizations = synced.organizations;
            }
        }

        // KeePass "sync" = re-read the database from disk (file I/O + KDF,
        // blocking — block_in_place keeps the runtime healthy; the session
        // lock is held, which is fine for a local file read).
        for (id, conn) in &mut session.connections {
            if let Some(k) = conn.keepass_mut() {
                match tokio::task::block_in_place(|| k.reload()) {
                    Ok(()) => any_ok = true,
                    Err(e) => {
                        log::warn!("reload failed for a KeePass connection ({id}): {}", e.message);
                        if first_err.is_none() {
                            first_err = Some(e);
                        }
                    }
                }
            }
        }
    }

    if !any_ok {
        if let Some(e) = first_err {
            return Err(e);
        }
    }
    Ok(())
}

/// Decrypt every unlocked connection's items into one unified list, stamping
/// each row with its owning connection.
pub async fn list_items(state: &AppState) -> AgateResult<Vec<VaultItem>> {
    let labels = label_map(state).await;
    let session = state.session.lock().await;
    let mut items = Vec::new();
    for (id, conn) in &session.connections {
        items.extend(conn.list_items(id, &label_for(&labels, id)));
    }
    Ok(items)
}

/// Per-login match index for autofill: each unlocked login with ALL of its URIs
/// (so a synthetic `app://` association in any slot matches, not just the first),
/// plus the display fields the candidate list needs. URIs are metadata, not
/// secrets — passwords are never read here.
pub async fn autofill_index(state: &AppState) -> AgateResult<Vec<crate::autofill::MatchItem>> {
    let labels = label_map(state).await;
    let session = state.session.lock().await;
    let mut out = Vec::new();
    for (id, conn) in &session.connections {
        out.extend(conn.autofill_entries(id, &label_for(&labels, id)));
    }
    Ok(out)
}

/// Collapse raw field names into the distinct, display-ordered set the column
/// picker offers: trimmed, empties dropped, de-duplicated case-insensitively
/// (first-seen casing wins), then sorted case-insensitively. Pure so the dedupe
/// rule is unit-tested without a vault.
pub(crate) fn distinct_field_names(names: impl IntoIterator<Item = String>) -> Vec<String> {
    let mut seen: std::collections::HashSet<String> = std::collections::HashSet::new();
    let mut out: Vec<String> = Vec::new();
    for raw in names {
        let trimmed = raw.trim();
        if trimmed.is_empty() {
            continue;
        }
        if seen.insert(trimmed.to_lowercase()) {
            out.push(trimmed.to_string());
        }
    }
    out.sort_by_key(|a| a.to_lowercase());
    out
}

/// Distinct custom-field names across every unlocked connection's items — feeds
/// the column picker so the user picks an existing field instead of typing its
/// exact name. Field NAMES are metadata, not secrets; field VALUES are never
/// collected here.
pub async fn list_custom_field_names(state: &AppState) -> AgateResult<Vec<String>> {
    let session = state.session.lock().await;
    let mut names: Vec<String> = Vec::new();
    for conn in session.connections.values() {
        names.extend(conn.custom_field_names());
    }
    Ok(distinct_field_names(names))
}

/// Find and decrypt one item (in `account_email`'s connection) into full detail.
pub async fn item_detail(state: &AppState, account_email: &str, id: &str) -> AgateResult<ItemDetail> {
    let labels = label_map(state).await;
    let session = state.session.lock().await;
    let conn = session
        .connections
        .get(account_email)
        .ok_or_else(AgateError::not_authenticated)?;
    conn.item_detail(account_email, &label_for(&labels, account_email), id)
}

/// Generate the current TOTP code for an item that has one.
pub async fn item_totp(state: &AppState, account_email: &str, id: &str) -> AgateResult<TotpCode> {
    let session = state.session.lock().await;
    let conn = session
        .connections
        .get(account_email)
        .ok_or_else(AgateError::not_authenticated)?;
    conn.item_totp(id)
}

/// Decrypt one BITWARDEN cipher to its `CipherView` — the write path's
/// read-modify building block (edit/clone round-trip the decrypted view).
pub(crate) async fn decrypt_one(
    state: &AppState,
    account_email: &str,
    id: &str,
) -> AgateResult<CipherView> {
    let session = state.session.lock().await;
    session
        .connections
        .get(account_email)
        .and_then(LiveConnection::bitwarden)
        .ok_or_else(AgateError::not_authenticated)?
        .decrypt_view(id)
}

/// List decrypted folders across every unlocked connection, stamped by account.
pub async fn list_folders(state: &AppState) -> AgateResult<Vec<Folder>> {
    let labels = label_map(state).await;
    let session = state.session.lock().await;
    let mut out = Vec::new();
    for (id, conn) in &session.connections {
        out.extend(conn.list_folders(id, &label_for(&labels, id)));
    }
    Ok(out)
}

/// List decrypted collections across every unlocked connection, stamped by
/// account. Read-only browse — membership editing isn't supported.
pub async fn list_collections(state: &AppState) -> AgateResult<Vec<Collection>> {
    let labels = label_map(state).await;
    let session = state.session.lock().await;
    let mut out = Vec::new();
    for (id, conn) in &session.connections {
        out.extend(conn.list_collections(id, &label_for(&labels, id)));
    }
    Ok(out)
}

#[cfg(test)]
mod tests {
    use super::*;

    /// The column picker's field list: blanks dropped, case/space duplicates
    /// collapsed (first-seen casing kept), sorted case-insensitively.
    #[test]
    fn distinct_field_names_trims_dedupes_ci_and_sorts() {
        let got = distinct_field_names(vec![
            "  Environment ".to_string(),
            "environment".to_string(), // dup (case + surrounding space) → dropped
            "PIN".to_string(),
            String::new(),    // empty → dropped
            "   ".to_string(), // blank → dropped
            "API Key".to_string(),
        ]);
        assert_eq!(got, vec!["API Key".to_string(), "Environment".to_string(), "PIN".to_string()]);
    }
}
