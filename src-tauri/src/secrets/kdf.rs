//! App Unlock Key derivation (Argon2id) and the random salt / device-pepper
//! generators that feed it.

use argon2::{Algorithm, Argon2, Params, Version};
use rand::RngCore;
use zeroize::Zeroizing;

use crate::error::{AgateError, AgateResult, ErrorKind};

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

#[cfg(test)]
mod tests {
    use super::*;

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
}
