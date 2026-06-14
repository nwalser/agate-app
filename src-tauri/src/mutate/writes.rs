//! Item write operations: create / edit / delete / restore / move / favorite /
//! clone. Every operation routes to a specific connection by `account_email` (the
//! unified list mixes accounts, so the caller always says which vault an item lives
//! in / a new item goes into).
//!
//! The SDK's typed `CipherCreateRequest`/`CipherEditRequest` live in private
//! modules and aren't nameable from outside the crate, so we reproduce the
//! create/edit flow the way `cipher_client::{create,edit}` do internally, using
//! only public APIs: build a `CipherView`, `key_store.encrypt` it to a `Cipher`,
//! convert to the public `CipherRequestModel`, and POST/PUT via `ciphers_api()`.
//!
//! Type-specific views are built via `serde_json` (missing optional fields default
//! to `None`); edit round-trips the decrypted `CipherView` through JSON so fields
//! we don't enumerate (key, password_history, dates…) are preserved.

use bitwarden_api_api::models::CipherRequestModel;
use bitwarden_pm::PasswordManagerClient;
use bitwarden_vault::{Cipher, CipherId, CipherView};
use chrono::Utc;
use serde::de::DeserializeOwned;
use serde_json::{json, Value};

use crate::dto::{CardInput, IdentityInput, ItemInput, ItemType, LoginInput, SshKeyInput};
use crate::error::{AgateError, AgateResult, ErrorKind};
use crate::state::AppState;
use crate::vault::{client_for, decrypt_one};

pub(super) fn op_err(kind: ErrorKind, what: &str, e: impl std::fmt::Display) -> AgateError {
    AgateError::new(kind, format!("{what}: {e}"))
}

fn build_err(e: impl std::fmt::Display) -> AgateError {
    AgateError::new(ErrorKind::BadRequest, format!("invalid item data: {e}"))
}

/// Parse a string id into a typed SDK id via serde (CipherId/FolderId/OrganizationId).
pub(super) fn parse_id<T: DeserializeOwned>(s: &str) -> AgateResult<T> {
    serde_json::from_value(Value::String(s.to_string()))
        .map_err(|_| AgateError::bad_request("invalid id"))
}

fn parse_opt_id<T: DeserializeOwned>(s: &Option<String>) -> AgateResult<Option<T>> {
    match s {
        Some(s) if !s.is_empty() => Ok(Some(parse_id(s)?)),
        _ => Ok(None),
    }
}

// reprompt is stored on CipherView as a repr-enum integer (None=0, Password=1).
fn reprompt_value(flag: bool) -> Value {
    json!(if flag { 1 } else { 0 })
}

fn build_login(i: &LoginInput) -> AgateResult<Value> {
    let uris: Vec<Value> = i
        .uris
        .iter()
        .filter(|u| u.uri.as_deref().map(|s| !s.trim().is_empty()).unwrap_or(false))
        .map(|u| json!({ "uri": u.uri, "match": u.match_type, "uriChecksum": null }))
        .collect();
    Ok(json!({
        "username": i.username,
        "password": i.password,
        "totp": i.totp,
        "uris": uris,
        "autofillOnPageLoad": i.autofill_on_page_load,
    }))
}

fn build_card(i: &CardInput) -> Value {
    json!({
        "cardholderName": i.cardholder_name, "number": i.number, "brand": i.brand,
        "expMonth": i.exp_month, "expYear": i.exp_year, "code": i.code,
    })
}

fn build_identity(i: &IdentityInput) -> Value {
    json!({
        "title": i.title, "firstName": i.first_name, "middleName": i.middle_name,
        "lastName": i.last_name, "username": i.username, "company": i.company,
        "ssn": i.ssn, "passportNumber": i.passport_number, "licenseNumber": i.license_number,
        "email": i.email, "phone": i.phone, "address1": i.address1, "address2": i.address2,
        "address3": i.address3, "city": i.city, "state": i.state, "postalCode": i.postal_code,
        "country": i.country,
    })
}

