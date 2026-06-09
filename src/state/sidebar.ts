// Live sidebar (left rail) customization store — the stateful half of the sidebar
// config (mirrors `state/columnStorage.ts`). Holds the reactive `sidebar` signal
// (seeded from localStorage) plus every mutator (show/hide, reorder, add/edit/
// remove saved query, reset), each writing through to localStorage best-effort.
// The immutable schema/metadata/parse lives in `lib/sidebarConfig.ts`. Not secret:
// a UI preference, not keychain material.

import { createSignal } from 'solid-js';
import {
  DIVIDER_PREFIX,
  SIDEBAR_STORAGE_KEY,
  type CustomQuery,
  type SavedFilter,
  type SidebarConfig,
  type SidebarEntry,
  defaultSidebar,
  isBuiltinId,
  isDividerId,
  readSidebarConfig,
  reconcile,
} from '../lib/sidebarConfig.ts';

const [sidebar, setSidebarSignal] = createSignal<SidebarConfig>(readSidebarConfig());

function persist(next: SidebarConfig) {
  const norm = reconcile(next);
  setSidebarSignal(norm);
  try {
    localStorage.setItem(SIDEBAR_STORAGE_KEY, JSON.stringify(norm));
  } catch {
    // ignore: persistence is best-effort; the in-memory signal still applies
  }
}

export { sidebar };

/** Find a saved query by id (null if it isn't a known query). */
export function queryById(id: string): CustomQuery | null {
  return sidebar().queries.find((q) => q.id === id) ?? null;
}

/** The ordered, non-hidden entries the rail renders, resolved to builtin/query. */
export function visibleEntries(): SidebarEntry[] {
  const cfg = sidebar();
  const hidden = new Set(cfg.hidden);
  const out: SidebarEntry[] = [];
  for (const id of cfg.order) {
    if (hidden.has(id)) continue;
    if (isBuiltinId(id)) {
      out.push({ kind: 'builtin', id });
    } else if (isDividerId(id)) {
      out.push({ kind: 'divider', id });
    } else {
      const q = cfg.queries.find((x) => x.id === id);
      if (q) out.push({ kind: 'query', query: q });
    }
  }
  return out;
}

export function isHidden(id: string): boolean {
  return sidebar().hidden.includes(id);
}

export function toggleHidden(id: string) {
  const cur = sidebar();
  persist({
    ...cur,
    hidden: cur.hidden.includes(id) ? cur.hidden.filter((h) => h !== id) : [...cur.hidden, id],
  });
}

/** Swap the entry at `index` with its neighbour in `dir` (arrow reorder). */
export function moveEntry(index: number, dir: -1 | 1) {
  const order = sidebar().order.slice();
  const j = index + dir;
  if (index < 0 || index >= order.length || j < 0 || j >= order.length) return;
  [order[index], order[j]] = [order[j], order[index]];
  persist({ ...sidebar(), order });
}

/** Move the entry at `from` to position `to` (drag-and-drop reorder). */
export function reorderEntry(from: number, to: number) {
  const order = sidebar().order.slice();
  if (from < 0 || from >= order.length || to < 0 || to >= order.length || from === to) return;
  const [moved] = order.splice(from, 1);
  order.splice(to, 0, moved);
  persist({ ...sidebar(), order });
}

/** Create a saved query (appended to the rail). Returns its new id, or null if the
 *  name is blank. */
export function addQuery(input: { name: string; query: string; filter: SavedFilter }): string | null {
  const name = input.name.trim();
  if (!name) return null;
  const id = `query:${crypto.randomUUID()}`;
  const q: CustomQuery = { id, name, query: input.query, filter: input.filter };
  const cur = sidebar();
  persist({ ...cur, order: [...cur.order, id], queries: [...cur.queries, q] });
  return id;
}

/** Patch an existing saved query in place (name trimmed; blank name ignored). */
export function updateQuery(id: string, patch: Partial<Omit<CustomQuery, 'id'>>) {
  const cur = sidebar();
  persist({
    ...cur,
    queries: cur.queries.map((q) => {
      if (q.id !== id) return q;
      const name = patch.name === undefined ? q.name : patch.name.trim() || q.name;
      return { ...q, ...patch, name, id: q.id };
    }),
  });
}

/** Add a horizontal divider to the rail. Inserts at `atIndex` in `order` (clamped),
 *  or appends when omitted. Returns the new divider id. */
export function addDivider(atIndex?: number): string {
  const id = `${DIVIDER_PREFIX}${crypto.randomUUID()}`;
  const cur = sidebar();
  const order = cur.order.slice();
  const at = atIndex === undefined ? order.length : Math.max(0, Math.min(atIndex, order.length));
  order.splice(at, 0, id);
  persist({ ...cur, order });
  return id;
}

/** Remove any entry by id (a divider or a saved query) from order + hidden, and —
 *  for a saved query — its definition. Builtins can't be removed (only hidden). */
export function removeEntry(id: string) {
  if (isBuiltinId(id)) return;
  const cur = sidebar();
  persist({
    order: cur.order.filter((x) => x !== id),
    hidden: cur.hidden.filter((x) => x !== id),
    queries: cur.queries.filter((q) => q.id !== id),
  });
}

/** Delete a saved query (alias of `removeEntry`, kept for call-site clarity). */
export function removeQuery(id: string) {
  removeEntry(id);
}

/** Restore the default rail order + visibility, discarding saved queries. */
export function resetSidebar() {
  persist(defaultSidebar());
}
