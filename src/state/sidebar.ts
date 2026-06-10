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
  type SidebarConfig,
  type SidebarEntry,
  type ViewConfig,
  defaultSidebar,
  defaultViewConfig,
  isBuiltinId,
  isDividerId,
  readSidebarConfig,
  reconcile,
  resolveSidebar,
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

/** The ordered, non-hidden entries the rail renders, resolved to builtin/query/
 *  divider (with labels + redundant-divider collapsing — see `resolveSidebar`). */
export function visibleEntries(): SidebarEntry[] {
  return resolveSidebar(sidebar());
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

/** Move `fromId` directly before `beforeId` in the full order (append when
 *  `beforeId` is null). Id-based so the rail (which renders only visible
 *  entries) can't land an entry on the far side of hidden neighbours — the
 *  index-based drop's failure mode. Unknown ids are a no-op. */
export function reorderEntryByIds(fromId: string, beforeId: string | null) {
  if (fromId === beforeId) return;
  const order = sidebar().order.slice();
  const from = order.indexOf(fromId);
  if (from < 0) return;
  if (beforeId !== null && !order.includes(beforeId)) return;
  order.splice(from, 1);
  const at = beforeId === null ? order.length : order.indexOf(beforeId);
  order.splice(at, 0, fromId);
  persist({ ...sidebar(), order });
}

/** Create a saved view (appended to the rail). With just a name + icon it starts
 *  from a default empty config (configured later while viewing); pass `config` to
 *  seed it from the current list state in one step ("Save as new view"). Returns
 *  the new id, or null if the name is blank. */
export function addQuery(input: { name: string; icon: string; config?: ViewConfig }): string | null {
  const name = input.name.trim();
  if (!name) return null;
  const id = `query:${crypto.randomUUID()}`;
  const q: CustomQuery = { id, name, icon: input.icon, config: input.config ?? defaultViewConfig() };
  const cur = sidebar();
  persist({ ...cur, order: [...cur.order, id], queries: [...cur.queries, q] });
  return id;
}

/** Patch an existing saved view in place (name trimmed; blank name ignored).
 *  Used by Settings (name/icon) and the in-view Save button (config). */
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

/** Clone a saved view: a fresh `query:<uuid>` carrying a deep copy of the source's
 *  icon + config, named `"<name> copy"`, inserted directly after the original in the
 *  rail. Returns the new id, or null if `id` isn't a known saved query. */
export function duplicateQuery(id: string): string | null {
  const src = queryById(id);
  if (!src) return null;
  const newId = `query:${crypto.randomUUID()}`;
  const copy: CustomQuery = {
    id: newId,
    name: `${src.name} copy`,
    icon: src.icon,
    // Deep-clone so edits to the copy never mutate the original's snapshot.
    config: structuredClone(src.config),
  };
  const cur = sidebar();
  const order = cur.order.slice();
  const at = order.indexOf(id);
  order.splice(at < 0 ? order.length : at + 1, 0, newId);
  persist({ ...cur, order, queries: [...cur.queries, copy] });
  return newId;
}

/** Add a horizontal divider to the rail. Inserts at `atIndex` in `order` (clamped),
 *  or appends when omitted. An optional `label` makes it a section header. Returns
 *  the new divider id. */
export function addDivider(atIndex?: number, label?: string): string {
  const id = `${DIVIDER_PREFIX}${crypto.randomUUID()}`;
  const cur = sidebar();
  const order = cur.order.slice();
  const at = atIndex === undefined ? order.length : Math.max(0, Math.min(atIndex, order.length));
  order.splice(at, 0, id);
  const dividerLabels = { ...cur.dividerLabels };
  if (label && label.trim()) dividerLabels[id] = label.trim();
  persist({ ...cur, order, dividerLabels });
  return id;
}

/** Set or clear a divider's section label (a blank label clears it, reverting the
 *  divider to a plain rule). No-op for non-divider ids. */
export function setDividerLabel(id: string, label: string) {
  if (!isDividerId(id)) return;
  const cur = sidebar();
  const dividerLabels = { ...cur.dividerLabels };
  const trimmed = label.trim();
  if (trimmed) dividerLabels[id] = trimmed;
  else delete dividerLabels[id];
  persist({ ...cur, dividerLabels });
}

/** Remove any entry by id (a divider or a saved query) from order + hidden, and —
 *  for a saved query — its definition. Builtins can't be removed (only hidden). */
export function removeEntry(id: string) {
  if (isBuiltinId(id)) return;
  const cur = sidebar();
  // reconcile (in persist) drops the removed divider's label since its id leaves order.
  persist({
    order: cur.order.filter((x) => x !== id),
    hidden: cur.hidden.filter((x) => x !== id),
    queries: cur.queries.filter((q) => q.id !== id),
    dividerLabels: cur.dividerLabels,
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
