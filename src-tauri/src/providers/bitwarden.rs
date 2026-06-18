//! The Bitwarden provider: an unlocked SDK client + the last sync's encrypted
//! material, decrypted on demand.
//!
//! All per-connection SDK *read* calls live here (sync key-store decrypts — no
//! awaits, so callers may hold the session lock). The network paths (login,
//! sync, writes) stay in `auth.rs` / `vault::reads` / `mutate`, which snapshot
//! client handles out of the lock first.

use bitwarden_api_api::models::ProfileOrganizationResponseModel;
use bitwarden_collections::collection::{Collection as SdkCollection, CollectionView};
use bitwarden_core::key_management::crypto::InitOrgCryptoRequest;
use bitwarden_core::OrganizationId;
use bitwarden_pm::PasswordManagerClient;
use bitwarden_vault::{
    Cipher, CipherRepromptType, CipherView, Folder as SdkFolder, FolderView,
};

use crate::dto::{Collection, Folder, ItemDetail, TotpCode, VaultItem};
use crate::error::{AgateError, AgateResult, ErrorKind};
use crate::vault::{view_to_detail, view_to_list_item};

use super::LiveConnection;
use crate::state::Session;

/// One live, unlocked Bitwarden connection: its SDK client plus the last sync's
/// encrypted ciphers / folders / collections.
pub struct BitwardenConnection {
    pub client: PasswordManagerClient,
    pub ciphers: Vec<Cipher>,
    pub folders: Vec<SdkFolder>,
    pub collections: Vec<SdkCollection>,
    /// Org id → display name, from the sync profile's organization memberships.
    /// Lets `list_collections` stamp each collection with its org's name so the
    /// UI can group "where to store" by organization.
    pub organizations: std::collections::HashMap<String, String>,
}

// Bitwarden-specific accessors on the live `Session` live HERE, not in state.rs,
// so the lowest config/data layer never names an SDK type — the Bitwarden SDK
// stays contained to the provider layer (CLAUDE.md's containment promise).
impl Session {
    /// A fresh handle to a Bitwarden connection's SDK client (the inner `Client`
    /// is cheap to clone — `Arc`-backed, sharing the unlocked key store). `None`
    /// when the connection is absent or not a Bitwarden one.
    pub fn client_for(&self, email: &str) -> Option<PasswordManagerClient> {
        self.connections
            .get(email)
            .and_then(LiveConnection::bitwarden)
            .map(|b| PasswordManagerClient(b.client.0.clone()))
    }

    /// Insert/replace a live Bitwarden connection.
    pub fn insert_bitwarden(&mut self, email: String, client: PasswordManagerClient) {
        self.connections
            .insert(email, LiveConnection::Bitwarden(BitwardenConnection::new(client)));
    }
}

impl BitwardenConnection {
    pub fn new(client: PasswordManagerClient) -> Self {
        Self {
            client,
            ciphers: Vec::new(),
            folders: Vec::new(),
            collections: Vec::new(),
            organizations: std::collections::HashMap::new(),
        }
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
        Ok(view_to_detail(&view, id, label))
    }

