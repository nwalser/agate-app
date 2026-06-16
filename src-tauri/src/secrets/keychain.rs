//! OS keychain access (keyring) generalized over an arbitrary entry key, plus the
//! typed store/load/delete helpers for each blob kind. Reads distinguish "absent"
//! (`Ok(None)`) from a real keychain failure or a corrupt value (a loud `Err`), so
//! callers never silently treat broken storage as not-enrolled.
//!
//! The PRIMITIVE layer (string store/load/delete) routes through a swappable
//! [`SecretBackend`]: the OS keychain in the app, an in-memory map in tests —
//! which makes the unlock-envelope ORCHESTRATION (configure → seal creds →
//! change password → verify) integration-testable without a real keychain.
//! The swap hook is `#[cfg(test)]`-only, so no alternate backend can ship.

use std::sync::{Arc, OnceLock, RwLock};

use base64::Engine;
use zeroize::Zeroizing;

use super::{
    b64, cred_key, AppUnlockBlob, SealedBlob, APP_UNLOCK_KEY, DEVICE_PEPPER_KEY,
    HELLO_AUK_KEY, KEYRING_SERVICE,
};
use crate::error::{AgateError, AgateResult, ErrorKind};

/// Primitive secret storage: keyed strings, absent ≠ broken.
pub trait SecretBackend: Send + Sync {
    fn store(&self, key: &str, value: &str) -> AgateResult<()>;
    /// `Ok(None)` == absent; `Err` == a real storage failure.
    fn load(&self, key: &str) -> AgateResult<Option<String>>;
    /// Absent is success (idempotent).
    fn delete(&self, key: &str) -> AgateResult<()>;
}

/// The OS keychain (keyring crate) — the only backend outside tests.
struct KeyringBackend;

impl KeyringBackend {
    fn entry(&self, key: &str) -> AgateResult<keyring::Entry> {
        keyring::Entry::new(KEYRING_SERVICE, key)
            .map_err(|e| AgateError::new(ErrorKind::Keychain, format!("keychain entry: {e}")))
    }
}

impl SecretBackend for KeyringBackend {
    fn store(&self, key: &str, value: &str) -> AgateResult<()> {
        self.entry(key)?
            .set_password(value)
            .map_err(|e| AgateError::new(ErrorKind::Keychain, format!("keychain write: {e}")))
    }
    fn load(&self, key: &str) -> AgateResult<Option<String>> {
        match self.entry(key)?.get_password() {
            Ok(s) => Ok(Some(s)),
            Err(keyring::Error::NoEntry) => Ok(None),
            Err(e) => Err(AgateError::new(ErrorKind::Keychain, format!("keychain read: {e}"))),
        }
    }
    fn delete(&self, key: &str) -> AgateResult<()> {
        match self.entry(key)?.delete_credential() {
            Ok(()) => Ok(()),
            Err(keyring::Error::NoEntry) => Ok(()),
            Err(e) => Err(AgateError::new(ErrorKind::Keychain, format!("keychain delete: {e}"))),
        }
    }
}

static BACKEND: OnceLock<RwLock<Arc<dyn SecretBackend>>> = OnceLock::new();

fn backend_cell() -> &'static RwLock<Arc<dyn SecretBackend>> {
    BACKEND.get_or_init(|| RwLock::new(Arc::new(KeyringBackend)))
}

fn backend() -> Arc<dyn SecretBackend> {
    backend_cell().read().unwrap_or_else(std::sync::PoisonError::into_inner).clone()
}

fn store_string(key: &str, value: &str) -> AgateResult<()> {
    backend().store(key, value)
}

/// Read a keychain string. `Ok(None)` == absent; an `Err` == a real keychain
/// failure (never silently swallowed) so callers distinguish absent from broken.
fn load_string(key: &str) -> AgateResult<Option<String>> {
    backend().load(key)
}

/// Delete a keychain entry; absent is success (idempotent).
pub fn delete_key(key: &str) -> AgateResult<()> {
    backend().delete(key)
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

// ---- test backend (compiled out of every shipping build) ----

#[cfg(test)]
pub mod testing {
    use super::*;
    use std::collections::HashMap;
    use std::sync::Mutex;

    /// In-memory secret store for integration tests.
    #[derive(Default)]
    pub struct InMemoryBackend {
        map: Mutex<HashMap<String, String>>,
    }

    impl SecretBackend for InMemoryBackend {
        fn store(&self, key: &str, value: &str) -> AgateResult<()> {
            self.map
                .lock()
                .unwrap_or_else(std::sync::PoisonError::into_inner)
                .insert(key.to_string(), value.to_string());
            Ok(())
        }
        fn load(&self, key: &str) -> AgateResult<Option<String>> {
            Ok(self.map.lock().unwrap_or_else(std::sync::PoisonError::into_inner).get(key).cloned())
        }
        fn delete(&self, key: &str) -> AgateResult<()> {
            self.map.lock().unwrap_or_else(std::sync::PoisonError::into_inner).remove(key);
            Ok(())
        }
    }

    /// Held for the duration of a keychain-touching test: serializes such tests
    /// (they share the process-global backend) while a FRESH in-memory store is
    /// installed. The store is left in place on drop — unit tests must never
    /// touch the real OS keychain, even between guards.
    pub struct KeychainTestGuard(#[allow(dead_code)] std::sync::MutexGuard<'static, ()>);

    pub fn install_in_memory_keychain() -> KeychainTestGuard {
        static TEST_LOCK: Mutex<()> = Mutex::new(());
        let guard = TEST_LOCK.lock().unwrap_or_else(std::sync::PoisonError::into_inner);
        *backend_cell().write().unwrap_or_else(std::sync::PoisonError::into_inner) =
            Arc::new(InMemoryBackend::default());
        KeychainTestGuard(guard)
    }
}
