//! Local-unlock secret storage — the crypto Agate owns.
//!
//! We take a secret (the Bitwarden session key, base64), derive a wrapping key
//! from the user's *local* password with Argon2id, and seal the secret with
//! AES-256-GCM. The sealed blob (+ salt + KDF params + nonce) lives in the OS
//! keychain. The master password is never involved here and never stored.
//!
//! A wrong local password fails the GCM authentication tag, so we never persist
//! a plaintext verifier — the AEAD *is* the verifier.

use aes_gcm::aead::{Aead, KeyInit};
use aes_gcm::{Aes256Gcm, Nonce};
use argon2::{Algorithm, Argon2, Params, Version};
use base64::Engine;
use rand::RngCore;
use serde::{Deserialize, Serialize};
use zeroize::Zeroize;

use crate::error::{AgateError, AgateResult, ErrorKind};

const KEYRING_SERVICE: &str = "com.agate.desktop";
const BLOB_VERSION: u32 = 1;

// Argon2id parameters (memory in KiB). Tuned for an interactive desktop unlock.
const ARGON_M_COST: u32 = 65_536; // 64 MiB
const ARGON_T_COST: u32 = 3;
const ARGON_P_COST: u32 = 1;

/// The sealed local-unlock blob persisted in the keychain.
#[derive(Debug, Serialize, Deserialize)]
pub struct LocalUnlockBlob {
    pub version: u32,
    pub kdf_salt: String,   // base64
    pub m_cost: u32,
    pub t_cost: u32,
    pub p_cost: u32,
    pub nonce: String,      // base64, 12 bytes
    pub ciphertext: String, // base64 (includes GCM tag)
}

fn b64() -> base64::engine::general_purpose::GeneralPurpose {
    base64::engine::general_purpose::STANDARD
}

fn derive_key(password: &str, salt: &[u8], m: u32, t: u32, p: u32) -> AgateResult<[u8; 32]> {
    let params = Params::new(m, t, p, Some(32))
        .map_err(|e| AgateError::new(ErrorKind::Crypto, format!("argon2 params: {e}")))?;
    let argon = Argon2::new(Algorithm::Argon2id, Version::V0x13, params);
    let mut key = [0u8; 32];
    argon
        .hash_password_into(password.as_bytes(), salt, &mut key)
        .map_err(|e| AgateError::new(ErrorKind::Crypto, format!("argon2 derive: {e}")))?;
    Ok(key)
}

/// Seal `secret` under `local_password` and return the blob to persist.
pub fn seal(secret: &[u8], local_password: &str) -> AgateResult<LocalUnlockBlob> {
    let mut rng = rand::thread_rng();
    let mut salt = [0u8; 16];
    let mut nonce_bytes = [0u8; 12];
    rng.fill_bytes(&mut salt);
    rng.fill_bytes(&mut nonce_bytes);

    let mut key = derive_key(local_password, &salt, ARGON_M_COST, ARGON_T_COST, ARGON_P_COST)?;
    let cipher = Aes256Gcm::new_from_slice(&key)
        .map_err(|_| AgateError::new(ErrorKind::Crypto, "bad key length"))?;
    key.zeroize();
    let nonce = Nonce::from(nonce_bytes);
    let ciphertext = cipher
        .encrypt(&nonce, secret)
        .map_err(|_| AgateError::new(ErrorKind::Crypto, "seal failed"))?;

    Ok(LocalUnlockBlob {
        version: BLOB_VERSION,
        kdf_salt: b64().encode(salt),
        m_cost: ARGON_M_COST,
        t_cost: ARGON_T_COST,
        p_cost: ARGON_P_COST,
        nonce: b64().encode(nonce_bytes),
        ciphertext: b64().encode(ciphertext),
    })
}

/// Open a sealed blob with `local_password`. Wrong password → `ErrorKind::LocalUnlock`.
pub fn open(blob: &LocalUnlockBlob, local_password: &str) -> AgateResult<Vec<u8>> {
    if blob.version != BLOB_VERSION {
        return Err(AgateError::new(ErrorKind::LocalUnlock, "unsupported blob version"));
    }
    let salt = b64()
        .decode(&blob.kdf_salt)
        .map_err(|_| AgateError::new(ErrorKind::LocalUnlock, "corrupt salt"))?;
    let nonce_vec = b64()
        .decode(&blob.nonce)
        .map_err(|_| AgateError::new(ErrorKind::LocalUnlock, "corrupt nonce"))?;
    let nonce_bytes: [u8; 12] = nonce_vec
        .as_slice()
        .try_into()
        .map_err(|_| AgateError::new(ErrorKind::LocalUnlock, "corrupt nonce"))?;
    let ciphertext = b64()
        .decode(&blob.ciphertext)
        .map_err(|_| AgateError::new(ErrorKind::LocalUnlock, "corrupt ciphertext"))?;

    let mut key = derive_key(local_password, &salt, blob.m_cost, blob.t_cost, blob.p_cost)?;
    let cipher = Aes256Gcm::new_from_slice(&key)
        .map_err(|_| AgateError::new(ErrorKind::Crypto, "bad key length"))?;
    key.zeroize();
    let nonce = Nonce::from(nonce_bytes);
    // GCM tag failure == wrong local password (or tampered blob).
    cipher
        .decrypt(&nonce, ciphertext.as_ref())
        .map_err(|_| AgateError::new(ErrorKind::LocalUnlock, "Incorrect local password."))
}

fn entry(account: &str) -> AgateResult<keyring::Entry> {
    keyring::Entry::new(KEYRING_SERVICE, account)
        .map_err(|e| AgateError::new(ErrorKind::Keychain, format!("keychain entry: {e}")))
}

/// Store the sealed blob in the OS keychain, keyed by account email.
pub fn store_blob(account: &str, blob: &LocalUnlockBlob) -> AgateResult<()> {
    let json = serde_json::to_string(blob)
        .map_err(|e| AgateError::internal(format!("serialize blob: {e}")))?;
    entry(account)?
        .set_password(&json)
        .map_err(|e| AgateError::new(ErrorKind::Keychain, format!("keychain write: {e}")))
}

/// Load the sealed blob from the keychain, if present.
pub fn load_blob(account: &str) -> AgateResult<Option<LocalUnlockBlob>> {
    match entry(account)?.get_password() {
        Ok(json) => {
            let blob = serde_json::from_str(&json)
                .map_err(|e| AgateError::new(ErrorKind::Keychain, format!("corrupt blob: {e}")))?;
            Ok(Some(blob))
        }
        Err(keyring::Error::NoEntry) => Ok(None),
        Err(e) => Err(AgateError::new(ErrorKind::Keychain, format!("keychain read: {e}"))),
    }
}

/// Remove the sealed blob from the keychain (disable local unlock / logout).
pub fn delete_blob(account: &str) -> AgateResult<()> {
    match entry(account)?.delete_credential() {
        Ok(()) => Ok(()),
        Err(keyring::Error::NoEntry) => Ok(()),
        Err(e) => Err(AgateError::new(ErrorKind::Keychain, format!("keychain delete: {e}"))),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn seal_then_open_roundtrips() {
        let secret = b"super-secret-session-key-material";
        let blob = seal(secret, "local-pw").expect("seal");
        let opened = open(&blob, "local-pw").expect("open");
        assert_eq!(opened, secret);
    }

    #[test]
    fn wrong_password_fails_with_local_unlock_kind() {
        let blob = seal(b"x", "right").expect("seal");
        let err = open(&blob, "wrong").expect_err("must fail");
        assert!(matches!(err.kind, ErrorKind::LocalUnlock));
    }
}
