// Vault-list column configuration. Not secret — persisted in localStorage (UI
// preference, not the keychain). Drives which columns the list shows, their
// order, whether secret/hidden content is revealed, and whether website
// favicons are fetched. Validated at the storage boundary (no `any`).

import { createSignal } from 'solid-js';
import type { ItemType } from '../lib/types.ts';

/** Built-in columns the list knows how to render without configuration. */
export type BuiltinColumnId = 'username' | 'website' | 'folder' | 'type' | 'totp' | 'password';

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
}

export const ALL_BUILTINS: BuiltinColumnId[] = [
  'username',
  'website',
  'folder',
  'type',
  'totp',
  'password',
];

/** Display labels for item types (Type column + type filter input). */
export const TYPE_LABELS: Record<ItemType, string> = {
  login: 'Login',
  secureNote: 'Secure note',
  card: 'Card',
  identity: 'Identity',
  sshKey: 'SSH key',
  unknown: 'Item',
};

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

const STORAGE_KEY = 'agate.columns';

const DEFAULT: ColumnConfig = {
  columns: [
    { kind: 'builtin', id: 'username' },
    { kind: 'builtin', id: 'website' },
  ],
  revealed: [],
  favicons: true,
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
    return { columns, revealed, favicons };
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
  persist({
    ...cur,
    columns: exists ? cur.columns.filter((x) => columnKey(x) !== k) : [...cur.columns, c],
    revealed: exists ? cur.revealed.filter((r) => r !== k) : cur.revealed,
  });
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
