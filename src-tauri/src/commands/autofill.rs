//! Autofill commands: feature status, mode switch, the pending detection (with
//! ranked candidates), fill, and dismiss. Thin wrappers over `crate::autofill`.

use super::State;
use crate::autofill;
use crate::dto::{AutofillMode, AutofillPending, AutofillStatus};
use crate::error::AgateResult;

#[tauri::command]
pub async fn autofill_status(state: State<'_>) -> AgateResult<AutofillStatus> {
    Ok(autofill::status(&state).await)
}

#[tauri::command]
pub async fn autofill_set_mode(
    app: tauri::AppHandle,
    state: State<'_>,
    mode: AutofillMode,
) -> AgateResult<()> {
    autofill::set_mode(&app, &state, mode).await
}

#[tauri::command]
pub async fn autofill_pending(state: State<'_>) -> AgateResult<Option<AutofillPending>> {
    autofill::pending(&state).await
}

#[tauri::command]
pub async fn autofill_fill(
    app: tauri::AppHandle,
    state: State<'_>,
    token: String,
    account_email: String,
    item_id: String,
) -> AgateResult<()> {
    autofill::fill(&app, &state, &token, &account_email, &item_id).await
}

#[tauri::command]
pub async fn autofill_dismiss(state: State<'_>) -> AgateResult<()> {
    autofill::dismiss(&state).await;
    Ok(())
}
