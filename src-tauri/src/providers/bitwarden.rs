//! The Bitwarden provider: an unlocked SDK client + the last sync's encrypted
//! material, decrypted on demand.
//!
//! All per-connection SDK *read* calls live here (sync key-store decrypts — no
//! awaits, so callers may hold the session lock). The network paths (login,
//! sync, writes) stay in `auth.rs` / `vault::reads` / `mutate`, which snapshot
//! client handles out of the lock first.

use base64::engine::general_purpose::URL_SAFE_NO_PAD;
use base64::Engine as _;
use bitwarden_api_api::models::CipherRequestModel;
use bitwarden_collections::collection::{Collection as SdkCollection, CollectionView};
use bitwarden_pm::PasswordManagerClient;
use bitwarden_vault::{
    generate_totp, Cipher, CipherRepromptType, CipherView, Fido2CredentialFullView,
    Fido2CredentialView, Folder as SdkFolder, FolderView,
};
use chrono::Utc;

use crate::dto::{Collection, Folder, ItemDetail, PasskeyCredential, TotpCode, VaultItem};
use crate::error::{AgateError, AgateResult, ErrorKind};
use crate::passkey::codec::pkcs8_pem_to_der;
use crate::passkey::{PasskeyTarget, StoredPasskey};
use crate::vault::{view_to_detail, view_to_list_item};

/// One live, unlocked Bitwarden connection: its SDK client plus the last sync's
/// encrypted ciphers / folders / collections.
pub struct BitwardenConnection {
    pub client: PasswordManagerClient,
    pub ciphers: Vec<Cipher>,
    pub folders: Vec<SdkFolder>,
    pub collections: Vec<SdkCollection>,
}

impl BitwardenConnection {
    pub fn new(client: PasswordManagerClient) -> Self {
        Self { client, ciphers: Vec::new(), folders: Vec::new(), collections: Vec::new() }
    }

    /// A fresh handle to the SDK client (`Arc`-backed, cheap, shares the
    /// unlocked key store).
    pub fn client_handle(&self) -> PasswordManagerClient {
        PasswordManagerClient(self.client.0.clone())
    }

    /// The cached encrypted cipher with this id, if present.
    pub fn find_cipher(&self, item_id: &str) -> Option<Cipher> {
        self.ciphers
            .iter()
            .find(|c| c.id.map(|i| i.to_string()).as_deref() == Some(item_id))
            .cloned()
    }

    /// Decrypt every cached cipher to a view, skipping (and logging) failures.
    fn decrypt_views(&self) -> Vec<CipherView> {
        let key_store = self.client.0.internal.get_key_store();
        let mut out = Vec::new();
        for cipher in &self.ciphers {
            match key_store.decrypt(cipher) {
                Ok(view) => out.push(view),
                Err(e) => log::warn!("skipping item that failed to decrypt: {e}"),
            }
        }
        out
    }

    pub fn list_items(&self, id: &str, label: &str) -> Vec<VaultItem> {
        self.decrypt_views().iter().map(|v| view_to_list_item(v, id, label)).collect()
    }

    pub fn autofill_entries(&self, id: &str, label: &str) -> Vec<crate::autofill::MatchItem> {
        let mut out = Vec::new();
        for view in self.decrypt_views() {
            if view.deleted_date.is_some() {
                continue;
            }
            let Some(login) = view.login.as_ref() else { continue };
            let uris = login
                .uris
                .as_ref()
                .map(|us| us.iter().filter_map(|u| u.uri.clone()).collect())
                .unwrap_or_default();
            out.push(crate::autofill::MatchItem {
                id: view.id.map(|i| i.to_string()).unwrap_or_default(),
                account_email: id.to_string(),
                account_label: label.to_string(),
                name: view.name.clone(),
                username: login.username.clone(),
                uris,
                reprompt: matches!(view.reprompt, CipherRepromptType::Password),
            });
        }
        out
    }

    pub fn custom_field_names(&self) -> Vec<String> {
        let mut names = Vec::new();
        for view in self.decrypt_views() {
            for f in view.fields.into_iter().flatten() {
                if let Some(name) = f.name {
                    names.push(name);
                }
            }
        }
        names
    }

    /// Decrypt one item to its view (the shared building block for detail /
    /// TOTP / the write path's read-modify cycle).
    pub fn decrypt_view(&self, item_id: &str) -> AgateResult<CipherView> {
        let cipher = self
            .find_cipher(item_id)
            .ok_or_else(|| AgateError::bad_request("No such item."))?;
        self.client
            .0
            .internal
            .get_key_store()
            .decrypt(&cipher)
            .map_err(|e| AgateError::new(ErrorKind::Crypto, format!("decrypt failed: {e}")))
    }

