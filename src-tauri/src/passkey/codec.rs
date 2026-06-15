//! Conversion between Agate's [`StoredPasskey`] and the `passkey` crate's
//! [`Passkey`], including the ES256 CoseKey ↔ PKCS#8 PEM bridge.
//!
//! `passkey-authenticator` stores the private key as a COSE key
//! (`coset::CoseKey`) and only supports ES256 (NIST P-256) by default, while
//! Agate persists it as PKCS#8 PEM (the KeePassXC-interoperable form). The
//! crate's own CoseKey↔key helpers are private, so the ES256 extraction here is
//! a faithful re-implementation of them (see `passkey-authenticator`'s
//! `private_key_from_cose_key` / `CoseKeyPair::from_secret_key`).

use coset::iana::{self, EnumI64};
use coset::{CoseKey, CoseKeyBuilder, Label, RegisteredLabel, RegisteredLabelWithPrivate};
use p256::ecdsa::SigningKey;
use p256::pkcs8::{DecodePrivateKey, EncodePrivateKey, LineEnding};
use p256::SecretKey;
use passkey_types::ctap2::make_credential::{
    PublicKeyCredentialRpEntity, PublicKeyCredentialUserEntity,
};
use passkey_types::Passkey;
use zeroize::Zeroizing;

use crate::error::{AgateError, AgateResult, ErrorKind};
use crate::passkey::{CoseAlgorithm, StoredPasskey};

/// The COSE algorithm of a key, if it is one Agate supports (only ES256, which
/// is also the only algorithm `passkey-authenticator` mints by default).
fn algorithm_of(key: &CoseKey) -> Option<CoseAlgorithm> {
    match key.alg {
        Some(RegisteredLabelWithPrivate::Assigned(iana::Algorithm::ES256)) => {
            Some(CoseAlgorithm::Es256)
        }
        _ => None,
    }
}

/// Extract the P-256 secret key from an ES256 EC2 [`CoseKey`].
fn secret_from_cose(key: &CoseKey) -> AgateResult<SecretKey> {
    if algorithm_of(key) != Some(CoseAlgorithm::Es256) {
        return Err(AgateError::bad_request("Only ES256 passkeys are supported."));
    }
    if !matches!(key.kty, RegisteredLabel::Assigned(iana::KeyType::EC2)) {
        return Err(AgateError::new(ErrorKind::Crypto, "passkey key is not an EC2 key"));
    }
    key.params
        .iter()
        .find_map(|(label, value)| {
            let Label::Int(i) = label else { return None };
            iana::Ec2KeyParameter::from_i64(*i)
                .filter(|p| *p == iana::Ec2KeyParameter::D)
                .and_then(|_| value.as_bytes())
                .and_then(|bytes| SecretKey::from_slice(bytes).ok())
        })
        .ok_or_else(|| AgateError::new(ErrorKind::Crypto, "passkey key has no private scalar"))
}

/// Build an ES256 EC2 private [`CoseKey`] from a P-256 secret key (mirrors the
/// crate's private `CoseKeyPair::from_secret_key`).
fn cose_from_secret(secret: &SecretKey) -> CoseKey {
    let point = SigningKey::from(secret).verifying_key().to_encoded_point(false);
    let x = point.x().map(|c| c.to_vec()).unwrap_or_default();
    let y = point.y().map(|c| c.to_vec()).unwrap_or_default();
    CoseKeyBuilder::new_ec2_priv_key(iana::EllipticCurve::P_256, x, y, secret.to_bytes().to_vec())
        .algorithm(iana::Algorithm::ES256)
        .build()
}

/// Serialize an ES256 CoseKey private key to PKCS#8 PEM (KeePassXC's form).
pub fn cose_key_to_pkcs8_pem(key: &CoseKey) -> AgateResult<Zeroizing<String>> {
    let secret = secret_from_cose(key)?;
    secret.to_pkcs8_pem(LineEnding::LF).map_err(|e| {
        AgateError::new(ErrorKind::Crypto, format!("could not encode passkey key: {e}"))
    })
}