fn build_ssh(i: &SshKeyInput) -> Value {
    json!({ "privateKey": i.private_key, "publicKey": i.public_key, "fingerprint": i.fingerprint })
}

fn build_fields(input: &ItemInput) -> Vec<Value> {
    input
        .fields
        .iter()
        .map(|f| json!({ "name": f.name, "value": f.value, "type": f.field_type, "linkedId": f.linked_id }))
        .collect()
}

/// SDK CipherType discriminant for an `ItemType`.
fn cipher_type_int(t: ItemType) -> AgateResult<i64> {
    Ok(match t {
        ItemType::Login => 1,
        ItemType::SecureNote => 2,
        ItemType::Card => 3,
        ItemType::Identity => 4,
        ItemType::SshKey => 5,
        ItemType::Unknown => return Err(AgateError::bad_request("unsupported item type")),
    })
}

/// Build a fresh `CipherView` (as JSON) for a create.
fn create_view_json(input: &ItemInput) -> AgateResult<Value> {
    // The server is authoritative for creation/revision dates on a new cipher and
    // overwrites whatever we send, so the value only has to be a valid RFC 3339
    // timestamp. Use "now" rather than a frozen literal so it's correct on the
    // off-chance anything reads it before the post-create re-sync.
    let now = Utc::now().to_rfc3339();
    let mut v = json!({
        "id": null,
        "organizationId": input.organization_id,
        "folderId": input.folder_id,
        "collectionIds": [],
        "key": null,
        "name": input.name,
        "notes": input.notes,
        "type": cipher_type_int(input.item_type)?,
        "login": null, "identity": null, "card": null, "secureNote": null,
        "sshKey": null, "bankAccount": null, "driversLicense": null, "passport": null,
        "favorite": input.favorite,
        "reprompt": reprompt_value(input.reprompt),
        "organizationUseTotp": false,
        "edit": true,
        "permissions": null,
        "viewPassword": true,
        "localData": null,
        "attachments": null,
        "attachmentDecryptionFailures": null,
        "fields": build_fields(input),
        "passwordHistory": null,
        "creationDate": now,
        "deletedDate": null,
        "revisionDate": now,
        "archivedDate": null,
    });
    set_type_payload(&mut v, input)?;
    Ok(v)
}

/// Set the type-specific sub-view (login/card/identity/secureNote/sshKey) on a
/// CipherView JSON object from the input.
fn set_type_payload(v: &mut Value, input: &ItemInput) -> AgateResult<()> {
    match input.item_type {
        ItemType::Login => {
            let l = input.login.as_ref().ok_or_else(|| AgateError::bad_request("missing login data"))?;
            v["login"] = build_login(l)?;
        }
        ItemType::Card => {
            let c = input.card.as_ref().ok_or_else(|| AgateError::bad_request("missing card data"))?;
            v["card"] = build_card(c);
        }
        ItemType::Identity => {
            let i = input.identity.as_ref().ok_or_else(|| AgateError::bad_request("missing identity data"))?;
            v["identity"] = build_identity(i);
        }
        ItemType::SecureNote => {
            v["secureNote"] = json!({ "type": 0 });
        }
        ItemType::SshKey => {
            let s = input.ssh_key.as_ref().ok_or_else(|| AgateError::bad_request("missing ssh key data"))?;
            v["sshKey"] = build_ssh(s);
        }
        ItemType::Unknown => return Err(AgateError::bad_request("unsupported item type")),
    }
    Ok(())
}

