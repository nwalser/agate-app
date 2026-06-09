//! AES-256-GCM seal / open. The key (the AUK or the VMK) is supplied by the
//! caller; AAD authenticates the blob's identity. A GCM-tag failure (wrong key,
//! tampered ciphertext, or mismatched AAD) is the verifier — no plaintext check
//! value is ever stored.

use aes_gcm::aead::{Aead, KeyInit, Payload};
use aes_gcm::{Aes256Gcm, Nonce};
use base64::Engine;
use rand::RngCore;
use zeroize::Zeroizing;

use super::{b64, SealedBlob};
use crate::error::{AgateError, AgateResult, ErrorKind};

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

#[cfg(test)]
mod tests {
    use super::*;
    use crate::secrets::{app_unlock_aad, cred_aad, ARGON_M_COST, ARGON_P_COST, ARGON_T_COST};

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
}
