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

use base64::engine::general_purpose::URL_SAFE_NO_PAD;
use base64::Engine as _;
use bitwarden_api_api::models::{CipherCreateRequestModel, CipherRequestModel};
use bitwarden_pm::PasswordManagerClient;
use bitwarden_vault::{Cipher, CipherId, CipherView};
use chrono::Utc;
use serde::de::DeserializeOwned;
use serde_json::{json, Value};

use crate::dto::{CardInput, IdentityInput, ItemInput, ItemType, LoginInput, SshKeyInput};
use crate::error::{AgateError, AgateResult, ErrorKind};
use crate::state::AppState;
use crate::vault::decrypt_one;

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
    json!(i32::from(flag))
}

fn build_login(i: &LoginInput) -> AgateResult<Value> {
    let uris: Vec<Value> = i
        .uris
        .iter()
        .filter(|u| u.uri.as_deref().is_some_and(|s| !s.trim().is_empty()))
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
        "collectionIds": input.collection_ids,
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

/// After `set_type_payload` rebuilds the login sub-view from the editor's input,
/// restore the login fields the editor doesn't model (and must not drop): stored
/// passkeys and the password-revision date. TOTP is deliberately NOT restored —
/// the editor owns the TOTP field now, so an emptied field clears the secret
/// rather than silently reviving the old one.
fn restore_uneditable_login_fields(prev_login: &Value, new_login: &mut Value) {
    for k in ["fido2Credentials", "passwordRevisionDate"] {
        if let Some(val) = prev_login.get(k) {
            new_login[k] = val.clone();
        }
    }
}

/// What to do with an encrypted cipher: create it as a personal cipher, create it
/// as an org cipher in one or more collections, or PUT an edit of an existing one.
#[derive(Debug)]
enum Push {
    /// `POST /ciphers` — a personal cipher (no organization).
    Create,
    /// `POST /ciphers/create` — an org cipher placed into these collections. The
    /// view MUST carry the matching `organizationId` so it encrypts under the org
    /// key.
    CreateInCollections(Vec<uuid::Uuid>),
    /// `PUT /ciphers/{id}` — edit an existing cipher in place.
    Edit(CipherId),
}

/// Encrypt a `CipherView` and push it to the server per `how`.
async fn encrypt_and_push(
    client: &PasswordManagerClient,
    view: CipherView,
    how: Push,
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
    match how {
        Push::Edit(id) => {
            ciphers_api
                .put(id.into(), Some(model))
                .await
                .map_err(|e| op_err(ErrorKind::Network, "Save failed", e))?;
        }
        Push::Create => {
            ciphers_api
                .post(Some(model))
                .await
                .map_err(|e| op_err(ErrorKind::Network, "Create failed", e))?;
        }
        Push::CreateInCollections(collection_ids) => {
            // An org cipher is created via the dedicated endpoint that takes the
            // collections to file it under (`POST /ciphers` is personal-only).
            let req = CipherCreateRequestModel {
                collection_ids: Some(collection_ids),
                cipher: Box::new(model),
            };
            ciphers_api
                .post_create(Some(req))
                .await
                .map_err(|e| op_err(ErrorKind::Network, "Create failed", e))?;
        }
    }
    Ok(())
}

/// Resolve how a CREATE should be pushed from its requested collections: a personal
/// cipher when none, else an org cipher (which requires the org to be set and every
/// collection id to parse).
fn create_push(input: &ItemInput) -> AgateResult<Push> {
    if input.collection_ids.is_empty() {
        return Ok(Push::Create);
    }
    if input.organization_id.is_none() {
        return Err(AgateError::bad_request("A collection requires an organization."));
    }
    let ids = input
        .collection_ids
        .iter()
        .map(|s| uuid::Uuid::parse_str(s).map_err(|_| AgateError::bad_request("invalid collection id")))
        .collect::<AgateResult<Vec<_>>>()?;
    Ok(Push::CreateInCollections(ids))
}

/// Create a new item or edit an existing one (edit when `input.id` is present), in
/// `account_email`'s vault. The frontend re-syncs after a successful write.
pub async fn save_item(state: &AppState, account_email: &str, input: ItemInput) -> AgateResult<()> {
    if input.name.trim().is_empty() {
        return Err(AgateError::bad_request("Name is required."));
    }
    let input = &input;
    super::dispatch_write(
        state,
        account_email,
        |client| async move {
            match &input.id {
                None => {
                    let push = create_push(input)?;
                    let view: CipherView =
                        serde_json::from_value(create_view_json(input)?).map_err(build_err)?;
                    encrypt_and_push(&client, view, push).await
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
                    v["fields"] = json!(build_fields(input));
                    set_type_payload(&mut v, input)?;

                    // Restore login fields the editor form can't model (stored passkeys,
                    // the password-revision date). NOT autofillOnPageLoad and NOT TOTP —
                    // the editor now owns both, so `build_login` already wrote the user's
                    // value (a cleared TOTP must stay cleared) and we must not clobber it.
                    if matches!(input.item_type, ItemType::Login) {
                        if let (Some(prev), Some(new_login)) =
                            (prev_login.as_ref(), v.get_mut("login"))
                        {
                            restore_uneditable_login_fields(prev, new_login);
                        }
                    }

                    let edited: CipherView = serde_json::from_value(v).map_err(build_err)?;
                    let cipher_id = parse_id::<CipherId>(id)?;
                    encrypt_and_push(&client, edited, Push::Edit(cipher_id)).await
                }
            }
        },
        |k| k.save_item(input),
    )
    .await
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
    super::dispatch_write(
        state,
        account_email,
        |client| async move {
            let existing = decrypt_one(state, account_email, item_id).await?;
            let mut v = serde_json::to_value(&existing).map_err(build_err)?;
            if v.get("login").is_none_or(Value::is_null) {
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
            encrypt_and_push(&client, view, Push::Edit(parse_id::<CipherId>(item_id)?)).await
        },
        |k| k.add_autofill_uri(item_id, uri),
    )
    .await
}

/// Remove a stored passkey from an item, identified by its base64url credential
/// id. KeePass strips the passkey's attributes (the item itself survives);
/// Bitwarden drops the matching FIDO2 credential from the cipher's login and
/// re-saves. The frontend re-syncs after a successful write.
///
/// ⚠️ The Bitwarden path is UNVERIFIED against a real account (see
/// `BitwardenConnection::create_passkey`).
pub async fn remove_passkey(
    state: &AppState,
    account_email: &str,
    item_id: &str,
    credential_id: &str,
) -> AgateResult<()> {
    super::dispatch_write(
        state,
        account_email,
        |client| async move {
            let mut view = decrypt_one(state, account_email, item_id).await?;

            // Find which FIDO2 credential matches, by its (plaintext) credential id.
            let idx = {
                let key_store = client.0.internal.get_key_store();
                let mut ctx = key_store.context();
                let creds = view
                    .decrypt_fido2_credentials(&mut ctx)
                    .map_err(|e| op_err(ErrorKind::Crypto, "read passkeys", e))?;
                creds
                    .iter()
                    .position(|c| c.credential_id == credential_id)
                    .ok_or_else(|| AgateError::bad_request("No such passkey."))?
            };

            // Drop the encrypted credential at that index (order matches the views),
            // then re-encrypt + save the cipher. Remaining credentials pass through.
            let removed = view
                .login
                .as_mut()
                .and_then(|l| l.fido2_credentials.as_mut())
                .filter(|creds| idx < creds.len())
                .map(|creds| {
                    creds.remove(idx);
                })
                .is_some();
            if !removed {
                return Err(AgateError::bad_request("No such passkey."));
            }

            encrypt_and_push(&client, view, Push::Edit(parse_id::<CipherId>(item_id)?)).await
        },
        |k| {
            let bytes = URL_SAFE_NO_PAD
                .decode(credential_id)
                .map_err(|_| AgateError::bad_request("invalid credential id"))?;
            k.remove_passkey(&bytes)
        },
    )
    .await
}

/// Duplicate an item into a new personal cipher named "… - Clone".
pub async fn clone_item(state: &AppState, account_email: &str, id: &str) -> AgateResult<()> {
    super::dispatch_write(
        state,
        account_email,
        |client| async move {
            let existing = decrypt_one(state, account_email, id).await?;

            let mut v = serde_json::to_value(&existing).map_err(build_err)?;
            v["id"] = Value::Null;
            v["name"] = json!(format!("{} - Clone", existing.name));
            v["organizationId"] = Value::Null;
            v["collectionIds"] = json!([]);
            v["key"] = Value::Null;
            v["passwordHistory"] = Value::Null;
            let view: CipherView = serde_json::from_value(v).map_err(build_err)?;
            encrypt_and_push(&client, view, Push::Create).await
        },
        // The KeePass provider has no clone primitive; niche enough to defer.
        |_k| Err(AgateError::bad_request("Cloning is not supported for KeePass vaults yet.")),
    )
    .await
}

/// Toggle favorite on one item (full edit so it works without edit-permission tricks).
pub async fn set_favorite(state: &AppState, account_email: &str, id: &str, favorite: bool) -> AgateResult<()> {
    super::dispatch_write(
        state,
        account_email,
        |client| async move {
            let existing = decrypt_one(state, account_email, id).await?;
            let mut v = serde_json::to_value(&existing).map_err(build_err)?;
            v["favorite"] = json!(favorite);
            let view: CipherView = serde_json::from_value(v).map_err(build_err)?;
            encrypt_and_push(&client, view, Push::Edit(parse_id::<CipherId>(id)?)).await
        },
        |k| k.set_favorite(id, favorite),
    )
    .await
}

/// Move items to a folder within one account (None clears the folder).
pub async fn move_items(
    state: &AppState,
    account_email: &str,
    ids: Vec<String>,
    folder_id: Option<String>,
) -> AgateResult<()> {
    let ids = &ids;
    let folder_id = &folder_id;
    super::dispatch_write(
        state,
        account_email,
        |client| async move {
            let cipher_ids: Vec<CipherId> =
                ids.iter().map(|s| parse_id(s)).collect::<AgateResult<_>>()?;
            let folder = parse_opt_id::<bitwarden_vault::FolderId>(folder_id)?;
            client
                .vault()
                .ciphers()
                .move_many(cipher_ids, folder)
                .await
                .map_err(|e| op_err(ErrorKind::Network, "Move failed", e))?;
            Ok(())
        },
        |k| k.move_items(ids, folder_id.as_deref()),
    )
    .await
}

/// Delete items in one account. `permanent` skips trash (hard delete).
pub async fn delete_items(
    state: &AppState,
    account_email: &str,
    ids: Vec<String>,
    permanent: bool,
) -> AgateResult<()> {
    let ids = &ids;
    super::dispatch_write(
        state,
        account_email,
        |client| async move {
            let cipher_ids: Vec<CipherId> =
                ids.iter().map(|s| parse_id(s)).collect::<AgateResult<_>>()?;
            let ciphers = client.vault().ciphers();
            if permanent {
                ciphers.delete_many(cipher_ids, None).await.map_err(|e| op_err(ErrorKind::Network, "Delete failed", e))?;
            } else {
                ciphers.soft_delete_many(cipher_ids, None).await.map_err(|e| op_err(ErrorKind::Network, "Delete failed", e))?;
            }
            Ok(())
        },
        |k| k.delete_items(ids, permanent),
    )
    .await
}

/// Restore soft-deleted items from trash in one account.
pub async fn restore_items(state: &AppState, account_email: &str, ids: Vec<String>) -> AgateResult<()> {
    let ids = &ids;
    super::dispatch_write(
        state,
        account_email,
        |client| async move {
            let cipher_ids: Vec<CipherId> =
                ids.iter().map(|s| parse_id(s)).collect::<AgateResult<_>>()?;
            client
                .vault()
                .ciphers()
                .restore_many(cipher_ids)
                .await
                .map_err(|e| op_err(ErrorKind::Network, "Restore failed", e))?;
            Ok(())
        },
        |k| k.restore_items(ids),
    )
    .await
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
            collection_ids: Vec::new(),
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

    /// A create with no collections is a personal cipher; one with collections is
    /// an org cipher (every id parsed) and REQUIRES the organization to be set.
    #[test]
    fn create_push_routes_personal_vs_org_collections() {
        // No collections → personal POST.
        let personal = login_input();
        assert!(matches!(create_push(&personal).unwrap(), Push::Create));

        // Collections without an org → rejected (an org cipher needs its org).
        let mut orphan = login_input();
        orphan.collection_ids = vec!["11111111-1111-1111-1111-111111111111".into()];
        assert!(matches!(create_push(&orphan).unwrap_err().kind, ErrorKind::BadRequest));

        // Collections + org → org create with the parsed ids.
        let mut org = login_input();
        org.organization_id = Some("22222222-2222-2222-2222-222222222222".into());
        org.collection_ids = vec!["11111111-1111-1111-1111-111111111111".into()];
        match create_push(&org).unwrap() {
            Push::CreateInCollections(ids) => {
                assert_eq!(ids, vec![uuid::Uuid::parse_str("11111111-1111-1111-1111-111111111111").unwrap()]);
            }
            _ => panic!("expected an org create"),
        }

        // A malformed collection id is rejected (bad input at the trust boundary).
        let mut bad = login_input();
        bad.organization_id = Some("22222222-2222-2222-2222-222222222222".into());
        bad.collection_ids = vec!["not-a-uuid".into()];
        assert!(matches!(create_push(&bad).unwrap_err().kind, ErrorKind::BadRequest));
    }

    /// The edit merge restores passkeys + the password-revision date the editor
    /// can't model, but must NOT restore the TOTP: the editor owns it now, so a
    /// cleared field has to stay cleared (regression for the provider-aware form).
    #[test]
    fn edit_restores_passkeys_and_revision_but_lets_the_editor_clear_totp() {
        let prev = json!({
            "username": "old",
            "totp": "OLDSEED",
            "fido2Credentials": [{ "credentialId": "abc" }],
            "passwordRevisionDate": "2025-01-01T00:00:00Z",
            "uris": [],
        });
        // What `build_login` produced for an edit that cleared the TOTP.
        let mut new_login = json!({
            "username": "new",
            "password": "new",
            "totp": null,
            "uris": [],
            "autofillOnPageLoad": null,
        });
        restore_uneditable_login_fields(&prev, &mut new_login);
        // Passkeys + revision date carry through (the editor can't model them).
        assert_eq!(new_login["fido2Credentials"], json!([{ "credentialId": "abc" }]));
        assert_eq!(new_login["passwordRevisionDate"], json!("2025-01-01T00:00:00Z"));
        // A cleared TOTP STAYS cleared — not revived from `prev`.
        assert!(new_login["totp"].is_null());
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
