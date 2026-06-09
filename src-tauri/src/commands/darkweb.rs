//! Dark-web / breach-monitor commands (consent + email/vault scans + directory).

use super::State;
use crate::darkweb;
use crate::dto::{AccountBreaches, BreachRecord, DarkWebReport};
use crate::error::AgateResult;

#[tauri::command]
pub async fn set_darkweb_consent(state: State<'_>, enabled: bool) -> AgateResult<()> {
    darkweb::set_consent(&state, enabled).await
}

#[tauri::command]
pub async fn darkweb_scan_email(state: State<'_>, email: String) -> AgateResult<AccountBreaches> {
    darkweb::scan_email(&state, email).await
}

#[tauri::command]
pub async fn darkweb_scan_vault(state: State<'_>) -> AgateResult<DarkWebReport> {
    darkweb::scan_vault(&state).await
}

#[tauri::command]
pub async fn breach_directory(state: State<'_>) -> AgateResult<Vec<BreachRecord>> {
    darkweb::directory(&state).await
}
