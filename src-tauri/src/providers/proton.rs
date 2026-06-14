//! The Proton Pass provider (FEASIBILITY SCAFFOLD — read the module spec below).
//!
//! Proton Pass is an end-to-end-encrypted vault behind the Proton account API.
//! There is **no official Rust SDK** for the password-manager surface, the login
//! is SRP-6a (Proton's *hardened* variant), and every item is an OpenPGP- and
//! AES-GCM-protected protobuf blob sitting under a multi-level key hierarchy. So
//! this module is deliberately split into two halves:
//!
//!   1. **Real, tested code** — the data model (`DecryptedItem`), the protobuf
//!      `Content`→`ItemType` classification, the DTO projections for ALL eight
//!      read methods, and TOTP generation. These run against a hand-built
//!      in-memory cache with no network, exactly like `bitwarden.rs` projects
//!      from its decrypted `CipherView`s, so they are unit-tested below.
//!   2. **Honest stubs** — `ProtonConnection::open` (login), the SRP handshake,
//!      the bcrypt key-passphrase derivation, the OpenPGP user/vault/item-key
//!      unwrap chain, the Pass API client, and the protobuf parse. Each returns
//!      a typed [`AgateError`] ("Proton Pass <X> is not yet implemented") and is
//!      annotated `// TODO(proton):` with the precise upstream source that
//!      documents the missing piece. NOTHING here pretends an unverified crypto
//!      path works.
//!
//! ## Protocol, as researched (sources cited at the bottom of this module)
//!
//! ### Auth (Proton account, shared by Mail/Drive/Pass)
//! 1. `POST /auth/info` `{Username}` → `{Version, Modulus, ServerEphemeral,
//!    Salt, SRPSession}`. `Modulus` is a **PGP clear-signed** 2048-bit value;
//!    a correct client MUST verify the signature against Proton's SRP signing
//!    key before use (rejecting a tampered modulus is part of the security
//!    model — Proton rotates moduli on every password change).
//! 2. Client runs SRP-6a: `x = bcrypt(password, expandedSalt)` (Proton's custom
//!    bcrypt base64 → `$2y$` cost-10), computes the verifier/proof, and
//!    `POST /auth` `{Username, ClientEphemeral, ClientProof, SRPSession}` →
//!    `{UID, AccessToken, RefreshToken, ServerProof, Scope, 2FA}`. The client
//!    MUST verify `ServerProof` (mutual auth) before trusting the session.
//! 3. If `2FA.Enabled` includes TOTP, `POST /auth/2fa` `{TwoFactorCode}` with
//!    the session headers to upgrade the scope.
//! 4. EVERY request needs `x-pm-uid: <UID>`, `Authorization: Bearer
//!    <AccessToken>`, and **`x-pm-appversion`** — a recognized client string
//!    (e.g. `web-pass@<ver>`). An unknown app-version is rejected by the server.
//!    This is the single biggest real-world blocker (see the spec verdict).
//!
//! ### Key hierarchy (account password → cleartext item)
//! `account password`
//!  └─ `bcrypt(password, keySalt)`  (keySalt from `GET /core/v4/salts`)
//!      └─ decrypts the **user OpenPGP private key** (`GET /core/v4/keys` /
//!         carried in the auth user object) — Curve25519 ECC.
//!          └─ decrypts each Pass **vault (share) key** — a 32-byte AES-GCM key,
//!             PGP-encrypted + signed to the user key.
//!              └─ decrypts each **item key** — a 32-byte AES-GCM key, encrypted
//!                 with the vault key.
//!                  └─ AES-256-GCM-decrypts the item `Content` — a protobuf
//!                     `Item` message (`pass-contents-proto-definition`).
//!
//! ### Pass API (data plane, all under the session headers)
//! - `GET /pass/v1/share` — enumerate the user's shares (vaults).
//! - `GET /pass/v1/share/{shareId}/key` — the vault key(s) for a share.
//! - `GET /pass/v1/share/{shareId}/item` — paginated item list (each carries its
//!   encrypted `Content`, its `ItemKey`, rotation, flags, revision).
//! - `GET /pass/v1/share/{shareId}/item/{itemId}/key` — item key(s) when rotated.
//!
//! ## Mapping decisions (documented for the orchestrator)
//! - A Proton **vault (share)** maps to a **Folder**, NOT a Collection: it is the
//!   user's own grouping (like a KeePass group / Bitwarden folder), one item lives
//!   in exactly one vault, and Agate's "move to folder" semantics fit. Collections
//!   stay empty (reserved for a future "shared-with-me" surface). `folder_id` =
//!   the `shareId`.
//! - `item id` = the Proton `ItemID`; `folder id` = the `ShareID`.
//! - `ItemType` is derived from the protobuf `Content` oneof discriminant:
//!   login→Login, note→SecureNote, creditCard→Card, identity→Identity,
//!   sshKey→SshKey, everything else (alias/wifi/custom)→Unknown.
//! - TOTP = the login's `totp_uri` field, run through `bitwarden_vault::generate_totp`
//!   (same generator the other two providers use — it accepts an otpauth:// URI
//!   or a bare base32 secret).
//! - favorite/deleted come from the item flags (`Flags`) / trash state the Pass
//!   API returns per item.
//!
//! ## Writability
//! **Read-only for v1.** Writes would require re-encrypting a protobuf `Item`
//! under a freshly-generated item key, signing with the user key, and the create/
//! update/trash endpoints with correct content-format versioning — out of scope
//! and high-risk. `save_item` etc. are intentionally absent (the orchestrator
//! must not route writes here).

