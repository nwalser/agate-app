// Pure vault search/sort/filter helpers (unit-tested, no IPC).

import type { ItemType, VaultItem } from './types.ts';

/**
 * Case-insensitive subsequence test: every character of `query` must appear in
 * `haystack` in order (not necessarily contiguously). An empty query matches.
 */
export function fuzzyContains(haystack: string, query: string): boolean {
  const q = query.toLowerCase();
  if (q === '') return true;
  const hay = haystack.toLowerCase();
  let qi = 0;
  for (let hi = 0; hi < hay.length && qi < q.length; hi++) {
    if (hay[hi] === q[qi]) qi++;
  }
  return qi === q.length;
}

/**
 * Fuzzy (subsequence) match over an item's name and username. Earlier code used
 * a substring match; subsequence matching is more forgiving (e.g. "gh" matches
 * "GitHub"). An empty/whitespace query matches everything.
 */
export function matchesQuery(item: VaultItem, query: string): boolean {
  const q = query.trim();
  if (q === '') return true;
  if (fuzzyContains(item.name, q)) return true;
  if (item.username && fuzzyContains(item.username, q)) return true;
  return false;
}

/** Closed set of left-rail filters. `folderId: null` = items with no folder.
 *  `atRisk` keeps only items flagged by the offline health audit — the membership
 *  test lives in the filtering hook (it needs the report), so here it behaves like
 *  `all` (non-deleted) and the hook narrows it further. */
export type VaultFilter =
  | { kind: 'all' }
  | { kind: 'favorites' }
  | { kind: 'trash' }
  | { kind: 'type'; itemType: ItemType }
  | { kind: 'atRisk' }
  | { kind: 'folder'; folderId: string | null };

/** Whether a single item passes the active filter (independent of search). */
export function passesFilter(item: VaultItem, filter: VaultFilter): boolean {
  switch (filter.kind) {
    case 'trash':
      return item.deleted;
    case 'favorites':
      return !item.deleted && item.favorite;
    case 'type':
      return !item.deleted && item.itemType === filter.itemType;
    case 'folder':
      return !item.deleted && (item.folderId ?? null) === filter.folderId;
    case 'atRisk':
    case 'all':
      return !item.deleted;
  }
}

/**
 * Apply the active filter, then the search query, then sort: favorites first,
 * then alphabetical by name.
 */
export function filterItems(
  items: VaultItem[],
  query: string,
  filter: VaultFilter = { kind: 'all' },
): VaultItem[] {
  return items
    .filter((it) => passesFilter(it, filter) && matchesQuery(it, query))
    .slice()
    .sort((a, b) => {
      if (a.favorite !== b.favorite) return a.favorite ? -1 : 1;
      return a.name.localeCompare(b.name, undefined, { sensitivity: 'base' });
    });
}
