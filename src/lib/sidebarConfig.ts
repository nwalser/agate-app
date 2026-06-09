// Sidebar (left rail) customization schema + metadata — the immutable, pure half
// of the sidebar config (mirrors `state/columnConfig.ts`). No signals, no side
// effects: the entry-id closed set, the builtin metadata (label/icon), the
// builtin → filter/view action maps, the saved-query type, and the validating
// parse + reconcile used at the localStorage boundary (no `any`). The live signal
// and its mutators live in `state/sidebar.ts`.

import { AlertTriangle, Bookmark, Dices, File, FolderClosed, RefreshCw, Shield, Star, Trash2 } from 'lucide-solid';
import type { IconComponent } from './icon.ts';
import type { ItemType } from './types.ts';
import type { VaultFilter } from './search.ts';
import { TYPE_FILTERS, type VaultView } from './vaultConfig.ts';
import { typeIcon } from './vaultIcons.ts';
import { DEFAULT_VIEW_ICON, isViewIcon } from './viewIcons.ts';
import {
  parseColumnConfig,
  type ColumnConfig,
  type SortDir,
  type SortKey,
} from '../state/columnConfig.ts';

/** Built-in rail entries the user can show/hide/reorder. `type:*` are the per-type
 *  filters; `folders` is the whole folder-tree block. */
export type SidebarBuiltinId =
  | 'all'
  | 'favorites'
  | 'trash'
  | 'type:login'
  | 'type:card'
  | 'type:identity'
  | 'type:secureNote'
  | 'type:sshKey'
  | 'folders'
  | 'generator'
  | 'security'
  | 'atRisk'
  | 'sync';

/** Base filter a saved query carries. A subset of `VaultFilter` — excludes
 *  `folder`, which is account-scoped and not portable across vault switches. */
export type SavedFilter =
  | { kind: 'all' }
  | { kind: 'favorites' }
  | { kind: 'trash' }
  | { kind: 'atRisk' }
  | { kind: 'type'; itemType: ItemType };

// Sort snapshot stored in a view (key + direction).
export interface ViewSort {
  key: SortKey;
  dir: SortDir;
}

/** The full list snapshot a saved view captures: base filter, titlebar search,
 *  per-column filters, and (optionally) the whole column layout + sort. `columns`
 *  and `sort` are optional so a freshly-created or legacy view doesn't force a
 *  layout — apply only touches the parts that are present. */
export interface ViewConfig {
  filter: SavedFilter;
  query: string;
  columnFilters: Record<string, string>;
  columns?: ColumnConfig;
  sort?: ViewSort;
}

/** Config a brand-new view starts from — everything else is set while viewing. */
export function defaultViewConfig(): ViewConfig {
  return { filter: { kind: 'all' }, query: '', columnFilters: {} };
}

/** A user-defined saved view pinned to the rail: a name + a pickable icon + a
 *  captured list snapshot (see ViewConfig). `id` is always `query:<uuid>` (kept
 *  for back-compat with the original "custom query" feature). */
export interface CustomQuery {
  id: string;
  name: string;
  icon: string;
  config: ViewConfig;
}

export interface SidebarConfig {
  /** Entry ids (builtin ids + query ids) in display order. */
  order: string[];
  /** Subset of `order` that is currently hidden from the rail. */
  hidden: string[];
  /** Definitions backing the `query:*` ids in `order`. */
  queries: CustomQuery[];
  /** Optional section label per divider id (`divider:*`). A labeled divider renders
   *  as a section header; an unlabeled one is a plain rule. Absent/blank = unlabeled. */
  dividerLabels: Record<string, string>;
}

/** Loose input to `reconcile`: `dividerLabels` is optional so legacy/test callers
 *  (and stored configs predating labels) need not supply it. */
export type SidebarConfigInput = Omit<SidebarConfig, 'dividerLabels'> &
  Partial<Pick<SidebarConfig, 'dividerLabels'>>;

/** A resolved, renderable rail entry (builtin, a saved query, or a divider line —
 *  carrying its optional section label). */
export type SidebarEntry =
  | { kind: 'builtin'; id: SidebarBuiltinId }
  | { kind: 'query'; query: CustomQuery }
  | { kind: 'divider'; id: string; label: string };

