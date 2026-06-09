// Vault-list column schema + metadata — the immutable, pure half of the column
// store. No signals, no side effects: just the column type definitions, the
// built-in column metadata, key/label/sort helpers, the grid-track math, and the
// validating parse used at the localStorage boundary (no `any`). The live signal
// and its mutators live in `columnStorage.ts`; `columns.ts` re-exports both.

/** Built-in columns the list knows how to render without configuration. */
export type BuiltinColumnId =
  | 'username'
  | 'website'
  | 'folder'
  | 'type'
  | 'totp'
  | 'password'
  | 'security'
  | 'passkey';

/** A visible column: a known built-in, or a custom field referenced by name. */
export type ColumnSpec =
  | { kind: 'builtin'; id: BuiltinColumnId }
  | { kind: 'custom'; field: string };

/** Columns the list can sort by (all derivable without fetching item detail).
 *  `security` ranks rows by their offline-health status (passed into the list). */
export type SortKey = 'name' | 'username' | 'folder' | 'type' | 'security';
export type SortDir = 'asc' | 'desc';

/** Categorical columns the list can group rows under (value available without
 *  fetching item detail). Drives the optional group-header rows. */
export type GroupKey = 'folder' | 'type' | 'security';

export const GROUP_KEYS: GroupKey[] = ['folder', 'type', 'security'];

/** Labels for the "Group by" picker (the per-group header text is derived from
 *  the rows themselves — see `lib/grouping.ts`). */
export const GROUP_LABELS: Record<GroupKey, string> = {
  folder: 'Folder',
  type: 'Type',
  security: 'Security',
};

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
  /** Group rows under header rows by this column's value, or null for a flat list. */
  groupBy: GroupKey | null;
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
  'passkey',
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
      // per-item detail — so no detail fetch, and not secret. Sortable: the list
      // ranks rows by their health status from the same report.
      return { label: 'Security', sortable: true, secret: false, needsDetail: false };
    case 'passkey':
      // Presence flag from the list row (`hasPasskey`) — an icon, not a value, so
      // not sortable/secret and no detail fetch.
      return { label: 'Passkey', sortable: false, secret: false, needsDetail: false };
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
  if (c.id === 'security') return 'security';
  return null;
}

/** The group key a column maps to, or null if it can't group rows. */
export function groupKeyOf(c: ColumnSpec): GroupKey | null {
  if (c.kind !== 'builtin') return null;
  if (c.id === 'folder') return 'folder';
  if (c.id === 'type') return 'type';
  if (c.id === 'security') return 'security';
  return null;
}

/** Whether a column can be filtered (its value is available without item detail). */
export function isFilterable(c: ColumnSpec): boolean {
  if (c.kind !== 'builtin') return false;
  return c.id === 'username' || c.id === 'website' || c.id === 'folder' || c.id === 'type';
}

// ---- grid track metrics -------------------------------------------------------
// The list is a CSS grid whose `grid-template-columns` is derived from the visible
// column set. Every configurable track floors at 0 (`minmax(0, …)`) so the columns
// COMPRESS to fit the list pane rather than overflowing it — the table never
// scrolls horizontally, and the last (flexible) column always reaches the right
// edge, flush against the detail pane. Each track still carries a natural width
// (`min`, summed into `minWidth`) used as an informational metric, and a column's
// preferred size is its `minmax` upper bound: fixed px for the icon columns, an
// `fr` share for the text columns. A user drag-width caps a track to that width
// (still shrinkable). The leading checkbox and trailing affordance tracks are the
// only hard-fixed columns; everything between them flexes.

/** Gap between grid tracks (px) — mirrors `gap` in the .vault-head/.vault-row CSS. */
export const COL_GAP = 10;
/** Fixed leading checkbox column (px). */
export const CHECK_COL_PX = 22;
/** Fixed trailing column for the favorite star / row affordances (px). */
export const END_COL_PX = 76;
/** Natural width + flexible track for the always-on Name column. */
const NAME_COL_FLOOR = 150;
const NAME_COL_TRACK = `minmax(0, 1.6fr)`;

interface Track {
  /** A single `grid-template-columns` entry. */
  template: string;
  /** This track's natural width (px) — summed into the table's `minWidth`. */
  min: number;
}

