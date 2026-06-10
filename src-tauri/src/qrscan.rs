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

/// Capture all monitors and return THE `otpauth://totp/` URI visible in a QR code.
///
/// Errors (all `Internal`, with a user-facing message):
/// - capture failed everywhere (screen-recording permission denied, no monitors)
/// - captured fine but no TOTP QR was visible
/// - MORE than one distinct TOTP QR was visible (returning an arbitrary one would
///   silently store the wrong secret — e.g. an old enrolment page still open)
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
    let mut found: Vec<String> = Vec::new();
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
        for uri in decode_totp_uris_from_rgba(&raw, w, h) {
            // Exact duplicates collapse (the same QR on mirrored displays is one
            // secret, not an ambiguity).
            if !found.contains(&uri) {
                found.push(uri);
            }
        }
    }
    resolve_scan(found, captured_any)
}

/// Turn the capture sweep's findings into the scan result (pure, unit-tested).
fn resolve_scan(mut found: Vec<String>, captured_any: bool) -> AgateResult<String> {
    if !captured_any {
        return Err(AgateError::new(
            ErrorKind::Internal,
            "Screen capture failed. Grant screen-recording permission to Agate and try again.",
        ));
    }
    match found.len() {
        0 => Err(AgateError::new(
            ErrorKind::Internal,
            "No TOTP QR code found on screen. Make sure the QR is fully visible, then try again.",
        )),
        1 => Ok(found.swap_remove(0)),
        _ => Err(AgateError::new(
            ErrorKind::Internal,
            "Multiple TOTP QR codes are visible. Show only the one you want to add, then try again.",
        )),
    }
}

const TOTP_PREFIX: &str = "otpauth://totp/";

/// Accept `content` as a TOTP enrolment URI: the `otpauth://totp/` prefix is
/// matched case-insensitively (QR alphanumeric mode encodes ALL-CAPS, and the
/// scheme/type are case-insensitive per RFC 3986) and canonicalized to
/// lowercase; everything after it — label, secret, params — stays verbatim.
/// HOTP (counter-based) is rejected outright: storing it would later generate
/// time-based codes from a counter-based secret, i.e. silently wrong codes.
fn canonical_totp_uri(content: &str) -> Option<String> {
    let prefix = content.get(..TOTP_PREFIX.len())?;
    if !prefix.eq_ignore_ascii_case(TOTP_PREFIX) {
        return None;
    }
    Some(format!("{TOTP_PREFIX}{}", &content[TOTP_PREFIX.len()..]))
}

