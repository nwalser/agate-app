//! OS keychain access (keyring) generalized over an arbitrary entry key, plus the
//! typed store/load/delete helpers for each blob kind. Reads distinguish "absent"
//! (`Ok(None)`) from a real keychain failure or a corrupt value (a loud `Err`), so
//! callers never silently treat broken storage as not-enrolled.

use base64::Engine;
use zeroize::Zeroizing;

use super::{
    b64, cred_key, AppUnlockBlob, SealedBlob, APP_UNLOCK_KEY, DEVICE_PEPPER_KEY, HELLO_AUK_KEY,
    KEYRING_SERVICE,
};
use crate::error::{AgateError, AgateResult, ErrorKind};

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