use bitwarden_vault::generate_totp;
use chrono::{TimeZone, Utc};
use zeroize::{Zeroize, Zeroizing};

use crate::dto::{
    Collection, CustomField, CustomFieldType, Folder, ItemDetail, ItemType, LoginDetail, LoginUri,
    TotpCode, VaultItem,
};
use crate::error::{AgateError, AgateResult, ErrorKind};

// ── In-memory decrypted model (REAL — the read methods project from this) ─────
//
// After a successful login + sync, a `ProtonConnection` holds a fully decrypted
// snapshot: the vaults (shares) and the items. This mirrors how `bitwarden.rs`
// holds decrypted `CipherView`s and `keepass.rs` holds an open `Database`. The
// network/crypto pipeline (stubbed below) is the ONLY thing that builds these;
// once built, every read is pure, synchronous projection — no awaits, no I/O —
// so a caller may hold the session lock while reading, like the other providers.

/// One decrypted Proton Pass vault (a "share" of type vault).
#[derive(Debug, Clone)]
pub struct DecryptedVault {
    /// Proton `ShareID` — used as the Agate `folder_id`.
    pub share_id: String,
    /// Vault display name (decrypted from the vault content).
    pub name: String,
}

/// One decrypted Proton Pass login payload (the subset Agate surfaces).
#[derive(Debug, Clone, Default)]
pub struct DecryptedLogin {
    pub username: Option<String>,
    /// Secret — zeroized when the connection drops (see `Drop` on the cache).
    pub password: Option<String>,
    /// The login's `totp_uri` (otpauth:// URI or bare secret). Secret.
    pub totp_uri: Option<String>,
    /// Login URLs (`urls` + `autofill_urls` in the protobuf), de-duplicated.
    pub urls: Vec<String>,
}

/// One decrypted item, classified to an Agate `ItemType`. Holds only what the
/// read surface needs; the full protobuf has far more we don't surface in v1.
#[derive(Debug, Clone)]
pub struct DecryptedItem {
    /// Proton `ItemID`.
    pub id: String,
    /// Owning vault's `ShareID` (the Agate `folder_id`).
    pub share_id: String,
    pub item_type: ItemType,
    /// `Metadata.name`.
    pub name: String,
    /// `Metadata.note` (surfaced as the item's notes).
    pub note: Option<String>,
    /// Present only for `ItemType::Login`.
    pub login: Option<DecryptedLogin>,
    /// `ExtraField`s the user added (custom fields). Hidden = the protobuf
    /// `Hidden`/`Totp` field kinds; Text = `Text`.
    pub custom_fields: Vec<DecryptedField>,
    pub favorite: bool,
    pub deleted: bool,
    /// Item create time (unix seconds), for the detail pane.
    pub create_time: i64,
    /// Item last-revision time (unix seconds).
    pub modify_time: i64,
}

/// A decrypted custom (extra) field.
#[derive(Debug, Clone)]
pub struct DecryptedField {
    pub name: String,
    /// Secret when `hidden` — never logged.
    pub value: String,
    pub hidden: bool,
}

/// The decrypted snapshot held by a live connection. Boxed-secret discipline:
/// the secret-bearing fields are zeroized on drop.
#[derive(Debug, Default)]
pub struct VaultCache {
    pub vaults: Vec<DecryptedVault>,
    pub items: Vec<DecryptedItem>,
}

impl Drop for VaultCache {
    fn drop(&mut self) {
        for item in &mut self.items {
            if let Some(login) = item.login.as_mut() {
                if let Some(p) = login.password.as_mut() {
                    p.zeroize();
                }
                if let Some(t) = login.totp_uri.as_mut() {
                    t.zeroize();
                }
            }
            for f in &mut item.custom_fields {
                if f.hidden {
                    f.value.zeroize();
                }
            }
        }
    }
}

// ── Session (what restart-unlock would have to seal) ──────────────────────────

/// The live Proton session tokens. Not currently obtainable (login is stubbed),
/// but modeled so the orchestrator can see exactly what restart-unlock must seal
/// under the VMK. See the `StoredConnection` notes in the module spec.
// Fields are populated only once the (stubbed) login pipeline lands; modeled now
// so the restart-unlock sealing contract is visible.
#[allow(dead_code)]
#[derive(Debug, Default)]
pub struct ProtonSession {
    /// `x-pm-uid` for every request.
    pub uid: String,
    /// `Authorization: Bearer <AccessToken>`. Short-lived. Secret.
    pub access_token: Zeroizing<String>,
    /// Refreshes the access token via `POST /auth/refresh`. Longer-lived but
    /// still revocable + device-bound; NOT a substitute for re-auth on a cold
    /// start (see the restart-unlock note). Secret.
    pub refresh_token: Zeroizing<String>,
}

