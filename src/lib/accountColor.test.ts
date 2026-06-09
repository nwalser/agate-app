import { describe, expect, it } from 'vitest';
import { ACCOUNT_PALETTE_SIZE, accountColorIndex, accountColorVar } from './accountColor.ts';

describe('accountColor', () => {
  it('is deterministic for the same email', () => {
    expect(accountColorIndex('a@example.com')).toBe(accountColorIndex('a@example.com'));
  });

  it('ignores case and surrounding whitespace', () => {
    expect(accountColorIndex('  A@Example.com ')).toBe(accountColorIndex('a@example.com'));
  });

  it('always returns an in-range palette index', () => {
    for (const email of ['a@b.com', 'longer.name@corp.example', 'x', '', 'zzz@zzz']) {
      const idx = accountColorIndex(email);
      expect(idx).toBeGreaterThanOrEqual(0);
      expect(idx).toBeLessThan(ACCOUNT_PALETTE_SIZE);
    }
  });

  it('emits a token reference, never a raw literal', () => {
    expect(accountColorVar('a@example.com')).toMatch(/^var\(--account-[0-7]\)$/);
  });

  it('spreads a handful of distinct emails across more than one bucket', () => {
    const emails = ['a@x.com', 'b@x.com', 'c@x.com', 'd@x.com', 'e@x.com', 'f@x.com'];
    const buckets = new Set(emails.map(accountColorIndex));
    expect(buckets.size).toBeGreaterThan(1);
  });
});
