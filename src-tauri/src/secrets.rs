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

use aes_gcm::aead::{Aead, KeyInit, Payload};
use aes_gcm::{Aes256Gcm, Nonce};
use argon2::{Algorithm, Argon2, Params, Version};
use base64::Engine;
use rand::RngCore;
use serde::{Deserialize, Serialize};
use zeroize::{Zeroize, Zeroizing};

use crate::dto::ServerConfig;
use crate::error::{AgateError, AgateResult, ErrorKind};

const KEYRING_SERVICE: &str = "com.agate.desktop";
/// Bumped from the original local-unlock blob (v1) to the AUK model.
pub const BLOB_VERSION: u32 = 2;

/// Fixed keychain entry name for the app-unlock descriptor.
pub const APP_UNLOCK_KEY: &str = "app-unlock";
/// Fixed keychain entry name for the (DPAPI-wrapped) Hello-released AUK.
pub const HELLO_AUK_KEY: &str = "hello-auk";
/// Fixed keychain entry name for the device pepper — a random secret that mixes
/// into the AUK derivation when the user binds unlock to this machine. Because the
/// keychain entry is OS-protected (DPAPI / Keychain / secret-service) to this user
/// on this machine, a copied `app-unlock` blob can't be unlocked elsewhere even
/// with the right app password.
pub const DEVICE_PEPPER_KEY: &str = "device-pepper";

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
    b64().encode(bytes)
}

/// Base64-decode, mapping a malformed value to a `Crypto` error.
pub fn decode_b64(s: &str) -> AgateResult<Vec<u8>> {
    b64()
        .decode(s)
        .map_err(|_| AgateError::new(ErrorKind::Crypto, "corrupt base64"))
}

/// Derive the App Unlock Key from the app password with Argon2id. CPU-bound and
/// synchronous — callers run it inside `spawn_blocking`.
///
/// `pepper` is an optional device-bound secret keyed into Argon2 (the "secret"
/// parameter). When present, the derived key depends on both the password and the
/// pepper, so the wrapped VMK is unusable without the device's keychain entry.
pub fn derive_auk(
    password: &str,
    salt: &[u8],
    m: u32,
    t: u32,
    p: u32,
    pepper: Option<&[u8]>,
) -> AgateResult<Zeroizing<[u8; 32]>> {
    let params = Params::new(m, t, p, Some(32))
        .map_err(|e| AgateError::new(ErrorKind::Crypto, format!("argon2 params: {e}")))?;
    let argon = match pepper {
        Some(secret) => Argon2::new_with_secret(secret, Algorithm::Argon2id, Version::V0x13, params)
            .map_err(|e| AgateError::new(ErrorKind::Crypto, format!("argon2 secret: {e}")))?,
        None => Argon2::new(Algorithm::Argon2id, Version::V0x13, params),
    };
    let mut key = Zeroizing::new([0u8; 32]);
    argon
        .hash_password_into(password.as_bytes(), salt, &mut *key)
        .map_err(|e| AgateError::new(ErrorKind::Crypto, format!("argon2 derive: {e}")))?;
    Ok(key)
}

/// Generate a fresh 32-byte device pepper (machine-binding secret).
pub fn fresh_pepper() -> Zeroizing<[u8; 32]> {
    let mut p = Zeroizing::new([0u8; 32]);
    rand::thread_rng().fill_bytes(&mut *p);
    p
}

/// Generate a fresh 16-byte Argon2 salt.
pub fn fresh_salt() -> [u8; 16] {
    let mut salt = [0u8; 16];
    rand::thread_rng().fill_bytes(&mut salt);
    salt
}

/// AAD for the AUK-wrapped VMK — binds it to the version, service, KDF params, and
/// (when set) the device-binding flag, so a KDF-parameter downgrade or an attempt
/// to strip the device binding fails the tag. The non-device-bound form keeps the
/// original (pre-binding) byte string so existing blobs still open.
pub fn app_unlock_aad(m: u32, t: u32, p: u32, device_bound: bool) -> Vec<u8> {
    let base = format!("{KEYRING_SERVICE}|v{BLOB_VERSION}|app-unlock|m{m}t{t}p{p}");
    if device_bound {
        format!("{base}|device").into_bytes()
    } else {
        base.into_bytes()
    }
}

/// AAD for a `cred:<email>` blob — binds it to the account email, so a swapped
/// credential blob (re-pointing one account's secret at another) fails the tag.
pub fn cred_aad(email: &str) -> Vec<u8> {
    format!("{KEYRING_SERVICE}|v{BLOB_VERSION}|cred|{email}").into_bytes()
}

fn cipher_for(key: &[u8; 32]) -> AgateResult<Aes256Gcm> {
    Aes256Gcm::new_from_slice(key).map_err(|_| AgateError::new(ErrorKind::Crypto, "bad key length"))
}

