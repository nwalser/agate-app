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
use crate::error::AgateResult;

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

/// The read surface every provider must satisfy — the SINGLE definition of the
/// provider read contract (previously only implied by eight copy-pasted 5-arm
/// match methods on `LiveConnection`). `LiveConnection::as_read` dispatches to
/// it, so adding a provider is one `impl VaultRead` (the compiler checks every
/// method is present) plus one new `as_read` arm, instead of a new arm in each
/// of eight methods.
pub trait VaultRead {
    fn list_items(&self, id: &str, label: &str) -> Vec<VaultItem>;
    fn autofill_entries(&self, id: &str, label: &str) -> Vec<crate::autofill::MatchItem>;
    fn custom_field_names(&self) -> Vec<String>;
    fn item_detail(&self, id: &str, label: &str, item_id: &str) -> AgateResult<ItemDetail>;
    fn item_totp(&self, item_id: &str) -> AgateResult<TotpCode>;
    fn list_folders(&self, id: &str, label: &str) -> Vec<Folder>;
    fn list_collections(&self, id: &str, label: &str) -> Vec<Collection>;
    fn count_password_use(&self, candidate: &str) -> u32;
}

// Each provider already implements these as inherent methods (where their own
// tests exercise them); forward to those so the trait is a thin contract layer.
// One macro instead of five hand-written, identical forwarding impls.
macro_rules! impl_vault_read {
    ($t:ty) => {
        impl VaultRead for $t {
            fn list_items(&self, id: &str, label: &str) -> Vec<VaultItem> {
                <$t>::list_items(self, id, label)
            }
            fn autofill_entries(&self, id: &str, label: &str) -> Vec<crate::autofill::MatchItem> {
                <$t>::autofill_entries(self, id, label)
            }
            fn custom_field_names(&self) -> Vec<String> {
                <$t>::custom_field_names(self)
            }
            fn item_detail(&self, id: &str, label: &str, item_id: &str) -> AgateResult<ItemDetail> {
                <$t>::item_detail(self, id, label, item_id)
            }
            fn item_totp(&self, item_id: &str) -> AgateResult<TotpCode> {
                <$t>::item_totp(self, item_id)
            }
            fn list_folders(&self, id: &str, label: &str) -> Vec<Folder> {
                <$t>::list_folders(self, id, label)
            }
            fn list_collections(&self, id: &str, label: &str) -> Vec<Collection> {
                <$t>::list_collections(self, id, label)
            }
            fn count_password_use(&self, candidate: &str) -> u32 {
                <$t>::count_password_use(self, candidate)
            }
        }
    };
}
impl_vault_read!(BitwardenConnection);
impl_vault_read!(KeepassConnection);
impl_vault_read!(PassConnection);
impl_vault_read!(EnpassConnection);
impl_vault_read!(ProtonConnection);

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

    /// This connection's read surface as the shared [`VaultRead`] contract. The
    /// ONE place a concrete provider is named for reads — every read method below
    /// forwards through here, so adding a provider is a single new arm here, not a
    /// new arm in each of the eight read methods.
    fn as_read(&self) -> &dyn VaultRead {
        match self {
            LiveConnection::Bitwarden(b) => b,
            LiveConnection::Keepass(k) => k,
            LiveConnection::Pass(p) => p,
            LiveConnection::Enpass(e) => e,
            LiveConnection::Proton(p) => p,
        }
    }

    /// Decrypt this connection's items into unified list rows. Decrypt failures
    /// are logged and skipped, never fatal to the list.
    pub fn list_items(&self, id: &str, label: &str) -> Vec<VaultItem> {
        self.as_read().list_items(id, label)
    }

    /// Per-login match entries for the autofill index (all URIs per login).
    pub fn autofill_entries(&self, id: &str, label: &str) -> Vec<crate::autofill::MatchItem> {
        self.as_read().autofill_entries(id, label)
    }

    /// Raw custom-field names across this connection's items (names only —
    /// values are never read here).
    pub fn custom_field_names(&self) -> Vec<String> {
        self.as_read().custom_field_names()
    }

    /// Decrypt one item into full detail.
    pub fn item_detail(&self, id: &str, label: &str, item_id: &str) -> AgateResult<ItemDetail> {
        self.as_read().item_detail(id, label, item_id)
    }

    /// Current TOTP code for an item that has one.
    pub fn item_totp(&self, item_id: &str) -> AgateResult<TotpCode> {
        self.as_read().item_totp(item_id)
    }

    /// Decrypted folders, stamped with the connection id + label.
    pub fn list_folders(&self, id: &str, label: &str) -> Vec<Folder> {
        self.as_read().list_folders(id, label)
    }

    /// Decrypted collections (Bitwarden org shares; empty for providers
    /// without the concept).
    pub fn list_collections(&self, id: &str, label: &str) -> Vec<Collection> {
        self.as_read().list_collections(id, label)
    }

    /// How many of this connection's logins use `candidate` (count only — which
    /// logins match never leaves the backend).
    pub fn count_password_use(&self, candidate: &str) -> u32 {
        self.as_read().count_password_use(candidate)
    }
}