// ── The connection ────────────────────────────────────────────────────────────

/// One live, unlocked Proton Pass connection: the account identity, the live
/// session tokens, and the decrypted in-memory snapshot the reads project from.
pub struct ProtonConnection {
    /// The account address (Agate connection id == email, like Bitwarden).
    email: String,
    /// Live session. Empty until login is implemented.
    #[allow(dead_code)] // wired once `open`/`sync` are real
    session: ProtonSession,
    /// Decrypted vaults + items.
    cache: VaultCache,
}

/// Redacted: never prints tokens, key material, or vault contents.
impl std::fmt::Debug for ProtonConnection {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("ProtonConnection")
            .field("email", &self.email)
            .field("vaults", &self.cache.vaults.len())
            .field("items", &self.cache.items.len())
            .finish_non_exhaustive()
    }
}

// ── lifecycle (login / sync) — STUBBED, the network+crypto pipeline ───────────

impl ProtonConnection {
    /// Log in to Proton and build a decrypted snapshot — the analogue of
    /// `KeepassConnection::open` / the Bitwarden login+sync.
    ///
    /// NOT YET IMPLEMENTED. The end-to-end pipeline this must perform:
    ///   1. SRP login → session tokens (+ optional TOTP 2FA).
    ///   2. Fetch the key salt + user OpenPGP key; derive the key passphrase via
    ///      bcrypt and unlock the user key.
    ///   3. Enumerate shares, decrypt each vault key, then each item key, then
    ///      AES-GCM-decrypt + protobuf-parse every item into [`DecryptedItem`].
    ///
    /// Each of those steps is a separate stub below, so the failure is precise
    /// and points the implementer at the exact missing piece.
    ///
    /// `two_factor` carries an optional TOTP code for accounts that enforce 2FA
    /// (mirrors the Bitwarden add/unlock flow — see the module spec).
    ///
    /// Blocking (bcrypt KDF + OpenPGP) once real — callers would wrap in
    /// `spawn_blocking`, like the KeePass `open`.
    pub async fn open(
        email: &str,
        password: Zeroizing<String>,
        two_factor: Option<&str>,
    ) -> AgateResult<Self> {
        // The shape is real so the call site compiles against the final
        // signature; only the body is a stub.
        let _ = (&password, two_factor);

        // TODO(proton): implement the SRP handshake. Reference:
        //   ProtonMail/go-srp (go-srp/srp.go) for the exact GenerateProofs(2048)
        //   math and the PGP clear-signed modulus verification, and
        //   ProtonMail/proton-python-client (proton/api.py `srpGetVerify`) for the
        //   custom bcrypt-base64 password expansion. `proton-api-rs` shells out to
        //   go-srp precisely because pure-Rust SRP crates trip Proton's hardened
        //   server checks — so the safe path is the `proton-crypto-rs` SRP crate
        //   (ProtonMail/proton-crypto-rs), NOT the bare `srp` crate.
        let _session = srp_login(email, &password, two_factor).await?;

        // TODO(proton): with a session, fetch + unlock the user key and build the
        // decrypted cache (the stubs below).
        Err(not_implemented("login"))
    }

    /// Re-fetch shares + items and rebuild the cache (the provider's "sync").
    /// NOT YET IMPLEMENTED — depends on the same pipeline as `open`.
    #[allow(dead_code)] // wired into vault sync once the login pipeline lands
    pub async fn reload(&mut self) -> AgateResult<()> {
        Err(not_implemented("sync"))
    }

    /// TEST/orchestration constructor: build a connection directly from an
    /// already-decrypted cache, bypassing the (stubbed) network+crypto pipeline.
    /// This is what makes the read surface unit-testable today, and is the seam
    /// the real `open` will hand its decrypted cache to once the pipeline lands.
    #[allow(dead_code)] // used by the unit tests + by `open` once the pipeline lands
    pub fn from_decrypted(email: impl Into<String>, cache: VaultCache) -> Self {
        Self { email: email.into(), session: ProtonSession::default(), cache }
    }
}

// ── read surface (mirrors BitwardenConnection / KeepassConnection) ────────────
//
// These are REAL and tested: pure projections from `self.cache`.

impl ProtonConnection {
    /// All items as unified list rows, stamped with the connection id + label.
    pub fn list_items(&self, id: &str, label: &str) -> Vec<VaultItem> {
        self.cache.items.iter().map(|it| item_to_list_row(it, id, label)).collect()
    }

    /// Per-login match entries for the autofill index (all URLs per login).
    pub fn autofill_entries(&self, id: &str, label: &str) -> Vec<crate::autofill::MatchItem> {
        let mut out = Vec::new();
        for it in &self.cache.items {
            if it.deleted || it.item_type != ItemType::Login {
                continue;
            }
            let Some(login) = it.login.as_ref() else { continue };
            out.push(crate::autofill::MatchItem {
                id: it.id.clone(),
                account_email: id.to_string(),
                account_label: label.to_string(),
                name: it.name.clone(),
                username: login.username.clone(),
                uris: login.urls.clone(),
                // Proton Pass has no per-item "require master password to view";
                // the whole vault is gated by the app unlock. Never reprompt here.
                reprompt: false,
            });
        }
        out
    }

