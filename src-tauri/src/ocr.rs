//! Text recognition (OCR) over a screen capture or a user-picked image file —
//! powers "scan card" and the generic "fill from image" in the item editor.
//!
//! Windows-first: uses the OS-native WinRT `Windows.Media.Ocr` engine (no model
//! bundled, no network). On macOS/Linux the feature reports unavailable and the
//! UI hides its buttons — the same documented-gap stance as `hello_unix.rs`.
//! Future: macOS Vision / Linux tesseract.
//!
//! SECURITY: recognized text may contain a full card number (PAN) or other
//! secrets. It is handed to the frontend only to prefill editor fields and is
//! NEVER logged — the same rule as the otpauth URI in `qrscan.rs`.
//!
//! Note: on Windows release builds the Agate window is `WDA_EXCLUDEFROMCAPTURE`
//! (see `hello::protect_window`), so it shows up blank in our own capture — the
//! card/document being scanned lives in another window or a file.

use xcap::Monitor;

use crate::error::{AgateError, AgateResult, ErrorKind};

/// Whether OCR is available on this platform (drives the UI's button visibility).
pub fn available() -> bool {
    cfg!(windows)
}

/// Capture all monitors and OCR them, returning every recognized text line.
/// Blocking work; call from a blocking context (the command wraps it in
/// `spawn_blocking`).
pub fn ocr_screen() -> AgateResult<Vec<String>> {
    let monitors = Monitor::all().map_err(|e| {
        AgateError::new(ErrorKind::Internal, format!("Screen capture failed: {e}"))
    })?;

    // Same capture sweep as qrscan: any single monitor failing is skipped, and
    // "no monitor captured at all" is a distinct (permission) error.
    let mut captured_any = false;
    let mut lines: Vec<String> = Vec::new();
    for monitor in monitors {
        let image = match monitor.capture_image() {
            Ok(img) => img,
            Err(_) => continue,
        };
        captured_any = true;
        let (w, h) = (image.width(), image.height());
        let raw = image.into_raw(); // RGBA8
        lines.extend(ocr_rgba(&raw, w, h)?);
    }

    if !captured_any {
        return Err(AgateError::new(
            ErrorKind::Internal,
            "Screen capture failed. Grant screen-recording permission to Agate and try again.",
        ));
    }
    Ok(lines)
}

/// OCR a user-picked image file.
pub fn ocr_file(path: &std::path::Path) -> AgateResult<Vec<String>> {
    let img = image::open(path)
        .map_err(|_| AgateError::bad_request("Could not read that image file."))?
        .to_rgba8();
    let (w, h) = (img.width(), img.height());
    ocr_rgba(&img.into_raw(), w, h)
}

