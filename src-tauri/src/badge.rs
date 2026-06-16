//! Pure raster compositing for the tray icon's match-count badge.
//!
//! The tray icon is the whole app, so when autofill Watch mode is on Agate paints
//! a small numbered disc onto it showing how many unlocked logins match the
//! currently focused app / website (see `autofill::refresh_badge`). This module is
//! the testable core: given the base icon's RGBA buffer and a count, it returns a
//! new RGBA buffer with the badge composited on. No Windows, no Tauri, no I/O —
//! `tray::set_match_badge` wraps the result in a `tauri::image::Image`.
//!
//! Rendering is dependency-free: a small built-in 5x7 bitmap font (digits + `+`)
//! is blitted at an integer scale over an anti-aliased disc, so it stays crisp at
//! any icon size without pulling in a font crate or shipping a font asset. The
//! disc colour mirrors the app accent (`--primary`); CSS tokens can't reach a
//! rendered PNG, so it is a deliberate fixed literal here.

/// Badge disc colour (RGB) — the app accent (`#0a84ff`, mirrors `--primary`).
/// Reads clearly on both light and dark taskbars.
const DISC_RGB: (u8, u8, u8) = (0x0a, 0x84, 0xff);
/// Glyph colour (RGB) — white, for max contrast on the accent disc.
const TEXT_RGB: (u8, u8, u8) = (0xff, 0xff, 0xff);

/// The label drawn on the badge for a match count: `None` below 1 (no badge),
/// the digit for 1–9, and `"9+"` for anything larger (the disc stays small).
pub fn badge_label(count: usize) -> Option<String> {
    match count {
        0 => None,
        1..=9 => Some(count.to_string()),
        _ => Some("9+".to_string()),
    }
}

/// Composite a match-count badge onto a copy of `base` (RGBA, row-major, length
/// `width * height * 4`). Returns the new RGBA buffer.
///
/// `count == 0` (or a malformed buffer) returns the base unchanged — the caller
/// restores the plain icon in that case. Never panics: out-of-range geometry is
/// clamped and a wrong-length buffer is passed through.
pub fn composite_badge(base: &[u8], width: u32, height: u32, count: usize) -> Vec<u8> {
    let mut buf = base.to_vec();
    let (w, h) = (width as i32, height as i32);
    // Defensive: only paint when the buffer matches the declared dimensions and
    // there is something to draw. Anything off → hand back the base untouched.
    if w <= 0 || h <= 0 || buf.len() != (w as usize) * (h as usize) * 4 {
        return buf;
    }
    let Some(label) = badge_label(count) else {
        return buf;
    };

    // Disc geometry: a circle hugging the bottom-right corner, sized to the icon.
    let dim = w.min(h) as f32;
    let r = (dim * 0.30).max(3.0);
    let inset = (dim * 0.04).max(1.0);
    let cx = w as f32 - r - inset;
    let cy = h as f32 - r - inset;

    paint_disc(&mut buf, w, h, cx, cy, r);
    paint_label(&mut buf, w, h, cx, cy, r, &label);
    buf
}

/// Blend the accent disc over the buffer with 1px anti-aliased edges.
fn paint_disc(buf: &mut [u8], w: i32, h: i32, cx: f32, cy: f32, r: f32) {
    let (x0, x1, y0, y1) = bounds(w, h, cx, cy, r + 1.0);
    for y in y0..y1 {
        for x in x0..x1 {
            let dist = ((x as f32 + 0.5 - cx).powi(2) + (y as f32 + 0.5 - cy).powi(2)).sqrt();
            let cov = (r - dist + 0.5).clamp(0.0, 1.0);
            if cov > 0.0 {
                blend_pixel(buf, w, x, y, DISC_RGB, cov);
            }
        }
    }
}

/// Blit the label glyphs (white) centred in the disc at an integer scale.
fn paint_label(buf: &mut [u8], w: i32, h: i32, cx: f32, cy: f32, r: f32, label: &str) {
    let chars: Vec<char> = label.chars().collect();
    let n = chars.len() as i32;
    if n == 0 {
        return;
    }
    // Columns across the whole label: GLYPH_W per glyph + a 1-column gap between.
    let total_cols = n * GLYPH_W + (n - 1);
    // Usable square inside the disc (leaves a margin so glyphs don't touch the rim).
    let inner = r * 1.45;
    let s = ((inner / total_cols as f32).floor())
        .min((inner / GLYPH_H as f32).floor())
        .max(1.0) as i32;
    let text_w = total_cols * s;
    let text_h = GLYPH_H * s;
    let x0 = (cx - text_w as f32 / 2.0).round() as i32;
    let y0 = (cy - text_h as f32 / 2.0).round() as i32;

    for (i, &c) in chars.iter().enumerate() {
        let Some(glyph) = glyph_rows(c) else { continue };
        let gx = x0 + i as i32 * (GLYPH_W + 1) * s;
        for (row, pattern) in glyph.iter().enumerate() {
            let bytes = pattern.as_bytes();
            for col in 0..GLYPH_W as usize {
                if bytes.get(col) != Some(&b'#') {
                    continue;
                }
                // Fill the s×s block for this glyph cell.
                for dy in 0..s {
                    for dx in 0..s {
                        let px = gx + col as i32 * s + dx;
                        let py = y0 + row as i32 * s + dy;
                        if px >= 0 && px < w && py >= 0 && py < h {
                            blend_pixel(buf, w, px, py, TEXT_RGB, 1.0);
                        }
                    }
                }
            }
        }
    }
}