    /// Names of every custom (extra) field across the cache (names only — values
    /// are never read here). Sorted + de-duplicated for determinism.
    pub fn custom_field_names(&self) -> Vec<String> {
        let mut names: Vec<String> = self
            .cache
            .items
            .iter()
            .flat_map(|it| it.custom_fields.iter().map(|f| f.name.clone()))
            .collect();
        names.sort();
        names.dedup();
        names
    }

    /// One item as full detail (login fields, notes, custom fields, dates).
    pub fn item_detail(&self, id: &str, label: &str, item_id: &str) -> AgateResult<ItemDetail> {
        let it = self.find_item(item_id)?;

        let login = it.login.as_ref().map(|l| LoginDetail {
            username: l.username.clone(),
            password: l.password.clone(),
            totp: l.totp_uri.clone(),
            uris: l
                .urls
                .iter()
                .map(|u| LoginUri { uri: Some(u.clone()), match_type: None })
                .collect(),
            has_totp: l.totp_uri.as_deref().is_some_and(|t| !t.is_empty()),
            password_revision_date: None,
            autofill_on_page_load: None,
            password_history: Vec::new(),
        });

        let fields = it
            .custom_fields
            .iter()
            .map(|f| CustomField {
                name: Some(f.name.clone()),
                value: Some(f.value.clone()),
                field_type: if f.hidden { CustomFieldType::Hidden } else { CustomFieldType::Text },
                linked_id: None,
            })
            .collect();

        Ok(ItemDetail {
            id: it.id.clone(),
            account_email: id.to_string(),
            account_label: label.to_string(),
            name: it.name.clone(),
            item_type: it.item_type,
            favorite: it.favorite,
            reprompt: false,
            notes: it.note.clone().filter(|n| !n.is_empty()),
            login,
            // v1 surfaces login/note fully; card/identity/ssh are classified for
            // the list + icon but their typed detail is not yet projected.
            card: None,
            identity: None,
            ssh_key: None,
            fields,
            folder_id: Some(it.share_id.clone()),
            organization_id: None,
            revision_date: unix_to_rfc3339(it.modify_time),
            creation_date: unix_to_rfc3339(it.create_time),
            collection_ids: Vec::new(),
            passkeys: Vec::new(),
        })
    }

    /// Current TOTP code from the login's `totp_uri` (same generator the other
    /// providers use).
    pub fn item_totp(&self, item_id: &str) -> AgateResult<TotpCode> {
        let it = self.find_item(item_id)?;
        let secret = it
            .login
            .as_ref()
            .and_then(|l| l.totp_uri.clone())
            .filter(|t| !t.is_empty())
            .ok_or_else(|| AgateError::bad_request("Item has no TOTP secret."))?;

        let now = Utc::now();
        let response = generate_totp(secret, Some(now))
            .map_err(|e| AgateError::new(ErrorKind::Crypto, format!("TOTP failed: {e}")))?;
        let period = response.period;
        let remaining = if period == 0 { 0 } else { period - (now.timestamp() as u32 % period) };
        Ok(TotpCode { code: response.code, period, remaining })
    }

    /// Proton vaults (shares) map to folders. `folder_id` = `ShareID`.
    pub fn list_folders(&self, id: &str, label: &str) -> Vec<Folder> {
        let mut out: Vec<Folder> = self
            .cache
            .vaults
            .iter()
            .map(|v| Folder {
                id: Some(v.share_id.clone()),
                name: v.name.clone(),
                account_email: id.to_string(),
                account_label: label.to_string(),
            })
            .collect();
        out.sort_by(|a, b| a.name.cmp(&b.name));
        out
    }

    /// Proton Pass has no "collection" concept Agate surfaces (vaults are folders);
    /// reserved for a future shared-with-me view. Always empty.
    pub fn list_collections(&self, _id: &str, _label: &str) -> Vec<Collection> {
        Vec::new()
    }

    /// How many non-deleted logins use `candidate` as their password.
    pub fn count_password_use(&self, candidate: &str) -> u32 {
        if candidate.is_empty() {
            return 0;
        }
        let mut count = 0u32;
        for it in &self.cache.items {
            if it.deleted || it.item_type != ItemType::Login {
                continue;
            }
            if it.login.as_ref().and_then(|l| l.password.as_deref()) == Some(candidate) {
                count += 1;
            }
        }
        count
    }

    fn find_item(&self, item_id: &str) -> AgateResult<&DecryptedItem> {
        self.cache
            .items
            .iter()
            .find(|it| it.id == item_id)
            .ok_or_else(|| AgateError::bad_request("No such item."))
    }
}

// ── pure helpers (REAL + tested) ──────────────────────────────────────────────