    pub fn item_detail(&self, id: &str, label: &str, item_id: &str) -> AgateResult<ItemDetail> {
        let view = self.decrypt_view(item_id)?;
        let mut detail = view_to_detail(&view, id, label);

        // Passkey metadata is decrypted from the view via a key-store context
        // (`decrypt_fido2_credentials` is a method on `CipherView`, not `Cipher`).
        // Best-effort: an item with no passkeys simply yields none.
        let key_store = self.client.0.internal.get_key_store();
        let mut ctx = key_store.context();
        match view.decrypt_fido2_credentials(&mut ctx) {
            Ok(creds) => detail.passkeys = creds.into_iter().map(passkey_to_dto).collect(),
            Err(e) => log::warn!("passkey decrypt failed: {e}"),
        }
        Ok(detail)
    }

    pub fn item_totp(&self, item_id: &str) -> AgateResult<TotpCode> {
        let view = self.decrypt_view(item_id)?;
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

    pub fn list_folders(&self, id: &str, label: &str) -> Vec<Folder> {
        let key_store = self.client.0.internal.get_key_store();
        let mut out = Vec::new();
        for folder in &self.folders {
            let decrypted: Result<FolderView, _> = key_store.decrypt(folder);
            match decrypted {
                Ok(view) => out.push(Folder {
                    id: view.id.map(|i| i.to_string()),
                    name: view.name,
                    account_email: id.to_string(),
                    account_label: label.to_string(),
                }),
                Err(e) => log::warn!("skipping folder that failed to decrypt: {e}"),
            }
        }
        out
    }

    pub fn list_collections(&self, id: &str, label: &str) -> Vec<Collection> {
        let key_store = self.client.0.internal.get_key_store();
        let mut out = Vec::new();
        for collection in &self.collections {
            let decrypted: Result<CollectionView, _> = key_store.decrypt(collection);
            match decrypted {
                Ok(view) => out.push(Collection {
                    id: view.id.map(|i| i.to_string()).unwrap_or_default(),
                    name: view.name,
                    organization_id: view.organization_id.to_string(),
                    account_email: id.to_string(),
                    account_label: label.to_string(),
                }),
                Err(e) => log::warn!("skipping collection that failed to decrypt: {e}"),
            }
        }
        out
    }

    pub fn count_password_use(&self, candidate: &str) -> u32 {
        let mut count = 0u32;
        for view in self.decrypt_views() {
            if view.r#type != bitwarden_vault::CipherType::Login || view.deleted_date.is_some() {
                continue;
            }
            let Some(login) = &view.login else { continue };
            if login.password.as_deref() == Some(candidate) {
                count += 1;
            }
        }
        count
    }

    /// Store a freshly-minted passkey on a Bitwarden cipher at `target`: attach it
    /// to an existing login (`target.item_id`) or create a new login in
    /// `target.folder_id`. Uses the SDK's `CipherView::set_new_fido2_credentials`
    /// and the same encrypt → `CipherRequestModel` → POST/PUT flow as `save_item`.
    ///
    /// ⚠️ UNVERIFIED LIVE: built against the SDK's confirmed types and the
    /// confirmed key format (`keyValue` = base64url of the PKCS#8 DER, matching
    /// the SDK's own `cose_key_to_pkcs8`), but NOT exercised against a real
    /// Bitwarden account. The server round-trip, the base64url variant, and
    /// cross-client interop (credential-id encoding) still need verification with
    /// a real account. The caller re-syncs after a successful write.
    pub async fn create_passkey(
        &mut self,
        passkey: StoredPasskey,
        target: &PasskeyTarget,
    ) -> AgateResult<()> {
        let key_der = pkcs8_pem_to_der(&passkey.private_key_pem)?;
        let full = Fido2CredentialFullView {
            credential_id: URL_SAFE_NO_PAD.encode(&passkey.credential_id),
            key_type: "public-key".to_string(),
            key_algorithm: "ECDSA".to_string(),
            key_curve: "P-256".to_string(),
            key_value: URL_SAFE_NO_PAD.encode(&*key_der),
            rp_id: passkey.rp_id.clone(),
            user_handle: (!passkey.user_handle.is_empty())
                .then(|| URL_SAFE_NO_PAD.encode(&passkey.user_handle)),
            user_name: passkey.user_name.clone(),
            counter: "0".to_string(),
            rp_name: passkey.rp_name.clone(),
            user_display_name: passkey.user_display_name.clone(),
            discoverable: "true".to_string(),
            creation_date: Utc::now(),
        };

        // Attach to an existing login, or build a new login cipher to hold it.
        let mut view: CipherView = match &target.item_id {
            Some(item_id) => {
                let existing = self.decrypt_view(item_id)?;
                if existing.login.is_none() {
                    return Err(AgateError::bad_request("Passkeys can only be added to logins."));
                }
                existing
            }
            None => new_passkey_login_view(&passkey, target.folder_id.as_deref())?,
        };
        let cipher_id = view.id;

        let internal = &self.client.0.internal;
        let user_id = internal.get_user_id().ok_or_else(AgateError::not_authenticated)?;
        let key_store = internal.get_key_store();
        {
            let mut ctx = key_store.context();
            view.set_new_fido2_credentials(&mut ctx, vec![full]).map_err(|e| {
                AgateError::new(ErrorKind::Crypto, format!("could not attach the passkey: {e}"))
            })?;
        }
        let cipher: Cipher = key_store
            .encrypt(view)
            .map_err(|e| AgateError::new(ErrorKind::Crypto, format!("encrypt failed: {e}")))?;
        let mut model: CipherRequestModel = cipher
            .try_into()
            .map_err(|e| AgateError::new(ErrorKind::Internal, format!("serialize cipher: {e}")))?;
        model.encrypted_for = Some(user_id.into());

        let api = internal.get_api_configurations();
        let ciphers_api = api.api_client.ciphers_api();
        match cipher_id {
            Some(id) => ciphers_api
                .put(id.into(), Some(model))
                .await
                .map(|_| ())
                .map_err(|e| AgateError::new(ErrorKind::Network, format!("Save failed: {e}")))?,
            None => ciphers_api
                .post(Some(model))
                .await
                .map(|_| ())
                .map_err(|e| AgateError::new(ErrorKind::Network, format!("Create failed: {e}")))?,
        }
        Ok(())
    }
}