/// Alpha-blend `rgb` at coverage `cov` (0..1) over the pixel at `(x, y)`, lifting
/// the destination alpha so the badge is opaque even over transparent icon corners.
fn blend_pixel(buf: &mut [u8], w: i32, x: i32, y: i32, rgb: (u8, u8, u8), cov: f32) {
    let idx = ((y * w + x) as usize) * 4;
    let Some(px) = buf.get_mut(idx..idx + 4) else {
        return;
    };
    let mix = |dst: u8, src: u8| (f32::from(src) * cov + f32::from(dst) * (1.0 - cov)).round() as u8;
    px[0] = mix(px[0], rgb.0);
    px[1] = mix(px[1], rgb.1);
    px[2] = mix(px[2], rgb.2);
    px[3] = px[3].max((cov * 255.0).round() as u8);
}

/// Clamp a square region of radius `rad` around `(cx, cy)` to the buffer bounds.
fn bounds(w: i32, h: i32, cx: f32, cy: f32, rad: f32) -> (i32, i32, i32, i32) {
    let x0 = (cx - rad).floor().max(0.0) as i32;
    let x1 = ((cx + rad).ceil() as i32).min(w);
    let y0 = (cy - rad).floor().max(0.0) as i32;
    let y1 = ((cy + rad).ceil() as i32).min(h);
    (x0, x1, y0, y1)
}

/// Glyph cell size for the built-in bitmap font.
const GLYPH_W: i32 = 5;
const GLYPH_H: i32 = 7;

/// The 5x7 bitmap for a label character (`#` on, `.` off), or `None` if unsupported.
/// Only the characters [`badge_label`] can produce (digits + `+`) are defined.
fn glyph_rows(c: char) -> Option<&'static [&'static str; 7]> {
    let g = match c {
        '0' => &["#####", "#...#", "#..##", "#.#.#", "##..#", "#...#", "#####"],
        '1' => &["..#..", ".##..", "..#..", "..#..", "..#..", "..#..", ".###."],
        '2' => &["####.", "....#", "....#", "####.", "#....", "#....", "#####"],
        '3' => &["####.", "....#", "....#", ".###.", "....#", "....#", "####."],
        '4' => &["#..#.", "#..#.", "#..#.", "#####", "...#.", "...#.", "...#."],
        '5' => &["#####", "#....", "####.", "....#", "....#", "#...#", "####."],
        '6' => &[".###.", "#....", "#....", "####.", "#...#", "#...#", "####."],
        '7' => &["#####", "....#", "...#.", "..#..", ".#...", ".#...", ".#..."],
        '8' => &[".###.", "#...#", "#...#", ".###.", "#...#", "#...#", ".###."],
        '9' => &[".###.", "#...#", "#...#", ".####", "....#", "....#", ".###."],
        '+' => &[".....", "..#..", "..#..", "#####", "..#..", "..#..", "....."],
        _ => return None,
    };
    Some(g)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn label_thresholds() {
        assert_eq!(badge_label(0), None);
        assert_eq!(badge_label(1).as_deref(), Some("1"));
        assert_eq!(badge_label(9).as_deref(), Some("9"));
        assert_eq!(badge_label(10).as_deref(), Some("9+"));
        assert_eq!(badge_label(999).as_deref(), Some("9+"));
    }

    fn base(w: u32, h: u32) -> Vec<u8> {
        // Opaque mid-grey so a blended badge pixel is clearly different.
        vec![0x40; (w * h * 4) as usize]
    }

    #[test]
    fn zero_count_returns_base_unchanged() {
        let b = base(32, 32);
        assert_eq!(composite_badge(&b, 32, 32, 0), b);
    }

    #[test]
    fn malformed_buffer_is_passed_through() {
        // Length doesn't match w*h*4 → no painting, no panic.
        let b = vec![0u8; 10];
        assert_eq!(composite_badge(&b, 32, 32, 3), b);
    }

    #[test]
    fn badge_preserves_dimensions_and_changes_the_corner() {
        let b = base(32, 32);
        let out = composite_badge(&b, 32, 32, 3);
        assert_eq!(out.len(), b.len(), "RGBA length is preserved");
        assert_ne!(out, b, "a badge must change some pixels");

        // The disc centre (bottom-right region) must be painted the accent colour.
        let (cx, cy) = (32 - 10, 32 - 10); // near the disc centre for a 32px icon
        let idx = ((cy * 32 + cx) as usize) * 4;
        assert_eq!(out[idx], DISC_RGB.0);
        assert_eq!(out[idx + 1], DISC_RGB.1);
        assert_eq!(out[idx + 2], DISC_RGB.2);
        assert_eq!(out[idx + 3], 0xff, "disc is opaque");

        // The top-left corner is far from the badge and must be untouched.
        assert_eq!(&out[0..4], &b[0..4]);
    }

    #[test]
    fn two_char_label_renders_without_panic() {
        let b = base(64, 64);
        let out = composite_badge(&b, 64, 64, 42); // "9+"
        assert_eq!(out.len(), b.len());
        assert_ne!(out, b);
    }

    #[test]
    fn tiny_icon_does_not_panic() {
        for n in [1u32, 2, 3, 8, 16] {
            let b = base(n, n);
            let out = composite_badge(&b, n, n, 7);
            assert_eq!(out.len(), b.len());
        }
    }

    #[test]
    fn every_label_char_has_a_glyph() {
        // Whatever badge_label can emit must be renderable.
        for c in "0123456789+".chars() {
            assert!(glyph_rows(c).is_some(), "missing glyph for {c:?}");
        }
        // Each glyph row is exactly GLYPH_W wide.
        for c in "0123456789+".chars() {
            for row in glyph_rows(c).into_iter().flatten() {
                assert_eq!(row.len(), GLYPH_W as usize, "{c:?} row width");
            }
        }
    }
}