fn item_to_list_row(it: &DecryptedItem, id: &str, label: &str) -> VaultItem {
    let (username, uri, has_totp) = match (&it.item_type, it.login.as_ref()) {
        (ItemType::Login, Some(l)) => (
            l.username.clone(),
            l.urls.first().cloned(),
            l.totp_uri.as_deref().is_some_and(|t| !t.is_empty()),
        ),
        _ => (None, None, false),
    };
    VaultItem {
        id: it.id.clone(),
        account_email: id.to_string(),
        account_label: label.to_string(),
        name: it.name.clone(),
        item_type: it.item_type,
        username,
        uri,
        has_totp,
        has_passkey: false, // passkeys exist in the protobuf but aren't surfaced in v1
        reprompt: false,
        favorite: it.favorite,
        deleted: it.deleted,
        folder_id: Some(it.share_id.clone()),
        organization_id: None,
    }
}

/// Proton item revision times are unix seconds. Render RFC 3339 for the
/// non-optional DTO dates; an out-of-range/zero stamp falls back to the epoch so
/// the date never panics or produces an invalid string.
fn unix_to_rfc3339(secs: i64) -> String {
    match Utc.timestamp_opt(secs, 0).single() {
        Some(dt) => dt.to_rfc3339(),
        None => Utc.timestamp_opt(0, 0).single().map(|e| e.to_rfc3339()).unwrap_or_default(),
    }
}

/// The protobuf `Content` oneof discriminant (the field number set in `item_v1.proto`).
/// Kept as a typed enum so the classifier is exhaustive and the proto field
/// numbers live in exactly one place.
///
/// Source: protonpass/pass-contents-proto-definition `protos/item_v1.proto`,
/// `Content` oneof — note=2, login=3, alias=4, creditCard=5, identity=6,
/// sshKey=7, wifi=8, custom=9 (case 1 is intentionally absent upstream).
// Real + unit-tested classification, but only reached once the protobuf-parse
// step (stubbed) feeds it a field number — hence dead in the non-test lib build.
#[allow(dead_code)]
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ProtonContentKind {
    Note,
    Login,
    Alias,
    CreditCard,
    Identity,
    SshKey,
    Wifi,
    Custom,
}

#[allow(dead_code)] // see ProtonContentKind: reached once protobuf parse lands
impl ProtonContentKind {
    /// Map the protobuf oneof field number to a kind (`None` for an unknown
    /// future number, which the classifier treats as `ItemType::Unknown`).
    pub fn from_proto_field(field_number: u32) -> Option<Self> {
        match field_number {
            2 => Some(Self::Note),
            3 => Some(Self::Login),
            4 => Some(Self::Alias),
            5 => Some(Self::CreditCard),
            6 => Some(Self::Identity),
            7 => Some(Self::SshKey),
            8 => Some(Self::Wifi),
            9 => Some(Self::Custom),
            _ => None,
        }
    }

    /// Project a Proton content kind onto Agate's `ItemType`. Alias / Wifi /
    /// Custom have no first-class Agate type yet, so they classify as `Unknown`
    /// (still listed + searchable, just without a typed detail view).
    pub fn to_item_type(self) -> ItemType {
        match self {
            Self::Login => ItemType::Login,
            Self::Note => ItemType::SecureNote,
            Self::CreditCard => ItemType::Card,
            Self::Identity => ItemType::Identity,
            Self::SshKey => ItemType::SshKey,
            Self::Alias | Self::Wifi | Self::Custom => ItemType::Unknown,
        }
    }
}

/// Classify a decrypted item's protobuf `Content` oneof into an `ItemType`.
/// Real and tested; the protobuf-parse step that produces the field number is
/// stubbed (see `parse_item_content`).
#[allow(dead_code)] // reached once the protobuf-parse step lands; exercised by tests
pub fn classify_content(content_field_number: u32) -> ItemType {
    ProtonContentKind::from_proto_field(content_field_number)
        .map(ProtonContentKind::to_item_type)
        .unwrap_or(ItemType::Unknown)
}

// ── auth / crypto / API pipeline — STUBS (each points at its upstream source) ──

fn not_implemented(what: &str) -> AgateError {
    AgateError::new(
        ErrorKind::Internal,
        format!("Proton Pass {what} is not yet implemented."),
    )
}

/// Run the Proton SRP-6a login and (optionally) the TOTP 2FA step, returning the
/// live session tokens.
///
/// NOT YET IMPLEMENTED.
/// TODO(proton): the wire flow is `POST /auth/info` → SRP math → `POST /auth`
/// (→ `POST /auth/2fa` if enforced). The exact, server-accepted implementation:
///   - SRP math + PGP clear-signed modulus verification: ProtonMail/go-srp
///     (`go-srp/srp.go`, `GenerateProofs`), or the SRP module of
///     ProtonMail/proton-crypto-rs (the official Rust crypto crates).
///   - Custom bcrypt password expansion + verifier: ProtonMail/proton-python-client
///     (`proton/api.py`, `srpGetVerify` / `getRandomSrpVerifier`).
///   - The session-header set + the **mandatory `x-pm-appversion`** value:
///     ProtonMail/go-proton-api (`manager_auth.go`, `manager.go`). A pure-Rust
///     `srp`-crate handshake is known to fail Proton's hardened checks — use the
///     Proton crypto crate.
async fn srp_login(
    _email: &str,
    _password: &Zeroizing<String>,
    _two_factor: Option<&str>,
) -> AgateResult<ProtonSession> {
    Err(not_implemented("SRP login"))
}

