// Recently-opened item IDs (most-recent-first), persisted in localStorage through
// the shared createPersistedStore trust boundary. Item IDs are opaque GUIDs — not
// secrets (same trust level as the favicon host cache), so localStorage is fine;
// the decrypted item content never goes here. Powers the titlebar search's
// "recent" list shown when the query is empty.

import { createPersistedStore } from './persisted.ts';

const MAX = 8;

// Validate at the storage boundary: a non-array (corrupt) value falls back to an
// empty list; non-string entries are dropped and the list is capped.
const store = createPersistedStore<string[]>({
  key: 'agate.recentItems',
  parse: (value) =>
    Array.isArray(value)
      ? value.filter((x): x is string => typeof x === 'string').slice(0, MAX)
      : null,
  fallback: () => [],
});

export const recentIds = store.value;

/** Record an item as just-opened (de-duplicated, most-recent-first, capped).
 *  Merges over the PERSISTED list, not the in-memory one: the main window and
 *  the tray popup share localStorage but not signals, so the other webview may
 *  have recorded entries since this one loaded. */
export function recordRecent(id: string): void {
  if (!id) return;
  const next = [id, ...store.peek().filter((x) => x !== id)].slice(0, MAX);
  store.set(next);
}

/** Re-read the persisted list — lets the tray popup pick up recents the main
 *  window recorded since the popup's webview booted (called on every show). */
export function reloadRecent(): void {
  store.refresh();
}

/** Forget all recents (e.g. on logout, if a caller wants a clean slate). Removes
 *  the storage key entirely (not persisted as an empty array). */
export function clearRecent(): void {
  store.clear();
}
