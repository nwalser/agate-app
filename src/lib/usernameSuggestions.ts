// Username autocomplete source for the login editor: distinct usernames already
// used across every unlocked vault. Pure (no signals) so it's unit-testable —
// the screen wraps it in a memo. Frequency-ordered: the username you use most is
// the one you most likely want next. Trashed items don't contribute (deleting a
// login should retire its username from the suggestions too).

import type { VaultItem } from './types.ts';

/** Keep the datalist usable on huge vaults. */
const MAX_SUGGESTIONS = 50;

export function collectUsernameSuggestions(items: VaultItem[]): string[] {
  // Case-insensitive grouping; the first-seen casing is the one displayed.
  const byKey = new Map<string, { display: string; count: number }>();
  for (const it of items) {
    if (it.deleted) continue;
    const u = it.username?.trim();
    if (!u) continue;
    const key = u.toLowerCase();
    const cur = byKey.get(key);
    if (cur) cur.count += 1;
    else byKey.set(key, { display: u, count: 1 });
  }
  return [...byKey.values()]
    .sort(
      (a, b) =>
        b.count - a.count ||
        a.display.localeCompare(b.display, undefined, { sensitivity: 'base' }),
    )
    .slice(0, MAX_SUGGESTIONS)
    .map((e) => e.display);
}
