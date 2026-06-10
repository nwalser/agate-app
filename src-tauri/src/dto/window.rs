//! Custom-titlebar window-control layout DTOs (backend → frontend).
//! Mirrors `src/lib/types.ts`.

use serde::Serialize;

/// Where the custom titlebar's window-control buttons sit and in what order, so
/// a borderless window (Windows/Linux) matches the host. On Linux this is read
/// from the desktop's `button-layout`; elsewhere it's a fixed platform default.
#[derive(Debug, Clone, Serialize)]
#[cfg_attr(test, derive(specta::Type))]
#[serde(rename_all = "camelCase")]
pub struct WindowControlsLayout {
    pub side: ControlsSide,
    pub buttons: Vec<WindowControl>,
}

#[derive(Debug, Clone, Copy, Serialize)]
#[cfg_attr(test, derive(specta::Type))]
#[serde(rename_all = "camelCase")]
pub enum ControlsSide {
    // `Left` is only ever produced on Linux (from the desktop button-layout); on
    // other platforms the layout is always `Right`, so the variant is dead there.
    #[cfg_attr(not(target_os = "linux"), allow(dead_code))]
    Left,
    Right,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[cfg_attr(test, derive(specta::Type))]
#[serde(rename_all = "camelCase")]
pub enum WindowControl {
    Minimize,
    Maximize,
    Close,
}