/// Seal `plaintext` under `key` with AES-256-GCM and the given AAD.
pub fn seal_with_key(key: &[u8; 32], plaintext: &[u8], aad: &[u8]) -> AgateResult<SealedBlob> {
    let mut nonce_bytes = [0u8; 12];
    rand::thread_rng().fill_bytes(&mut nonce_bytes);
    let cipher = cipher_for(key)?;
    let nonce = Nonce::from(nonce_bytes);
    let ciphertext = cipher
        .encrypt(&nonce, Payload { msg: plaintext, aad })
        .map_err(|_| AgateError::new(ErrorKind::Crypto, "seal failed"))?;
    Ok(SealedBlob {
        nonce: b64().encode(nonce_bytes),
        ciphertext: b64().encode(ciphertext),
    })
}

/// Open a `SealedBlob` under `key` with the given AAD. A GCM-tag failure (wrong
/// key, tampered ciphertext, or mismatched AAD) returns `ErrorKind::Crypto`;
/// callers reclassify (e.g. the verifier path maps it to "incorrect app password").
pub fn open_with_key(
    key: &[u8; 32],
    blob: &SealedBlob,
    aad: &[u8],
) -> AgateResult<Zeroizing<Vec<u8>>> {
    let nonce_vec = b64()
        .decode(&blob.nonce)
        .map_err(|_| AgateError::new(ErrorKind::Crypto, "corrupt nonce"))?;
    let nonce_bytes: [u8; 12] = nonce_vec
        .as_slice()
        .try_into()
        .map_err(|_| AgateError::new(ErrorKind::Crypto, "corrupt nonce"))?;
    let ciphertext = b64()
        .decode(&blob.ciphertext)
        .map_err(|_| AgateError::new(ErrorKind::Crypto, "corrupt ciphertext"))?;
    let cipher = cipher_for(key)?;
    let nonce = Nonce::from(nonce_bytes);
    let plaintext = cipher
        .decrypt(&nonce, Payload { msg: ciphertext.as_ref(), aad })
        .map_err(|_| AgateError::new(ErrorKind::Crypto, "decryption failed (wrong key or tampered)"))?;
    Ok(Zeroizing::new(plaintext))
}

// ---------------------------------------------------------------------------
// Keychain access (generalized over an arbitrary entry key).
// ---------------------------------------------------------------------------

fn entry(key: &str) -> AgateResult<keyring::Entry> {
    keyring::Entry::new(KEYRING_SERVICE, key)
        .map_err(|e| AgateError::new(ErrorKind::Keychain, format!("keychain entry: {e}")))
}

fn store_string(key: &str, value: &str) -> AgateResult<()> {
    entry(key)?
        .set_password(value)
        .map_err(|e| AgateError::new(ErrorKind::Keychain, format!("keychain write: {e}")))
}

/// Read a keychain string. `Ok(None)` == absent; an `Err` == a real keychain
/// failure (never silently swallowed) so callers distinguish absent from broken.
fn load_string(key: &str) -> AgateResult<Option<String>> {
    match entry(key)?.get_password() {
        Ok(s) => Ok(Some(s)),
        Err(keyring::Error::NoEntry) => Ok(None),
        Err(e) => Err(AgateError::new(ErrorKind::Keychain, format!("keychain read: {e}"))),
    }
}

/// Delete a keychain entry; absent is success (idempotent).
pub fn delete_key(key: &str) -> AgateResult<()> {
    match entry(key)?.delete_credential() {
        Ok(()) => Ok(()),
        Err(keyring::Error::NoEntry) => Ok(()),
        Err(e) => Err(AgateError::new(ErrorKind::Keychain, format!("keychain delete: {e}"))),
    }
}

// ---- typed helpers ----

pub fn store_app_unlock(blob: &AppUnlockBlob) -> AgateResult<()> {
    let json = serde_json::to_string(blob)
        .map_err(|e| AgateError::internal(format!("serialize app-unlock: {e}")))?;
    store_string(APP_UNLOCK_KEY, &json)
}

pub fn load_app_unlock() -> AgateResult<Option<AppUnlockBlob>> {
    match load_string(APP_UNLOCK_KEY)? {
        Some(json) => {
            let blob = serde_json::from_str(&json)
                .map_err(|e| AgateError::new(ErrorKind::Keychain, format!("corrupt app-unlock: {e}")))?;
            Ok(Some(blob))
        }
        None => Ok(None),
    }
}

pub fn store_cred(email: &str, blob: &SealedBlob) -> AgateResult<()> {
    let json = serde_json::to_string(blob)
        .map_err(|e| AgateError::internal(format!("serialize cred: {e}")))?;
    store_string(&cred_key(email), &json)
}

/// Load a sealed credential blob. `Ok(None)` == not enrolled; a parse failure is a
/// loud `Keychain` error (corrupt), never treated as absent.
pub fn load_cred(email: &str) -> AgateResult<Option<SealedBlob>> {
    match load_string(&cred_key(email))? {
        Some(json) => {
            let blob = serde_json::from_str(&json)
                .map_err(|e| AgateError::new(ErrorKind::Keychain, format!("corrupt cred blob: {e}")))?;
            Ok(Some(blob))
        }
        None => Ok(None),
    }
}

pub fn delete_cred(email: &str) -> AgateResult<()> {
    delete_key(&cred_key(email))
}

