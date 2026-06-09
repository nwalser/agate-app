//! Data-transfer objects shared with the frontend.
//!
//! These mirror `src/lib/types.ts`. Keep the two in sync. All closed sets are
//! enums (serialized as lowercase strings) — never bare strings — per CLAUDE.md.
//!
//! Split into cohesive submodules and re-exported flat, so every existing
//! `crate::dto::X` / `use crate::dto::{...}` across the crate keeps compiling.

mod audit;
mod auth;
mod generator;
mod vault;
mod window;

pub use audit::*;
pub use auth::*;
pub use generator::*;
pub use vault::*;
pub use window::*;

#[cfg(test)]
mod mirror_tests {
    //! Guards the manual TS<->Rust DTO mirror (`src/lib/types.ts`). Every struct
    //! sent to the frontend must serialize with camelCase keys, and every
    //! closed-set enum must serialize to its documented wire string. If a field
    //! is renamed to snake_case, a `#[serde(rename_all = "camelCase")]` is dropped
    //! during a refactor, or an enum's wire value drifts, one of these fails —
    //! catching mirror breakage before it reaches the frontend at runtime.
    use super::*;
    use serde::Serialize;
    use serde_json::{json, Value};

    /// Recursively assert every object key reachable from `v` is lowerCamelCase.
    fn assert_camel(label: &str, v: &Value) {
        match v {
            Value::Object(map) => {
                for (k, val) in map {
                    assert!(
                        !k.contains('_'),
                        "{label}: key `{k}` leaked snake_case through the DTO mirror"
                    );
                    assert!(
                        !k.chars().next().is_some_and(|c| c.is_ascii_uppercase()),
                        "{label}: key `{k}` should be lowerCamelCase, not PascalCase"
                    );
                    assert_camel(label, val);
                }
            }
            Value::Array(items) => items.iter().for_each(|it| assert_camel(label, it)),
            _ => {}
        }
    }

    fn camel<T: Serialize>(label: &str, value: &T) {
        let v = serde_json::to_value(value).expect("DTO must serialize");
        assert_camel(label, &v);
    }

    #[test]
    fn outbound_dtos_serialize_camel_case() {
        camel(
            "ServerConfig",
            &ServerConfig::SelfHosted { base_url: "https://vault.example".into() },
        );
        camel(
            "LoginResult",
            &LoginResult::TwoFactorRequired { providers: vec![TwoFactorKind::Authenticator] },
        );
        camel(
            "ConnectionSummary",
            &ConnectionSummary {
                email: "a@b.com".into(),
                server_label: "EU".into(),
                server: ServerConfig::Eu,
                unlocked: true,
                store_credentials: true,
            },
        );
        camel(
            "UnlockOutcome(2fa)",
            &UnlockOutcome {
                email: "a@b.com".into(),
                server_label: "EU".into(),
                status: UnlockStatus::TwoFactorRequired { providers: vec![TwoFactorKind::Email] },
            },
        );
        camel(
            "UnlockOutcome(failed)",
            &UnlockOutcome {
                email: "a@b.com".into(),
                server_label: "EU".into(),
                status: UnlockStatus::Failed { message: "network".into() },
            },
        );
        camel("SessionStatus", &SessionStatus::default());
        camel(
            "VaultItem",
            &VaultItem {
                id: "i".into(),
                account_email: "a@b.com".into(),
                account_label: "EU".into(),
                name: "n".into(),
                item_type: ItemType::Login,
                username: Some("u".into()),
                uri: Some("https://x".into()),
                has_totp: true,
                has_passkey: false,
                favorite: false,
                deleted: false,
                folder_id: None,
                organization_id: None,
            },
        );
        camel(
            "LoginDetail",
            &LoginDetail {
                uris: vec![LoginUri { uri: Some("https://x".into()), match_type: Some(0) }],
                ..Default::default()
            },
        );
        camel(
            "CustomField",
            &CustomField {
                name: Some("n".into()),
                value: Some("v".into()),
                field_type: CustomFieldType::Hidden,
                linked_id: None,
            },
        );
        camel(
            "ItemDetail",
            &ItemDetail {
                id: "i".into(),
                account_email: "a@b.com".into(),
                account_label: "EU".into(),
                name: "n".into(),
                item_type: ItemType::Identity,
                favorite: false,
                reprompt: false,
                notes: None,
                login: None,
                card: None,
                identity: Some(IdentityInput::default()),
                ssh_key: None,
                fields: vec![],
                folder_id: None,
                organization_id: None,
            },
        );
        camel("TotpCode", &TotpCode { code: "123456".into(), period: 30, remaining: 10 });
        camel(
            "Folder",
            &Folder {
                id: Some("f".into()),
                name: "n".into(),
                account_email: "a@b.com".into(),
                account_label: "EU".into(),
            },
        );
        camel(
            "VaultHealthReport",
            &VaultHealthReport {
                score: 80,
                band: HealthBand::Good,
                total_logins: 1,
                reused: 0,
                weak: 0,
                old: 0,
                insecure: 0,
                no_totp: 0,
                at_risk: vec![ItemAudit {
                    id: "i".into(),
                    name: "n".into(),
                    reused: false,
                    weak: true,
                    weak_score: Some(2),
                    old: false,
                    insecure_uri: false,
                    no_totp: true,
                }],
            },
        );
        camel("ExposedResult", &ExposedResult { id: "i".into(), name: "n".into(), count: 3 });
        camel(
            "DarkWebReport",
            &DarkWebReport {
                accounts: vec![AccountBreaches {
                    email: "a@b.com".into(),
                    breaches: vec![BreachRecord {
                        name: "Adobe".into(),
                        domain: "adobe.com".into(),
                        breach_date: Some("2013".into()),
                        pwn_count: Some(1),
                        data_classes: vec!["Email addresses".into()],
                        description: None,
                        logo: None,
                        verified: true,
                        password_risk: None,
                    }],
                    exposed_data: vec!["Email addresses".into()],
                    risk_label: None,
                    risk_score: None,
                }],
                errored: vec![EmailError { email: "c@d.com".into(), error: "rate limit".into() }],
                pending: vec!["e@f.com".into()],
                locked_connections: vec!["g@h.com".into()],
                total_breaches: 1,
                clean: 0,
            },
        );
        camel(
            "WindowControlsLayout",
            &WindowControlsLayout {
                side: ControlsSide::Right,
                buttons: vec![WindowControl::Minimize, WindowControl::Close],
            },
        );
    }

