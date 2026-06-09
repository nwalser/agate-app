// All list-shaping logic for the vault screen: the active rail filter, the column
// sort, and the per-column substring filters, composed into the `displayed` list
// the rows render from. `filtered` applies (in order) the rail filter + titlebar
// search, the active-vault scope, and the visible filterable-column needles;
// `displayed` then sorts it. Also derives the folder scoping the rail tree + the
// bulk "move to folder" targets use. Pure-ish (only IPC-free signal reads).

import { type Accessor, createMemo, createSignal } from 'solid-js';
import type { Folder, ItemAudit, ItemType, VaultHealthReport, VaultItem } from '../lib/types.ts';
import { filterItems, type VaultFilter } from '../lib/search.ts';
import { isCommandQuery } from '../lib/command.ts';
import { groupOf, type GroupContext } from '../lib/grouping.ts';
import { query } from '../state/search.ts';
import { filters, NAME_FILTER_KEY } from '../state/columnFilters.ts';
import {
  columnKey,
  columns,
  isFilterable,
  TYPE_LABELS,
  type SortDir,
  type SortKey,
} from '../state/columns.ts';
import { activeVault } from '../state/ui.ts';

export function useVaultFiltering(deps: {
  items: Accessor<VaultItem[]>;
  folders: Accessor<Folder[]>;
  /** Offline vault-health report — drives the Security sort + grouping ranks. */
  health: Accessor<VaultHealthReport | null>;
}) {
  // `query` is the shared titlebar search signal (state/search.ts) — the search
  // field now lives in the custom window titlebar, not this header.
  const [filter, setFilter] = createSignal<VaultFilter>({ kind: 'all' });

  // Column sort. `displayed` is the filtered list in the sorted order the rows
  // actually render in — selection (shift-range) and the For both key off it so
  // visual order and logical order never diverge.
  const [sortKey, setSortKey] = createSignal<SortKey>('name');
  const [sortDir, setSortDir] = createSignal<SortDir>('asc');

  const inTrash = createMemo(() => filter().kind === 'trash');

  // The current list page's type, if it's a type page (Logins/Cards/…). Drives
  // the per-page Add button: a type page adds that type directly; All / Favorites
  // / folders fall back to the type-picker menu.
  const addType = createMemo<ItemType | null>(() => {
    const f = filter();
    return f.kind === 'type' ? f.itemType : null;
  });

  const folderNameOf = (id: string | null): string =>
    id ? deps.folders().find((f) => f.id === id)?.name ?? '' : '';

  const filtered = createMemo(() => {
    const av = activeVault();
    // A `/`-prefixed query is a command, not a list filter — don't let it hide rows.
    const term = isCommandQuery(query()) ? '' : query();
    let base = filterItems(deps.items(), term, filter());
    // Scope to the selected vault (connection), if any. null = all merged.
    if (av) base = base.filter((it) => it.accountEmail === av);
    const active = filters();
    if (Object.keys(active).length === 0) return base;
    // Per-column filters. Build extractors only for the Name column and the
    // currently-visible filterable columns, so a stale filter on a hidden
    // column can't silently hide rows with no visible input to clear it.
    const extractors = new Map<string, (it: VaultItem) => string>();
    extractors.set(NAME_FILTER_KEY, (it) => it.name);
    for (const col of columns().columns) {
      if (col.kind !== 'builtin' || !isFilterable(col)) continue;
      const k = columnKey(col);
      if (col.id === 'username') extractors.set(k, (it) => it.username ?? '');
      else if (col.id === 'website') extractors.set(k, (it) => it.uri ?? '');
      else if (col.id === 'folder') extractors.set(k, (it) => folderNameOf(it.folderId));
      else if (col.id === 'type') extractors.set(k, (it) => TYPE_LABELS[it.itemType]);
    }
    const applicable = Object.keys(active)
      .filter((k) => extractors.has(k) && active[k])
      .map((k) => ({ needle: active[k].toLowerCase(), get: extractors.get(k)! }));
    if (applicable.length === 0) return base;
    return base.filter((it) => applicable.every((f) => f.get(it).toLowerCase().includes(f.needle)));
  });

  // At-risk logins indexed by id (for the Security sort + grouping). Empty until
  // the first offline-health report arrives.
  const atRiskById = createMemo(() => {
    const map = new Map<string, ItemAudit>();
    const r = deps.health();
    if (r) for (const a of r.atRisk) map.set(a.id, a);
    return map;
  });

  const groupCtx = (): GroupContext => ({
    folderName: folderNameOf,
    audit: (id) => atRiskById().get(id),
    hasSecurityReport: deps.health() !== null,
  });

  // Security sort rank: higher = worse. 0 = unrated (non-login / no report) and
  // always sorts last, regardless of direction.
  const securityRank = (it: VaultItem): number => {
    if (it.itemType !== 'login' || deps.health() === null) return 0;
    const a = atRiskById().get(it.id);
    if (!a) return 1; // audited-clean
    return groupOf(it, 'security', groupCtx()).rank === 1 ? 3 : 2; // risk : warn
  };

  // The within-group sort comparator for the active column + direction.
  const sortComparator = (key: SortKey, dir: number) => {
    if (key === 'security') {
      return (a: VaultItem, b: VaultItem): number => {
        const ra = securityRank(a);
        const rb = securityRank(b);
        if (ra === 0 && rb !== 0) return 1;
        if (ra !== 0 && rb === 0) return -1;
        if (ra !== rb) return dir * (ra - rb);
        return a.name.localeCompare(b.name, undefined, { sensitivity: 'base' });
      };
    }
    const val = (it: VaultItem): string => {
      switch (key) {
        case 'name':
          return it.name;
        case 'username':
          return it.username ?? '';
        case 'folder':
          return folderNameOf(it.folderId);
        case 'type':
          return it.itemType;
        default:
          return '';
      }
    };
    // Stable, case-insensitive, locale-aware; empty values sort last.
    return (a: VaultItem, b: VaultItem): number => {
      const av = val(a);
      const bv = val(b);
      if (!av && bv) return 1;
      if (av && !bv) return -1;
      return dir * av.localeCompare(bv, undefined, { sensitivity: 'base' });
    };
  };

  const displayed = createMemo(() => {
    const dir = sortDir() === 'asc' ? 1 : -1;
    const cmpSort = sortComparator(sortKey(), dir);
    const gb = columns().groupBy;
    if (!gb) return [...filtered()].sort(cmpSort);
    // Grouped: order by group (fixed natural order, independent of sort dir),
    // then by the active sort within each group. The rows stay a flat array so
    // selection ranges and the row `For` keep working on the displayed order.
    const ctx = groupCtx();
    return [...filtered()].sort((a, b) => {
      const ga = groupOf(a, gb, ctx);
      const gbv = groupOf(b, gb, ctx);
      if (ga.rank !== gbv.rank) return ga.rank - gbv.rank;
      if (ga.id !== gbv.id) return ga.label.localeCompare(gbv.label, undefined, { sensitivity: 'base' });
      return cmpSort(a, b);
    });
  });

  // Click a column header: toggle direction if already sorted by it, else switch
  // to it ascending.
  function toggleSort(key: SortKey) {
    if (sortKey() === key) {
      setSortDir((d) => (d === 'asc' ? 'desc' : 'asc'));
    } else {
      setSortKey(key);
      setSortDir('asc');
    }
  }

  // Set sort key + direction outright (restoring a saved view's snapshot).
  function setSort(key: SortKey, dir: SortDir) {
    setSortKey(key);
    setSortDir(dir);
  }

  // Folders scoped to the active vault (all folders when no vault is selected) —
  // drives the rail folder tree and the bulk "move to folder" targets.
  const scopedFolders = createMemo(() => {
    const av = activeVault();
    return av ? deps.folders().filter((f) => f.accountEmail === av) : deps.folders();
  });
  const realFolders = createMemo(() => scopedFolders().filter((f) => f.id !== null));

  return {
    filter,
    setFilter,
    sortKey,
    sortDir,
    toggleSort,
    setSort,
    inTrash,
    addType,
    folderNameOf,
    filtered,
    displayed,
    scopedFolders,
    realFolders,
  };
}

export type VaultFiltering = ReturnType<typeof useVaultFiltering>;