/// All distinct TOTP enrolment URIs decodable from an RGBA8 buffer (prefix
/// canonicalized — see `canonical_totp_uri`).
///
/// Pure (no capture, no I/O) so it's unit-testable from a rendered QR. Feeds rqrr
/// greyscale via its closure constructor, avoiding any `image`-crate type coupling.
fn decode_totp_uris_from_rgba(rgba: &[u8], width: usize, height: usize) -> Vec<String> {
    let mut out: Vec<String> = Vec::new();
    if width == 0 || height == 0 || rgba.len() < width * height * 4 {
        return out;
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
            if let Some(uri) = canonical_totp_uri(&content) {
                if !out.contains(&uri) {
                    out.push(uri);
                }
            }
        }
    }
    out
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

    /// Blit two rendered QR buffers side by side on one white canvas (one
    /// "screen" showing two codes), with a quiet-zone gap between them.
    fn side_by_side(a: (Vec<u8>, usize, usize), b: (Vec<u8>, usize, usize)) -> (Vec<u8>, usize, usize) {
        let gap = 40usize;
        let w = a.1 + gap + b.1;
        let h = a.2.max(b.2);
        let mut canvas = vec![255u8; w * h * 4];
        for (buf, bw, bh, x0) in [(&a.0, a.1, a.2, 0usize), (&b.0, b.1, b.2, a.1 + gap)] {
            for y in 0..bh {
                let src = y * bw * 4;
                let dst = (y * w + x0) * 4;
                canvas[dst..dst + bw * 4].copy_from_slice(&buf[src..src + bw * 4]);
            }
        }
        (canvas, w, h)
    }

    #[test]
    fn decodes_otpauth_uri_from_rgba() {
        let uri = "otpauth://totp/Example:alice@example.com?secret=JBSWY3DPEHPK3PXP&issuer=Example";
        let (rgba, w, h) = render_qr_rgba(uri);
        assert_eq!(decode_totp_uris_from_rgba(&rgba, w, h), vec![uri.to_string()]);
    }

    #[test]
    fn accepts_all_caps_qr_and_canonicalizes_only_the_prefix() {
        // QR alphanumeric mode encodes ALL-CAPS; the scheme/type are
        // case-insensitive, the rest must be preserved verbatim.
        let uri = "OTPAUTH://TOTP/EXAMPLE:ALICE?SECRET=JBSWY3DPEHPK3PXP&ISSUER=EXAMPLE";
        let (rgba, w, h) = render_qr_rgba(uri);
        assert_eq!(
            decode_totp_uris_from_rgba(&rgba, w, h),
            vec!["otpauth://totp/EXAMPLE:ALICE?SECRET=JBSWY3DPEHPK3PXP&ISSUER=EXAMPLE".to_string()]
        );
    }

    #[test]
    fn rejects_hotp_enrolment_qr() {
        // Counter-based HOTP stored as TOTP would silently generate wrong codes.
        let (rgba, w, h) =
            render_qr_rgba("otpauth://hotp/Example:alice?secret=JBSWY3DPEHPK3PXP&counter=0");
        assert!(decode_totp_uris_from_rgba(&rgba, w, h).is_empty());
    }

    #[test]
    fn ignores_non_otpauth_qr() {
        // A QR that isn't a TOTP setup code must not be mistaken for one.
        let (rgba, w, h) = render_qr_rgba("https://example.com/not-a-totp");
        assert!(decode_totp_uris_from_rgba(&rgba, w, h).is_empty());
    }

    #[test]
    fn finds_both_codes_when_two_distinct_qrs_share_the_screen() {
        let a = "otpauth://totp/SiteA:alice?secret=JBSWY3DPEHPK3PXP";
        let b = "otpauth://totp/SiteB:alice?secret=KRSXG5CTMVRXEZLU";
        let (rgba, w, h) = side_by_side(render_qr_rgba(a), render_qr_rgba(b));
        let uris = decode_totp_uris_from_rgba(&rgba, w, h);
        assert_eq!(uris.len(), 2, "expected both QRs to decode, got {uris:?}");
        assert!(uris.contains(&a.to_string()) && uris.contains(&b.to_string()));
    }

    #[test]
    fn resolve_scan_demands_exactly_one_distinct_uri() {
        let one = resolve_scan(vec!["otpauth://totp/a?secret=X".into()], true);
        assert_eq!(one.ok().as_deref(), Some("otpauth://totp/a?secret=X"));

        let none = resolve_scan(vec![], true);
        assert!(none.is_err_and(|e| e.message.contains("No TOTP QR")));

        let many = resolve_scan(
            vec!["otpauth://totp/a?secret=X".into(), "otpauth://totp/b?secret=Y".into()],
            true,
        );
        assert!(many.is_err_and(|e| e.message.contains("Multiple TOTP QR")));

        let no_capture = resolve_scan(vec![], false);
        assert!(no_capture.is_err_and(|e| e.message.contains("Screen capture failed")));
    }

    #[test]
    fn returns_none_for_blank_image() {
        let (w, h) = (64usize, 64usize);
        let rgba = vec![255u8; w * h * 4]; // all white, no QR
        assert!(decode_totp_uris_from_rgba(&rgba, w, h).is_empty());
    }

    #[test]
    fn returns_none_for_undersized_buffer() {
        // Guard against a malformed (too-short) buffer rather than panicking.
        assert!(decode_totp_uris_from_rgba(&[0, 0, 0], 100, 100).is_empty());
    }
}
