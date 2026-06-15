//! Vault providers — one variant per backing store.
//!
//! `LiveConnection` is the session's unit of polymorphism: every unlocked
//! connection is one enum variant, and every per-connection operation (list /
//! detail / TOTP / folders / writes) dispatches on it. Adding a provider =
//! adding a variant + its module; the compiler then points at every match that
//! needs a new arm — no dynamic dispatch, no second code path left behind.
//!
//! The aggregation layer (`vault::*`, `mutate::*`) stays provider-agnostic: it
//! iterates `Session::connections`, calls these methods, and stamps rows with
//! the connection id + label. Provider-specific code lives in the submodules.

pub mod bitwarden;
pub mod enpass;
pub mod keepass;
pub mod pass;
pub mod proton;

pub use bitwarden::BitwardenConnection;
pub use enpass::EnpassConnection;
pub use keepass::KeepassConnection;
pub use pass::PassConnection;
pub use proton::ProtonConnection;

use crate::dto::{Collection, ConnectionKind, Folder, ItemDetail, TotpCode, VaultItem};
use crate::error::{AgateError, AgateResult};
use crate::passkey::StoredPasskey;

/// One live, unlocked connection.
// large_enum_variant allow: a KeepassConnection embeds the decrypted Database
// inline (~0.8 KiB). Connections are few, long-lived, and already heap-backed
// inside `Session::connections`, so boxing would only add indirection to every
// dispatch — and the wiring contract names the variant payload unboxed.
#[allow(clippy::large_enum_variant)]
pub enum LiveConnection {
    Bitwarden(BitwardenConnection),
    Keepass(KeepassConnection),
    Pass(PassConnection),
    Enpass(EnpassConnection),
    Proton(ProtonConnection),
}

impl LiveConnection {
    pub fn kind(&self) -> ConnectionKind {
        match self {
            LiveConnection::Bitwarden(_) => ConnectionKind::Bitwarden,
            LiveConnection::Keepass(_) => ConnectionKind::Keepass,
            LiveConnection::Pass(_) => ConnectionKind::Pass,
            LiveConnection::Enpass(_) => ConnectionKind::Enpass,
            LiveConnection::Proton(_) => ConnectionKind::Proton,
        }
    }

    /// The Bitwarden payload, when this is one (Bitwarden-only call sites:
    /// SDK client handles, the re-login unlock path).
    pub fn bitwarden(&self) -> Option<&BitwardenConnection> {
        match self {
            LiveConnection::Bitwarden(b) => Some(b),
            _ => None,
        }
    }

    pub fn bitwarden_mut(&mut self) -> Option<&mut BitwardenConnection> {
        match self {
            LiveConnection::Bitwarden(b) => Some(b),
            _ => None,
        }
    }

    /// The KeePass payload, when this is one (KeePass-only call sites: the
    /// reload-on-sync and write paths).
    pub fn keepass_mut(&mut self) -> Option<&mut KeepassConnection> {
        match self {
            LiveConnection::Keepass(k) => Some(k),
            _ => None,
        }
    }

    /// Decrypt this connection's items into unified list rows. Decrypt failures
    /// are logged and skipped, never fatal to the list.
    pub fn list_items(&self, id: &str, label: &str) -> Vec<VaultItem> {
        match self {
            LiveConnection::Bitwarden(b) => b.list_items(id, label),
            LiveConnection::Keepass(k) => k.list_items(id, label),
            LiveConnection::Pass(p) => p.list_items(id, label),
            LiveConnection::Enpass(e) => e.list_items(id, label),
            LiveConnection::Proton(p) => p.list_items(id, label),
        }
    }

    /// Per-login match entries for the autofill index (all URIs per login).
    pub fn autofill_entries(&self, id: &str, label: &str) -> Vec<crate::autofill::MatchItem> {
        match self {
            LiveConnection::Bitwarden(b) => b.autofill_entries(id, label),
            LiveConnection::Keepass(k) => k.autofill_entries(id, label),
            LiveConnection::Pass(p) => p.autofill_entries(id, label),
            LiveConnection::Enpass(e) => e.autofill_entries(id, label),
            LiveConnection::Proton(p) => p.autofill_entries(id, label),
        }
    }

    /// Raw custom-field names across this connection's items (names only —
    /// values are never read here).
    pub fn custom_field_names(&self) -> Vec<String> {
        match self {
            LiveConnection::Bitwarden(b) => b.custom_field_names(),
            LiveConnection::Keepass(k) => k.custom_field_names(),
            LiveConnection::Pass(p) => p.custom_field_names(),
            LiveConnection::Enpass(e) => e.custom_field_names(),
            LiveConnection::Proton(p) => p.custom_field_names(),
        }
    }

    /// Decrypt one item into full detail (including passkey metadata).
    pub fn item_detail(&self, id: &str, label: &str, item_id: &str) -> AgateResult<ItemDetail> {
        match self {
            LiveConnection::Bitwarden(b) => b.item_detail(id, label, item_id),
            LiveConnection::Keepass(k) => k.item_detail(id, label, item_id),
            LiveConnection::Pass(p) => p.item_detail(id, label, item_id),
            LiveConnection::Enpass(e) => e.item_detail(id, label, item_id),
            LiveConnection::Proton(p) => p.item_detail(id, label, item_id),
        }
    }

