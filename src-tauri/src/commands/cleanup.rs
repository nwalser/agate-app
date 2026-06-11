//! Vault-cleanup commands. Link-health checker: on demand, pings every login URL
//! and flags the dead ones so the item can be updated. On-demand only (never
//! background) — see `src-tauri/src/cleanup/`.

use super::State;
use crate::cleanup;
use crate::dto::LinkCheckReport;
use crate::error::AgateResult;

#[tauri::command]
pub async fn link_check_vault(state: State<'_>) -> AgateResult<LinkCheckReport> {
    cleanup::link_check_vault(&state).await
}
