// Card-brand helpers for the item editor + detail pane: the fixed brand set,
// best-effort brand detection from a card number, and number formatting/masking.
// Pure functions, no render dependency — unit-testable in isolation.

// The fixed brand set the editor offers (matches Bitwarden's card-brand list,
// so the stored string round-trips with the official clients).
export const CARD_BRANDS = [
  'Visa',
  'Mastercard',
  'Amex',
  'Discover',
  'Diners Club',
  'JCB',
  'Maestro',
  'UnionPay',
  'RuPay',
  'Other',
] as const;
export type CardBrand = (typeof CARD_BRANDS)[number];

// Best-effort brand detection from the card number's IIN prefix. Ordered so the
// more specific 3x/6x ranges win before the broad ones; returns null when no
// rule matches (the user can still pick a brand by hand).
export function detectCardBrand(raw: string): CardBrand | null {
  const n = raw.replace(/\D/g, '');
  if (!n) return null;
  if (/^4/.test(n)) return 'Visa';
  if (/^3[47]/.test(n)) return 'Amex';
  if (/^3(0[0-5]|[689])/.test(n)) return 'Diners Club';
  if (/^35/.test(n)) return 'JCB';
  if (/^(50|5018|5020|5038|56|57|58|6304|6759|676[1-3])/.test(n)) return 'Maestro';
  if (/^(5[1-5]|222[1-9]|22[3-9]|2[3-6]|27[01]|2720)/.test(n)) return 'Mastercard';
  if (/^(6011|64[4-9]|65)/.test(n)) return 'Discover';
  if (/^62/.test(n)) return 'UnionPay';
  return null;
}

// Group a card number for display: Amex as 4-6-5, everything else in 4s.
export function formatCardNumber(raw: string, brand?: string | null): string {
  const n = raw.replace(/\D/g, '');
  if (!n) return '';
  if (brand === 'Amex' || /^3[47]/.test(n)) {
    return [n.slice(0, 4), n.slice(4, 10), n.slice(10, 15)].filter(Boolean).join(' ');
  }
  return n.replace(/(.{4})/g, '$1 ').trim();
}

// Mask all but the last four digits (•••• •••• •••• 1234).
export function maskCardNumber(raw: string): string {
  const n = raw.replace(/\D/g, '');
  if (n.length <= 4) return n;
  return `•••• •••• •••• ${n.slice(-4)}`;
}