/** Prefix for user-added horizontal divider ids (`divider:<uuid>`). A divider has
 *  no backing definition — it exists purely as an id in `order`. */
export const DIVIDER_PREFIX = 'divider:';

export const SIDEBAR_STORAGE_KEY = 'agate.sidebar';

/** Canonical built-in order — the rail layout before any customization. */
export const DEFAULT_ORDER: SidebarBuiltinId[] = [
  'all',
  'favorites',
  'trash',
  'type:login',
  'type:card',
  'type:identity',
  'type:secureNote',
  'type:sshKey',
  'folders',
  'generator',
  'security',
  'atRisk',
  'sync',
];

/** A fresh default config (never share the mutable arrays). */
export function defaultSidebar(): SidebarConfig {
  return { order: [...DEFAULT_ORDER], hidden: [], queries: [], dividerLabels: {} };
}

// Per-type rail entry id ↔ ItemType. Order mirrors TYPE_FILTERS / DEFAULT_ORDER.
const TYPE_BY_ID: Record<string, ItemType> = {
  'type:login': 'login',
  'type:card': 'card',
  'type:identity': 'identity',
  'type:secureNote': 'secureNote',
  'type:sshKey': 'sshKey',
};

const TYPE_LABEL = new Map(TYPE_FILTERS.map((t) => [t.type, t.label] as const));
const VALID_ITEM_TYPES = new Set<ItemType>(TYPE_FILTERS.map((t) => t.type));

export function isItemType(v: unknown): v is ItemType {
  return typeof v === 'string' && VALID_ITEM_TYPES.has(v as ItemType);
}

export function isBuiltinId(v: unknown): v is SidebarBuiltinId {
  return typeof v === 'string' && (DEFAULT_ORDER as string[]).includes(v);
}

export function isQueryId(v: unknown): v is string {
  return typeof v === 'string' && v.startsWith('query:');
}

export function isDividerId(v: unknown): v is string {
  return typeof v === 'string' && v.startsWith(DIVIDER_PREFIX);
}

/** Label + icon for a builtin entry — single source shared by the rail and the
 *  settings editor. */
export function entryMeta(id: SidebarBuiltinId): { label: string; icon: IconComponent } {
  switch (id) {
    case 'all':
      return { label: 'All items', icon: File };
    case 'favorites':
      return { label: 'Favorites', icon: Star };
    case 'trash':
      return { label: 'Trash', icon: Trash2 };
    case 'folders':
      return { label: 'Folders', icon: FolderClosed };
    case 'generator':
      return { label: 'Generator', icon: Dices };
    case 'security':
      return { label: 'Security', icon: Shield };
    case 'atRisk':
      return { label: 'At risk', icon: AlertTriangle };
    case 'sync':
      return { label: 'Sync', icon: RefreshCw };
    default: {
      const t = TYPE_BY_ID[id];
      return { label: TYPE_LABEL.get(t) ?? t, icon: typeIcon(t) };
    }
  }
}

/** Page title + icon for an active vault filter — drives the item-list page
 *  header (mirrors the Security page's icon + title). Folder pages resolve their
 *  name through `folderName` (the no-folder bucket has no name → "No folder"). */
export function filterPageMeta(
  filter: VaultFilter,
  folderName: (id: string | null) => string,
): { label: string; icon: IconComponent } {
  switch (filter.kind) {
    case 'all':
      return entryMeta('all');
    case 'favorites':
      return entryMeta('favorites');
    case 'trash':
      return entryMeta('trash');
    case 'atRisk':
      return entryMeta('atRisk');
    case 'type':
      return { label: TYPE_LABEL.get(filter.itemType) ?? filter.itemType, icon: typeIcon(filter.itemType) };
    case 'folder':
      return { label: folderName(filter.folderId) || 'No folder', icon: FolderClosed };
  }
}

/** Icon for a saved query (every saved query renders the bookmark glyph). */
export const QUERY_ICON: IconComponent = Bookmark;

