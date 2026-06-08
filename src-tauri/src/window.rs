//! Native window-chrome helpers.
//!
//! The window runs borderless on Windows/Linux (see `lib.rs` setup), so the
//! frontend titlebar (`src/components/Titlebar.tsx`) draws its own
//! minimize/maximize/close controls. To feel native it places them per the
//! host: a fixed convention on Windows, and the desktop's configured
//! `button-layout` on Linux. macOS keeps its real traffic lights and never
//! calls this.

use crate::dto::{ControlsSide, WindowControl, WindowControlsLayout};

/// The control layout to render. Linux reads the GNOME `button-layout`
/// gsetting; every other platform (and any Linux read failure) uses the
/// right-hand minimize/maximize/close default.
pub fn controls_layout() -> WindowControlsLayout {
    #[cfg(target_os = "linux")]
    {
        linux_layout().unwrap_or_else(default_layout)
    }
    #[cfg(not(target_os = "linux"))]
    {
        default_layout()
    }
}

/// Windows / fallback convention: minimize, maximize, close — on the right.
fn default_layout() -> WindowControlsLayout {
    WindowControlsLayout {
        side: ControlsSide::Right,
        buttons: vec![
            WindowControl::Minimize,
            WindowControl::Maximize,
            WindowControl::Close,
        ],
    }
}

/// Read GNOME/GTK's title-button preference. Returns `None` (→ default) when
/// `gsettings` is absent or the key is unset, as on KDE/XFCE — whose own
/// default is also right-hand controls.
#[cfg(target_os = "linux")]
fn linux_layout() -> Option<WindowControlsLayout> {
    use std::process::Command;
    let out = Command::new("gsettings")
        .args(["get", "org.gnome.desktop.wm.preferences", "button-layout"])
        .output()
        .ok()?;
    if !out.status.success() {
        return None;
    }
    let raw = String::from_utf8(out.stdout).ok()?;
    parse_button_layout(&raw)
}

/// Parse a GNOME `button-layout` value (e.g. `'appmenu:minimize,maximize,close'`
/// or `'close,minimize,maximize:'`) into our side + ordered buttons. The single
/// `:` splits the left-of-title group from the right-of-title group; the window
/// controls normally cluster on one side. Unknown tokens (`appmenu`, `icon`,
/// `spacer`) are ignored. We report the side holding the close button.
#[cfg(target_os = "linux")]
fn parse_button_layout(raw: &str) -> Option<WindowControlsLayout> {
    let trimmed = raw.trim().trim_matches(|c| c == '\'' || c == '"');
    let (left, right) = trimmed.split_once(':').unwrap_or(("", trimmed));

    let parse_group = |group: &str| -> Vec<WindowControl> {
        group
            .split(',')
            .filter_map(|token| match token.trim() {
                "minimize" => Some(WindowControl::Minimize),
                "maximize" => Some(WindowControl::Maximize),
                "close" => Some(WindowControl::Close),
                _ => None,
            })
            .collect()
    };
    let left_buttons = parse_group(left);
    let right_buttons = parse_group(right);

    // Cluster on whichever side carries the close button, or the only populated
    // side. Neither populated → treat as absent so the caller uses the default.
    let (side, buttons) = if right_buttons.contains(&WindowControl::Close)
        || (!right_buttons.is_empty() && left_buttons.is_empty())
    {
        (ControlsSide::Right, right_buttons)
    } else if !left_buttons.is_empty() {
        (ControlsSide::Left, left_buttons)
    } else {
        return None;
    };
    Some(WindowControlsLayout { side, buttons })
}

#[cfg(all(test, target_os = "linux"))]
mod tests {
    use super::*;

    #[test]
    fn parses_right_hand_gnome_default() {
        let l = parse_button_layout("'appmenu:minimize,maximize,close'").unwrap();
        assert!(matches!(l.side, ControlsSide::Right));
        assert_eq!(
            l.buttons,
            vec![
                WindowControl::Minimize,
                WindowControl::Maximize,
                WindowControl::Close
            ]
        );
    }

    #[test]
    fn parses_left_hand_layout() {
        let l = parse_button_layout("'close,minimize,maximize:'").unwrap();
        assert!(matches!(l.side, ControlsSide::Left));
        assert_eq!(l.buttons.first(), Some(&WindowControl::Close));
    }

    #[test]
    fn close_only_layout() {
        let l = parse_button_layout("'appmenu:close'").unwrap();
        assert!(matches!(l.side, ControlsSide::Right));
        assert_eq!(l.buttons, vec![WindowControl::Close]);
    }

    #[test]
    fn empty_layout_is_none() {
        assert!(parse_button_layout("':'").is_none());
    }
}
