// Stable per-connection identity color, so accounts are distinguishable at a
// glance in the unified (merged) views. This is an avatar-style decorative color,
// NOT a semantic/brand color: it's derived from the account email and maps onto
// the theme-aware `--account-N` palette defined in styles.css, so it still
// resolves through design tokens rather than a hardcoded literal. Pure +
// deterministic — unit-tested in accountColor.test.ts.

// Must match the number of `--account-N` tokens defined in styles.css.
export const ACCOUNT_PALETTE_SIZE = 8;

// Small deterministic string hash (djb2-ish). Not cryptographic — only needs to
// spread emails across the palette buckets stably.
function hashString(s: string): number {
  let h = 0;
  for (let i = 0; i < s.length; i++) {
    h = (h * 31 + s.charCodeAt(i)) | 0;
  }
  return Math.abs(h);
}

/** Palette index (0..N-1) for an account email. Case/space-insensitive. */
export function accountColorIndex(email: string): number {
  return hashString(email.trim().toLowerCase()) % ACCOUNT_PALETTE_SIZE;
}

/** CSS color for an account — a `var(--account-N)` token reference. */
export function accountColorVar(email: string): string {
  return `var(--account-${accountColorIndex(email)})`;
}
