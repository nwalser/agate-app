//! Local secret storage — the crypto Agate owns for the unified app-unlock.
//!
//! Model (see `appunlock.rs` for the flow) — a KEK/DEK envelope:
//! * a random **Vault Master Key (VMK)** is the data key; it seals every
//!   connection's master password into `cred:<email>` and is stable for the life
//!   of the install.
//! * the user's single app password derives an **App Unlock Key (AUK)** with
//!   Argon2id; the AUK only *wraps the VMK*. The `app-unlock` keychain entry holds
//!   the KDF params + the AUK-wrapped VMK. Opening it (GCM tag) proves the app
//!   password — no separate verifier needed.
//!
//! Changing the app password re-wraps the VMK alone (one atomic keychain write);
//! the per-connection blobs never move, so a password change can't half-rekey the
//! credential store. Windows Hello stores a DPAPI-wrapped copy of the VMK,
//! released after a consent check.
//!
//! ⚠️ Security posture (inverted from the original local-unlock design): to
//! deliver "one unlock opens every vault and survives restart", the per-connection
//! **master password is persisted** (sealed, never in plaintext). This is forced
//! by the SDK at the pinned rev — token injection is `pub(crate)`, so a restored
//! session must re-login, which needs the password. See CLAUDE.md and
//! `appunlock.rs`. Hardening: Argon2id-derived key, AES-256-GCM with **AAD** that
//! binds each blob to its identity (version, service, account, type, KDF params,
//! AUK epoch) so a swapped / rolled-back / KDF-downgraded blob fails the tag.
//!
//! A wrong app password fails the GCM authentication tag, so we never persist a
//! plaintext check value — the AEAD *is* the verifier.
//!
//! Module layout (the envelope is one responsibility, split by concern):
//! - [`kdf`] — Argon2id App Unlock Key derivation + salt/pepper generation.
//! - [`aad`] — the additional-authenticated-data byte strings that bind each blob.
//! - [`envelope`] — AES-256-GCM seal / open.
//! - [`keychain`] — OS keychain access + the typed store/load/delete helpers.

use serde::{Deserialize, Serialize};
use zeroize::Zeroize;

use crate::dto::ServerConfig;
use crate::error::{AgateError, AgateResult, ErrorKind};

mod aad;
mod envelope;
mod kdf;
mod keychain;

// Flat re-export: every existing `crate::secrets::X` keeps resolving unchanged.
pub use aad::{app_unlock_aad, cred_aad, scan_cache_aad};
pub use envelope::{open_with_key, seal_with_key};
pub use kdf::{derive_auk, fresh_pepper, fresh_salt};
pub use keychain::{
    delete_ai_token, delete_cred, delete_device_pepper, delete_hello_blob, delete_key,
    delete_scan_cache, load_ai_token, load_app_unlock, load_cred, load_device_pepper,
    load_hello_blob, load_scan_cache, store_ai_token, store_app_unlock, store_cred,
    store_device_pepper, store_hello_blob, store_scan_cache,
};

const KEYRING_SERVICE: &str = "com.agate.desktop";
/// Bumped from the original local-unlock blob (v1) to the AUK model.
pub const BLOB_VERSION: u32 = 2;

/// Fixed keychain entry name for the app-unlock descriptor.
pub const APP_UNLOCK_KEY: &str = "app-unlock";
/// Fixed keychain entry name for the (DPAPI-wrapped) Hello-released AUK.
pub const HELLO_AUK_KEY: &str = "hello-auk";
/// Fixed keychain entry name for the cached breach/exposed scan results, sealed
/// under the VMK (the results carry the user's emails + which breaches they're in
/// — PII, so they're encrypted at rest like every other secret, never plaintext).
pub const SCAN_CACHE_KEY: &str = "scan-cache";
/// Fixed keychain entry name for the device pepper — a random secret that mixes
/// into the AUK derivation when the user binds unlock to this machine. Because the
/// keychain entry is OS-protected (DPAPI / Keychain / secret-service) to this user
/// on this machine, a copied `app-unlock` blob can't be unlocked elsewhere even
/// with the right app password.
pub const DEVICE_PEPPER_KEY: &str = "device-pepper";
/// Fixed keychain entry name for the local MCP server's bearer token. The token
/// gates the loopback AI-access endpoint, so it is a capability secret: stored in
/// the OS keychain (never `config.json`), generated on first enable.
pub const AI_TOKEN_KEY: &str = "ai-mcp-token";

/// Keychain entry name for a connection's sealed master password.
pub fn cred_key(email: &str) -> String {
    format!("cred:{email}")
}

// Argon2id parameters (memory in KiB). Tuned for an interactive desktop unlock.
pub const ARGON_M_COST: u32 = 65_536; // 64 MiB
pub const ARGON_T_COST: u32 = 3;
pub const ARGON_P_COST: u32 = 1;

/// A value sealed under a 32-byte key with AES-256-GCM (+ AAD). No KDF params:
/// the key (the AUK) is supplied by the caller, not derived per-blob.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SealedBlob {
    pub nonce: String,      // base64, 12 bytes
    pub ciphertext: String, // base64 (includes the GCM tag)
}

/// The `app-unlock` keychain descriptor: KDF params + the AUK-wrapped VMK.
/// Unwrapping the VMK with a candidate AUK (GCM tag) proves the app password.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AppUnlockBlob {
    pub version: u32,
    pub kdf_salt: String, // base64, 16 bytes
    pub m_cost: u32,
    pub t_cost: u32,
    pub p_cost: u32,
    /// Whether the AUK derivation mixes in the device pepper (machine binding).
    /// Defaults false so pre-binding blobs keep the original AAD and still open.
    #[serde(default)]
    pub device_bound: bool,
    pub sealed_vmk: SealedBlob,
}

/// A connection's persisted credentials, sealed under the AUK into `cred:<email>`.
/// `master_password` is zeroized on drop; the `Drop` impl forbids moving it out,
/// so callers clone it for the one-shot SDK login (the SDK's own copy is outside
/// our control and is the documented unavoidable residue).
#[derive(Serialize, Deserialize)]
pub struct StoredConnection {
    pub server: ServerConfig,
    pub email: String,
    pub master_password: String,
}

impl Drop for StoredConnection {
    fn drop(&mut self) {
        self.master_password.zeroize();
    }
}

fn b64() -> base64::engine::general_purpose::GeneralPurpose {
    base64::engine::general_purpose::STANDARD
}

/// Base64-encode bytes (for storing salts / wrapped keys in keychain JSON).
pub fn encode_b64(bytes: &[u8]) -> String {
    use base64::Engine;
    b64().encode(bytes)
}

/// Base64-decode, mapping a malformed value to a `Crypto` error.
pub fn decode_b64(s: &str) -> AgateResult<Vec<u8>> {
    use base64::Engine;
    b64()
        .decode(s)
        .map_err(|_| AgateError::new(ErrorKind::Crypto, "corrupt base64"))
}
