// Lazy per-row ItemDetail cache for the vault list. Columns that need decrypted
// content (website, password, hidden custom fields) read values out of this cache;
// it is filled on demand with a small bounded-concurrency queue so revealing a
// detail-heavy column doesn't fire hundreds of IPC calls at once. Best-effort: a
// failed fetch leaves the row blank. Created per VaultList instance via a factory
// so its queue/pending bookkeeping is scoped to that list and torn down with it.

import { createSignal } from 'solid-js';
import { ipc } from '../lib/ipc.ts';
import type { ItemDetail } from '../lib/types.ts';

const DETAIL_CONCURRENCY = 6;

export interface DetailCache {
  /** Reactive map of item id -> decrypted detail (only the fetched rows). */
  cache: () => Map<string, ItemDetail>;
  /** Queue a fetch for one row if it isn't cached or already in flight. */
  ensure: (email: string, id: string) => void;
  /** Drop all cached detail and any pending queue (e.g. after a sync/mutation). */
  reset: () => void;
}

export function createDetailCache(): DetailCache {
  const [detailCache, setDetailCache] = createSignal<Map<string, ItemDetail>>(new Map());
  const detailPending = new Set<string>();
  let detailQueue: { email: string; id: string }[] = [];
  let detailActive = 0;
  // Bumped by reset(). Each in-flight fetch captures the generation it started in
  // and, if a reset happened meanwhile, discards its (now-stale) result and skips
  // its bookkeeping — otherwise a fetch that was mid-flight at invalidation would
  // write a pre-mutation value into the freshly-cleared cache and leave its id
  // stuck in detailPending so ensure() never re-queues it.
  let cacheGen = 0;

  function pumpDetail() {
    while (detailActive < DETAIL_CONCURRENCY && detailQueue.length > 0) {
      const next = detailQueue.shift();
      if (next === undefined) break;
      const { email, id } = next;
      const gen = cacheGen;
      detailActive++;
      void ipc
        .itemDetail(email, id)
        .then((d) => {
          if (gen === cacheGen) setDetailCache((m) => new Map(m).set(id, d));
        })
        .catch(() => {
          // ignore: detail is best-effort for list cells; the cell shows blank
        })
        .finally(() => {
          // A reset() while this was in flight already cleared the pending set and
          // zeroed detailActive for the new generation; touching them here would
          // double-decrement and wrongly evict a re-queued id.
          if (gen !== cacheGen) return;
          detailActive--;
          detailPending.delete(id);
          pumpDetail();
        });
    }
  }

  function ensure(email: string, id: string) {
    if (detailCache().has(id) || detailPending.has(id)) return;
    detailPending.add(id);
    detailQueue.push({ email, id });
    pumpDetail();
  }

  function reset() {
    cacheGen++;
    setDetailCache(new Map());
    detailPending.clear();
    detailQueue = [];
    detailActive = 0;
  }

  return { cache: detailCache, ensure, reset };
}
