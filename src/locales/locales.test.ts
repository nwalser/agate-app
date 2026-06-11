import { describe, it, expect } from 'vitest';
import { en } from './en.ts';
import { de } from './de.ts';
import { es } from './es.ts';

/** Flatten a nested message dict into dotted leaf keys ("a.b.c"). */
function leafKeys(obj: unknown, prefix = '', out: string[] = []): string[] {
  if (obj && typeof obj === 'object') {
    for (const k of Object.keys(obj as Record<string, unknown>)) {
      const path = prefix ? `${prefix}.${k}` : k;
      leafKeys((obj as Record<string, unknown>)[k], path, out);
    }
  } else {
    out.push(prefix);
  }
  return out;
}

const enKeys = new Set(leafKeys(en));
const locales = { de, es };

describe('locale key parity', () => {
  // Locales may OMIT keys (runtime falls back to English in i18n.ts), but they
  // must never contain a key that English lacks — such a key is a typo or a stale
  // entry that the lookup can never reach.
  for (const [name, loc] of Object.entries(locales)) {
    it(`${name}: has no keys absent from en (typo/stale guard)`, () => {
      const extra = leafKeys(loc).filter((k) => !enKeys.has(k));
      expect(extra).toEqual([]);
    });
  }

  it('en has a non-trivial number of keys', () => {
    expect(enKeys.size).toBeGreaterThan(60);
  });
});
