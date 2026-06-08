// Pure vault search/sort helpers (unit-tested, no IPC).

import type { VaultItem } from './types.ts';

/** Case-insensitive substring match over an item's name and username. */
export function matchesQuery(item: VaultItem, query: string): boolean {
  const q = query.trim().toLowerCase();
  if (q === '') return true;
  if (item.name.toLowerCase().includes(q)) return true;
  if (item.username && item.username.toLowerCase().includes(q)) return true;
  return false;
}

/** Filter then sort: favorites first, then alphabetical by name. */
export function filterItems(items: VaultItem[], query: string): VaultItem[] {
  return items
    .filter((it) => matchesQuery(it, query))
    .slice()
    .sort((a, b) => {
      if (a.favorite !== b.favorite) return a.favorite ? -1 : 1;
      return a.name.localeCompare(b.name, undefined, { sensitivity: 'base' });
    });
}
