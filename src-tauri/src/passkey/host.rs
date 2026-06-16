//! The ceremony host: the tray-side handler that turns a CBOR-encoded CTAP2
//! request (the form a plugin authenticator receives from the OS WebAuthn
//! layer) into a CBOR-encoded CTAP2 response, by running the provider-agnostic
//! ceremony in [`super::authenticator`].
//!
//! This is platform-independent and is the single seam that bridges the wire
//! (CBOR) to the ceremony. The Windows plugin-authenticator COM server
//! (`super::win_plugin`) and the Layer C IPC contract (`super::ipc`) both drive
//! these functions, so the OS-specific shims stay thin.

use passkey_authenticator::UserValidationMethod;
use passkey_types::ctap2::{get_assertion, make_credential};
use passkey_types::Passkey;

use crate::error::{AgateError, AgateResult, ErrorKind};
use crate::passkey::PasskeyTarget;
use crate::providers::LiveConnection;

fn decode<T: serde::de::DeserializeOwned>(what: &str, cbor: &[u8]) -> AgateResult<T> {
    ciborium::from_reader(cbor).map_err(|e| {
        AgateError::new(ErrorKind::BadRequest, format!("invalid CBOR {what} request: {e}"))
    })
}

fn encode<T: serde::Serialize>(what: &str, value: &T) -> AgateResult<Vec<u8>> {
    let mut out = Vec::new();
    ciborium::into_writer(value, &mut out).map_err(|e| {
        AgateError::new(ErrorKind::Internal, format!("could not encode {what} response: {e}"))
    })?;
    Ok(out)
}

/// Run a make-credential (registration) ceremony from a CBOR CTAP2 request,
/// storing the new credential in `conn` at `target`; returns the CBOR CTAP2
/// response the OS expects back.
pub async fn make_credential_cbor<U>(
    conn: &mut LiveConnection,
    target: PasskeyTarget,
    request_cbor: &[u8],
    user_validation: U,
) -> AgateResult<Vec<u8>>
where
    U: UserValidationMethod<PasskeyItem = Passkey> + Send + Sync,
{
    let request: make_credential::Request = decode("make-credential", request_cbor)?;
    let response =
        super::authenticator::make_credential(conn, request, target, user_validation).await?;
    encode("make-credential", &response)
}

/// Run a get-assertion (sign-in) ceremony from a CBOR CTAP2 request against the
/// credentials in `conn`; returns the CBOR CTAP2 response.
pub async fn get_assertion_cbor<U>(
    conn: &mut LiveConnection,
    request_cbor: &[u8],
    user_validation: U,
) -> AgateResult<Vec<u8>>
where
    U: UserValidationMethod<PasskeyItem = Passkey> + Send + Sync,
{
    let request: get_assertion::Request = decode("get-assertion", request_cbor)?;
    let response = super::authenticator::get_assertion(conn, request, user_validation).await?;
    encode("get-assertion", &response)
}

#[cfg(test)]
mod tests {
    use super::*;
    use coset::iana;
    use passkey_authenticator::UserCheck;
    use passkey_types::ctap2::make_credential::{Options, PublicKeyCredentialRpEntity};
    use passkey_types::ctap2::Ctap2Error;
    use passkey_types::webauthn;

    use crate::providers::keepass::KeepassConnection;

    const RP: &str = "example.com";

    struct GrantAll;

    #[async_trait::async_trait]
    impl UserValidationMethod for GrantAll {
        type PasskeyItem = Passkey;
        async fn check_user<'a>(
            &self,
            _c: Option<&'a Passkey>,
            _p: bool,
            _v: bool,
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
        let path = dir.path().join("host.kdbx");
        let conn = KeepassConnection::create(&path, "pw", None).unwrap();
        (dir, LiveConnection::Keepass(conn))
    }

    fn make_request_cbor() -> Vec<u8> {
        let request = make_credential::Request {
            client_data_hash: vec![0x11; 32].into(),
            rp: PublicKeyCredentialRpEntity { id: RP.into(), name: Some("Example".into()) },
            user: webauthn::PublicKeyCredentialUserEntity {
                id: vec![0x22; 16].into(),
                display_name: "Octo Cat".into(),
                name: "octocat".into(),
            },
            pub_key_cred_params: vec![webauthn::PublicKeyCredentialParameters {
                ty: webauthn::PublicKeyCredentialType::PublicKey,
                alg: iana::Algorithm::ES256,
            }],
            exclude_list: None,
            extensions: None,
            options: Options { rk: true, up: true, uv: true },
            pin_auth: None,
            pin_protocol: None,
        };
        let mut buf = Vec::new();
        ciborium::into_writer(&request, &mut buf).unwrap();
        buf
    }

    fn assert_request_cbor() -> Vec<u8> {
        let request = get_assertion::Request {
            rp_id: RP.into(),
            client_data_hash: vec![0x33; 32].into(),
            allow_list: None,
            extensions: None,
            options: Options { rk: false, up: true, uv: true },
            pin_auth: None,
            pin_protocol: None,
        };
        let mut buf = Vec::new();
        ciborium::into_writer(&request, &mut buf).unwrap();
        buf
    }

    /// The OS-facing round-trip: a CBOR make-credential request stores a passkey
    /// and yields a decodable CBOR response; a CBOR get-assertion request then
    /// produces a signed assertion — all through the byte interface the COM
    /// server speaks.
    #[tokio::test]
    async fn cbor_make_then_get_assertion_round_trips() {
        let (_dir, mut conn) = temp_conn();

        let mc_resp = make_credential_cbor(&mut conn, PasskeyTarget::default(), &make_request_cbor(), GrantAll)
            .await
            .unwrap();
        // Response decodes back into a CTAP2 make-credential response.
        let decoded: make_credential::Response = ciborium::from_reader(&mc_resp[..]).unwrap();
        assert_eq!(decoded.fmt, "None");
        assert_eq!(conn.find_passkeys_for_rp(RP).unwrap().len(), 1);

        let ga_resp =
            get_assertion_cbor(&mut conn, &assert_request_cbor(), GrantAll).await.unwrap();
        let decoded: get_assertion::Response = ciborium::from_reader(&ga_resp[..]).unwrap();
        assert!(!decoded.signature.is_empty());
    }

    #[tokio::test]
    async fn malformed_cbor_is_a_typed_error() {
        let (_dir, mut conn) = temp_conn();
        let err = make_credential_cbor(&mut conn, PasskeyTarget::default(), b"not-cbor", GrantAll)
            .await
            .unwrap_err();
        assert!(matches!(err.kind, ErrorKind::BadRequest), "got: {err}");
    }
}