/// OCR an RGBA8 buffer into text lines via the WinRT engine.
#[cfg(windows)]
fn ocr_rgba(rgba: &[u8], width: u32, height: u32) -> AgateResult<Vec<String>> {
    use windows::Graphics::Imaging::{BitmapPixelFormat, SoftwareBitmap};
    use windows::Media::Ocr::OcrEngine;
    use windows::Storage::Streams::DataWriter;
    use windows::Win32::System::WinRT::{RoInitialize, RO_INIT_MULTITHREADED};

    let internal = |what: &str, e: windows::core::Error| {
        // Engine/plumbing errors only — never include recognized text.
        AgateError::new(ErrorKind::Internal, format!("Text recognition failed ({what}): {e}"))
    };

    if width == 0 || height == 0 || rgba.len() < (width as usize) * (height as usize) * 4 {
        return Err(AgateError::new(ErrorKind::Internal, "Malformed image buffer."));
    }

    // The blocking-pool thread may not have a WinRT apartment yet. Already
    // initialized with a different mode is fine (RPC_E_CHANGED_MODE).
    // ignore: per-thread idempotent init — any real failure surfaces on the
    // first WinRT call below.
    unsafe {
        let _ = RoInitialize(RO_INIT_MULTITHREADED);
    }

    // Downscale captures past the engine's hard input cap (4K+ monitors).
    let max = OcrEngine::MaxImageDimension().map_err(|e| internal("limits", e))?;
    let (mut buf, mut w, mut h) = (std::borrow::Cow::Borrowed(rgba), width, height);
    if w > max || h > max {
        let scale = (max as f32 / w.max(h) as f32).min(1.0);
        let (nw, nh) = ((w as f32 * scale) as u32, (h as f32 * scale) as u32);
        let img = image::RgbaImage::from_raw(w, h, rgba.to_vec())
            .ok_or_else(|| AgateError::new(ErrorKind::Internal, "Malformed image buffer."))?;
        let resized = image::imageops::resize(&img, nw, nh, image::imageops::FilterType::Triangle);
        (w, h) = (nw, nh);
        buf = std::borrow::Cow::Owned(resized.into_raw());
    }

    // RGBA → BGRA (the engine wants Bgra8).
    let mut bgra = buf.into_owned();
    for px in bgra.chunks_exact_mut(4) {
        px.swap(0, 2);
    }

    let writer = DataWriter::new().map_err(|e| internal("buffer", e))?;
    writer.WriteBytes(&bgra).map_err(|e| internal("buffer", e))?;
    let buffer = writer.DetachBuffer().map_err(|e| internal("buffer", e))?;
    let bitmap =
        SoftwareBitmap::CreateCopyFromBuffer(&buffer, BitmapPixelFormat::Bgra8, w as i32, h as i32)
            .map_err(|e| internal("bitmap", e))?;

    let engine = OcrEngine::TryCreateFromUserProfileLanguages().map_err(|e| internal("engine", e))?;
    let result = engine
        .RecognizeAsync(&bitmap)
        .map_err(|e| internal("recognize", e))?
        .get()
        .map_err(|e| internal("recognize", e))?;

    let mut out = Vec::new();
    for line in result.Lines().map_err(|e| internal("lines", e))? {
        let text = line.Text().map_err(|e| internal("lines", e))?.to_string();
        if !text.trim().is_empty() {
            out.push(text);
        }
    }
    Ok(out)
}

/// Non-Windows stub: written on a Windows host; the native engines for
/// macOS (Vision) / Linux are future work. The UI hides OCR via `available()`.
#[cfg(not(windows))]
fn ocr_rgba(_rgba: &[u8], _width: u32, _height: u32) -> AgateResult<Vec<String>> {
    Err(AgateError::new(
        ErrorKind::Internal,
        "Text recognition is only available on Windows for now.",
    ))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[cfg(windows)]
    #[test]
    fn rejects_a_malformed_buffer_instead_of_panicking() {
        assert!(ocr_rgba(&[0, 0, 0], 100, 100).is_err());
        assert!(ocr_rgba(&[], 0, 0).is_err());
    }

    #[test]
    fn availability_matches_the_platform() {
        assert_eq!(available(), cfg!(windows));
    }

    #[test]
    fn ocr_file_rejects_a_non_image() {
        let dir = std::env::temp_dir().join("agate-ocr-test.txt");
        std::fs::write(&dir, b"not an image").expect("write test file");
        let err = ocr_file(&dir).expect_err("non-image must fail");
        assert!(err.message.contains("Could not read that image file"));
        let _ = std::fs::remove_file(&dir);
    }

    /// LIVE WinRT engine run over a committed test-card fixture (Luhn-valid test
    /// number, rendered text). `#[ignore]`d because it needs a Windows OCR
    /// language pack — run locally with `cargo test -- --ignored`.
    #[cfg(windows)]
    #[test]
    #[ignore]
    fn live_engine_reads_the_card_fixture() {
        let path = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("testdata/ocr-card.png");
        let lines = ocr_file(&path).expect("live OCR over the fixture");
        let digits: String = lines.join(" ").chars().filter(|c| c.is_ascii_digit()).collect();
        assert!(digits.contains("4242424242424242"), "recognized lines: {lines:?}");
        assert!(
            lines.iter().any(|l| l.to_uppercase().contains("ALICE")),
            "recognized lines: {lines:?}"
        );
    }
}