/// Encrypt a `CipherView` and POST (create) or PUT (edit) it to the server.
async fn encrypt_and_push(
    client: &PasswordManagerClient,
    view: CipherView,
    edit_id: Option<CipherId>,
) -> AgateResult<()> {
    let internal = &client.0.internal;
    let user_id = internal.get_user_id().ok_or_else(AgateError::not_authenticated)?;
    let key_store = internal.get_key_store();
    let cipher: Cipher = key_store
        .encrypt(view)
        .map_err(|e| op_err(ErrorKind::Crypto, "encrypt", e))?;
    let mut model: CipherRequestModel = cipher
        .try_into()
        .map_err(|e| op_err(ErrorKind::Internal, "serialize cipher", e))?;
    model.encrypted_for = Some(user_id.into());

    let api = internal.get_api_configurations();
    let ciphers_api = api.api_client.ciphers_api();
    match edit_id {
        Some(id) => {
            ciphers_api
                .put(id.into(), Some(model))
                .await
                .map_err(|e| op_err(ErrorKind::Network, "Save failed", e))?;
        }
        None => {
            ciphers_api
                .post(Some(model))
                .await
                .map_err(|e| op_err(ErrorKind::Network, "Create failed", e))?;
        }
    }
    Ok(())
}

/// Create a new item or edit an existing one (edit when `input.id` is present), in
/// `account_email`'s vault. The frontend re-syncs after a successful write.
pub async fn save_item(state: &AppState, account_email: &str, input: ItemInput) -> AgateResult<()> {
    if input.name.trim().is_empty() {
        return Err(AgateError::bad_request("Name is required."));
    }
    if let super::WriteRoute::Keepass = super::route_for(state, account_email).await? {
        return super::keepass_write(state, account_email, |k| k.save_item(&input)).await;
    }
    let client = client_for(state, account_email).await?;

    match &input.id {
        None => {
            let view: CipherView = serde_json::from_value(create_view_json(&input)?).map_err(build_err)?;
            encrypt_and_push(&client, view, None).await
        }
        Some(id) => {
            let existing = decrypt_one(state, account_email, id).await?;
            let mut v = serde_json::to_value(&existing).map_err(build_err)?;
            let prev_login = v.get("login").cloned();
            v["name"] = json!(input.name);
            v["notes"] = json!(input.notes);
            v["favorite"] = json!(input.favorite);
            v["folderId"] = json!(input.folder_id);
            v["reprompt"] = reprompt_value(input.reprompt);
            v["fields"] = json!(build_fields(&input));
            set_type_payload(&mut v, &input)?;

            // Restore login fields the editor form can't carry (passkeys, password
            // revision date, and a TOTP the editor couldn't show). NOT
            // autofillOnPageLoad — the editor now owns that toggle, so `build_login`
            // already wrote the user's value and we must not clobber it from `prev`.
            if matches!(input.item_type, ItemType::Login) {
                if let (Some(prev), Some(new_login)) = (prev_login.as_ref(), v.get_mut("login")) {
                    for k in ["fido2Credentials", "passwordRevisionDate"] {
                        if let Some(val) = prev.get(k) {
                            new_login[k] = val.clone();
                        }
                    }
                    let totp_blank = new_login.get("totp").map(|t| t.is_null()).unwrap_or(true);
                    if totp_blank {
                        if let Some(t) = prev.get("totp") {
                            new_login["totp"] = t.clone();
                        }
                    }
                }
            }

            let edited: CipherView = serde_json::from_value(v).map_err(build_err)?;
            let cipher_id = parse_id::<CipherId>(id)?;
            encrypt_and_push(&client, edited, Some(cipher_id)).await
        }
    }
}