/** The default track (shrinkable template + natural width) for a column. */
export function columnTrack(c: ColumnSpec): Track {
  if (c.kind === 'custom') return { template: 'minmax(0, 1fr)', min: 120 };
  switch (c.id) {
    case 'type':
      return { template: 'minmax(0, 96px)', min: 96 };
    case 'totp':
      return { template: 'minmax(0, 120px)', min: 120 };
    case 'username':
      return { template: 'minmax(0, 1fr)', min: 120 };
    case 'website':
      return { template: 'minmax(0, 1fr)', min: 130 };
    case 'folder':
      return { template: 'minmax(0, 0.8fr)', min: 110 };
    case 'password':
      return { template: 'minmax(0, 1fr)', min: 120 };
    case 'security':
      // A single right-aligned status badge (icon) — a tight track is plenty.
      return { template: 'minmax(0, 72px)', min: 72 };
    case 'passkey':
      // A single presence icon — tight track.
      return { template: 'minmax(0, 72px)', min: 72 };
  }
}

/** Resolve one column's track, honouring a user drag-width override (as a cap). */
function resolveTrack(c: ColumnSpec, widths: Record<string, number>): Track {
  const w = widths[columnKey(c)];
  if (w) return { template: `minmax(0, ${w}px)`, min: w };
  return columnTrack(c);
}

export interface GridMetrics {
  /** Value for the `--vault-cols` custom property (grid-template-columns). */
  template: string;
  /** The table's natural width (px): every track's natural width + the gaps.
   *  Informational — tracks compress below this to fit a narrow pane. */
  minWidth: number;
}

/**
 * Build the grid template (and the table's natural width) from the visible columns
 * plus the fixed checkbox/name/end tracks. Every configurable track is shrinkable,
 * so the grid always fits the list pane width instead of scrolling horizontally.
 */
export function gridMetrics(cols: ColumnSpec[], widths: Record<string, number>): GridMetrics {
  const tracks: Track[] = [{ template: `${CHECK_COL_PX}px`, min: CHECK_COL_PX }];
  const nameW = widths[NAME_COL_KEY];
  tracks.push(
    nameW ? { template: `minmax(0, ${nameW}px)`, min: nameW } : { template: NAME_COL_TRACK, min: NAME_COL_FLOOR },
  );
  for (const c of cols) tracks.push(resolveTrack(c, widths));
  tracks.push({ template: `${END_COL_PX}px`, min: END_COL_PX });
  const template = tracks.map((t) => t.template).join(' ');
  const minWidth = tracks.reduce((sum, t) => sum + t.min, 0) + (tracks.length - 1) * COL_GAP;
  return { template, minWidth };
}

// ---- storage parse / defaults -------------------------------------------------

export const STORAGE_KEY = 'agate.columns';

export const DEFAULT: ColumnConfig = {
  columns: [
    { kind: 'builtin', id: 'username' },
    { kind: 'builtin', id: 'website' },
  ],
  revealed: [],
  favicons: true,
  widths: {},
  groupBy: null,
};

function isBuiltinId(v: unknown): v is BuiltinColumnId {
  return typeof v === 'string' && (ALL_BUILTINS as string[]).includes(v);
}

function isGroupKey(v: unknown): v is GroupKey {
  return typeof v === 'string' && (GROUP_KEYS as string[]).includes(v);
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

/** Validate an arbitrary value into a `ColumnConfig`, falling back field-by-field
 *  to DEFAULT. Shared by `readColumnConfig` (localStorage) and the saved-view
 *  snapshot parser (lib/sidebarConfig.ts) so both validate identically (no `any`). */
export function parseColumnConfig(value: unknown): ColumnConfig {
  if (typeof value !== 'object' || value === null) return { ...DEFAULT };
  const o = value as Record<string, unknown>;
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
  const groupBy = isGroupKey(o.groupBy) ? o.groupBy : null;
  return { columns, revealed, favicons, widths, groupBy };
}

/** Read + validate the persisted config; corrupt/unavailable falls back to DEFAULT. */
export function readColumnConfig(): ColumnConfig {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return DEFAULT;
    return parseColumnConfig(JSON.parse(raw));
  } catch {
    // ignore: corrupt/unavailable config falls back to defaults
    return DEFAULT;
  }
}
