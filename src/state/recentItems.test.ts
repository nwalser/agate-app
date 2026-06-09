// Recently-opened item-id list (powers the titlebar search's empty-query recents):
// most-recent-first, de-duplicated, capped, persisted, and corrupt-tolerant at the
// storage boundary. Light module → a fresh import per case is cheap and lets the
// import-time `read()` validation be exercised directly.

import { describe, expect, it, vi } from 'vitest';

async function fresh(seed?: unknown) {
  vi.resetModules();
  localStorage.clear();
  if (seed !== undefined) localStorage.setItem('agate.recentItems', JSON.stringify(seed));
  return import('./recentItems.ts');
}

describe('recentItems', () => {
  it('starts empty with no stored value', async () => {
    const m = await fresh();
    expect(m.recentIds()).toEqual([]);
  });

  it('records most-recent-first and de-duplicates', async () => {
    const m = await fresh();
    m.recordRecent('a');
    m.recordRecent('b');
    m.recordRecent('a'); // re-open moves a to the front
    expect(m.recentIds()).toEqual(['a', 'b']);
  });

  it('caps the list at 8 and drops the oldest', async () => {
    const m = await fresh();
    for (const id of ['1', '2', '3', '4', '5', '6', '7', '8', '9']) m.recordRecent(id);
    expect(m.recentIds()).toEqual(['9', '8', '7', '6', '5', '4', '3', '2']);
  });

  it('ignores a blank id', async () => {
    const m = await fresh();
    m.recordRecent('');
    expect(m.recentIds()).toEqual([]);
  });

  it('persists across reloads and clearRecent empties + removes storage', async () => {
    const m = await fresh();
    m.recordRecent('x');
    expect(JSON.parse(localStorage.getItem('agate.recentItems') ?? '[]')).toEqual(['x']);
    m.clearRecent();
    expect(m.recentIds()).toEqual([]);
    expect(localStorage.getItem('agate.recentItems')).toBeNull();
  });

  it('reads a valid stored list (capped) and drops non-strings', async () => {
    const valid = await fresh(['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h', 'i']);
    expect(valid.recentIds()).toEqual(['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h']); // capped to 8
    const mixed = await fresh(['ok', 5, null, 'fine']);
    expect(mixed.recentIds()).toEqual(['ok', 'fine']); // non-strings dropped
  });

  it('tolerates a corrupt stored value', async () => {
    vi.resetModules();
    localStorage.clear();
    localStorage.setItem('agate.recentItems', '{not json');
    const m = await import('./recentItems.ts');
    expect(m.recentIds()).toEqual([]);
  });
});
