//! Folder write operations: create / rename / delete, each scoped to one
//! connection by `account_email`.
//!
//! We bypass the SDK's high-level `FoldersClient::{create,edit}` because both are
//! repository-backed (`repository.require()` / `get`), and Agate registers no
//! folder repository — so they'd error even when the server write succeeded. This
//! mirrors how cipher writes go straight through `ciphers_api()` in
//! `encrypt_and_push`.

use bitwarden_api_api::models::FolderRequestModel;
use bitwarden_pm::PasswordManagerClient;
use bitwarden_vault::{FolderAddEditRequest, FolderId};

use crate::dto::Folder;
use crate::error::{AgateError, AgateResult, ErrorKind};
use crate::server;
use crate::state::AppState;
use crate::vault::client_for;

use super::writes::{op_err, parse_id};

/// Server label for one connection (for stamping returned folders).
async fn account_label(state: &AppState, email: &str) -> String {
    let cfg = state.config.lock().await;
    cfg.server_for(email).map_or_else(|| email.to_string(), |s| server::server_label(&s))
}

/// Encrypt a folder name and create (no id) or rename (with id) it via the raw
/// `folders_api()`, returning the server's folder id. We bypass the SDK's
/// high-level `FoldersClient::{create,edit}` because both are repository-backed
/// (`repository.require()` / `get`), and Agate registers no folder repository —
/// so they'd error even when the server write succeeded. This mirrors how cipher
/// writes go straight through `ciphers_api()` in `encrypt_and_push`.
async fn push_folder(
    client: &PasswordManagerClient,
    id: Option<&str>,
    name: &str,
) -> AgateResult<Option<String>> {
    let internal = &client.0.internal;
    let key_store = internal.get_key_store();
    let model: FolderRequestModel = key_store
        .encrypt(FolderAddEditRequest { name: name.to_string() })
        .map_err(|e| op_err(ErrorKind::Crypto, "encrypt folder", e))?;
    let api = internal.get_api_configurations();
    let folders_api = api.api_client.folders_api();
    let resp = match id {
        Some(id) => folders_api
            .put(id, Some(model))
            .await
            .map_err(|e| op_err(ErrorKind::Network, "Rename folder failed", e))?,
        None => folders_api
            .post(Some(model))
            .await
            .map_err(|e| op_err(ErrorKind::Network, "Create folder failed", e))?,
    };
    Ok(resp.id.map(|i| i.to_string()))
}

/// Create a personal folder in one account.
pub async fn create_folder(state: &AppState, account_email: &str, name: String) -> AgateResult<Folder> {
    if name.trim().is_empty() {
        return Err(AgateError::bad_request("Folder name is required."));
    }
    match super::route_for(state, account_email).await? {
        super::WriteRoute::Keepass => {
            // The provider returns the new group's id; stamp the connection here
            // (it doesn't know its own id/label, same as the Bitwarden path).
            let folder =
                super::keepass_write(state, account_email, |k| k.create_folder(&name)).await?;
            Ok(Folder {
                id: folder.id,
                name: folder.name,
                account_email: account_email.to_string(),
                account_label: account_label(state, account_email).await,
            })
        }
        super::WriteRoute::Bitwarden => {
            let client = client_for(state, account_email).await?;
            let id = push_folder(&client, None, &name).await?;
            Ok(Folder {
                id,
                name,
                account_email: account_email.to_string(),
                account_label: account_label(state, account_email).await,
            })
        }
    }
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
    match super::route_for(state, account_email).await? {
        super::WriteRoute::Keepass => {
            super::keepass_write(state, account_email, |k| k.delete_folder(id)).await
        }
        super::WriteRoute::Bitwarden => {
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
    }
}

/// Rename an existing folder in one account.
pub async fn rename_folder(state: &AppState, account_email: &str, id: &str, name: String) -> AgateResult<Folder> {
    if name.trim().is_empty() {
        return Err(AgateError::bad_request("Folder name is required."));
    }
    match super::route_for(state, account_email).await? {
        super::WriteRoute::Keepass => {
            super::keepass_write(state, account_email, |k| k.rename_folder(id, &name)).await?;
            Ok(Folder {
                id: Some(id.to_string()),
                name,
                account_email: account_email.to_string(),
                account_label: account_label(state, account_email).await,
            })
        }
        super::WriteRoute::Bitwarden => {
            // Validate the id shape before touching the network.
            let _: FolderId = parse_id(id)?;
            let client = client_for(state, account_email).await?;
            push_folder(&client, Some(id), &name).await?;
            Ok(Folder {
                // A rename keeps the same id; echo the caller's (the response repeats it).
                id: Some(id.to_string()),
                name,
                account_email: account_email.to_string(),
                account_label: account_label(state, account_email).await,
            })
        }
    }
}
