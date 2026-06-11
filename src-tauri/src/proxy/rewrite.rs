//! Prelogin path + `/sync` body rewriting for self-hosted compatibility. Pure
//! transforms (no network / state) so the cipher-data strip is unit-tested.

pub(super) const NEW_PRELOGIN: &str = "/accounts/prelogin/password";
pub(super) const OLD_PRELOGIN: &str = "/accounts/prelogin";

/// Render a JSON value as a type-only skeleton (keys preserved, values replaced
/// by their type) so we can diagnose schema mismatches without logging secrets.
pub(super) fn skeleton(v: &serde_json::Value, depth: usize) -> String {
    use serde_json::Value;
    if depth == 0 {
        return "…".to_string();
    }
    match v {
        Value::Null => "null".into(),
        Value::Bool(_) => "bool".into(),
        Value::Number(_) => "num".into(),
        Value::String(_) => "str".into(),
        Value::Array(a) => match a.first() {
            Some(first) => format!("[{}]x{}", skeleton(first, depth - 1), a.len()),
            None => "[]".into(),
        },
        Value::Object(map) => {
            let inner: Vec<String> = map
                .iter()
                .map(|(k, val)| format!("{k}:{}", skeleton(val, depth - 1)))
                .collect();
            format!("{{{}}}", inner.join(","))
        }
    }
}

/// Drop a legacy `data`/`Data` field from one cipher object, but only when it's
/// an OBJECT. Vaultwarden sends the legacy object shape; a server that already
/// matches the SDK (string or absent) is left untouched, so this is always safe
/// — the SDK ignores `data` entirely (the typed sub-objects carry the content).
fn remove_object_data(map: &mut serde_json::Map<String, serde_json::Value>) {
    use serde_json::Value;
    for key in ["data", "Data"] {
        if matches!(map.get(key), Some(Value::Object(_))) {
            map.remove(key);
        }
    }
}

/// Remove the legacy `data` field from each cipher in a `/sync` response.
/// Vaultwarden sends it as an object; the SDK types it as a string and doesn't
/// use it (the typed login/card/identity/secureNote/sshKey sub-objects carry the
/// real content), so dropping it makes the response SDK-parseable without loss.
pub(super) fn strip_legacy_cipher_data(v: &mut serde_json::Value) {
    use serde_json::Value;
    for key in ["ciphers", "Ciphers"] {
        if let Some(Value::Array(arr)) = v.get_mut(key) {
            for item in arr.iter_mut() {
                if let Value::Object(map) = item {
                    remove_object_data(map);
                }
            }
        }
    }
}

/// Remove the legacy `data` field from a single-cipher response — the body the
/// server returns from `POST /ciphers` (create) and `PUT /ciphers/{id}` (save).
/// Same Vaultwarden quirk as [`strip_legacy_cipher_data`], but the create/save
/// reply is a bare cipher object (no `ciphers` wrapper), so it needs its own
/// pass or the SDK's `CipherResponseModel` (which types `data` as a string)
/// fails to deserialize with "invalid type: map, expected a string".
pub(super) fn strip_legacy_cipher_data_object(v: &mut serde_json::Value) {
    use serde_json::Value;
    if let Value::Object(map) = v {
        remove_object_data(map);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn strip_legacy_data_makes_sync_deserialize() {
        use bitwarden_api_api::models::SyncResponseModel;
        // Mirror Vaultwarden: each cipher carries a legacy `data` OBJECT (which the
        // SDK types as a string) alongside the modern typed `login` sub-object.
        let raw = r#"{
            "profile": {"id":"00000000-0000-0000-0000-000000000000","object":"profile"},
            "ciphers": [{
                "id":"11111111-1111-1111-1111-111111111111","type":1,
                "data":{"name":"x","uri":"y","username":"u"},
                "login":{"username":"u","password":"p"},
                "name":"n","object":"cipherDetails"
            }],
            "object":"sync"
        }"#;
        let mut v: serde_json::Value = serde_json::from_str(raw).expect("parse fixture");

        // Before the fix, the `data` object breaks deserialization.
        assert!(
            serde_json::from_value::<SyncResponseModel>(v.clone()).is_err(),
            "expected the legacy data object to break parsing pre-strip"
        );

        // After stripping `data`, the SDK model parses cleanly.
        strip_legacy_cipher_data(&mut v);
        let parsed = serde_json::from_value::<SyncResponseModel>(v).expect("parse after strip");
        assert_eq!(parsed.ciphers.expect("ciphers present").len(), 1);
    }

    #[test]
    fn strip_legacy_data_makes_cipher_create_response_deserialize() {
        use bitwarden_api_api::models::CipherResponseModel;
        // Mirror Vaultwarden's `POST /ciphers` (create) reply: a bare cipher with
        // a legacy `data` OBJECT alongside the typed `login` sub-object. This is
        // the shape `ciphers_api().post()`/`put()` deserialize into a
        // `CipherResponseModel`, whose `data` is typed as a string.
        let raw = r#"{
            "id":"11111111-1111-1111-1111-111111111111","type":1,
            "data":{"name":"x","uri":"y","username":"u"},
            "login":{"username":"u","password":"p"},
            "name":"n","object":"cipher"
        }"#;
        let mut v: serde_json::Value = serde_json::from_str(raw).expect("parse fixture");

        // Before the fix, the legacy `data` object breaks the create/save reply —
        // surfaced to the user as "Create failed: error in serde: invalid type:
        // map, expected a string".
        assert!(
            serde_json::from_value::<CipherResponseModel>(v.clone()).is_err(),
            "expected the legacy data object to break parsing pre-strip"
        );

        // After stripping `data`, the single-cipher reply parses cleanly.
        strip_legacy_cipher_data_object(&mut v);
        let parsed =
            serde_json::from_value::<CipherResponseModel>(v).expect("parse after strip");
        assert_eq!(parsed.object.as_deref(), Some("cipher"));
    }
}