    /// Current TOTP code for an item that has one.
    pub fn item_totp(&self, item_id: &str) -> AgateResult<TotpCode> {
        match self {
            LiveConnection::Bitwarden(b) => b.item_totp(item_id),
            LiveConnection::Keepass(k) => k.item_totp(item_id),
            LiveConnection::Pass(p) => p.item_totp(item_id),
            LiveConnection::Enpass(e) => e.item_totp(item_id),
            LiveConnection::Proton(p) => p.item_totp(item_id),
        }
    }

    /// Decrypted folders, stamped with the connection id + label.
    pub fn list_folders(&self, id: &str, label: &str) -> Vec<Folder> {
        match self {
            LiveConnection::Bitwarden(b) => b.list_folders(id, label),
            LiveConnection::Keepass(k) => k.list_folders(id, label),
            LiveConnection::Pass(p) => p.list_folders(id, label),
            LiveConnection::Enpass(e) => e.list_folders(id, label),
            LiveConnection::Proton(p) => p.list_folders(id, label),
        }
    }

    /// Decrypted collections (Bitwarden org shares; empty for providers
    /// without the concept).
    pub fn list_collections(&self, id: &str, label: &str) -> Vec<Collection> {
        match self {
            LiveConnection::Bitwarden(b) => b.list_collections(id, label),
            LiveConnection::Keepass(k) => k.list_collections(id, label),
            LiveConnection::Pass(p) => p.list_collections(id, label),
            LiveConnection::Enpass(e) => e.list_collections(id, label),
            LiveConnection::Proton(p) => p.list_collections(id, label),
        }
    }

    /// How many of this connection's logins use `candidate` (count only — which
    /// logins match never leaves the backend).
    pub fn count_password_use(&self, candidate: &str) -> u32 {
        match self {
            LiveConnection::Bitwarden(b) => b.count_password_use(candidate),
            LiveConnection::Keepass(k) => k.count_password_use(candidate),
            LiveConnection::Pass(p) => p.count_password_use(candidate),
            LiveConnection::Enpass(e) => e.count_password_use(candidate),
            LiveConnection::Proton(p) => p.count_password_use(candidate),
        }
    }
}

// ── passkeys (FIDO2 / WebAuthn) ──────────────────────────────────────────────
//
// The provider-agnostic boundary the passkey ceremony layer talks to. Reads
// return whatever the provider can surface (empty for providers that don't store
// passkeys yet); writes require a writable provider and otherwise return a typed
// `BadRequest`, mirroring `mutate::route_for`. The only caller is the ceremony
// adapter (next slice), so allow this surface to sit unused until then.
#[allow(dead_code)]
impl LiveConnection {
    /// Every stored passkey for a relying-party id — the candidate set for a
    /// get-assertion (sign-in) ceremony.
    pub fn find_passkeys_for_rp(&self, rp_id: &str) -> AgateResult<Vec<StoredPasskey>> {
        match self {
            LiveConnection::Keepass(k) => k.find_passkeys_for_rp(rp_id),
            // No passkey storage for these (yet): Bitwarden reads land here once
            // the SDK Fido2 surface is wired; the rest are read-only sources that
            // don't carry passkeys.
            LiveConnection::Bitwarden(_)
            | LiveConnection::Pass(_)
            | LiveConnection::Enpass(_)
            | LiveConnection::Proton(_) => Ok(Vec::new()),
        }
    }

    /// One stored passkey by credential id, if this connection holds it.
    pub fn get_passkey(&self, credential_id: &[u8]) -> AgateResult<Option<StoredPasskey>> {
        match self {
            LiveConnection::Keepass(k) => k.get_passkey(credential_id),
            LiveConnection::Bitwarden(_)
            | LiveConnection::Pass(_)
            | LiveConnection::Enpass(_)
            | LiveConnection::Proton(_) => Ok(None),
        }
    }

    /// Store a freshly-minted passkey (a make-credential ceremony).
    pub fn create_passkey(&mut self, passkey: StoredPasskey) -> AgateResult<()> {
        match self {
            LiveConnection::Keepass(k) => k.create_passkey(&passkey),
            // SDK Fido2 *write* support is not confirmed at the pinned rev — gate
            // it loudly rather than silently dropping a credential.
            LiveConnection::Bitwarden(_) => Err(AgateError::bad_request(
                "Storing passkeys to a Bitwarden vault isn't supported yet.",
            )),
            LiveConnection::Pass(_) | LiveConnection::Enpass(_) | LiveConnection::Proton(_) => {
                Err(AgateError::bad_request(
                    "This vault is read-only and can't store passkeys.",
                ))
            }
        }
    }

    /// Persist a new signature counter after a successful assertion (a no-op for
    /// providers that report counter `0`).
    pub fn update_passkey_sign_count(
        &mut self,
        credential_id: &[u8],
        sign_count: u32,
    ) -> AgateResult<()> {
        match self {
            LiveConnection::Keepass(k) => k.update_passkey_sign_count(credential_id, sign_count),
            LiveConnection::Bitwarden(_)
            | LiveConnection::Pass(_)
            | LiveConnection::Enpass(_)
            | LiveConnection::Proton(_) => Ok(()),
        }
    }

    /// Remove a stored passkey by credential id.
    pub fn delete_passkey(&mut self, credential_id: &[u8]) -> AgateResult<()> {
        match self {
            LiveConnection::Keepass(k) => k.delete_passkey(credential_id),
            LiveConnection::Bitwarden(_) => Err(AgateError::bad_request(
                "Managing Bitwarden passkeys isn't supported yet.",
            )),
            LiveConnection::Pass(_) | LiveConnection::Enpass(_) | LiveConnection::Proton(_) => {
                Err(AgateError::bad_request("This vault is read-only."))
            }
        }
    }
}