/// Remember a login for an autofill target: append `uri` (a real site URL or a
/// synthetic `app://<process>` association) to the login's autofill URIs, so the
/// matcher offers it there next time. Idempotent — a URI already present is a no-op.
pub async fn associate_uri(
    state: &AppState,
    account_email: &str,
    item_id: &str,
    uri: &str,
) -> AgateResult<()> {
    let uri = uri.trim();
    if uri.is_empty() {
        return Err(AgateError::bad_request("There's nothing to remember for this app."));
    }
    if let super::WriteRoute::Keepass = super::route_for(state, account_email).await? {
        let uri = uri.to_string();
        return super::keepass_write(state, account_email, move |k| {
            k.add_autofill_uri(item_id, &uri)
        })
        .await;
    }

    let client = client_for(state, account_email).await?;
    let existing = decrypt_one(state, account_email, item_id).await?;
    let mut v = serde_json::to_value(&existing).map_err(build_err)?;
    if v.get("login").map(Value::is_null).unwrap_or(true) {
        return Err(AgateError::bad_request("Only logins can be remembered for autofill."));
    }
    let mut uris = v["login"]["uris"].as_array().cloned().unwrap_or_default();
    // Already associated → nothing to do (don't churn the cipher / revision date).
    if uris.iter().any(|u| u.get("uri").and_then(Value::as_str) == Some(uri)) {
        return Ok(());
    }
    uris.push(json!({ "uri": uri, "match": null }));
    v["login"]["uris"] = json!(uris);
    let view: CipherView = serde_json::from_value(v).map_err(build_err)?;
    encrypt_and_push(&client, view, Some(parse_id::<CipherId>(item_id)?)).await
}

/// Duplicate an item into a new personal cipher named "… - Clone".
pub async fn clone_item(state: &AppState, account_email: &str, id: &str) -> AgateResult<()> {
    if let super::WriteRoute::Keepass = super::route_for(state, account_email).await? {
        // The KeePass provider has no clone primitive; niche enough to defer.
        return Err(AgateError::bad_request("Cloning is not supported for KeePass vaults yet."));
    }
    let client = client_for(state, account_email).await?;
    let existing = decrypt_one(state, account_email, id).await?;

    let mut v = serde_json::to_value(&existing).map_err(build_err)?;
    v["id"] = Value::Null;
    v["name"] = json!(format!("{} - Clone", existing.name));
    v["organizationId"] = Value::Null;
    v["collectionIds"] = json!([]);
    v["key"] = Value::Null;
    v["passwordHistory"] = Value::Null;
    let view: CipherView = serde_json::from_value(v).map_err(build_err)?;
    encrypt_and_push(&client, view, None).await
}

/// Toggle favorite on one item (full edit so it works without edit-permission tricks).
pub async fn set_favorite(state: &AppState, account_email: &str, id: &str, favorite: bool) -> AgateResult<()> {
    if let super::WriteRoute::Keepass = super::route_for(state, account_email).await? {
        return super::keepass_write(state, account_email, |k| k.set_favorite(id, favorite)).await;
    }
    let client = client_for(state, account_email).await?;
    let existing = decrypt_one(state, account_email, id).await?;
    let mut v = serde_json::to_value(&existing).map_err(build_err)?;
    v["favorite"] = json!(favorite);
    let view: CipherView = serde_json::from_value(v).map_err(build_err)?;
    encrypt_and_push(&client, view, Some(parse_id::<CipherId>(id)?)).await
}

/// Move items to a folder within one account (None clears the folder).
pub async fn move_items(
    state: &AppState,
    account_email: &str,
    ids: Vec<String>,
    folder_id: Option<String>,
) -> AgateResult<()> {
    if let super::WriteRoute::Keepass = super::route_for(state, account_email).await? {
        return super::keepass_write(state, account_email, |k| {
            k.move_items(&ids, folder_id.as_deref())
        })
        .await;
    }
    let client = client_for(state, account_email).await?;
    let cipher_ids: Vec<CipherId> = ids.iter().map(|s| parse_id(s)).collect::<AgateResult<_>>()?;
    let folder = parse_opt_id::<bitwarden_vault::FolderId>(&folder_id)?;
    client
        .vault()
        .ciphers()
        .move_many(cipher_ids, folder)
        .await
        .map_err(|e| op_err(ErrorKind::Network, "Move failed", e))?;
    Ok(())
}

