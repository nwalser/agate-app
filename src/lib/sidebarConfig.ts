// Sidebar (left rail) customization schema + metadata — the immutable, pure half
// of the sidebar config (mirrors `state/columnConfig.ts`). No signals, no side
// effects: the entry-id closed set, the builtin metadata (label/icon), the
// builtin → filter/view action maps, the saved-query type, and the validating
// parse + reconcile used at the localStorage boundary (no `any`). The live signal
// and its mutators live in `state/sidebar.ts`.

import { Bookmark, Dices, File, FolderClosed, RefreshCw, Shield, Star, Trash2 } from 'lucide-solid';
import type { IconComponent } from './icon.ts';
import type { ItemType } from './types.ts';
import type { VaultFilter } from './search.ts';
import { TYPE_FILTERS, type VaultView } from './vaultConfig.ts';
import { typeIcon } from './vaultIcons.ts';

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
  | 'sync';

/** Base filter a saved query carries. A subset of `VaultFilter` — excludes
 *  `folder`, which is account-scoped and not portable across vault switches. */
export type SavedFilter =
  | { kind: 'all' }
  | { kind: 'favorites' }
  | { kind: 'trash' }
  | { kind: 'type'; itemType: ItemType };

/** A user-defined saved query pinned to the rail: a name + search text applied on
 *  top of a base filter. `id` is always `query:<uuid>`. */
export interface CustomQuery {
  id: string;
  name: string;
  query: string;
  filter: SavedFilter;
}

export interface SidebarConfig {
  /** Entry ids (builtin ids + query ids) in display order. */
  order: string[];
  /** Subset of `order` that is currently hidden from the rail. */
  hidden: string[];
  /** Definitions backing the `query:*` ids in `order`. */
  queries: CustomQuery[];
}

/** A resolved, renderable rail entry (builtin, a saved query, or a divider line). */
export type SidebarEntry =
  | { kind: 'builtin'; id: SidebarBuiltinId }
  | { kind: 'query'; query: CustomQuery }
  | { kind: 'divider'; id: string };

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
  'sync',
];

/** A fresh default config (never share the mutable arrays). */
export function defaultSidebar(): SidebarConfig {
  return { order: [...DEFAULT_ORDER], hidden: [], queries: [] };
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
    case 'sync':
      return { label: 'Sync', icon: RefreshCw };
    default: {
      const t = TYPE_BY_ID[id];
      return { label: TYPE_LABEL.get(t) ?? t, icon: typeIcon(t) };
    }
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
  if (o.kind === 'all' || o.kind === 'favorites' || o.kind === 'trash') return { kind: o.kind };
  if (o.kind === 'type' && isItemType(o.itemType)) return { kind: 'type', itemType: o.itemType };
  return null;
}

export function parseCustomQuery(v: unknown): CustomQuery | null {
  if (typeof v !== 'object' || v === null) return null;
  const o = v as Record<string, unknown>;
  if (!isQueryId(o.id)) return null;
  if (typeof o.name !== 'string' || o.name.trim() === '') return null;
  if (typeof o.query !== 'string') return null;
  const filter = parseSavedFilter(o.filter);
  if (!filter) return null;
  return { id: o.id, name: o.name, query: o.query, filter };
}

/**
 * Normalize a config so the rail can render it safely: drop unknown/duplicate
 * ids, append any built-in missing from `order` (future-proofs new builtins),
 * append saved-query ids not yet ordered, and clamp `hidden ⊆ order`.
 */
export function reconcile(cfg: SidebarConfig): SidebarConfig {
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
  return { order, hidden, queries: cfg.queries };
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
    return reconcile({ order, hidden, queries });
  } catch {
    // ignore: corrupt/unavailable config falls back to defaults
    return defaultSidebar();
  }
}
