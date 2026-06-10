import { describe, expect, it } from 'vitest';
import { collectUsernameSuggestions } from './usernameSuggestions.ts';
import { makeItem } from '../testing/factories.ts';
import type { VaultItem } from './types.ts';

function item(over: Partial<VaultItem>): VaultItem {
  return makeItem({
    id: Math.random().toString(36).slice(2), // fresh id per call — tests build many distinct rows
    name: 'Item',
    accountEmail: 'a@b.com',
    accountLabel: 'Cloud',
    ...over,
  });
}

const items = (...usernames: (string | null)[]) => usernames.map((u) => item({ username: u }));

describe('collectUsernameSuggestions', () => {
  it('orders by frequency (most-used first), alpha as tiebreak', () => {
    const out = collectUsernameSuggestions(
      items('bob', 'alice', 'alice', 'carol', 'alice', 'carol'),
    );
    expect(out).toEqual(['alice', 'carol', 'bob']);
  });

  it('dedupes case-insensitively, keeping the first-seen casing', () => {
    const out = collectUsernameSuggestions(items('Alice@x.com', 'alice@X.COM', 'ALICE@x.com'));
    expect(out).toEqual(['Alice@x.com']);
  });

  it('trims whitespace and drops empty/null usernames', () => {
    const out = collectUsernameSuggestions(items('  bob  ', '   ', null, ''));
    expect(out).toEqual(['bob']);
  });

  it('excludes trashed items', () => {
    const out = collectUsernameSuggestions([
      item({ username: 'live' }),
      item({ username: 'trashed', deleted: true }),
    ]);
    expect(out).toEqual(['live']);
  });

  it('caps the list at 50 entries', () => {
    const many = Array.from({ length: 80 }, (_, i) => item({ username: `user-${String(i).padStart(2, '0')}` }));
    expect(collectUsernameSuggestions(many)).toHaveLength(50);
  });
});
