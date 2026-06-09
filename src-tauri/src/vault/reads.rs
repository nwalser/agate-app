//! The read path: sync, the unified item list, item detail, TOTP, and folders.
//!
//! In the unified model every read aggregates across every unlocked connection and
//! stamps each row/detail with its owning account (`account_email` + a label), and
//! every per-item operation routes by `(account_email, id)` to the right client.
//!
//! All SDK read calls are isolated here. The read path decrypts each cipher to a
//! full `CipherView` (a stable SDK type) rather than the more volatile
//! `CipherListView`.
//!
//! NOTE (unstable SDK): `sync()` returns the raw `SyncResponseModel`; the SDK does
//! not materialize ciphers into a repository on its own. We convert the API models
//! to domain `Cipher`s here.

use std::collections::HashMap;

use bitwarden_collections::collection::{Collection as VaultCollection, CollectionView};
use bitwarden_core::UserId;
use bitwarden_pm::PasswordManagerClient;
use bitwarden_sync::SyncRequest;
use bitwarden_vault::{
    generate_totp, Cipher, CipherView, Fido2CredentialView, Folder as VaultFolder, FolderView,
};
use chrono::Utc;

use crate::dto::{Collection, Folder, ItemDetail, PasskeyCredential, TotpCode, VaultItem};
use crate::error::{AgateError, AgateResult, ErrorKind};
use crate::server;
use crate::state::AppState;

use super::transform::{view_to_detail, view_to_list_item};

/// One connection's freshly-synced material: (account email, ciphers, folders,
/// collections). Aliased so the sync aggregation type stays readable (clippy
/// `type_complexity`).
type SyncedConnection = (String, Vec<Cipher>, Vec<VaultFolder>, Vec<VaultCollection>);

/// A fresh handle to one connection's unlocked client, or a typed error.
pub(crate) async fn client_for(state: &AppState, account_email: &str) -> AgateResult<PasswordManagerClient> {
    state
        .session
        .lock()
        .await
        .client_for(account_email)
        .ok_or_else(AgateError::not_authenticated)
}

/// Any unlocked client (for account-agnostic ops like generation), or a throwaway.
pub(super) async fn any_or_throwaway(state: &AppState) -> PasswordManagerClient {
    match state.session.lock().await.connections.values().next() {
        Some(c) => PasswordManagerClient(c.client.0.clone()),
        None => PasswordManagerClient::new(None),
    }
}

/// Snapshot of email → server label for the currently configured connections.
async fn label_map(state: &AppState) -> HashMap<String, String> {
    state
        .config
        .lock()
        .await
        .accounts
        .iter()
        .map(|a| (a.email.clone(), server::server_label(&a.server)))
        .collect()
}

fn label_for(labels: &HashMap<String, String>, email: &str) -> String {
    labels.get(email).cloned().unwrap_or_else(|| email.to_string())
}

