//! Autofill commands: feature status, mode switch, submit/denylist settings, the
//! pending detection (with ranked candidates), fill, associate, and dismiss. Thin
//! wrappers over `crate::autofill` (+ `crate::mutate` for the associate write).

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

/// Persist whether a successful fill presses Enter to submit the form.
#[tauri::command]
pub async fn autofill_set_submit(state: State<'_>, submit: bool) -> AgateResult<()> {
    autofill::set_submit(&state, submit).await
}

/// Replace the per-app denylist ("never offer autofill in these apps").
#[tauri::command]
pub async fn autofill_set_denylist(state: State<'_>, denylist: Vec<String>) -> AgateResult<()> {
    autofill::set_denylist(&state, denylist).await
}

/// Remember a login for the current target ("use this login here"): append the
/// detected association URI to the chosen login so it matches there next time.
#[tauri::command]
pub async fn autofill_associate(
    state: State<'_>,
    account_email: String,
    item_id: String,
    uri: String,
) -> AgateResult<()> {
    crate::mutate::associate_uri(&state, &account_email, &item_id, &uri).await
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