/// Derive the user-key passphrase from the account password and the key salt.
///
/// NOT YET IMPLEMENTED.
/// TODO(proton): passphrase = base64(bcrypt(password, `$2y$10$<22-char salt>`))
/// where the salt is `GET /core/v4/salts` `KeySalts[].KeySalt` (base64, 16 bytes)
/// expanded into Proton's bcrypt salt string. Reference:
/// ProtonMail/proton-python-client `proton/srp/pmhash.py` + `proton/srp/util.py`
/// (the `bcrypt_b64` alphabet differs from standard bcrypt). The returned
/// passphrase MUST be `Zeroizing`.
#[allow(dead_code)]
fn derive_user_key_passphrase(
    _password: &Zeroizing<String>,
    _key_salt_b64: &str,
) -> AgateResult<Zeroizing<Vec<u8>>> {
    Err(not_implemented("key-passphrase derivation"))
}

/// Unlock the user's OpenPGP private key with the derived passphrase, decrypt a
/// vault (share) key, then an item key, then AES-256-GCM-decrypt the item blob.
///
/// NOT YET IMPLEMENTED.
/// TODO(proton): OpenPGP (Curve25519) unlock + decrypt of the armored user key
/// and the PGP-encrypted vault keys; AES-256-GCM for item keys + item content.
/// Reference: proton.me/blog/proton-pass-security-model (the hierarchy) and
/// protonpass/pass-cli (Go) for the concrete decrypt order. Use the official
/// ProtonMail/proton-crypto-rs (gopenpgp-backed) crate for PGP — NOT a bare
/// `sequoia-openpgp`/`rpgp` path, because Proton's key + message framing has
/// quirks the official crate already handles. All intermediate keys MUST be
/// `Zeroizing`.
#[allow(dead_code)]
fn decrypt_item_blob(
    _vault_key: &Zeroizing<Vec<u8>>,
    _encrypted_item_key: &[u8],
    _encrypted_content: &[u8],
) -> AgateResult<Vec<u8>> {
    Err(not_implemented("item decryption"))
}

/// Parse a decrypted item blob (protobuf `Item`) into a [`DecryptedItem`].
///
/// NOT YET IMPLEMENTED.
/// TODO(proton): decode the `Item` message and project it. Generate the types
/// with `prost` from protonpass/pass-contents-proto-definition `protos/item_v1.proto`
/// (a build-time `prost-build` step, or a vendored generated module). Field map
/// is already captured in this module's header + `ProtonContentKind`. Until then,
/// `classify_content` + the `DecryptedItem` model are ready to receive the result.
#[allow(dead_code)]
fn parse_item_content(
    _share_id: &str,
    _item_id: &str,
    _decrypted_protobuf: &[u8],
) -> AgateResult<DecryptedItem> {
    Err(not_implemented("item protobuf parsing"))
}

/// Minimal authenticated Proton API client (the data plane).
///
/// NOT YET IMPLEMENTED.
/// TODO(proton): a `reqwest` client (rustls-tls, NEVER `danger_accept_invalid_certs`)
/// that stamps `x-pm-uid`, `Authorization: Bearer …`, and `x-pm-appversion` on
/// every request, refreshes via `POST /auth/refresh` on 401, and exposes:
///   - `GET /pass/v1/share`                          (vaults)
///   - `GET /pass/v1/share/{shareId}/key`            (vault keys)
///   - `GET /pass/v1/share/{shareId}/item`           (paginated items)
///   - `GET /pass/v1/share/{shareId}/item/{itemId}/key` (rotated item keys)
///
/// Reference: protonpass/pass-cli (Go) for the exact paths + JSON shapes, and
/// ProtonMail/go-proton-api `manager.go` for the header/refresh middleware.
#[allow(dead_code)]
struct ProtonApi;

#[cfg(test)]
mod tests {
    use super::*;

    fn login(username: &str, password: &str, totp: Option<&str>, urls: &[&str]) -> DecryptedLogin {
        DecryptedLogin {
            username: Some(username.to_string()),
            password: Some(password.to_string()),
            totp_uri: totp.map(str::to_string),
            urls: urls.iter().map(|u| u.to_string()).collect(),
        }
    }

