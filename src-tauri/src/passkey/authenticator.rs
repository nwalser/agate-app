//! The CredentialStore adapter + ceremony entry points.
//!
//! This bridges `passkey-authenticator` (the provider-agnostic WebAuthn/CTAP2
//! ceremony + crypto core) to Agate's provider layer: [`ConnectionStore`]
//! implements the crate's [`CredentialStore`] by converting
//! [`StoredPasskey`](crate::passkey::StoredPasskey) ↔ `Passkey` (via
//! [`super::codec`]) and dispatching through [`LiveConnection`]'s passkey
//! methods. It is provider-blind — adding a provider only adds an enum arm, and
//! nothing here changes.
//!
//! [`make_credential`] / [`get_assertion`] are the entry points the OS
//! integration shim (Layer C — Windows plugin authenticator, macOS credential
//! provider) calls once a ceremony arrives from the browser. They are generic
//! over [`UserValidationMethod`] so the shim supplies the real consent/biometric
//! gate (Windows Hello, Touch ID). They are not yet wired to any OS.

use passkey_authenticator::{
    Authenticator, CredentialStore, DiscoverabilitySupport, StoreInfo, UserValidationMethod,
};
use passkey_types::ctap2::get_assertion::{
    Options, Request as GetAssertionRequest, Response as GetAssertionResponse,
};
use passkey_types::ctap2::make_credential::{
    PublicKeyCredentialRpEntity, PublicKeyCredentialUserEntity, Request as MakeCredentialRequest,
    Response as MakeCredentialResponse,
};
use passkey_types::ctap2::{Aaguid, Ctap2Error, StatusCode};
use passkey_types::webauthn::PublicKeyCredentialDescriptor;
use passkey_types::Passkey;

use crate::error::{AgateError, AgateResult, ErrorKind};
use crate::passkey::codec::{passkey_to_stored, stored_to_passkey};
use crate::passkey::PasskeyTarget;
use crate::providers::LiveConnection;

/// A [`CredentialStore`] over a single live connection. Provider-blind: converts
/// `StoredPasskey` ↔ `Passkey` and dispatches through `LiveConnection`'s passkey
/// methods. `target` is where a newly-created credential is stored (chosen by the
/// user before the ceremony); it is unused for assertions.
struct ConnectionStore<'a> {
    conn: &'a mut LiveConnection,
    target: PasskeyTarget,
}

/// Map a provider/storage failure to a CTAP status. The detail is logged (never
/// the key material) and a generic "operation denied" is returned to the host.
fn store_status(err: AgateError) -> StatusCode {
    log::warn!("passkey store operation failed: {err}");
    Ctap2Error::OperationDenied.into()
}

#[async_trait::async_trait]
impl CredentialStore for ConnectionStore<'_> {
    type PasskeyItem = Passkey;

    async fn find_credentials(
        &self,
        ids: Option<&[PublicKeyCredentialDescriptor]>,
        rp_id: &str,
    ) -> Result<Vec<Passkey>, StatusCode> {
        let stored = match ids {
            Some(ids) if !ids.is_empty() => {
                let mut out = Vec::new();
                for descriptor in ids {
                    if let Some(passkey) =
                        self.conn.get_passkey(&descriptor.id).map_err(store_status)?
                    {
                        if passkey.rp_id == rp_id {
                            out.push(passkey);
                        }
                    }
                }
                out
            }
            _ => self.conn.find_passkeys_for_rp(rp_id).map_err(store_status)?,
        };
        let creds: Vec<Passkey> = stored.iter().filter_map(|s| stored_to_passkey(s).ok()).collect();
        if creds.is_empty() {
            Err(Ctap2Error::NoCredentials.into())
        } else {
            Ok(creds)
        }
    }

    async fn save_credential(
        &mut self,
        cred: Passkey,
        user: PublicKeyCredentialUserEntity,
        rp: PublicKeyCredentialRpEntity,
        _options: Options,
    ) -> Result<(), StatusCode> {
        let stored = passkey_to_stored(&cred, &user, &rp).map_err(store_status)?;
        self.conn.create_passkey(stored, &self.target).await.map_err(store_status)
    }

    async fn update_credential(&mut self, _cred: Passkey) -> Result<(), StatusCode> {
        // Agate passkeys report signature counter 0 (not tracked), so there is
        // nothing to persist after an assertion. See `StoredPasskey::sign_count`.
        Ok(())
    }

    async fn get_info(&self) -> StoreInfo {
        StoreInfo { discoverability: DiscoverabilitySupport::Full }
    }
}

/// Agate's authenticator AAGUID. All-zero = self/"none" attestation (no
/// registered model id) — the privacy-preserving default for a software
/// provider, and what KeePassXC and most third-party providers use.
fn agate_aaguid() -> Aaguid {
    Aaguid::new_empty()
}

fn ceremony_status(status: StatusCode) -> AgateError {
    AgateError::new(ErrorKind::Crypto, format!("passkey ceremony failed: {status:?}"))
}

