// Lazy TOTP cache + countdown ticker for the vault list. Only populated when the
// one-time-code column is revealed: each visible row with a TOTP fetches its
// current code, then a single 1s ticker counts every cached code down and refetches
// the ones that roll over (so the list mirrors the live authenticator). Best-effort:
// a failed fetch leaves the cell blank. Created per VaultList instance via a factory
// that registers its own ticker cleanup, so it must be called during component setup.

import { createSignal, onCleanup } from 'solid-js';
import { ipc } from '../lib/ipc.ts';
import type { TotpCode } from '../lib/types.ts';

export interface TotpCache {
  /** Reactive map of item id -> current TOTP code (only the fetched rows). */
  cache: () => Map<string, TotpCode>;
  /** Fetch a row's code if missing/not in flight; `force` refetches on rollover. */
  ensure: (email: string, id: string, force?: boolean) => void;
  /** Drop every cached code (e.g. after a sync/mutation). */
  reset: () => void;
}

/**
 * @param findEmail Resolve the account email for an item id whose code rolled over,
 *   so the ticker can refetch it. Returns undefined if the row is gone.
 */
export function createTotpCache(findEmail: (id: string) => string | undefined): TotpCache {
  const [totpCache, setTotpCache] = createSignal<Map<string, TotpCode>>(new Map());
  const totpPending = new Set<string>();

  function ensure(email: string, id: string, force = false) {
    if (!force && (totpCache().has(id) || totpPending.has(id))) return;
    totpPending.add(id);
    void ipc
      .itemTotp(email, id)
      .then((c) => setTotpCache((m) => new Map(m).set(id, c)))
      .catch(() => {
        // ignore: TOTP is best-effort for the list cell
      })
      .finally(() => totpPending.delete(id));
  }

  // Single ticker: count down cached codes; refetch the ones that roll over.
  const ticker = setInterval(() => {
    const m = totpCache();
    if (m.size === 0) return;
    const next = new Map(m);
    let changed = false;
    for (const [id, code] of next) {
      if (code.remaining <= 1) {
        const email = findEmail(id);
        if (email) ensure(email, id, true);
      } else {
        next.set(id, { ...code, remaining: code.remaining - 1 });
        changed = true;
      }
    }
    if (changed) setTotpCache(next);
  }, 1000);
  onCleanup(() => clearInterval(ticker));

  function reset() {
    setTotpCache(new Map());
  }

  return { cache: totpCache, ensure, reset };
}
