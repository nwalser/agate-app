//! Window-chrome query command.

use crate::dto;
use crate::window;

/// The titlebar's window-control layout for this platform (Linux reads the
/// desktop's `button-layout`; others use a fixed default). Pure host query — no
/// state, never fails.
#[tauri::command]
pub fn window_controls_layout() -> dto::WindowControlsLayout {
    window::controls_layout()
}