/// Run a make-credential (registration) ceremony, storing the new credential in
/// `conn` at `target` (the item/folder the user chose). `user_validation` is the
/// consent/verification gate — the OS shim supplies a Windows Hello / Touch ID
/// backed implementation.
#[allow(dead_code)] // entry point for the OS integration shim (Layer C); not yet wired.
pub async fn make_credential<U>(
    conn: &mut LiveConnection,
    request: MakeCredentialRequest,
    target: PasskeyTarget,
    user_validation: U,
) -> AgateResult<MakeCredentialResponse>
where
    U: UserValidationMethod<PasskeyItem = Passkey> + Send + Sync,
{
    let store = ConnectionStore { conn, target };
    let mut authenticator = Authenticator::new(agate_aaguid(), store, user_validation);
    authenticator.make_credential(request).await.map_err(ceremony_status)
}

/// Run a get-assertion (sign-in) ceremony against the credentials in `conn`.
#[allow(dead_code)] // entry point for the OS integration shim (Layer C); not yet wired.
pub async fn get_assertion<U>(
    conn: &mut LiveConnection,
    request: GetAssertionRequest,
    user_validation: U,
) -> AgateResult<GetAssertionResponse>
where
    U: UserValidationMethod<PasskeyItem = Passkey> + Send + Sync,
{
    // Assertions never store, so the target is irrelevant here.
    let store = ConnectionStore { conn, target: PasskeyTarget::default() };
    let mut authenticator = Authenticator::new(agate_aaguid(), store, user_validation);
    authenticator.get_assertion(request).await.map_err(ceremony_status)
}

#[cfg(test)]
mod tests {
    use super::*;
    use coset::iana;
    use passkey_authenticator::UserCheck;
    use passkey_types::ctap2::get_assertion::Request as AssertRequest;
    use passkey_types::ctap2::make_credential::{Options as McOptions, PublicKeyCredentialRpEntity};
    use passkey_types::webauthn;

    use crate::passkey::CoseAlgorithm;
    use crate::providers::keepass::KeepassConnection;

    const RP: &str = "example.com";
    const PW: &str = "test-master-password";

    /// Test consent gate: always present + verified (the real biometric gate is
    /// supplied by Layer C).
    struct GrantAll;

    #[async_trait::async_trait]
    impl UserValidationMethod for GrantAll {
        type PasskeyItem = Passkey;

        async fn check_user<'a>(
            &self,
            _credential: Option<&'a Passkey>,
            _presence: bool,
            _verification: bool,
        ) -> Result<UserCheck, Ctap2Error> {
            Ok(UserCheck { presence: true, verification: true })
        }

        fn is_presence_enabled(&self) -> bool {
            true
        }

        fn is_verification_enabled(&self) -> Option<bool> {
            Some(true)
        }
    }

    fn temp_conn() -> (tempfile::TempDir, LiveConnection) {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("pk.kdbx");
        let conn = KeepassConnection::create(&path, PW, None).unwrap();
        (dir, LiveConnection::Keepass(conn))
    }

    fn make_request() -> MakeCredentialRequest {
        MakeCredentialRequest {
            client_data_hash: vec![0x11u8; 32].into(),
            rp: PublicKeyCredentialRpEntity { id: RP.into(), name: Some("Example".into()) },
            user: webauthn::PublicKeyCredentialUserEntity {
                id: vec![0x22u8; 16].into(),
                display_name: "Octo Cat".into(),
                name: "octocat".into(),
            },
            pub_key_cred_params: vec![webauthn::PublicKeyCredentialParameters {
                ty: webauthn::PublicKeyCredentialType::PublicKey,
                alg: iana::Algorithm::ES256,
            }],
            exclude_list: None,
            extensions: None,
            options: McOptions { rk: true, up: true, uv: true },
            pin_auth: None,
            pin_protocol: None,
        }
    }

    fn assert_request() -> AssertRequest {
        AssertRequest {
            rp_id: RP.into(),
            client_data_hash: vec![0x33u8; 32].into(),
            allow_list: None,
            extensions: None,
            options: McOptions { rk: false, up: true, uv: true },
            pin_auth: None,
            pin_protocol: None,
        }
    }

    /// The headline integration test: a full register ceremony stores a passkey
    /// in a real KeePass vault, and a sign-in ceremony reads it back (through
    /// the CoseKey ↔ PKCS#8 bridge) and produces a signature.
    #[tokio::test]
    async fn make_then_get_assertion_round_trips_through_keepass() {
        let (_dir, mut conn) = temp_conn();

        make_credential(&mut conn, make_request(), PasskeyTarget::default(), GrantAll).await.unwrap();

        // Persisted as a KeePassXC-style ES256 passkey.
        let stored = conn.find_passkeys_for_rp(RP).unwrap();
        assert_eq!(stored.len(), 1);
        assert_eq!(stored[0].algorithm, CoseAlgorithm::Es256);

        // Sign-in finds it and produces a non-empty assertion signature.
        let assertion = get_assertion(&mut conn, assert_request(), GrantAll).await.unwrap();
        assert!(!assertion.signature.is_empty(), "assertion must carry a signature");
    }

    #[tokio::test]
    async fn get_assertion_without_a_credential_errors() {
        let (_dir, mut conn) = temp_conn();
        let err = get_assertion(&mut conn, assert_request(), GrantAll).await.unwrap_err();
        assert!(matches!(err.kind, ErrorKind::Crypto), "got: {err}");
    }
}
