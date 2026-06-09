// Live vault-list column store — the stateful half of the column config. Holds
// the reactive `columns` signal (seeded from localStorage) plus every mutator
// (show/hide, reorder, reveal, resize, favicons, reset), each of which writes
// through to localStorage best-effort. The immutable schema/metadata/parse lives
// in `columnConfig.ts`; `columns.ts` re-exports both as the public surface.

import { createSignal } from 'solid-js';
import {
  columnKey,
  DEFAULT,
  MIN_COL_WIDTH,
  readColumnConfig,
  STORAGE_KEY,
  type ColumnConfig,
  type ColumnSpec,
  type GroupKey,
} from './columnConfig.ts';

const [columns, setColumnsSignal] = createSignal<ColumnConfig>(readColumnConfig());

function persist(next: ColumnConfig) {
  setColumnsSignal(next);
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(next));
  } catch {
    // ignore: persistence is best-effort; the in-memory signal still applies
  }
}

export { columns };

/** Replace the entire column config (visible set, order, reveal, favicons, widths,
 *  group-by) — used to restore a saved view's layout snapshot. */
export function applyColumnConfig(cfg: ColumnConfig) {
  persist({
    columns: cfg.columns.map((c) => ({ ...c })),
    revealed: [...cfg.revealed],
    favicons: cfg.favicons,
    widths: { ...cfg.widths },
    groupBy: cfg.groupBy,
  });
}

export function isColumnVisible(c: ColumnSpec): boolean {
  const k = columnKey(c);
  return columns().columns.some((x) => columnKey(x) === k);
}

export function toggleColumn(c: ColumnSpec) {
  const k = columnKey(c);
  const cur = columns();
  const exists = cur.columns.some((x) => columnKey(x) === k);
  // Dropping a column also forgets its custom width and reveal state.
  const widths = { ...cur.widths };
  if (exists) delete widths[k];
  persist({
    ...cur,
    columns: exists ? cur.columns.filter((x) => columnKey(x) !== k) : [...cur.columns, c],
    revealed: exists ? cur.revealed.filter((r) => r !== k) : cur.revealed,
    widths,
  });
}

/** Set a column's pixel width (drag-resize). Clamped to a sane minimum. */
export function setColumnWidth(key: string, px: number) {
  const cur = columns();
  persist({ ...cur, widths: { ...cur.widths, [key]: Math.max(MIN_COL_WIDTH, Math.round(px)) } });
}

/** Clear a column's custom width, reverting it to the default flexible size. */
export function resetColumnWidth(key: string) {
  const cur = columns();
  if (!(key in cur.widths)) return;
  const widths = { ...cur.widths };
  delete widths[key];
  persist({ ...cur, widths });
}

export function removeColumn(c: ColumnSpec) {
  toggleColumn(c); // remove path of toggle (also clears its reveal)
}

export function addCustomColumn(field: string) {
  const f = field.trim();
  if (!f) return;
  const c: ColumnSpec = { kind: 'custom', field: f };
  if (isColumnVisible(c)) return;
  persist({ ...columns(), columns: [...columns().columns, c] });
}

export function moveColumn(index: number, dir: -1 | 1) {
  const cur = columns().columns.slice();
  const j = index + dir;
  if (index < 0 || index >= cur.length || j < 0 || j >= cur.length) return;
  [cur[index], cur[j]] = [cur[j], cur[index]];
  persist({ ...columns(), columns: cur });
}

/** Move the column at `from` to position `to` (drag-and-drop reorder). */
export function reorderColumn(from: number, to: number) {
  const cur = columns().columns.slice();
  if (from < 0 || from >= cur.length || to < 0 || to >= cur.length || from === to) return;
  const [moved] = cur.splice(from, 1);
  cur.splice(to, 0, moved);
  persist({ ...columns(), columns: cur });
}

/** Restore the default visible set, order, reveal state, favicons, and widths. */
export function resetColumns() {
  persist({
    columns: DEFAULT.columns.map((c) => ({ ...c })),
    revealed: [],
    favicons: DEFAULT.favicons,
    widths: {},
    groupBy: null,
  });
}

export function isRevealed(key: string): boolean {
  return columns().revealed.includes(key);
}

export function toggleReveal(key: string) {
  const cur = columns();
  persist({
    ...cur,
    revealed: cur.revealed.includes(key)
      ? cur.revealed.filter((r) => r !== key)
      : [...cur.revealed, key],
  });
}

export function setFavicons(on: boolean) {
  persist({ ...columns(), favicons: on });
}

/** Group rows under header rows by a column's value, or null for a flat list. */
export function setGroupBy(key: GroupKey | null) {
  persist({ ...columns(), groupBy: key });
}