/// Sync every unlocked connection from the server, caching encrypted ciphers per
/// connection. Partial failures are logged; the whole sync only errors if *no*
/// connection synced.
pub async fn sync(state: &AppState, force: bool) -> AgateResult<()> {
    let clients: Vec<(String, PasswordManagerClient)> = {
        let session = state.session.lock().await;
        session
            .connections
            .iter()
            .map(|(email, c)| (email.clone(), PasswordManagerClient(c.client.0.clone())))
            .collect()
    };
    if clients.is_empty() {
        return Err(AgateError::not_authenticated());
    }

    let mut results: Vec<SyncedConnection> = Vec::new();
    let mut first_err: Option<AgateError> = None;
    let mut any_ok = false;
    for (email, client) in clients {
        match sync_one(&client, force).await {
            Ok((ciphers, folders, collections)) => {
                any_ok = true;
                results.push((email, ciphers, folders, collections));
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
        for (email, ciphers, folders, collections) in results {
            if let Some(conn) = session.connections.get_mut(&email) {
                conn.ciphers = ciphers;
                conn.folders = folders;
                conn.collections = collections;
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

/// Ensure the client's `user_id` is set. The SDK's password-login flow
/// (`auth::login_password`) sets the tokens and the user key but never the
/// `user_id`. Cipher *writes* (`mutate::encrypt_and_push`) require it to stamp the
/// `encryptedFor` field — so without this, every create / edit / favorite returns
/// `NotAuthenticated` ("Not logged in.") even though the vault is fully unlocked
/// and reads/syncs work. We adopt it from the sync profile, which is the first
/// authenticated response that carries the account's id.
///
/// Idempotent: a no-op once set (clones share one `Arc<InternalClient>`), and a
/// no-op when the profile carried no id.
async fn adopt_user_id(client: &PasswordManagerClient, profile_id: Option<uuid::Uuid>) {
    if client.0.internal.get_user_id().is_some() {
        return;
    }
    if let Some(id) = profile_id {
        // ignore: `init_user_id` only errors when a *different* id is already set;
        // we just checked it is unset, so this cannot fail here.
        let _ = client.0.internal.init_user_id(UserId::new(id)).await;
    }
}

async fn sync_one(
    client: &PasswordManagerClient,
    force: bool,
) -> AgateResult<(Vec<Cipher>, Vec<VaultFolder>, Vec<VaultCollection>)> {
    let response = client
        .sync()
        .sync(SyncRequest { force, exclude_subdomains: None })
        .await
        .map_err(|e| {
            let mut msg = format!("Sync failed: {e}");
            if let Some(shape) = crate::proxy::last_sync_shape() {
                let shape = &shape[..shape.len().min(1800)];
                msg.push_str(&format!(" | response shape: {shape}"));
            }
            AgateError::new(ErrorKind::Network, msg)
        })?;

    // Sync is the first authenticated call after login, so it's where we learn the
    // account id the write path needs. See `adopt_user_id`.
    adopt_user_id(client, response.profile.as_ref().and_then(|p| p.id)).await;

    let mut ciphers: Vec<Cipher> = Vec::new();
    for model in response.ciphers.unwrap_or_default() {
        match Cipher::try_from(model) {
            Ok(c) => ciphers.push(c),
            Err(e) => log::warn!("skipping cipher that failed to decode: {e}"),
        }
    }

    // Populate the SDK's local cipher repository so repository-backed write ops
    // (notably `edit`) can read the original. Best-effort.
    match client.0.platform().state().get::<Cipher>() {
        Ok(repo) => {
            for c in &ciphers {
                if let Some(id) = c.id {
                    if let Err(e) = repo.set(id, c.clone()).await {
                        log::warn!("cipher repository populate failed: {e}");
                    }
                }
            }
        }
        Err(e) => log::warn!("no cipher repository registered; edits may be limited: {e}"),
    }

    // Folders, like ciphers, are NOT materialized into a repository by the SDK
    // (and Agate registers none), so we decode the sync response's folders into
    // domain `Folder`s here and cache them on the connection — `list_folders`
    // decrypts straight from that cache, mirroring the cipher read path.
    let mut folders: Vec<VaultFolder> = Vec::new();
    for model in response.folders.unwrap_or_default() {
        match VaultFolder::try_from(model) {
            Ok(f) => folders.push(f),
            Err(e) => log::warn!("skipping folder that failed to decode: {e}"),
        }
    }

    // Collections, like ciphers/folders, aren't materialized by the SDK — decode
    // them from the sync response and cache for `list_collections`.
    let mut collections: Vec<VaultCollection> = Vec::new();
    for model in response.collections.unwrap_or_default() {
        match VaultCollection::try_from(model) {
            Ok(c) => collections.push(c),
            Err(e) => log::warn!("skipping collection that failed to decode: {e}"),
        }
    }

    Ok((ciphers, folders, collections))
}

/// Decrypt every unlocked connection's cached ciphers into one unified list,
/// stamping each row with its owning account.
pub async fn list_items(state: &AppState) -> AgateResult<Vec<VaultItem>> {
    let labels = label_map(state).await;
    let snapshot: Vec<(String, PasswordManagerClient, Vec<Cipher>)> = {
        let session = state.session.lock().await;
        session
            .connections
            .iter()
            .map(|(email, c)| (email.clone(), PasswordManagerClient(c.client.0.clone()), c.ciphers.clone()))
            .collect()
    };

    let mut items = Vec::new();
    for (email, client, ciphers) in snapshot {
        let label = label_for(&labels, &email);
        let key_store = client.0.internal.get_key_store();
        for cipher in &ciphers {
            let decrypted: Result<CipherView, _> = key_store.decrypt(cipher);
            match decrypted {
                Ok(view) => items.push(view_to_list_item(&view, &email, &label)),
                Err(e) => log::warn!("skipping item that failed to decrypt: {e}"),
            }
        }
    }
    Ok(items)
}

/// Find and decrypt one cipher (in `account_email`'s vault) into full detail,
/// including its stored passkeys (FIDO2 credential metadata).
pub async fn item_detail(state: &AppState, account_email: &str, id: &str) -> AgateResult<ItemDetail> {
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
            .find(|c| c.id.map(|i| i.to_string()).as_deref() == Some(id))
            .cloned()
            .ok_or_else(|| AgateError::bad_request("No such item."))?;
        (client, cipher)
    };

    let key_store = client.0.internal.get_key_store();
    let view: CipherView = key_store
        .decrypt(&cipher)
        .map_err(|e| AgateError::new(ErrorKind::Crypto, format!("decrypt failed: {e}")))?;
    let label = label_for(&label_map(state).await, account_email);
    let mut detail = view_to_detail(&view, account_email, &label);

    // Passkey metadata is decrypted from the view via a key-store context
    // (`decrypt_fido2_credentials` is a method on `CipherView`, not `Cipher`).
    // Best-effort: an item with no passkeys simply yields none.
    let mut ctx = key_store.context();
    match view.decrypt_fido2_credentials(&mut ctx) {
        Ok(creds) => detail.passkeys = creds.into_iter().map(passkey_to_dto).collect(),
        Err(e) => log::warn!("passkey decrypt failed: {e}"),
    }
    Ok(detail)
}

fn passkey_to_dto(c: Fido2CredentialView) -> PasskeyCredential {
    PasskeyCredential {
        rp_id: c.rp_id,
        rp_name: c.rp_name,
        user_name: c.user_name,
        user_display_name: c.user_display_name,
        key_algorithm: c.key_algorithm,
        creation_date: c.creation_date.to_rfc3339(),
    }
}

/// Generate the current TOTP code for an item that has one.
pub async fn item_totp(state: &AppState, account_email: &str, id: &str) -> AgateResult<TotpCode> {
    let view = decrypt_one(state, account_email, id).await?;
    let secret = view
        .login
        .as_ref()
        .and_then(|l| l.totp.clone())
        .ok_or_else(|| AgateError::bad_request("Item has no TOTP secret."))?;

    let now = Utc::now();
    let response = generate_totp(secret, Some(now))
        .map_err(|e| AgateError::new(ErrorKind::Crypto, format!("TOTP failed: {e}")))?;

    let period = response.period;
    let remaining = if period == 0 { 0 } else { period - (now.timestamp() as u32 % period) };
    Ok(TotpCode { code: response.code, period, remaining })
}

pub(crate) async fn decrypt_one(
    state: &AppState,
    account_email: &str,
    id: &str,
) -> AgateResult<CipherView> {
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
            .find(|c| c.id.map(|i| i.to_string()).as_deref() == Some(id))
            .cloned()
            .ok_or_else(|| AgateError::bad_request("No such item."))?;
        (client, cipher)
    };
    client
        .vault()
        .ciphers()
        .decrypt(cipher)
        .await
        .map_err(|e| AgateError::new(ErrorKind::Crypto, format!("decrypt failed: {e}")))
}

/// List decrypted folders across every unlocked connection, stamped by account.
/// Reads from each connection's cached folders (populated by `sync`) and decrypts
/// them locally — the SDK's repository-backed `folders().list()` returns nothing
/// because no folder repository is registered (same reason `list_items` decrypts
/// the cached ciphers itself).
pub async fn list_folders(state: &AppState) -> AgateResult<Vec<Folder>> {
    let labels = label_map(state).await;
    let snapshot: Vec<(String, PasswordManagerClient, Vec<VaultFolder>)> = {
        let session = state.session.lock().await;
        session
            .connections
            .iter()
            .map(|(email, c)| {
                (email.clone(), PasswordManagerClient(c.client.0.clone()), c.folders.clone())
            })
            .collect()
    };

    let mut out = Vec::new();
    for (email, client, folders) in snapshot {
        let label = label_for(&labels, &email);
        let key_store = client.0.internal.get_key_store();
        for folder in &folders {
            let decrypted: Result<FolderView, _> = key_store.decrypt(folder);
            match decrypted {
                Ok(view) => out.push(Folder {
                    id: view.id.map(|i| i.to_string()),
                    name: view.name,
                    account_email: email.clone(),
                    account_label: label.clone(),
                }),
                Err(e) => log::warn!("skipping folder that failed to decrypt: {e}"),
            }
        }
    }
    Ok(out)
}

/// List decrypted collections across every unlocked connection, stamped by
/// account. Read-only browse — membership editing isn't supported yet. Mirrors
/// `list_folders`: decrypts from each connection's cached collections.
pub async fn list_collections(state: &AppState) -> AgateResult<Vec<Collection>> {
    let labels = label_map(state).await;
    // `Collection` (the SDK type) isn't `Clone`, so we can't snapshot it out of the
    // lock like folders/ciphers. Collections are few; decrypt them by reference
    // while holding the lock (no `.await` inside, so this is cheap + safe).
    let session = state.session.lock().await;
    let mut out = Vec::new();
    for (email, conn) in session.connections.iter() {
        let label = label_for(&labels, email);
        let key_store = conn.client.0.internal.get_key_store();
        for collection in &conn.collections {
            let decrypted: Result<CollectionView, _> = key_store.decrypt(collection);
            match decrypted {
                Ok(view) => out.push(Collection {
                    id: view.id.map(|i| i.to_string()).unwrap_or_default(),
                    name: view.name,
                    organization_id: view.organization_id.to_string(),
                    account_email: email.clone(),
                    account_label: label.clone(),
                }),
                Err(e) => log::warn!("skipping collection that failed to decrypt: {e}"),
            }
        }
    }
    Ok(out)
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Regression for "favoriting says 'Not logged in.'": the SDK's password login
    /// leaves the client's `user_id` unset, and `mutate::encrypt_and_push` (the
    /// favorite / create / edit write path) maps a missing `user_id` to
    /// `NotAuthenticated`. `sync_one` adopts the id from the sync profile; this
    /// proves the adopt step turns the failing precondition into a passing one.
    #[tokio::test]
    async fn adopts_user_id_from_sync_profile() {
        let client = PasswordManagerClient::new(None);
        // Precondition = the bug: a freshly-built (logged-in) client has no user_id,
        // so a write would return "Not logged in." here.
        assert!(
            client.0.internal.get_user_id().is_none(),
            "fresh client must have no user_id (the bug's root cause)"
        );

        let id = uuid::Uuid::parse_str("d5b1fde2-a1e3-4c5b-9e0f-1a2b3c4d5e6f").unwrap();
        adopt_user_id(&client, Some(id)).await;

        assert_eq!(
            client.0.internal.get_user_id().map(uuid::Uuid::from),
            Some(id),
            "after sync, favorite/create/edit must see a user_id (no 'Not logged in.')"
        );
    }

    /// A second adopt with a different id is ignored — the client stays bound to the
    /// first account, never silently re-pointed.
    #[tokio::test]
    async fn adopt_user_id_keeps_first_id() {
        let client = PasswordManagerClient::new(None);
        let first = uuid::Uuid::parse_str("d5b1fde2-a1e3-4c5b-9e0f-1a2b3c4d5e6f").unwrap();
        let second = uuid::Uuid::parse_str("00000000-0000-4000-8000-000000000000").unwrap();

        adopt_user_id(&client, Some(first)).await;
        adopt_user_id(&client, Some(second)).await;

        assert_eq!(client.0.internal.get_user_id().map(uuid::Uuid::from), Some(first));
    }

    /// A sync response with no profile id leaves the client unset rather than panicking.
    #[tokio::test]
    async fn adopt_user_id_is_noop_without_profile_id() {
        let client = PasswordManagerClient::new(None);
        adopt_user_id(&client, None).await;
        assert!(client.0.internal.get_user_id().is_none());
    }
}