    /// A two-vault cache: vault "Personal" with a GitHub login (TOTP + a hidden
    /// and a text custom field) and a "Backup codes" note; vault "Work" with a
    /// deleted login.
    fn cache() -> VaultCache {
        VaultCache {
            vaults: vec![
                DecryptedVault { share_id: "share-work".into(), name: "Work".into() },
                DecryptedVault { share_id: "share-personal".into(), name: "Personal".into() },
            ],
            items: vec![
                DecryptedItem {
                    id: "item-gh".into(),
                    share_id: "share-personal".into(),
                    item_type: classify_content(3), // login
                    name: "GitHub".into(),
                    note: Some("main account".into()),
                    login: Some(login(
                        "octocat",
                        "hunter2",
                        Some("otpauth://totp/GitHub:octocat?secret=JBSWY3DPEHPK3PXP&issuer=GitHub"),
                        &["https://github.com/login", "https://github.com"],
                    )),
                    custom_fields: vec![
                        DecryptedField { name: "API Key".into(), value: "secret-key".into(), hidden: true },
                        DecryptedField { name: "Plan".into(), value: "pro".into(), hidden: false },
                    ],
                    favorite: true,
                    deleted: false,
                    create_time: 1_700_000_000,
                    modify_time: 1_700_100_000,
                },
                DecryptedItem {
                    id: "item-note".into(),
                    share_id: "share-personal".into(),
                    item_type: classify_content(2), // note
                    name: "Backup codes".into(),
                    note: Some("1234 5678".into()),
                    login: None,
                    custom_fields: vec![],
                    favorite: false,
                    deleted: false,
                    create_time: 1_700_000_000,
                    modify_time: 1_700_000_000,
                },
                DecryptedItem {
                    id: "item-old".into(),
                    share_id: "share-work".into(),
                    item_type: classify_content(3), // login
                    name: "Old VPN".into(),
                    note: None,
                    login: Some(login("vpnuser", "hunter2", None, &["https://vpn.example"])),
                    custom_fields: vec![],
                    favorite: false,
                    deleted: true,
                    create_time: 1_699_000_000,
                    modify_time: 1_699_500_000,
                },
            ],
        }
    }

    fn conn() -> ProtonConnection {
        ProtonConnection::from_decrypted("user@proton.me", cache())
    }

    // ── content classification (proto oneof → ItemType) ──────────────────────

    #[test]
    fn classify_content_maps_every_known_oneof_field() {
        assert_eq!(classify_content(3), ItemType::Login);
        assert_eq!(classify_content(2), ItemType::SecureNote);
        assert_eq!(classify_content(5), ItemType::Card);
        assert_eq!(classify_content(6), ItemType::Identity);
        assert_eq!(classify_content(7), ItemType::SshKey);
        // alias / wifi / custom have no Agate type yet → Unknown
        assert_eq!(classify_content(4), ItemType::Unknown);
        assert_eq!(classify_content(8), ItemType::Unknown);
        assert_eq!(classify_content(9), ItemType::Unknown);
        // case 1 is intentionally absent upstream; an unknown future field → Unknown
        assert_eq!(classify_content(1), ItemType::Unknown);
        assert_eq!(classify_content(999), ItemType::Unknown);
    }

    // ── reads ─────────────────────────────────────────────────────────────────

    #[test]
    fn list_items_maps_types_username_uri_totp_favorite_and_deleted() {
        let c = conn();
        let items = c.list_items("user@proton.me", "Proton");
        assert_eq!(items.len(), 3);

        let gh = items.iter().find(|i| i.id == "item-gh").unwrap();
        assert_eq!(gh.name, "GitHub");
        assert_eq!(gh.item_type, ItemType::Login);
        assert_eq!(gh.username.as_deref(), Some("octocat"));
        assert_eq!(gh.uri.as_deref(), Some("https://github.com/login"), "first url");
        assert!(gh.has_totp);
        assert!(gh.favorite);
        assert!(!gh.deleted);
        assert_eq!(gh.folder_id.as_deref(), Some("share-personal"), "vault == folder");
        assert_eq!(gh.account_email, "user@proton.me");
        assert_eq!(gh.account_label, "Proton");

        let note = items.iter().find(|i| i.id == "item-note").unwrap();
        assert_eq!(note.item_type, ItemType::SecureNote);
        assert_eq!(note.username, None);
        assert!(!note.has_totp);

        let old = items.iter().find(|i| i.id == "item-old").unwrap();
        assert!(old.deleted);
        assert_eq!(old.folder_id.as_deref(), Some("share-work"));
    }

    #[test]
    fn item_detail_maps_login_notes_custom_fields_and_dates() {
        let c = conn();
        let d = c.item_detail("user@proton.me", "Proton", "item-gh").unwrap();
        assert_eq!(d.item_type, ItemType::Login);
        assert_eq!(d.notes.as_deref(), Some("main account"));
        assert!(d.favorite);
        assert_eq!(d.folder_id.as_deref(), Some("share-personal"));
        assert!(d.collection_ids.is_empty());
        assert!(d.passkeys.is_empty());

        let login = d.login.as_ref().unwrap();
        assert_eq!(login.username.as_deref(), Some("octocat"));
        assert_eq!(login.password.as_deref(), Some("hunter2"));
        assert!(login.totp.as_deref().unwrap().starts_with("otpauth://"));
        assert!(login.has_totp);
        assert_eq!(login.uris.len(), 2, "both urls round-trip");
        assert_eq!(login.uris[0].uri.as_deref(), Some("https://github.com/login"));

        let api = d.fields.iter().find(|f| f.name.as_deref() == Some("API Key")).unwrap();
        assert_eq!(api.value.as_deref(), Some("secret-key"));
        assert_eq!(api.field_type, CustomFieldType::Hidden, "hidden → Hidden");
        let plan = d.fields.iter().find(|f| f.name.as_deref() == Some("Plan")).unwrap();
        assert_eq!(plan.field_type, CustomFieldType::Text);

        // dates render as parseable RFC 3339
        assert!(chrono::DateTime::parse_from_rfc3339(&d.revision_date).is_ok());
        assert!(chrono::DateTime::parse_from_rfc3339(&d.creation_date).is_ok());

        // a note has no login section
        let note = c.item_detail("user@proton.me", "Proton", "item-note").unwrap();
        assert!(note.login.is_none());
        assert_eq!(note.notes.as_deref(), Some("1234 5678"));

        // missing item → typed BadRequest, no panic
        let err = c.item_detail("user@proton.me", "Proton", "nope").unwrap_err();
        assert!(matches!(err.kind, ErrorKind::BadRequest));
    }

