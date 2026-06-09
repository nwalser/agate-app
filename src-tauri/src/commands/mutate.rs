//! Vault write commands (save / clone / favorite / move / delete / restore / folders).

use super::State;
use crate::dto::{Folder, ItemInput};
use crate::error::AgateResult;
use crate::mutate;

#[tauri::command]
pub async fn save_item(state: State<'_>, account_email: String, input: ItemInput) -> AgateResult<()> {
    mutate::save_item(&state, &account_email, input).await
}

#[tauri::command]
pub async fn clone_item(state: State<'_>, account_email: String, id: String) -> AgateResult<()> {
    mutate::clone_item(&state, &account_email, &id).await
}

#[tauri::command]
pub async fn set_favorite(
    state: State<'_>,
    account_email: String,
    id: String,
    favorite: bool,
) -> AgateResult<()> {
    mutate::set_favorite(&state, &account_email, &id, favorite).await
}

#[tauri::command]
pub async fn move_items(
    state: State<'_>,
    account_email: String,
    ids: Vec<String>,
    folder_id: Option<String>,
) -> AgateResult<()> {
    mutate::move_items(&state, &account_email, ids, folder_id).await
}

#[tauri::command]
pub async fn delete_items(
    state: State<'_>,
    account_email: String,
    ids: Vec<String>,
    permanent: bool,
) -> AgateResult<()> {
    mutate::delete_items(&state, &account_email, ids, permanent).await
}

#[tauri::command]
pub async fn restore_items(
    state: State<'_>,
    account_email: String,
    ids: Vec<String>,
) -> AgateResult<()> {
    mutate::restore_items(&state, &account_email, ids).await
}

#[tauri::command]
pub async fn create_folder(
    state: State<'_>,
    account_email: String,
    name: String,
) -> AgateResult<Folder> {
    mutate::create_folder(&state, &account_email, name).await
}

#[tauri::command]
pub async fn rename_folder(
    state: State<'_>,
    account_email: String,
    id: String,
    name: String,
) -> AgateResult<Folder> {
    mutate::rename_folder(&state, &account_email, &id, name).await
}

#[tauri::command]
pub async fn delete_folder(
    state: State<'_>,
    account_email: String,
    id: String,
) -> AgateResult<()> {
    mutate::delete_folder(&state, &account_email, &id).await
}
