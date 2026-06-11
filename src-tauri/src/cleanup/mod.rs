//! Vault cleanup — maintenance tools that keep the vault tidy (distinct from the
//! security audit). First tool: the **link-health checker** (`links.rs`), which
//! pings every login URL and flags the dead ones so the item can be updated.
//!
//! ⚠️ Privacy: the checker makes an outbound request to every web URL in the vault,
//! which reveals the vault's domain list to those servers and any network observer.
//! It is therefore **on-demand only** — never run in the background — and the UI
//! states this before the user runs it.

mod links;

pub use links::link_check_vault;

use bitwarden_vault::{Cipher, CipherType, CipherView};

use crate::error::{AgateError, AgateResult};
use crate::state::AppState;

/// A decrypted login distilled to what the link checker needs: its identity plus
/// the raw URI strings it carries. Names/URLs are vault-derived metadata already
/// exposed by `VaultItem`, so (unlike `audit::LoginAudit`) nothing here is secret —
/// no zeroizing.
pub(super) struct LinkItem {
    pub(super) id: String,
    pub(super) name: String,
    pub(super) account_email: String,
    pub(super) uris: Vec<String>,
}

/// Decrypt every unlocked connection's cached ciphers and pull the login URIs.
/// Covers the UNION of all vaults. Logins are kept regardless of whether they have
/// a password (an entry can be a pure bookmark); logins with no URI at all are
/// dropped. Returns `not_authenticated` when no connections are open.
pub(super) async fn collect_link_items(state: &AppState) -> AgateResult<Vec<LinkItem>> {
    let snapshot: Vec<(String, bitwarden_pm::PasswordManagerClient, Vec<Cipher>)> = {
        let session = state.session.lock().await;
        if session.connections.is_empty() {
            return Err(AgateError::not_authenticated());
        }
        session
            .connections
            .iter()
            .map(|(email, c)| {
                (email.clone(), bitwarden_pm::PasswordManagerClient(c.client.0.clone()), c.ciphers.clone())
            })
            .collect()
    };

    let mut out = Vec::new();
    for (email, client, ciphers) in snapshot {
        // Synchronous key-store decrypt in a loop — same approach as the audit
        // collector: avoids the async per-item feature-flag fetch.
        let key_store = client.0.internal.get_key_store();
        for cipher in &ciphers {
            let view: CipherView = match key_store.decrypt(cipher) {
                Ok(v) => v,
                Err(e) => {
                    log::warn!("link check: skipping undecryptable cipher: {e}");
                    continue;
                }
            };
            if view.r#type != CipherType::Login || view.deleted_date.is_some() {
                continue;
            }
            let Some(login) = &view.login else { continue };
            let uris: Vec<String> = login
                .uris
                .as_ref()
                .map(|us| us.iter().filter_map(|u| u.uri.clone()).collect())
                .unwrap_or_default();
            if uris.is_empty() {
                continue;
            }
            out.push(LinkItem {
                id: view.id.map(|i| i.to_string()).unwrap_or_default(),
                name: view.name.clone(),
                account_email: email.clone(),
                uris,
            });
        }
    }
    Ok(out)
}