/// Build a fresh login `CipherView` to hold a new passkey (mirrors the field set
/// of `mutate::writes::create_view_json` for a login). The server is
/// authoritative for dates on create.
fn new_passkey_login_view(passkey: &StoredPasskey, folder_id: Option<&str>) -> AgateResult<CipherView> {
    let now = Utc::now().to_rfc3339();
    let title = passkey.rp_name.clone().unwrap_or_else(|| passkey.rp_id.clone());
    let v = serde_json::json!({
        "id": null,
        "organizationId": null,
        "folderId": folder_id,
        "collectionIds": [],
        "key": null,
        "name": title,
        "notes": null,
        "type": 1,
        "login": {
            "username": passkey.user_name,
            "password": null,
            "totp": null,
            "uris": [{ "uri": format!("https://{}", passkey.rp_id), "match": null, "uriChecksum": null }],
            "autofillOnPageLoad": null,
        },
        "identity": null, "card": null, "secureNote": null, "sshKey": null,
        "bankAccount": null, "driversLicense": null, "passport": null,
        "favorite": false,
        "reprompt": 0,
        "organizationUseTotp": false,
        "edit": true,
        "permissions": null,
        "viewPassword": true,
        "localData": null,
        "attachments": null,
        "attachmentDecryptionFailures": null,
        "fields": [],
        "passwordHistory": null,
        "creationDate": now,
        "deletedDate": null,
        "revisionDate": now,
        "archivedDate": null,
    });
    serde_json::from_value(v)
        .map_err(|e| AgateError::new(ErrorKind::Internal, format!("could not build cipher: {e}")))
}

fn passkey_to_dto(c: Fido2CredentialView) -> PasskeyCredential {
    PasskeyCredential {
        credential_id: c.credential_id,
        rp_id: c.rp_id,
        rp_name: c.rp_name,
        user_name: c.user_name,
        user_display_name: c.user_display_name,
        key_algorithm: c.key_algorithm,
        creation_date: c.creation_date.to_rfc3339(),
    }
}

// ── Network sync ─────────────────────────────────────────────────────────────

/// One connection's freshly-synced material.
pub(crate) struct SyncedMaterial {
    pub ciphers: Vec<Cipher>,
    pub folders: Vec<SdkFolder>,
    pub collections: Vec<SdkCollection>,
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
        let _ = client.0.internal.init_user_id(bitwarden_core::UserId::new(id)).await;
    }
}

/// Sync one connection from the server and decode its material.
///
/// NOTE (unstable SDK): `sync()` returns the raw `SyncResponseModel`; the SDK
/// does not materialize ciphers into a repository on its own. We convert the
/// API models to domain types here.
pub(crate) async fn sync_connection(
    client: &PasswordManagerClient,
    force: bool,
) -> AgateResult<SyncedMaterial> {
    let response = client
        .sync()
        .sync(bitwarden_sync::SyncRequest { force, exclude_subdomains: None })
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
    let mut folders: Vec<SdkFolder> = Vec::new();
    for model in response.folders.unwrap_or_default() {
        match SdkFolder::try_from(model) {
            Ok(f) => folders.push(f),
            Err(e) => log::warn!("skipping folder that failed to decode: {e}"),
        }
    }

    // Collections, like ciphers/folders, aren't materialized by the SDK — decode
    // them from the sync response and cache for `list_collections`.
    let mut collections: Vec<SdkCollection> = Vec::new();
    for model in response.collections.unwrap_or_default() {
        match SdkCollection::try_from(model) {
            Ok(c) => collections.push(c),
            Err(e) => log::warn!("skipping collection that failed to decode: {e}"),
        }
    }

    Ok(SyncedMaterial { ciphers, folders, collections })
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Regression for "favoriting says 'Not logged in.'": the SDK's password login
    /// leaves the client's `user_id` unset, and `mutate::encrypt_and_push` (the
    /// favorite / create / edit write path) maps a missing `user_id` to
    /// `NotAuthenticated`. `sync_connection` adopts the id from the sync profile;
    /// this proves the adopt step turns the failing precondition into a passing one.
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
