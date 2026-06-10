// Parse OCR text lines from a card scan into editor prefill values. Pure +
// unit-tested. Conservative by design: a number is only ever offered when it
// passes Luhn (a misread digit must not be silently saved), and the CVV is
// deliberately never parsed (back-of-card, any 3-digit run is ambiguous).
// SECURITY: callers must never log or toast the parsed number.

import { detectCardBrand } from './cardBrands.ts';

/** Luhn checksum over a digit string (13–19 digits for a plausible PAN). */
export function luhnValid(digits: string): boolean {
  if (!/^\d{13,19}$/.test(digits)) return false;
  let sum = 0;
  let double = false;
  for (let i = digits.length - 1; i >= 0; i--) {
    let d = digits.charCodeAt(i) - 48;
    if (double) {
      d *= 2;
      if (d > 9) d -= 9;
    }
    sum += d;
    double = !double;
  }
  return sum % 10 === 0;
}

export interface ParsedCard {
  number?: string;
  brand?: string;
  expMonth?: string;
  expYear?: string;
  cardholderName?: string;
  /** 'number' = a Luhn-valid PAN found; 'partial' = some fields but no number;
   *  'none' = nothing recognizable. */
  confidence: 'number' | 'partial' | 'none';
}

// Words that mark a line as branding/noise rather than the cardholder name.
const NOISE_WORDS =
  /\b(VISA|MASTERCARD|MAESTRO|AMEX|AMERICAN|EXPRESS|DISCOVER|UNIONPAY|RUPAY|JCB|DINERS|BANK|DEBIT|CREDIT|VALID|THRU|FROM|EXPIRES?|END|MONTH|YEAR|GOLD|PLATINUM|WORLD|BUSINESS|CARD)\b/i;

const EXPIRY_RE = /\b(0?[1-9]|1[0-2])\s*[/\-.]\s*((?:20)?\d{2})\b/g;

export function parseCardFromOcr(lines: string[]): ParsedCard {
  const out: ParsedCard = { confidence: 'none' };

  // ── number: digit runs per line, joined across OCR's space/dash/dot splits ──
  let bestNumber = '';
  for (const line of lines) {
    // Skip pure date lines so 12/27 can't be glued into a candidate.
    const joined = line.replace(/[\s.-]/g, '');
    for (const m of joined.matchAll(/\d{13,19}/g)) {
      if (luhnValid(m[0]) && m[0].length > bestNumber.length) bestNumber = m[0];
    }
  }
  if (bestNumber) {
    out.number = bestNumber;
    const brand = detectCardBrand(bestNumber);
    if (brand) out.brand = brand;
  }

  // ── expiry: prefer THRU/EXP-marked lines; with several dates, take the latest ──
  let best: { month: number; year: number } | null = null;
  for (const line of lines) {
    const marked = /\b(VALID\s*THRU|THRU|EXP|EXPIRES|GOOD\s*THRU|END)\b/i.test(line);
    const from = /\bFROM\b/i.test(line) && !marked;
    for (const m of line.matchAll(EXPIRY_RE)) {
      const month = Number(m[1]);
      const year = Number(m[2].length === 2 ? `20${m[2]}` : m[2]);
      if (from && best) continue; // an unmarked FROM date never beats a real one
      if (!best || year > best.year || (year === best.year && month > best.month)) {
        best = { month, year };
      }
    }
  }
  if (best) {
    out.expMonth = String(best.month); // Bitwarden stores bare "1".."12"
    out.expYear = String(best.year);
  }

  // ── cardholder: ≥2 words, letters only, no digits, not a branding line ──
  for (const line of lines) {
    const t = line.trim();
    if (!/^[A-Za-zÀ-ÿ'./\- ]+$/.test(t)) continue;
    if (t.split(/\s+/).length < 2) continue;
    if (NOISE_WORDS.test(t)) continue;
    // Card names print in caps; require it so prose lines don't qualify.
    if (t !== t.toUpperCase()) continue;
    out.cardholderName = t;
    break;
  }

  out.confidence = out.number
    ? 'number'
    : out.expMonth || out.cardholderName
      ? 'partial'
      : 'none';
  return out;
}
