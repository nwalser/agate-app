// The vault item list rendered as a sortable, customizable column table.
//
// Columns come from the columns store (state/columns.ts). The always-on Name
// cell shows a website favicon for logins. Columns that need decrypted content
// (website, password, TOTP, custom fields) read from small per-row caches that
// fill lazily and only when such a column is actually shown — and secret columns
// (password/TOTP/hidden custom) stay masked, never fetched, until that column is
// revealed. Sorting (Name/Username/Folder/Type) is driven by the parent so it can
// stay in sync with selection order.
//
// This component is a thin orchestrator: it owns the lazy caches (detailCache /
// totpCache), wires the "what to fetch" effects to the visible column set, and
// renders the header (VaultListHeader), filter row (FilterRow) and the row loop —
// each cell delegating its content to the pure cellContent + VaultListCell.

import { createEffect, createMemo, For, on, Show } from 'solid-js';
import { Star } from 'lucide-solid';
import type { Folder, ItemAudit, VaultHealthReport, VaultItem } from '../lib/types.ts';
import { typeIcon } from '../lib/vaultIcons.ts';
import { cellContent, type CellContext } from '../lib/cellRendering.ts';
import {
  builtinMeta,
  columnKey,
  columns,
  gridMetrics,
  isRevealed,
  type SortDir,
  type SortKey,
} from '../state/columns.ts';
import { createDetailCache } from '../state/detailCache.ts';
import { createTotpCache } from '../state/totpCache.ts';
import Favicon from './Favicon.tsx';
import VaultListHeader from './VaultListHeader.tsx';
import FilterRow from './FilterRow.tsx';
import VaultListCell from './VaultListCell.tsx';
import './VaultList.css';

export interface VaultListProps {
  /** Already filtered + sorted, in the exact order rows render. */
  items: VaultItem[];
  folders: Folder[];
  sortKey: SortKey;
  sortDir: SortDir;
  onSort: (k: SortKey) => void;
  selectedId: string | null;
  selectedCount: number;
  isSelected: (id: string) => boolean;
  onRowClick: (item: VaultItem, e: MouseEvent) => void;
  onRowContextMenu: (item: VaultItem, e: MouseEvent) => void;
  onCheckboxToggle: (item: VaultItem, checked: boolean) => void;
  emptyMessage: string;
  /** Bumped by the parent after a mutation/sync to drop stale cached detail. */
  cacheToken: number;
  /** Offline vault-health report, used by the optional "Security" column. Null
   *  until the first audit completes; at-risk items come from its `atRisk`. */
  security: VaultHealthReport | null;
}

export default function VaultList(props: VaultListProps) {
  // Lazy caches (website / password / custom detail, and live TOTP codes).
  const detail = createDetailCache();
  const totp = createTotpCache((id) => props.items.find((it) => it.id === id)?.accountEmail);

  // Drop caches when the parent signals the vault changed.
  createEffect(
    on(
      () => props.cacheToken,
      () => {
        detail.reset();
        totp.reset();
      },
      { defer: true },
    ),
  );

  const totpColKey = createMemo(() => {
    const col = columns().columns.find((c) => c.kind === 'builtin' && c.id === 'totp');
    return col ? columnKey(col) : null;
  });
  const totpRevealed = () => {
    const k = totpColKey();
    return k !== null && isRevealed(k);
  };

  // Whether any visible column needs decrypted detail (a custom field, or a
  // revealed secret). Website + favicon come from the list's `uri` now, so they
  // no longer force a per-row detail fetch.
  const detailNeeded = createMemo(() => {
    for (const col of columns().columns) {
      if (col.kind === 'custom') return true;
      if (builtinMeta(col.id).secret && isRevealed(columnKey(col))) return true;
    }
    return false;
  });

  // Kick off the lazy fetches whenever the visible set or the config changes.
  createEffect(() => {
    const its = props.items;
    const need = detailNeeded();
    const wantTotp = totpRevealed();
    for (const it of its) {
      if (need) detail.ensure(it.accountEmail, it.id);
      if (wantTotp && it.hasTotp) totp.ensure(it.accountEmail, it.id);
    }
  });

  // The grid template + the table's minimum width, derived from the visible
  // columns and any user drag-widths. The min-width is what makes the table
  // scroll horizontally instead of squashing columns into each other when narrow.
  const metrics = createMemo(() => gridMetrics(columns().columns, columns().widths));

  const folderName = (id: string | null): string => {
    if (!id) return '';
    return props.folders.find((f) => f.id === id)?.name ?? '';
  };

  // At-risk items from the offline health report, indexed by id for the Security
  // column. Logins absent from this map (with a report present) are audited-clean.
  const securityById = createMemo(() => {
    const map = new Map<string, ItemAudit>();
    const r = props.security;
    if (r) for (const a of r.atRisk) map.set(a.id, a);
    return map;
  });

  // The lookups the pure cell logic needs from the surrounding list.
  const cellCtx = (): CellContext => ({
    isRevealed,
    detail: (id) => detail.cache().get(id),
    totp: (id) => totp.cache().get(id),
    folderName,
    audit: (id) => securityById().get(id),
    hasSecurityReport: props.security !== null,
  });

  return (
    <Show
      when={props.items.length > 0}
      fallback={<div class="vault-empty muted">{props.emptyMessage}</div>}
    >
      <div
        class="vault-table"
        style={{ '--vault-cols': metrics().template, '--vault-min': `${metrics().minWidth}px` }}
      >
        {/* Header + filter row are sticky as one block, so they pin vertically
            yet scroll horizontally in lockstep with the rows (same scroll
            container + the shared --vault-min keeps every track aligned). */}
        <div class="vault-thead">
          <VaultListHeader sortKey={props.sortKey} sortDir={props.sortDir} onSort={props.onSort} />
          <FilterRow />
        </div>

        <div class="vault-rows">
          <For each={props.items}>
            {(item) => {
              const Icon = typeIcon(item.itemType);
              const typeFallback = (
                <Icon size={16} strokeWidth={1.6} class="vault-row-icon" />
              );
              return (
                <div
                  class="vault-row"
                  classList={{
                    active: props.selectedId === item.id && props.selectedCount === 0,
                    'multi-selected': props.isSelected(item.id),
                  }}
                  onClick={(e) => props.onRowClick(item, e)}
                  onContextMenu={(e) => props.onRowContextMenu(item, e)}
                >
                  <label class="vault-row-check" onClick={(e) => e.stopPropagation()}>
                    <input
                      type="checkbox"
                      checked={props.isSelected(item.id)}
                      onChange={(e) => props.onCheckboxToggle(item, e.currentTarget.checked)}
                    />
                  </label>
                  <span class="vault-name-cell">
                    <Show when={columns().favicons} fallback={typeFallback}>
                      <Favicon uri={item.uri} fallback={typeFallback} />
                    </Show>
                    <span class="vault-row-name truncate">{item.name}</span>
                  </span>
                  <For each={columns().columns}>
                    {(col) => <VaultListCell content={cellContent(item, col, cellCtx())} />}
                  </For>
                  <span class="vault-row-end">
                    <Show when={item.favorite}>
                      <Star size={13} strokeWidth={1.75} class="vault-row-fav" />
                    </Show>
                  </span>
                </div>
              );
            }}
          </For>
        </div>
      </div>
    </Show>
  );
}