/** The vault filter a filter-builtin selects, or null for view/block entries. */
export function builtinFilter(id: SidebarBuiltinId): VaultFilter | null {
  switch (id) {
    case 'all':
      return { kind: 'all' };
    case 'favorites':
      return { kind: 'favorites' };
    case 'trash':
      return { kind: 'trash' };
    case 'atRisk':
      return { kind: 'atRisk' };
    case 'type:login':
    case 'type:card':
    case 'type:identity':
    case 'type:secureNote':
    case 'type:sshKey':
      return { kind: 'type', itemType: TYPE_BY_ID[id] };
    default:
      return null;
  }
}

/** The main view a view-builtin switches to, or null for filter/block entries. */
export function builtinView(id: SidebarBuiltinId): VaultView | null {
  switch (id) {
    case 'generator':
      return 'generator';
    case 'security':
      return 'security';
    case 'sync':
      return 'sync';
    default:
      return null;
  }
}

// ---- storage parse / reconcile ------------------------------------------------

export function parseSavedFilter(v: unknown): SavedFilter | null {
  if (typeof v !== 'object' || v === null) return null;
  const o = v as Record<string, unknown>;
  if (o.kind === 'all' || o.kind === 'favorites' || o.kind === 'trash' || o.kind === 'atRisk')
    return { kind: o.kind };
  if (o.kind === 'type' && isItemType(o.itemType)) return { kind: 'type', itemType: o.itemType };
  return null;
}

const SORT_KEYS: SortKey[] = ['name', 'username', 'folder', 'type', 'security'];
function parseSortKey(v: unknown): SortKey | null {
  return typeof v === 'string' && (SORT_KEYS as string[]).includes(v) ? (v as SortKey) : null;
}

/** Validate an arbitrary value into a `ViewConfig`, defaulting missing pieces.
 *  `columns` / `sort` are only set when present (so applying won't touch layout). */
export function parseViewConfig(v: unknown): ViewConfig {
  if (typeof v !== 'object' || v === null) return defaultViewConfig();
  const o = v as Record<string, unknown>;
  const filter = parseSavedFilter(o.filter) ?? { kind: 'all' };
  const query = typeof o.query === 'string' ? o.query : '';
  const columnFilters: Record<string, string> = {};
  if (o.columnFilters && typeof o.columnFilters === 'object') {
    for (const [k, val] of Object.entries(o.columnFilters as Record<string, unknown>)) {
      if (typeof val === 'string' && val) columnFilters[k] = val;
    }
  }
  const cfg: ViewConfig = { filter, query, columnFilters };
  if (o.columns !== undefined) cfg.columns = parseColumnConfig(o.columns);
  if (o.sort && typeof o.sort === 'object') {
    const so = o.sort as Record<string, unknown>;
    const key = parseSortKey(so.key);
    if (key && (so.dir === 'asc' || so.dir === 'desc')) cfg.sort = { key, dir: so.dir };
  }
  return cfg;
}

export function parseCustomQuery(v: unknown): CustomQuery | null {
  if (typeof v !== 'object' || v === null) return null;
  const o = v as Record<string, unknown>;
  if (!isQueryId(o.id)) return null;
  if (typeof o.name !== 'string' || o.name.trim() === '') return null;
  const icon = isViewIcon(o.icon) ? o.icon : DEFAULT_VIEW_ICON;
  // New shape carries an explicit `config`. Legacy shape is flat `{query, filter}`
  // — upgrade it into a config (filter + search only; no layout snapshot).
  if (o.config !== undefined) {
    return { id: o.id, name: o.name, icon, config: parseViewConfig(o.config) };
  }
  const filter = parseSavedFilter(o.filter) ?? { kind: 'all' };
  const query = typeof o.query === 'string' ? o.query : '';
  return { id: o.id, name: o.name, icon, config: { filter, query, columnFilters: {} } };
}

/** Validate a persisted `dividerLabels` blob: keep only string values (the divider
 *  id ↔ label map). Non-objects yield an empty map. */
export function parseDividerLabels(v: unknown): Record<string, string> {
  const out: Record<string, string> = {};
  if (typeof v !== 'object' || v === null) return out;
  for (const [k, val] of Object.entries(v as Record<string, unknown>)) {
    if (typeof val === 'string') out[k] = val;
  }
  return out;
}

