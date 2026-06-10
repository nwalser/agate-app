// State for the tray quick-access popup: a thin session/item cache + the three
// copy actions (username / password / TOTP). Built as a FACTORY with injected
// deps (same pattern as createSecurityScans) — TrayApp constructs the production
// instance with the real ipc/clipboard; tests inject fakes.
//
// Security posture:
// - Reprompt ("require master password to view") items NEVER copy secrets here —
//   the reprompt gate lives in the main window, and its verification state is
//   per-webview, so the popup always defers to the full app (onRepromptBlocked).
// - The popup deliberately KEEPS its state (query, items, scroll, selection)
//   across hide/show — a user choice; the retained data is list metadata only
//   (names/usernames/uris, never passwords). It still fails closed: refresh()
//   runs on every show and drops the items the moment the session is locked.

import { createSignal } from 'solid-js';
import type { ipc as realIpc } from '../lib/ipc.ts';
import type { VaultItem } from '../lib/types.ts';

/** Hard cap on rendered rows — the popup is a quick-access list, not a browser. */
export const TRAY_MAX_RESULTS = 50;

/** Exactly the IPC surface the popup touches — what tests fake. */
export type TrayIpc = Pick<
  typeof realIpc,
  'getSessionStatus' | 'listItems' | 'itemDetail' | 'itemTotp'
>;

export interface TrayStoreDeps {
  ipc: TrayIpc;
  /** Secret-copy path (production: lib/clipboard.copyWithAutoClear). */
  copy: (label: string, value: string | null | undefined) => Promise<void>;
  onError: (err: unknown) => void;
  /** A copy was blocked because the item requires a master-password reprompt. */
  onRepromptBlocked: (item: VaultItem) => void;
}

/** Filter + rank the unified list for the popup: drop trashed items, match the
 *  query against name/username/uri, and order by match quality (name prefix >
 *  name substring > username/uri), favorites and name breaking ties. */
export function filterTrayItems(items: VaultItem[], query: string): VaultItem[] {
  const q = query.trim().toLowerCase();

  // Lower rank sorts first; null = no match at all.
  const rank = (it: VaultItem): number | null => {
    if (!q) return 0;
    const name = it.name.toLowerCase();
    if (name.startsWith(q)) return 0;
    if (name.includes(q)) return 1;
    if (it.username?.toLowerCase().includes(q) || it.uri?.toLowerCase().includes(q)) return 2;
    return null;
  };

  return items
    .filter((it) => !it.deleted)
    .map((it) => ({ it, r: rank(it) }))
    .filter((e): e is { it: VaultItem; r: number } => e.r !== null)
    .sort(
      (a, b) =>
        a.r - b.r ||
        Number(b.it.favorite) - Number(a.it.favorite) ||
        a.it.name.localeCompare(b.it.name),
    )
    .slice(0, TRAY_MAX_RESULTS)
    .map((e) => e.it);
}

/** Whether two list entries are field-for-field identical (VaultItem is a flat
 *  all-primitive shape, so shallow comparison is exact). */
function sameItem(a: VaultItem, b: VaultItem): boolean {
  const keys = new Set([...Object.keys(a), ...Object.keys(b)]) as Set<keyof VaultItem>;
  for (const k of keys) {
    if (a[k] !== b[k]) return false;
  }
  return true;
}

/** Adopt the fresh list but keep the previous object for every unchanged item,
 *  so <For> reuses its DOM rows and the list's scroll position survives the
 *  refresh-on-show. */
function reconcileById(prev: VaultItem[], next: VaultItem[]): VaultItem[] {
  const byId = new Map(prev.map((i) => [i.id, i]));
  return next.map((n) => {
    const old = byId.get(n.id);
    return old && sameItem(old, n) ? old : n;
  });
}

export function createTrayStore(deps: TrayStoreDeps) {
  const [ready, setReady] = createSignal(false);
  const [unlocked, setUnlocked] = createSignal(false);
  const [items, setItems] = createSignal<VaultItem[]>([]);
  const [query, setQuery] = createSignal('');

  /** Re-read session + items. Called on mount and every time the popup shows,
   *  so a lock/sync in the main window is reflected on the next open. The query
   *  is never touched here — popup state survives open/close on purpose. */
  async function refresh(): Promise<void> {
    try {
      const status = await deps.ipc.getSessionStatus();
      setUnlocked(status.unlocked);
      const fresh = status.unlocked ? await deps.ipc.listItems() : [];
      setItems((prev) => reconcileById(prev, fresh));
    } catch (err) {
      // Treat an unreadable session as locked — the popup must fail closed.
      setUnlocked(false);
      setItems([]);
      deps.onError(err);
    } finally {
      setReady(true);
    }
  }

  const filtered = () => filterTrayItems(items(), query());

  /** False (and defers to the full app) when the item is reprompt-protected. */
  function passReprompt(item: VaultItem): boolean {
    if (!item.reprompt) return true;
    deps.onRepromptBlocked(item);
    return false;
  }

  async function copyUsername(item: VaultItem): Promise<void> {
    await deps.copy('Username', item.username);
  }

  async function copyPassword(item: VaultItem): Promise<void> {
    if (!passReprompt(item)) return;
    try {
      const detail = await deps.ipc.itemDetail(item.accountEmail, item.id);
      await deps.copy('Password', detail.login?.password);
    } catch (err) {
      deps.onError(err);
    }
  }

  async function copyTotp(item: VaultItem): Promise<void> {
    if (!passReprompt(item)) return;
    try {
      const totp = await deps.ipc.itemTotp(item.accountEmail, item.id);
      await deps.copy('TOTP code', totp.code);
    } catch (err) {
      deps.onError(err);
    }
  }

  return {
    ready,
    unlocked,
    query,
    setQuery,
    filtered,
    refresh,
    copyUsername,
    copyPassword,
    copyTotp,
  };
}

export type TrayStore = ReturnType<typeof createTrayStore>;
