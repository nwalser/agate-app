// Decrypted collections across all unlocked connections, loaded lazily for the
// detail pane's "Collections" row. Item rows carry `collectionIds`; this store
// resolves those IDs to names. Loaded once on first need (guarded), re-loadable
// after a sync. Not secret (collection names are metadata), in-memory only.

import { createSignal } from 'solid-js';
import { ipc } from '../lib/ipc.ts';
import type { Collection } from '../lib/types.ts';

const [collections, setCollections] = createSignal<Collection[]>([]);
let loaded = false;

export { collections };

/** Load collections once (or force a refresh). Failures leave the list reloadable. */
export async function loadCollections(force = false): Promise<void> {
  if (loaded && !force) return;
  loaded = true;
  try {
    setCollections(await ipc.listCollections());
  } catch {
    // ignore: collections are advisory; allow a later retry
    loaded = false;
  }
}

/** Resolve a set of collection IDs to their names (unknown IDs are dropped). */
export function collectionNamesFor(ids: string[]): string[] {
  if (ids.length === 0) return [];
  const byId = new Map(collections().map((c) => [c.id, c.name] as const));
  return ids.map((id) => byId.get(id)).filter((n): n is string => n !== undefined);
}

/** Clear on lock/logout. */
export function clearCollections(): void {
  setCollections([]);
  loaded = false;
}