/**
 * Resolve a config into the ordered, renderable rail entries: drop hidden ids, map
 * each id to a builtin / query / divider entry (attaching a divider's optional
 * section label), and collapse cosmetically-redundant UNLABELED dividers — a
 * leading one, a trailing one, or one directly after another divider. Labeled
 * dividers are section headers and are always kept.
 */
export function resolveSidebar(cfg: SidebarConfig): SidebarEntry[] {
  const hidden = new Set(cfg.hidden);
  const byId = new Map(cfg.queries.map((q) => [q.id, q] as const));
  const mapped: SidebarEntry[] = [];
  for (const id of cfg.order) {
    if (hidden.has(id)) continue;
    if (isBuiltinId(id)) {
      mapped.push({ kind: 'builtin', id });
    } else if (isDividerId(id)) {
      mapped.push({ kind: 'divider', id, label: (cfg.dividerLabels[id] ?? '').trim() });
    } else {
      const q = byId.get(id);
      if (q) mapped.push({ kind: 'query', query: q });
    }
  }
  const isBareDivider = (e: SidebarEntry | undefined) =>
    e !== undefined && e.kind === 'divider' && e.label === '';
  const out: SidebarEntry[] = [];
  for (const e of mapped) {
    // Skip an unlabeled divider that is leading or directly follows another divider.
    if (isBareDivider(e) && (out.length === 0 || out[out.length - 1].kind === 'divider')) continue;
    out.push(e);
  }
  while (isBareDivider(out[out.length - 1])) out.pop(); // drop a trailing bare divider
  return out;
}

/**
 * Normalize a config so the rail can render it safely: drop unknown/duplicate
 * ids, append any built-in missing from `order` (future-proofs new builtins),
 * append saved-query ids not yet ordered, clamp `hidden ⊆ order`, and keep only
 * divider labels whose (non-empty) divider id survived in `order`.
 */
export function reconcile(cfg: SidebarConfigInput): SidebarConfig {
  const queryIds = new Set(cfg.queries.map((q) => q.id));
  const seen = new Set<string>();
  const order: string[] = [];
  for (const id of cfg.order) {
    if (seen.has(id)) continue;
    if (isBuiltinId(id) || queryIds.has(id) || isDividerId(id)) {
      order.push(id);
      seen.add(id);
    }
  }
  for (const id of DEFAULT_ORDER) {
    if (!seen.has(id)) {
      order.push(id);
      seen.add(id);
    }
  }
  for (const q of cfg.queries) {
    if (!seen.has(q.id)) {
      order.push(q.id);
      seen.add(q.id);
    }
  }
  const orderSet = new Set(order);
  const hidden = [...new Set(cfg.hidden)].filter((h) => orderSet.has(h));
  const dividerLabels: Record<string, string> = {};
  const src = cfg.dividerLabels ?? {};
  for (const id of order) {
    const label = src[id];
    if (isDividerId(id) && typeof label === 'string' && label.trim()) dividerLabels[id] = label;
  }
  return { order, hidden, queries: cfg.queries, dividerLabels };
}

/** Read + validate the persisted config; corrupt/unavailable falls back to default. */
export function readSidebarConfig(): SidebarConfig {
  try {
    const raw = localStorage.getItem(SIDEBAR_STORAGE_KEY);
    if (!raw) return defaultSidebar();
    const parsed: unknown = JSON.parse(raw);
    if (typeof parsed !== 'object' || parsed === null) return defaultSidebar();
    const o = parsed as Record<string, unknown>;
    const order = Array.isArray(o.order)
      ? o.order.filter((x): x is string => typeof x === 'string')
      : [];
    const hidden = Array.isArray(o.hidden)
      ? o.hidden.filter((x): x is string => typeof x === 'string')
      : [];
    const queries = Array.isArray(o.queries)
      ? o.queries.map(parseCustomQuery).filter((x): x is CustomQuery => x !== null)
      : [];
    const dividerLabels = parseDividerLabels(o.dividerLabels);
    return reconcile({ order, hidden, queries, dividerLabels });
  } catch {
    // ignore: corrupt/unavailable config falls back to defaults
    return defaultSidebar();
  }
}