    #[test]
    fn closed_set_enums_use_documented_wire_values() {
        // Item types (mirror the `ItemType` union in types.ts).
        assert_eq!(serde_json::to_value(ItemType::Login).unwrap(), json!("login"));
        assert_eq!(serde_json::to_value(ItemType::SecureNote).unwrap(), json!("secureNote"));
        assert_eq!(serde_json::to_value(ItemType::SshKey).unwrap(), json!("sshKey"));
        // Other closed sets.
        assert_eq!(serde_json::to_value(TwoFactorKind::Authenticator).unwrap(), json!("authenticator"));
        assert_eq!(serde_json::to_value(HealthBand::Excellent).unwrap(), json!("excellent"));
        assert_eq!(serde_json::to_value(WindowControl::Maximize).unwrap(), json!("maximize"));
        // ServerConfig is internally tagged on `region`.
        assert_eq!(serde_json::to_value(ServerConfig::Us).unwrap(), json!({ "region": "us" }));
        assert_eq!(
            serde_json::to_value(ServerConfig::SelfHosted { base_url: "https://x".into() }).unwrap(),
            json!({ "region": "selfHosted", "baseUrl": "https://x" })
        );
        // CustomFieldType wire values — pin the `fieldType` strings the
        // String->enum change must keep producing.
        assert_eq!(serde_json::to_value(CustomFieldType::Text).unwrap(), json!("text"));
        assert_eq!(serde_json::to_value(CustomFieldType::Hidden).unwrap(), json!("hidden"));
        assert_eq!(serde_json::to_value(CustomFieldType::Boolean).unwrap(), json!("boolean"));
        assert_eq!(serde_json::to_value(CustomFieldType::Linked).unwrap(), json!("linked"));
        // CustomField wire shape — `fieldType` serializes as the documented
        // string, plus `linkedId` round-trip.
        let f = CustomField {
            name: None,
            value: None,
            field_type: CustomFieldType::Linked,
            linked_id: Some(7),
        };
        assert_eq!(
            serde_json::to_value(&f).unwrap(),
            json!({ "name": null, "value": null, "fieldType": "linked", "linkedId": 7 })
        );
        // UnlockStatus wire values (mirror the `UnlockOutcome` union in types.ts) —
        // pin the unit-variant strings so a rename can't silently drift the contract.
        let status_of = |s: UnlockStatus| {
            serde_json::to_value(UnlockOutcome {
                email: "a@b.com".into(),
                server_label: "EU".into(),
                status: s,
            })
            .unwrap()["status"]
                .clone()
        };
        assert_eq!(status_of(UnlockStatus::Unlocked), json!("unlocked"));
        assert_eq!(status_of(UnlockStatus::ManualUnlock), json!("manualUnlock"));
    }
}
