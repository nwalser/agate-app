// Recently-opened item IDs (most-recent-first), persisted in localStorage. Item
// IDs are opaque GUIDs — not secrets (same trust level as the favicon host
// cache), so localStorage is fine; the decrypted item content never goes here.
// Powers the titlebar search's "recent" list shown when the query is empty.
// Validated at the storage boundary: a corrupt value yields an empty list.

import { createSignal } from 'solid-js';

const KEY = 'agate.recentItems';
const MAX = 8;

function read(): string[] {
  try {
    const raw = localStorage.getItem(KEY);
    if (!raw) return [];
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed.filter((x): x is string => typeof x === 'string').slice(0, MAX);
  } catch {
    // ignore: storage unavailable / corrupt → no recents
    return [];
  }
}

const [recentIds, setRecentIds] = createSignal<string[]>(read());
export { recentIds };

/** Record an item as just-opened (de-duplicated, most-recent-first, capped). */
export function recordRecent(id: string): void {
  if (!id) return;
  setRecentIds((prev) => {
    const next = [id, ...prev.filter((x) => x !== id)].slice(0, MAX);
    try {
      localStorage.setItem(KEY, JSON.stringify(next));
    } catch {
      // ignore: persistence is best-effort; the in-memory signal still applies
    }
    return next;
  });
}

/** Forget all recents (e.g. on logout, if a caller wants a clean slate). */
export function clearRecent(): void {
  setRecentIds([]);
  try {
    localStorage.removeItem(KEY);
  } catch {
    // ignore: best-effort
  }
}