/// Store the Hello-released AUK material (already DPAPI-wrapped by the caller),
/// base64-encoded.
pub fn store_hello_blob(wrapped: &[u8]) -> AgateResult<()> {
    store_string(HELLO_AUK_KEY, &b64().encode(wrapped))
}

pub fn load_hello_blob() -> AgateResult<Option<Vec<u8>>> {
    match load_string(HELLO_AUK_KEY)? {
        Some(s) => {
            let bytes = b64()
                .decode(&s)
                .map_err(|_| AgateError::new(ErrorKind::Keychain, "corrupt hello blob"))?;
            Ok(Some(bytes))
        }
        None => Ok(None),
    }
}

pub fn delete_hello_blob() -> AgateResult<()> {
    delete_key(HELLO_AUK_KEY)
}

/// Store the device pepper (base64). Machine binding ties the keychain entry to
/// this user/machine, so the wrapped VMK can't be derived on another device.
pub fn store_device_pepper(pepper: &[u8]) -> AgateResult<()> {
    store_string(DEVICE_PEPPER_KEY, &b64().encode(pepper))
}

/// Load the device pepper. `Ok(None)` == not bound; a parse failure is a loud
/// `Keychain` error (corrupt), never silently treated as absent.
pub fn load_device_pepper() -> AgateResult<Option<Zeroizing<Vec<u8>>>> {
    match load_string(DEVICE_PEPPER_KEY)? {
        Some(s) => {
            let bytes = b64()
                .decode(&s)
                .map_err(|_| AgateError::new(ErrorKind::Keychain, "corrupt device pepper"))?;
            Ok(Some(Zeroizing::new(bytes)))
        }
        None => Ok(None),
    }
}

pub fn delete_device_pepper() -> AgateResult<()> {
    delete_key(DEVICE_PEPPER_KEY)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn test_key() -> [u8; 32] {
        let mut k = [0u8; 32];
        for (i, b) in k.iter_mut().enumerate() {
            *b = i as u8;
        }
        k
    }

    #[test]
    fn seal_then_open_roundtrips_with_aad() {
        let key = test_key();
        let aad = cred_aad("alice@example.com");
        let secret = b"super-secret-master-password";
        let blob = seal_with_key(&key, secret, &aad).expect("seal");
        let opened = open_with_key(&key, &blob, &aad).expect("open");
        assert_eq!(opened.as_slice(), secret);
    }

    #[test]
    fn wrong_aad_fails_the_tag() {
        let key = test_key();
        let blob = seal_with_key(&key, b"x", &cred_aad("alice@example.com")).expect("seal");
        // Same key, different AAD (swapped account, or wrong blob type) must fail.
        assert!(open_with_key(&key, &blob, &cred_aad("bob@example.com")).is_err());
        assert!(open_with_key(&key, &blob, &app_unlock_aad(256, 1, 1, false)).is_err());
    }

    #[test]
    fn wrong_key_fails() {
        let aad = app_unlock_aad(ARGON_M_COST, ARGON_T_COST, ARGON_P_COST, false);
        let blob = seal_with_key(&test_key(), b"wrapped-vmk", &aad).expect("seal");
        let mut other = test_key();
        other[0] ^= 0xff;
        assert!(open_with_key(&other, &blob, &aad).is_err());
    }

    #[test]
    fn derive_auk_is_deterministic_for_same_inputs() {
        let salt = [7u8; 16];
        let a = derive_auk("app-pw", &salt, 256, 1, 1, None).expect("derive");
        let b = derive_auk("app-pw", &salt, 256, 1, 1, None).expect("derive");
        assert_eq!(*a, *b);
        let c = derive_auk("other-pw", &salt, 256, 1, 1, None).expect("derive");
        assert_ne!(*a, *c);
    }

    #[test]
    fn device_pepper_changes_the_derived_key() {
        let salt = [9u8; 16];
        let pepper = [3u8; 32];
        let plain = derive_auk("app-pw", &salt, 256, 1, 1, None).expect("derive");
        let bound = derive_auk("app-pw", &salt, 256, 1, 1, Some(&pepper)).expect("derive");
        // Same password + salt but a pepper yields a different key (machine binding).
        assert_ne!(*plain, *bound);
        // Deterministic for the same pepper; different for a different pepper.
        let bound2 = derive_auk("app-pw", &salt, 256, 1, 1, Some(&pepper)).expect("derive");
        assert_eq!(*bound, *bound2);
        let other = derive_auk("app-pw", &salt, 256, 1, 1, Some(&[4u8; 32])).expect("derive");
        assert_ne!(*bound, *other);
    }

    #[test]
    fn device_binding_changes_the_aad() {
        // Stripping the device-bound flag changes the AAD, so a device-bound blob
        // can't be opened as if it were a plain one (and vice versa).
        assert_ne!(app_unlock_aad(256, 1, 1, true), app_unlock_aad(256, 1, 1, false));
        // The non-device-bound form is byte-identical to the original (pre-binding)
        // AAD so existing blobs still open.
        assert_eq!(
            app_unlock_aad(256, 1, 1, false),
            format!("{KEYRING_SERVICE}|v{BLOB_VERSION}|app-unlock|m256t1p1").into_bytes(),
        );
    }
}
