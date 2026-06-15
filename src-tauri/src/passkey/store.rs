//! Provider-agnostic passkey types shared across the persistence and ceremony
//! layers.

use zeroize::Zeroizing;

/// COSE signature algorithm for a stored passkey. A closed set (never a bare
/// string in storage) of the three algorithms WebAuthn requires and KeePassXC
/// supports.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum CoseAlgorithm {
    /// ES256 — ECDSA over the NIST P-256 curve (COSE alg `-7`). The WebAuthn
    /// default; what nearly every relying party requests first.
    Es256,
    /// EdDSA — Ed25519 (COSE alg `-8`).
    EdDsa,
    /// RS256 — RSASSA-PKCS1-v1_5 with SHA-256 (COSE alg `-257`).
    Rs256,
}

impl CoseAlgorithm {
    // `cose_id` / `from_cose_id` are consumed by the passkey ceremony adapter
    // (the layer that maps to the `passkey` crate's request types); they are not
    // yet wired, so allow them to sit unused until that slice lands.
    /// The COSE algorithm identifier (the negative integers WebAuthn uses on the
    /// wire in `pubKeyCredParams`).
    #[allow(dead_code)]
    pub fn cose_id(self) -> i32 {
        match self {
            CoseAlgorithm::Es256 => -7,
            CoseAlgorithm::EdDsa => -8,
            CoseAlgorithm::Rs256 => -257,
        }
    }

    /// Parse from a COSE algorithm identifier; `None` for an algorithm Agate
    /// does not handle (so an unsupported request is rejected, not guessed).
    #[allow(dead_code)]
    pub fn from_cose_id(id: i32) -> Option<Self> {
        match id {
            -7 => Some(CoseAlgorithm::Es256),
            -8 => Some(CoseAlgorithm::EdDsa),
            -257 => Some(CoseAlgorithm::Rs256),
            _ => None,
        }
    }

    /// Human/interop label — matches `dto::PasskeyCredential.key_algorithm` and
    /// the value KeePassXC writes, so a label round-trips across clients.
    pub fn label(self) -> &'static str {
        match self {
            CoseAlgorithm::Es256 => "ES256",
            CoseAlgorithm::EdDsa => "EdDSA",
            CoseAlgorithm::Rs256 => "RS256",
        }
    }

    /// Parse the interop label back to an algorithm.
    pub fn from_label(label: &str) -> Option<Self> {
        match label {
            "ES256" => Some(CoseAlgorithm::Es256),
            "EdDSA" => Some(CoseAlgorithm::EdDsa),
            "RS256" => Some(CoseAlgorithm::Rs256),
            _ => None,
        }
    }
}

/// A passkey credential as Agate stores it — provider-agnostic and free of any
/// `passkey`-crate type, so a provider persists it without depending on the
/// ceremony layer. The CredentialStore adapter (the single place that knows the
/// `passkey` crate) converts between this and the crate's `Passkey`.
///
/// Field formats follow the KeePassXC convention so a passkey written by Agate
/// is usable by KeePassXC and vice-versa: `credential_id` and `user_handle` are
/// raw bytes (base64url at rest), and `private_key_pem` is PKCS#8 in PEM.
// Several fields are read only by the ceremony adapter (next slice) — the
// persistence layer round-trips them but doesn't yet consume them in a non-test
// build. Allow until that layer lands.
#[allow(dead_code)]
#[derive(Clone)]
pub struct StoredPasskey {
    /// The credential id (raw bytes; base64url at rest). The WebAuthn handle the
    /// relying party stores and presents back on assertion.
    pub credential_id: Vec<u8>,
    /// Relying-party id, e.g. `"github.com"`.
    pub rp_id: String,
    /// Relying-party display name, if the create ceremony provided one.
    pub rp_name: Option<String>,
    /// The user handle (raw bytes; base64url at rest) — the relying party's
    /// opaque user id, used to match a discoverable credential.
    pub user_handle: Vec<u8>,
    /// Account name at the relying party (e.g. an email), if provided.
    pub user_name: Option<String>,
    /// Human display name for the account, if provided.
    pub user_display_name: Option<String>,
    /// Signature algorithm of `private_key_pem`.
    pub algorithm: CoseAlgorithm,
    /// The PKCS#8 private key in PEM. **Secret** — zeroized on drop, never
    /// logged, never sent to the frontend.
    pub private_key_pem: Zeroizing<String>,
    /// WebAuthn signature counter. Agate authenticators report `0` ("counter not
    /// supported"), matching KeePassXC and avoiding cross-client sync conflicts.
    pub sign_count: u32,
    /// Creation timestamp (RFC 3339); empty when the store records none.
    pub created: String,
    /// FIDO `BE` flag — the credential is eligible to be backed up / synced.
    pub backup_eligible: bool,
    /// FIDO `BS` flag — the credential is currently backed up / synced.
    pub backup_state: bool,
}

/// Redacted: never prints the private key (or any byte material that could
/// fingerprint a credential).
impl std::fmt::Debug for StoredPasskey {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("StoredPasskey")
            .field("rp_id", &self.rp_id)
            .field("algorithm", &self.algorithm)
            .field("user_name", &self.user_name)
            .field("private_key_pem", &"<redacted>")
            .finish_non_exhaustive()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn cose_id_round_trips() {
        for alg in [CoseAlgorithm::Es256, CoseAlgorithm::EdDsa, CoseAlgorithm::Rs256] {
            assert_eq!(CoseAlgorithm::from_cose_id(alg.cose_id()), Some(alg));
            assert_eq!(CoseAlgorithm::from_label(alg.label()), Some(alg));
        }
        assert_eq!(CoseAlgorithm::from_cose_id(-999), None);
        assert_eq!(CoseAlgorithm::from_label("HS256"), None);
    }

    #[test]
    fn debug_redacts_the_private_key() {
        let pk = StoredPasskey {
            credential_id: vec![1, 2, 3],
            rp_id: "github.com".into(),
            rp_name: None,
            user_handle: vec![9],
            user_name: Some("octocat".into()),
            user_display_name: None,
            algorithm: CoseAlgorithm::Es256,
            private_key_pem: Zeroizing::new("-----BEGIN PRIVATE KEY-----SECRET".into()),
            sign_count: 0,
            created: String::new(),
            backup_eligible: true,
            backup_state: true,
        };
        let rendered = format!("{pk:?}");
        assert!(!rendered.contains("SECRET"), "private key leaked into Debug: {rendered}");
        assert!(rendered.contains("github.com"));
    }
}
