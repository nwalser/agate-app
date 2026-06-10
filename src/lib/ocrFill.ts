// Map OCR text lines into editor prefill values for the non-card item types
// (the card parser lives in lib/cardOcr.ts — one OCR pipeline, per-type
// mappers). Pure + unit-tested; conservative: only unambiguous shapes (email,
// URL, phone, a clean name line) are offered, everything else is left alone.
// SECURITY: callers must never log the recognized text.

const EMAIL_RE = /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/;
const URL_RE = /\bhttps?:\/\/[^\s]+/i;
const BARE_DOMAIN_RE = /^\s*([a-z0-9-]+(\.[a-z0-9-]+)+)(\/\S*)?\s*$/i;
const PHONE_RE = /(?:^|\s)(\+?\d[\d\s().\-/]{6,}\d)(?:\s|$)/;

export interface OcrLoginFill {
  username?: string;
  uri?: string;
}

export function mapOcrToLogin(lines: string[]): OcrLoginFill {
  const out: OcrLoginFill = {};
  for (const line of lines) {
    if (!out.username) {
      const email = EMAIL_RE.exec(line);
      if (email) out.username = email[0];
    }
    if (!out.uri) {
      const url = URL_RE.exec(line);
      if (url) {
        out.uri = url[0];
      } else {
        const bare = BARE_DOMAIN_RE.exec(line);
        // An email line also matches the bare-domain shape after the @ — don't
        // turn it into a uri.
        if (bare && !EMAIL_RE.test(line)) out.uri = bare[1] + (bare[3] ?? '');
      }
    }
  }
  return out;
}

export interface OcrIdentityFill {
  firstName?: string;
  lastName?: string;
  email?: string;
  phone?: string;
}

export function mapOcrToIdentity(lines: string[]): OcrIdentityFill {
  const out: OcrIdentityFill = {};
  for (const line of lines) {
    if (!out.email) {
      const email = EMAIL_RE.exec(line);
      if (email) out.email = email[0];
    }
    if (!out.phone) {
      const phone = PHONE_RE.exec(line);
      if (phone) {
        const digits = phone[1].replace(/\D/g, '').length;
        // 7–12 digits (or up to 15 with an explicit +): excludes card-number
        // runs (13–19 digits), which are NOT phone numbers.
        const max = phone[1].trim().startsWith('+') ? 15 : 12;
        if (digits >= 7 && digits <= max) out.phone = phone[1].trim();
      }
    }
    if (!out.firstName) {
      // A clean name line: 2+ words, letters only (incl. accents/'-), no digits.
      const t = line.trim();
      if (/^[A-Za-zÀ-ÿ'.\- ]+$/.test(t)) {
        const words = t.split(/\s+/);
        if (words.length >= 2 && words.length <= 5) {
          out.firstName = words[0];
          out.lastName = words.slice(1).join(' ');
        }
      }
    }
  }
  return out;
}