/// Parse a PKCS#8 PEM private key back into an ES256 CoseKey.
pub fn pkcs8_pem_to_cose_key(pem: &str) -> AgateResult<CoseKey> {
    let secret = SecretKey::from_pkcs8_pem(pem).map_err(|e| {
        AgateError::new(ErrorKind::Crypto, format!("could not parse passkey key: {e}"))
    })?;
    Ok(cose_from_secret(&secret))
}

/// Convert a freshly-minted [`Passkey`] (plus the ceremony's user/rp entities)
/// into Agate's [`StoredPasskey`] for persistence.
pub fn passkey_to_stored(
    cred: &Passkey,
    user: &PublicKeyCredentialUserEntity,
    rp: &PublicKeyCredentialRpEntity,
) -> AgateResult<StoredPasskey> {
    let algorithm = algorithm_of(&cred.key)
        .ok_or_else(|| AgateError::bad_request("Only ES256 passkeys are supported."))?;
    let private_key_pem = cose_key_to_pkcs8_pem(&cred.key)?;
    Ok(StoredPasskey {
        credential_id: cred.credential_id.to_vec(),
        rp_id: rp.id.clone(),
        rp_name: rp.name.clone(),
        user_handle: user.id.to_vec(),
        user_name: user.name.clone(),
        user_display_name: user.display_name.clone(),
        algorithm,
        private_key_pem,
        sign_count: 0,
        created: String::new(),
        backup_eligible: true,
        backup_state: true,
    })
}

/// Reconstruct a [`Passkey`] from a stored credential for an assertion ceremony.
pub fn stored_to_passkey(stored: &StoredPasskey) -> AgateResult<Passkey> {
    if stored.algorithm != CoseAlgorithm::Es256 {
        return Err(AgateError::bad_request("Only ES256 passkeys are supported."));
    }
    Ok(Passkey {
        key: pkcs8_pem_to_cose_key(&stored.private_key_pem)?,
        credential_id: stored.credential_id.clone().into(),
        rp_id: stored.rp_id.clone(),
        user_handle: (!stored.user_handle.is_empty()).then(|| stored.user_handle.clone().into()),
        counter: None,
        extensions: Default::default(),
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use p256::ecdsa::signature::{Signer, Verifier};

    /// The CoseKey ↔ PKCS#8 PEM bridge must preserve the key: a signature made
    /// with the reconstructed key verifies under the original public key.
    #[test]
    fn cose_pkcs8_round_trip_preserves_the_signing_key() {
        let secret = SecretKey::random(&mut rand::thread_rng());
        let original_cose = cose_from_secret(&secret);

        // CoseKey -> PEM -> CoseKey
        let pem = cose_key_to_pkcs8_pem(&original_cose).unwrap();
        let restored_cose = pkcs8_pem_to_cose_key(&pem).unwrap();

        // Sign with the restored key, verify with the original public key.
        let restored_secret = secret_from_cose(&restored_cose).unwrap();
        let signing = SigningKey::from(&restored_secret);
        let message = b"agate passkey assertion target";
        let signature: p256::ecdsa::Signature = signing.sign(message);

        let verifying = SigningKey::from(&secret).verifying_key().to_owned();
        verifying.verify(message, &signature).expect("signature must verify");
    }

    #[test]
    fn non_es256_pem_round_trips_as_es256() {
        // sanity: a PEM produced by the bridge parses back and reports ES256.
        let secret = SecretKey::random(&mut rand::thread_rng());
        let pem = cose_key_to_pkcs8_pem(&cose_from_secret(&secret)).unwrap();
        let cose = pkcs8_pem_to_cose_key(&pem).unwrap();
        assert_eq!(algorithm_of(&cose), Some(CoseAlgorithm::Es256));
    }
}
