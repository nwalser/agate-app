//! Additional-authenticated-data byte strings. Each AAD binds a sealed blob to its
//! identity (service, version, type, account / KDF params) so a swapped,
//! rolled-back, or KDF-downgraded blob fails the GCM tag instead of opening.

use super::{BLOB_VERSION, KEYRING_SERVICE};

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

#[cfg(test)]
mod tests {
    use super::*;

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
