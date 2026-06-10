//! OCR commands: availability probe, full-screen recognition, and recognition
//! over a user-picked image file. Thin wrappers over `crate::ocr` — the
//! recognized text may contain secrets (a card PAN), so it is never logged.

use tauri_plugin_dialog::DialogExt;

use crate::error::{AgateError, AgateResult};
use crate::ocr;

/// Whether OCR is available on this platform (Windows-native engine for now).
#[tauri::command]
pub async fn ocr_available() -> AgateResult<bool> {
    Ok(ocr::available())
}

/// Capture every monitor and return the recognized text lines.
#[tauri::command]
pub async fn ocr_capture_screen() -> AgateResult<Vec<String>> {
    // Capture + recognition are blocking/CPU-bound; keep them off the async
    // runtime's worker threads (same shape as scan_totp_qr).
    tokio::task::spawn_blocking(ocr::ocr_screen)
        .await
        .map_err(|e| AgateError::internal(format!("OCR task failed: {e}")))?
}

/// Pick an image file and return its recognized text lines (None = cancelled).
#[tauri::command]
pub async fn ocr_capture_file(app: tauri::AppHandle) -> AgateResult<Option<Vec<String>>> {
    let Some(file) = app
        .dialog()
        .file()
        .add_filter("Images", &["png", "jpg", "jpeg", "bmp", "webp"])
        .blocking_pick_file()
    else {
        return Ok(None); // user cancelled
    };
    let path = file
        .into_path()
        .map_err(|e| AgateError::internal(format!("Could not resolve the chosen file: {e}")))?;
    let lines = tokio::task::spawn_blocking(move || ocr::ocr_file(&path))
        .await
        .map_err(|e| AgateError::internal(format!("OCR task failed: {e}")))??;
    Ok(Some(lines))
}