    pub fn item_totp(&self, item_id: &str) -> AgateResult<TotpCode> {
        let view = self.decrypt_view(item_id)?;
        let secret = view
            .login
            .as_ref()
            .and_then(|l| l.totp.clone())
            .ok_or_else(|| AgateError::bad_request("Item has no TOTP secret."))?;

        crate::totp::current(secret)
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
                Ok(view) => {
                    let org_id = view.organization_id.to_string();
                    let organization_name = self.organizations.get(&org_id).cloned().unwrap_or_default();
                    out.push(Collection {
                        id: view.id.map(|i| i.to_string()).unwrap_or_default(),
                        name: view.name,
                        organization_id: org_id,
                        organization_name,
                        account_email: id.to_string(),
                        account_label: label.to_string(),
                    });
                }
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
}

// ── Network sync ─────────────────────────────────────────────────────────────

/// One connection's freshly-synced material.
pub(crate) struct SyncedMaterial {
    pub ciphers: Vec<Cipher>,
    pub folders: Vec<SdkFolder>,
    pub collections: Vec<SdkCollection>,
    /// Org id → display name from the sync profile (see [`BitwardenConnection`]).
    pub organizations: std::collections::HashMap<String, String>,
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

/// Build the org-crypto init request from the sync profile's organization
/// memberships. Each org carries its symmetric key encrypted to the user
/// (`organizations[].key`); an entry is kept only when it has BOTH a real id and
/// a parseable key. A missing/malformed key skips that one org (a bad key for one
/// must not block decrypting the others) — never panics.
fn org_init_request(orgs: &[ProfileOrganizationResponseModel]) -> InitOrgCryptoRequest {
    let organization_keys = orgs
        .iter()
        .filter_map(|o| Some((OrganizationId::new(o.id?), o.key.as_deref()?.parse().ok()?)))
        .collect();
    InitOrgCryptoRequest { organization_keys }
}

/// Load the account's organization keys into the SDK key store so org-OWNED data
/// (collections + org ciphers) can decrypt. The SDK's password login initializes
/// only the USER key; without this, `key_store.decrypt` fails for every org
/// collection — `list_collections` returns nothing and the create-item
/// org/collection picker silently stays empty (orgs are derived from collections).
///
/// Must run after the user key is set (it is, by sync time) and before any org
/// decrypt (those happen on demand, later). Idempotent: safe to re-run on every
/// sync (re-login / cold-start unlock both re-sync). Best-effort + loud: a failure
/// is logged, never fatal — personal-vault reads keep working.
async fn init_org_crypto(
    client: &PasswordManagerClient,
    orgs: Option<&Vec<ProfileOrganizationResponseModel>>,
) {
    let req = org_init_request(orgs.map_or(&[], Vec::as_slice));
    if req.organization_keys.is_empty() {
        return; // personal-only account (or none parseable) — nothing to load
    }
    if let Err(e) = client.crypto().initialize_org_crypto(req).await {
        log::warn!("org crypto init failed; org collections and ciphers will not decrypt: {e}");
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

    // ...and where we load the account's org keys, so org collections / ciphers
    // can decrypt (the SDK login only sets up the user key). See `init_org_crypto`.
    init_org_crypto(client, response.profile.as_ref().and_then(|p| p.organizations.as_ref())).await;

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

    // The sync profile lists the account's organization memberships (id + name) —
    // cache id → name so collections can be grouped by their org in the UI.
    let organizations = response
        .profile
        .as_ref()
        .and_then(|p| p.organizations.as_ref())
        .map(|orgs| {
            orgs.iter()
                .filter_map(|o| Some((o.id?.to_string(), o.name.clone().unwrap_or_default())))
                .collect()
        })
        .unwrap_or_default();

    Ok(SyncedMaterial { ciphers, folders, collections, organizations })
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

    fn org_membership(id: Option<uuid::Uuid>, key: Option<&str>) -> ProfileOrganizationResponseModel {
        ProfileOrganizationResponseModel {
            id,
            key: key.map(str::to_string),
            ..Default::default()
        }
    }

    /// `org_init_request` keeps only org memberships with BOTH a real id and a
    /// parseable key, and skips the rest — so collections in the good orgs can
    /// decrypt even when one membership's key is missing or malformed. (A "4."
    /// prefix is the RSA-OAEP-SHA1 UnsignedSharedKey wire form; the body just has
    /// to base64-decode for `FromStr` to accept it.)
    #[test]
    fn org_init_request_keeps_valid_orgs_and_skips_the_rest() {
        let good = uuid::Uuid::parse_str("d5b1fde2-a1e3-4c5b-9e0f-1a2b3c4d5e6f").unwrap();
        let orgs = vec![
            org_membership(Some(good), Some("4.AAAA")),                  // kept
            org_membership(Some(uuid::Uuid::new_v4()), Some("garbage")), // malformed key → skipped
            org_membership(Some(uuid::Uuid::new_v4()), None),            // no key → skipped
            org_membership(None, Some("4.AAAA")),                        // no id → skipped
        ];

        let req = org_init_request(&orgs);

        assert_eq!(req.organization_keys.len(), 1, "only the well-formed org is loaded");
        assert!(req.organization_keys.contains_key(&OrganizationId::new(good)));
    }

    /// A personal-only account (no org memberships) yields an empty request — the
    /// caller skips the SDK call, and the org/collection picker stays hidden by
    /// design (nothing to file into).
    #[test]
    fn org_init_request_is_empty_without_memberships() {
        assert!(org_init_request(&[]).organization_keys.is_empty());
    }
}
