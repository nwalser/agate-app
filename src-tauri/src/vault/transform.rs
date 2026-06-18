//! Pure mapping from decrypted SDK `CipherView`s into the frontend DTOs
//! (`VaultItem` list rows and `ItemDetail`), including the `CustomField`
//! construction. No SDK calls and no state — just shape conversion.

use bitwarden_vault::{
    CipherRepromptType, CipherType, CipherView, FieldType, PasswordHistoryView,
};

use crate::dto::{
    CustomField, CustomFieldType, ItemDetail, ItemType, LoginDetail, LoginUri,
    PasswordHistoryEntry, VaultItem,
};

/// Map the SDK field type to our closed `CustomFieldType`, preserving the exact
/// wire values the frontend expects (`text` / `hidden` / `boolean` / `linked`).
fn field_type_to_dto(t: FieldType) -> CustomFieldType {
    match t {
        FieldType::Hidden => CustomFieldType::Hidden,
        FieldType::Boolean => CustomFieldType::Boolean,
        FieldType::Linked => CustomFieldType::Linked,
        _ => CustomFieldType::Text,
    }
}

/// Map the decrypted password-history views into the frontend DTO (RFC 3339
/// dates). Pure so the date formatting + ordering are unit-tested without a vault.
fn password_history_to_dto(history: Option<&Vec<PasswordHistoryView>>) -> Vec<PasswordHistoryEntry> {
    history
        .map(|entries| {
            entries
                .iter()
                .map(|e| PasswordHistoryEntry {
                    password: e.password.clone(),
                    last_used_date: e.last_used_date.to_rfc3339(),
                })
                .collect()
        })
        .unwrap_or_default()
}

pub(super) fn cipher_type_to_dto(t: CipherType) -> ItemType {
    match t {
        CipherType::Login => ItemType::Login,
        CipherType::SecureNote => ItemType::SecureNote,
        CipherType::Card => ItemType::Card,
        CipherType::Identity => ItemType::Identity,
        CipherType::SshKey => ItemType::SshKey,
        CipherType::BankAccount | CipherType::DriversLicense | CipherType::Passport => {
            ItemType::Unknown
        }
    }
}

pub(crate) fn view_to_list_item(
    view: &CipherView,
    account_email: &str,
    account_label: &str,
) -> VaultItem {
    let (username, has_totp, uri) = match &view.login {
        Some(login) => (
            login.username.clone(),
            login.totp.is_some(),
            login.uris.as_ref().and_then(|uris| uris.iter().find_map(|u| u.uri.clone())),
        ),
        None => (None, false, None),
    };
    VaultItem {
        id: view.id.map(|i| i.to_string()).unwrap_or_default(),
        account_email: account_email.to_string(),
        account_label: account_label.to_string(),
        name: view.name.clone(),
        item_type: cipher_type_to_dto(view.r#type),
        username,
        uri,
        has_totp,
        reprompt: matches!(view.reprompt, CipherRepromptType::Password),
        favorite: view.favorite,
        deleted: view.deleted_date.is_some(),
        folder_id: view.folder_id.map(|i| i.to_string()),
        organization_id: view.organization_id.map(|i| i.to_string()),
    }
}

/// Map a decrypted `CipherView` into the frontend `ItemDetail` DTO.
pub fn view_to_detail(view: &CipherView, account_email: &str, account_label: &str) -> ItemDetail {
    let login = view.login.as_ref().map(|l| LoginDetail {
        username: l.username.clone(),
        password: l.password.clone(),
        totp: l.totp.clone(),
        uris: l
            .uris
            .as_ref()
            .map(|uris| {
                uris.iter()
                    .map(|u| LoginUri { uri: u.uri.clone(), match_type: u.r#match.map(|m| m as u8) })
                    .collect()
            })
            .unwrap_or_default(),
        has_totp: l.totp.as_ref().is_some_and(|t| !t.is_empty()),
        password_revision_date: l.password_revision_date.map(|d| d.to_rfc3339()),
        autofill_on_page_load: l.autofill_on_page_load,
        // Password history lives on the cipher, not the login sub-view; surface it
        // under the login so the pane shows it next to the current password.
        password_history: password_history_to_dto(view.password_history.as_ref()),
    });

    let card = view
        .card
        .as_ref()
        .and_then(|c| serde_json::to_value(c).ok())
        .and_then(|v| serde_json::from_value(v).ok());
    let identity = view
        .identity
        .as_ref()
        .and_then(|i| serde_json::to_value(i).ok())
        .and_then(|v| serde_json::from_value(v).ok());
    let ssh_key = view
        .ssh_key
        .as_ref()
        .and_then(|s| serde_json::to_value(s).ok())
        .and_then(|v| serde_json::from_value(v).ok());

    let fields = view
        .fields
        .as_ref()
        .map(|fields| {
            fields
                .iter()
                .map(|f| CustomField {
                    name: f.name.clone(),
                    value: f.value.clone(),
                    field_type: field_type_to_dto(f.r#type),
                    linked_id: f.linked_id.map(u32::from),
                })
                .collect()
        })
        .unwrap_or_default();

    ItemDetail {
        id: view.id.map(|i| i.to_string()).unwrap_or_default(),
        account_email: account_email.to_string(),
        account_label: account_label.to_string(),
        name: view.name.clone(),
        item_type: cipher_type_to_dto(view.r#type),
        favorite: view.favorite,
        reprompt: matches!(view.reprompt, CipherRepromptType::Password),
        notes: view.notes.clone(),
        login,
        card,
        identity,
        ssh_key,
        fields,
        folder_id: view.folder_id.map(|i| i.to_string()),
        organization_id: view.organization_id.map(|i| i.to_string()),
        revision_date: view.revision_date.to_rfc3339(),
        creation_date: view.creation_date.to_rfc3339(),
        collection_ids: view.collection_ids.iter().map(std::string::ToString::to_string).collect(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use chrono::{DateTime, Utc};

    fn at(iso: &str) -> DateTime<Utc> {
        DateTime::parse_from_rfc3339(iso).expect("valid rfc3339").with_timezone(&Utc)
    }

    #[test]
    fn password_history_maps_value_and_rfc3339_date() {
        let history = vec![
            PasswordHistoryView { password: "old1".into(), last_used_date: at("2026-01-02T03:04:05Z") },
            PasswordHistoryView { password: "old2".into(), last_used_date: at("2025-06-01T00:00:00Z") },
        ];
        let out = password_history_to_dto(Some(&history));
        assert_eq!(out.len(), 2);
        assert_eq!(out[0].password, "old1");
        assert_eq!(out[0].last_used_date, "2026-01-02T03:04:05+00:00");
        assert_eq!(out[1].password, "old2");
    }

    #[test]
    fn password_history_none_is_empty() {
        assert!(password_history_to_dto(None).is_empty());
    }
}