/// Delete items in one account. `permanent` skips trash (hard delete).
pub async fn delete_items(
    state: &AppState,
    account_email: &str,
    ids: Vec<String>,
    permanent: bool,
) -> AgateResult<()> {
    if let super::WriteRoute::Keepass = super::route_for(state, account_email).await? {
        return super::keepass_write(state, account_email, |k| k.delete_items(&ids, permanent))
            .await;
    }
    let client = client_for(state, account_email).await?;
    let cipher_ids: Vec<CipherId> = ids.iter().map(|s| parse_id(s)).collect::<AgateResult<_>>()?;
    let ciphers = client.vault().ciphers();
    if permanent {
        ciphers.delete_many(cipher_ids, None).await.map_err(|e| op_err(ErrorKind::Network, "Delete failed", e))?;
    } else {
        ciphers.soft_delete_many(cipher_ids, None).await.map_err(|e| op_err(ErrorKind::Network, "Delete failed", e))?;
    }
    Ok(())
}

/// Restore soft-deleted items from trash in one account.
pub async fn restore_items(state: &AppState, account_email: &str, ids: Vec<String>) -> AgateResult<()> {
    if let super::WriteRoute::Keepass = super::route_for(state, account_email).await? {
        return super::keepass_write(state, account_email, |k| k.restore_items(&ids)).await;
    }
    let client = client_for(state, account_email).await?;
    let cipher_ids: Vec<CipherId> = ids.iter().map(|s| parse_id(s)).collect::<AgateResult<_>>()?;
    client
        .vault()
        .ciphers()
        .restore_many(cipher_ids)
        .await
        .map_err(|e| op_err(ErrorKind::Network, "Restore failed", e))?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::dto::{FieldInput, UriInput};

    /// `build_login` must emit `autofillOnPageLoad` so the editor's toggle round-
    /// trips. Regression guard: it was previously dropped (only restored from the
    /// prior cipher on edit), so a create or a toggle change never persisted.
    #[test]
    fn build_login_carries_autofill_on_page_load() {
        let on = LoginInput {
            username: Some("u".into()),
            password: None,
            totp: None,
            uris: vec![UriInput { uri: Some("https://x".into()), match_type: None }],
            autofill_on_page_load: Some(true),
        };
        assert_eq!(build_login(&on).unwrap()["autofillOnPageLoad"], json!(true));

        let unset = LoginInput {
            username: None,
            password: None,
            totp: None,
            uris: Vec::new(),
            autofill_on_page_load: None,
        };
        assert_eq!(build_login(&unset).unwrap()["autofillOnPageLoad"], Value::Null);
    }

    fn login_input() -> ItemInput {
        ItemInput {
            id: None,
            item_type: ItemType::Login,
            name: "x".into(),
            folder_id: None,
            organization_id: None,
            favorite: false,
            reprompt: false,
            notes: None,
            login: None,
            card: None,
            identity: None,
            ssh_key: None,
            fields: Vec::new(),
        }
    }

    /// Regression: `build_fields` once hardcoded `linkedId: null`, dropping the
    /// linked-field target on every create/edit (round-trip data loss). It must
    /// now carry `f.linked_id` and `f.field_type` through verbatim.
    #[test]
    fn build_fields_preserves_linked_id_and_type() {
        let mut input = login_input();
        input.fields = vec![
            FieldInput { name: Some("acct".into()), value: None, field_type: 3, linked_id: Some(7) },
            FieldInput {
                name: Some("note".into()),
                value: Some("v".into()),
                field_type: 0,
                linked_id: None,
            },
        ];
        let out = build_fields(&input);
        assert_eq!(out.len(), 2);
        // Linked field: the LinkedIdType target survives.
        assert_eq!(out[0]["linkedId"], json!(7));
        assert_eq!(out[0]["type"], json!(3));
        assert_eq!(out[0]["name"], json!("acct"));
        // Plain text field: no linked id.
        assert_eq!(out[1]["linkedId"], Value::Null);
        assert_eq!(out[1]["type"], json!(0));
        assert_eq!(out[1]["value"], json!("v"));
    }
}
