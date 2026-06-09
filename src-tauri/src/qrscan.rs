//! Scan a TOTP setup QR code off the screen.
//!
//! When adding TOTP to a login, a website shows an `otpauth://` QR during 2FA
//! enrolment. Rather than retyping the secret, the user clicks "Scan QR" and we
//! grab every monitor (`xcap`), decode any QR codes (`rqrr`), and return the first
//! `otpauth://` URI — which the `login.totp` field stores verbatim and the SDK's
//! `generate_totp` parses directly.
//!
//! All capture + decode happens in Rust. The otpauth URI is a secret: it's handed
//! to the frontend only to populate the editor field, and is never logged.
//!
//! Note: on Windows release builds the Agate window is `WDA_EXCLUDEFROMCAPTURE`
//! (see `hello::protect_window`), so it shows up blank in our own capture — fine,
//! since the QR being scanned lives in another app/browser window.

use rqrr::PreparedImage;
use xcap::Monitor;

use crate::error::{AgateError, AgateResult, ErrorKind};

/// Capture all monitors and return the first `otpauth://` URI found in a QR code.
///
/// Errors (all `Internal`, with a user-facing message):
/// - capture failed everywhere (screen-recording permission denied, no monitors)
/// - captured fine but no otpauth QR was visible
///
/// Blocking work; call from a blocking context (the command wraps it in
/// `spawn_blocking`).
pub fn scan_totp_qr() -> AgateResult<String> {
    let monitors = Monitor::all().map_err(|e| {
        AgateError::new(ErrorKind::Internal, format!("Screen capture failed: {e}"))
    })?;

    // Track whether *any* monitor was captured, to tell "permission denied / no
    // displays" apart from "captured fine but no QR on screen".
    let mut captured_any = false;
    for monitor in monitors {
        // One monitor failing (e.g. just disconnected, or a protected surface)
        // shouldn't abort the scan — try the rest.
        let image = match monitor.capture_image() {
            Ok(img) => img,
            Err(_) => continue,
        };
        captured_any = true;

        let (w, h) = (image.width() as usize, image.height() as usize);
        let raw = image.into_raw(); // RGBA8, 4 bytes/pixel
        if let Some(uri) = decode_otpauth_from_rgba(&raw, w, h) {
            return Ok(uri);
        }
    }

    if !captured_any {
        return Err(AgateError::new(
            ErrorKind::Internal,
            "Screen capture failed. Grant screen-recording permission to Agate and try again.",
        ));
    }
    Err(AgateError::new(
        ErrorKind::Internal,
        "No TOTP QR code found on screen. Make sure the QR is fully visible, then try again.",
    ))
}

/// Decode the first `otpauth://` QR in an RGBA8 buffer, or `None` if there is none.
///
/// Pure (no capture, no I/O) so it's unit-testable from a rendered QR. Feeds rqrr
/// greyscale via its closure constructor, avoiding any `image`-crate type coupling.
fn decode_otpauth_from_rgba(rgba: &[u8], width: usize, height: usize) -> Option<String> {
    if width == 0 || height == 0 || rgba.len() < width * height * 4 {
        return None;
    }
    let mut prepared = PreparedImage::prepare_from_greyscale(width, height, |x, y| {
        let i = (y * width + x) * 4;
        let r = rgba[i] as u32;
        let g = rgba[i + 1] as u32;
        let b = rgba[i + 2] as u32;
        // ITU-R BT.601 luma.
        ((r * 299 + g * 587 + b * 114) / 1000) as u8
    });
    for grid in prepared.detect_grids() {
        // A grid that fails to decode (partial / obscured) is skipped, not fatal.
        if let Ok((_meta, content)) = grid.decode() {
            if content.starts_with("otpauth://") {
                return Some(content);
            }
        }
    }
    None
}

#[cfg(test)]
mod tests {
    use super::*;
    use qrcode::QrCode;

    /// Render `uri` as a QR into an RGBA8 buffer, mimicking a screen capture.
    fn render_qr_rgba(uri: &str) -> (Vec<u8>, usize, usize) {
        let code = QrCode::new(uri.as_bytes()).expect("encode qr");
        // Scale up + keep the quiet zone so rqrr can lock onto the finder patterns.
        let luma = code
            .render::<image::Luma<u8>>()
            .min_dimensions(320, 320)
            .build();
        let (w, h) = (luma.width() as usize, luma.height() as usize);
        let mut rgba = Vec::with_capacity(w * h * 4);
        for p in luma.pixels() {
            let v = p.0[0];
            rgba.extend_from_slice(&[v, v, v, 255]);
        }
        (rgba, w, h)
    }

    #[test]
    fn decodes_otpauth_uri_from_rgba() {
        let uri = "otpauth://totp/Example:alice@example.com?secret=JBSWY3DPEHPK3PXP&issuer=Example";
        let (rgba, w, h) = render_qr_rgba(uri);
        assert_eq!(decode_otpauth_from_rgba(&rgba, w, h).as_deref(), Some(uri));
    }

    #[test]
    fn ignores_non_otpauth_qr() {
        // A QR that isn't a TOTP setup code must not be mistaken for one.
        let (rgba, w, h) = render_qr_rgba("https://example.com/not-a-totp");
        assert_eq!(decode_otpauth_from_rgba(&rgba, w, h), None);
    }

    #[test]
    fn returns_none_for_blank_image() {
        let (w, h) = (64usize, 64usize);
        let rgba = vec![255u8; w * h * 4]; // all white, no QR
        assert_eq!(decode_otpauth_from_rgba(&rgba, w, h), None);
    }

    #[test]
    fn returns_none_for_undersized_buffer() {
        // Guard against a malformed (too-short) buffer rather than panicking.
        assert_eq!(decode_otpauth_from_rgba(&[0, 0, 0], 100, 100), None);
    }
}
