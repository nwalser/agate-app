// Vault-list column configuration. Not secret — persisted in localStorage (UI
// preference, not the keychain). Drives which columns the list shows, their
// order, whether secret/hidden content is revealed, and whether website
// favicons are fetched. Validated at the storage boundary (no `any`).

import { createSignal } from 'solid-js';

/** Built-in columns the list knows how to render without configuration. */
export type BuiltinColumnId =
  | 'username'
  | 'website'
  | 'folder'
  | 'type'
  | 'totp'
  | 'password'
  | 'security';

/** A visible column: a known built-in, or a custom field referenced by name. */
export type ColumnSpec =
  | { kind: 'builtin'; id: BuiltinColumnId }
  | { kind: 'custom'; field: string };

/** Columns the list can sort by (all derivable without fetching item detail). */
export type SortKey = 'name' | 'username' | 'folder' | 'type';
export type SortDir = 'asc' | 'desc';

export interface ColumnConfig {
  /** Visible data columns after the always-on Name column, in display order. */
  columns: ColumnSpec[];
  /** Column keys (see `columnKey`) whose secret/hidden content is revealed. */
  revealed: string[];
  /** Fetch + show website favicons in the Name cell of login rows. */
  favicons: boolean;
  /** Per-column pixel widths, keyed by `columnKey` (or `NAME_COL_KEY` for the
   *  always-on Name column). Absent = the column's default flexible width. */
  widths: Record<string, number>;
}

/** Width-map key for the always-on Name column. */
export const NAME_COL_KEY = 'name';

/** Smallest a column may be dragged to (px). */
export const MIN_COL_WIDTH = 60;

export const ALL_BUILTINS: BuiltinColumnId[] = [
  'username',
  'website',
  'folder',
  'type',
  'totp',
  'password',
  'security',
];

/** Display labels for item types — single source in `lib/labels.ts`, re-exported
 *  here for the column/list importers that already pull it from this module. */
export { TYPE_LABELS } from '../lib/labels.ts';

interface ColumnMeta {
  label: string;
  /** Header is clickable to sort (handled by the list's sort state). */
  sortable: boolean;
  /** Content is sensitive — masked until its column key is revealed. */
  secret: boolean;
  /** Needs the full ItemDetail (or a live TOTP) to render a value. */
  needsDetail: boolean;
}

export function builtinMeta(id: BuiltinColumnId): ColumnMeta {
  switch (id) {
    case 'username':
      return { label: 'Username', sortable: true, secret: false, needsDetail: false };
    case 'website':
      return { label: 'Website', sortable: false, secret: false, needsDetail: true };
    case 'folder':
      return { label: 'Folder', sortable: true, secret: false, needsDetail: false };
    case 'type':
      return { label: 'Type', sortable: true, secret: false, needsDetail: false };
    case 'totp':
      return { label: 'One-time code', sortable: false, secret: true, needsDetail: true };
    case 'password':
      return { label: 'Password', sortable: false, secret: true, needsDetail: true };
    case 'security':
      // Rendered from the offline health report (passed into the list), not from
      // per-item detail — so no detail fetch and not a sortable/secret column.
      return { label: 'Security', sortable: false, secret: false, needsDetail: false };
  }
}

/** Stable key for a column (used for reveal state, dedup, and For keys). */
export function columnKey(c: ColumnSpec): string {
  return c.kind === 'builtin' ? `builtin:${c.id}` : `custom:${c.field}`;
}

export function columnLabel(c: ColumnSpec): string {
  return c.kind === 'builtin' ? builtinMeta(c.id).label : c.field;
}

/** The sort key a column maps to, or null if it isn't sortable. */
export function sortKeyOf(c: ColumnSpec): SortKey | null {
  if (c.kind !== 'builtin') return null;
  if (c.id === 'username') return 'username';
  if (c.id === 'folder') return 'folder';
  if (c.id === 'type') return 'type';
  return null;
}

/** Whether a column can be filtered (its value is available without item detail). */
export function isFilterable(c: ColumnSpec): boolean {
  if (c.kind !== 'builtin') return false;
  return c.id === 'username' || c.id === 'website' || c.id === 'folder' || c.id === 'type';
}

// ---- grid track metrics -------------------------------------------------------
// The list is a CSS grid whose `grid-template-columns` and total minimum width
// are derived from the visible column set. Every column has a hard FLOOR (px) so
// tracks can never collapse to zero and overlap their neighbours when the pane is
// narrow — instead the table reaches its minimum width and scrolls horizontally.
// A user-set drag width overrides both the flexible track and its floor.

/** Gap between grid tracks (px) — mirrors `gap` in the .vault-head/.vault-row CSS. */
export const COL_GAP = 10;
/** Fixed leading checkbox column (px). */
export const CHECK_COL_PX = 22;
/** Fixed trailing column for the favorite star / row affordances (px). */
export const END_COL_PX = 76;
/** Floor + flexible track for the always-on Name column. */
const NAME_COL_FLOOR = 150;
const NAME_COL_TRACK = `minmax(${NAME_COL_FLOOR}px, 1.6fr)`;