    #[test]
    fn item_totp_generates_six_digit_code_and_errors_without_secret() {
        let c = conn();
        let totp = c.item_totp("item-gh").unwrap();
        assert_eq!(totp.code.len(), 6);
        assert!(totp.code.chars().all(|ch| ch.is_ascii_digit()), "code: {}", totp.code);
        assert_eq!(totp.period, 30);
        assert!(totp.remaining >= 1 && totp.remaining <= 30);

        let err = c.item_totp("item-note").unwrap_err();
        assert!(matches!(err.kind, ErrorKind::BadRequest));
    }

    #[test]
    fn folders_are_vaults_and_collections_are_empty() {
        let c = conn();
        let folders = c.list_folders("user@proton.me", "Proton");
        let names: Vec<&str> = folders.iter().map(|f| f.name.as_str()).collect();
        assert_eq!(names, vec!["Personal", "Work"], "sorted by name");
        let personal = folders.iter().find(|f| f.name == "Personal").unwrap();
        assert_eq!(personal.id.as_deref(), Some("share-personal"), "folder id = shareId");
        assert_eq!(personal.account_email, "user@proton.me");

        assert!(c.list_collections("user@proton.me", "Proton").is_empty());
    }

    #[test]
    fn custom_field_names_are_sorted_deduped_names_only() {
        let c = conn();
        assert_eq!(c.custom_field_names(), vec!["API Key".to_string(), "Plan".to_string()]);
    }

    #[test]
    fn count_password_use_ignores_deleted_and_empty() {
        let c = conn();
        // "hunter2" is used by item-gh (live) and item-old (deleted) → only live counts.
        assert_eq!(c.count_password_use("hunter2"), 1);
        assert_eq!(c.count_password_use("not-used"), 0);
        assert_eq!(c.count_password_use(""), 0);
    }

    #[test]
    fn autofill_entries_are_live_logins_only_with_all_urls() {
        let c = conn();
        let matches = c.autofill_entries("user@proton.me", "Proton");
        // item-gh only: the note is not a login, item-old is deleted.
        assert_eq!(matches.len(), 1);
        let gh = &matches[0];
        assert_eq!(gh.id, "item-gh");
        assert_eq!(gh.username.as_deref(), Some("octocat"));
        assert_eq!(gh.uris, vec!["https://github.com/login".to_string(), "https://github.com".to_string()]);
        assert!(!gh.reprompt);
    }

    // ── the stubs are honest (typed errors, never panic, never fake success) ──

    #[tokio::test]
    async fn open_is_not_yet_implemented() {
        let err = ProtonConnection::open(
            "user@proton.me",
            Zeroizing::new("pw".to_string()),
            None,
        )
        .await
        .unwrap_err();
        assert!(matches!(err.kind, ErrorKind::Internal));
        assert!(err.message.contains("not yet implemented"), "got: {}", err.message);
    }

    #[tokio::test]
    async fn reload_is_not_yet_implemented() {
        let mut c = conn();
        let err = c.reload().await.unwrap_err();
        assert!(matches!(err.kind, ErrorKind::Internal));
    }

    #[test]
    fn stubbed_crypto_steps_return_typed_errors() {
        let salt_err = derive_user_key_passphrase(&Zeroizing::new("pw".into()), "c2FsdA==").unwrap_err();
        assert!(matches!(salt_err.kind, ErrorKind::Internal));
        let dec_err = decrypt_item_blob(&Zeroizing::new(vec![0u8; 32]), &[], &[]).unwrap_err();
        assert!(matches!(dec_err.kind, ErrorKind::Internal));
        let parse_err = parse_item_content("s", "i", &[]).unwrap_err();
        assert!(matches!(parse_err.kind, ErrorKind::Internal));
    }

    /// VaultCache zeroizes login secrets on drop (smoke: building + dropping a
    /// cache with secrets must not panic; Drop runs the zeroize path).
    #[test]
    fn vault_cache_drop_runs_without_panic() {
        let cache = cache();
        drop(cache);
    }

    /// Debug never leaks the email-less internals beyond counts (no tokens/items).
    #[test]
    fn debug_is_redacted() {
        let dbg = format!("{:?}", conn());
        assert!(dbg.contains("ProtonConnection"));
        assert!(!dbg.contains("hunter2"), "must never print secrets");
    }
}
