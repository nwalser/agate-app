//! Encrypted scan-result cache commands (save / load the sealed breach + exposed
//! results). Thin wrappers over `scancache`; the crypto + keychain work lives there.

use super::State;
use crate::error::AgateResult;
use crate::scancache;

#[tauri::command]
pub async fn cache_security_scans(state: State<'_>, payload: String) -> AgateResult<()> {
    scancache::save(&state, payload).await
}

#[tauri::command]
pub async fn load_security_scans(state: State<'_>) -> AgateResult<Option<String>> {
    scancache::load(&state).await
}