interface Track {
  /** A single `grid-template-columns` entry. */
  template: string;
  /** The smallest width this track can occupy (px) — feeds the table min-width. */
  min: number;
}

/** The default track (template + floor) for a configurable column. */
export function columnTrack(c: ColumnSpec): Track {
  if (c.kind === 'custom') return { template: 'minmax(120px, 1fr)', min: 120 };
  switch (c.id) {
    case 'type':
      return { template: '96px', min: 96 };
    case 'totp':
      return { template: '120px', min: 120 };
    case 'username':
      return { template: 'minmax(120px, 1fr)', min: 120 };
    case 'website':
      return { template: 'minmax(130px, 1fr)', min: 130 };
    case 'folder':
      return { template: 'minmax(110px, 0.8fr)', min: 110 };
    case 'password':
      return { template: 'minmax(120px, 1fr)', min: 120 };
    case 'security':
      return { template: 'minmax(130px, 1.2fr)', min: 130 };
  }
}

/** Resolve one column's track, honouring a user drag-width override. */
function resolveTrack(c: ColumnSpec, widths: Record<string, number>): Track {
  const w = widths[columnKey(c)];
  if (w) return { template: `${w}px`, min: w };
  return columnTrack(c);
}

export interface GridMetrics {
  /** Value for the `--vault-cols` custom property (grid-template-columns). */
  template: string;
  /** Total minimum width of the table (px): all track floors + the gaps. */
  minWidth: number;
}

/**
 * Build the grid template and the table's minimum width from the visible columns
 * (plus the fixed checkbox/name/end tracks). The min-width is what lets the table
 * scroll horizontally instead of squashing columns into each other.
 */
export function gridMetrics(cols: ColumnSpec[], widths: Record<string, number>): GridMetrics {
  const tracks: Track[] = [{ template: `${CHECK_COL_PX}px`, min: CHECK_COL_PX }];
  const nameW = widths[NAME_COL_KEY];
  tracks.push(nameW ? { template: `${nameW}px`, min: nameW } : { template: NAME_COL_TRACK, min: NAME_COL_FLOOR });
  for (const c of cols) tracks.push(resolveTrack(c, widths));
  tracks.push({ template: `${END_COL_PX}px`, min: END_COL_PX });
  const template = tracks.map((t) => t.template).join(' ');
  const minWidth = tracks.reduce((sum, t) => sum + t.min, 0) + (tracks.length - 1) * COL_GAP;
  return { template, minWidth };
}

const STORAGE_KEY = 'agate.columns';

const DEFAULT: ColumnConfig = {
  columns: [
    { kind: 'builtin', id: 'username' },
    { kind: 'builtin', id: 'website' },
  ],
  revealed: [],
  favicons: true,
  widths: {},
};

function isBuiltinId(v: unknown): v is BuiltinColumnId {
  return typeof v === 'string' && (ALL_BUILTINS as string[]).includes(v);
}

function parseSpec(v: unknown): ColumnSpec | null {
  if (typeof v !== 'object' || v === null) return null;
  const o = v as Record<string, unknown>;
  if (o.kind === 'builtin' && isBuiltinId(o.id)) return { kind: 'builtin', id: o.id };
  if (o.kind === 'custom' && typeof o.field === 'string' && o.field.trim()) {
    return { kind: 'custom', field: o.field };
  }
  return null;
}

function read(): ColumnConfig {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return DEFAULT;
    const parsed: unknown = JSON.parse(raw);
    if (typeof parsed !== 'object' || parsed === null) return DEFAULT;
    const o = parsed as Record<string, unknown>;
    const columns = Array.isArray(o.columns)
      ? o.columns.map(parseSpec).filter((x): x is ColumnSpec => x !== null)
      : DEFAULT.columns;
    const revealed = Array.isArray(o.revealed)
      ? o.revealed.filter((x): x is string => typeof x === 'string')
      : [];
    const favicons = typeof o.favicons === 'boolean' ? o.favicons : DEFAULT.favicons;
    const widths: Record<string, number> = {};
    if (o.widths && typeof o.widths === 'object') {
      for (const [k, v] of Object.entries(o.widths as Record<string, unknown>)) {
        if (typeof v === 'number' && Number.isFinite(v) && v >= MIN_COL_WIDTH) widths[k] = v;
      }
    }
    return { columns, revealed, favicons, widths };
  } catch {
    // ignore: corrupt/unavailable config falls back to defaults
    return DEFAULT;
  }
}

const [columns, setColumnsSignal] = createSignal<ColumnConfig>(read());

function persist(next: ColumnConfig) {
  setColumnsSignal(next);
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(next));
  } catch {
    // ignore: persistence is best-effort; the in-memory signal still applies
  }
}

export { columns };

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
