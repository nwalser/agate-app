//! Pure mapping from decrypted SDK `CipherView`s into the frontend DTOs
//! (`VaultItem` list rows and `ItemDetail`), including the `CustomField`
//! construction. No SDK calls and no state — just shape conversion.

use bitwarden_vault::{CipherRepromptType, CipherType, CipherView};

use crate::dto::{CustomField, ItemDetail, ItemType, LoginDetail, LoginUri, VaultItem};

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

pub(super) fn view_to_list_item(
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
        has_totp: l.totp.as_ref().map(|t| !t.is_empty()).unwrap_or(false),
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
                    field_type: format!("{:?}", f.r#type).to_lowercase(),
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
    }
}
