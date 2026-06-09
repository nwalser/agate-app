//! Vault write operations: create / edit / delete / restore / move / favorite /
//! clone items, and folder create / rename. Every operation routes to a specific
//! connection by `account_email` (the unified list mixes accounts, so the caller
//! always says which vault an item lives in / a new item goes into).
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
use bitwarden_vault::{Cipher, CipherId, CipherView, FolderAddEditRequest, FolderId};
use serde::de::DeserializeOwned;
use serde_json::{json, Value};

use crate::dto::{CardInput, Folder, IdentityInput, ItemInput, ItemType, LoginInput, SshKeyInput};
use crate::error::{AgateError, AgateResult, ErrorKind};
use crate::server;
use crate::state::AppState;
use crate::vault::{client_for, decrypt_one};

fn op_err(kind: ErrorKind, what: &str, e: impl std::fmt::Display) -> AgateError {
    AgateError::new(kind, format!("{what}: {e}"))
}

fn build_err(e: impl std::fmt::Display) -> AgateError {
    AgateError::new(ErrorKind::BadRequest, format!("invalid item data: {e}"))
}

/// Server label for one connection (for stamping returned folders).
async fn account_label(state: &AppState, email: &str) -> String {
    let cfg = state.config.lock().await;
    cfg.server_for(email)
        .map(|s| server::server_label(&s))
        .unwrap_or_else(|| email.to_string())
}

/// Parse a string id into a typed SDK id via serde (CipherId/FolderId/OrganizationId).
fn parse_id<T: DeserializeOwned>(s: &str) -> AgateResult<T> {
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
        "creationDate": "2025-01-01T00:00:00Z",
        "deletedDate": null,
        "revisionDate": "2025-01-01T00:00:00Z",
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
            // revision date, autofill flag, and a TOTP the editor couldn't show).
            if matches!(input.item_type, ItemType::Login) {
                if let (Some(prev), Some(new_login)) = (prev_login.as_ref(), v.get_mut("login")) {
                    for k in ["fido2Credentials", "passwordRevisionDate", "autofillOnPageLoad"] {
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

/// Duplicate an item into a new personal cipher named "… - Clone".
pub async fn clone_item(state: &AppState, account_email: &str, id: &str) -> AgateResult<()> {
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
    let client = client_for(state, account_email).await?;
    let cipher_ids: Vec<CipherId> = ids.iter().map(|s| parse_id(s)).collect::<AgateResult<_>>()?;
    let folder = parse_opt_id::<FolderId>(&folder_id)?;
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

/// Create a personal folder in one account.
pub async fn create_folder(state: &AppState, account_email: &str, name: String) -> AgateResult<Folder> {
    if name.trim().is_empty() {
        return Err(AgateError::bad_request("Folder name is required."));
    }
    let client = client_for(state, account_email).await?;
    let view = client
        .vault()
        .folders()
        .create(FolderAddEditRequest { name })
        .await
        .map_err(|e| op_err(ErrorKind::Network, "Create folder failed", e))?;
    Ok(Folder {
        id: view.id.map(|i| i.to_string()),
        name: view.name,
        account_email: account_email.to_string(),
        account_label: account_label(state, account_email).await,
    })
}

/// Delete a single folder entity in one account. The server clears the folder
/// association on any item that referenced it (those items move to "No folder" —
/// deleting a folder never deletes its items). Subtree deletes + explicit item
/// reassignment are orchestrated by the frontend (it has the decrypted folder +
/// item lists and re-syncs after), so this stays a thin one-folder wrapper.
///
/// No SDK high-level `delete` exists, so we hit the raw `folders_api()` the same
/// way `encrypt_and_push` reaches `ciphers_api()`. The SDK's local folder repo
/// goes stale after this raw delete; the post-mutation re-sync refreshes it.
pub async fn delete_folder(state: &AppState, account_email: &str, id: &str) -> AgateResult<()> {
    // Validate the id shape before touching the network.
    let _: FolderId = parse_id(id)?;
    let client = client_for(state, account_email).await?;
    let api = client.0.internal.get_api_configurations();
    api.api_client
        .folders_api()
        .delete(id)
        .await
        .map_err(|e| op_err(ErrorKind::Network, "Delete folder failed", e))?;
    Ok(())
}

/// Rename an existing folder in one account.
pub async fn rename_folder(state: &AppState, account_email: &str, id: &str, name: String) -> AgateResult<Folder> {
    if name.trim().is_empty() {
        return Err(AgateError::bad_request("Folder name is required."));
    }
    let client = client_for(state, account_email).await?;
    let view = client
        .vault()
        .folders()
        .edit(parse_id::<FolderId>(id)?, FolderAddEditRequest { name })
        .await
        .map_err(|e| op_err(ErrorKind::Network, "Rename folder failed", e))?;
    Ok(Folder {
        id: view.id.map(|i| i.to_string()),
        name: view.name,
        account_email: account_email.to_string(),
        account_label: account_label(state, account_email).await,
    })
}
