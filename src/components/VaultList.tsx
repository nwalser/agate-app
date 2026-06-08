// The vault item list rendered as a sortable, customizable column table.
//
// Columns come from the columns store (state/columns.ts). The always-on Name
// cell shows a website favicon for logins. Columns that need decrypted content
// (website, password, TOTP, custom fields) read from a small per-row detail
// cache that is filled lazily and only when such a column is actually shown —
// and secret columns (password/TOTP/hidden custom) stay masked, never fetched,
// until that column is revealed. Sorting (Name/Username/Folder/Type) is driven
// by the parent so it can stay in sync with selection order.

import {
  createEffect,
  createMemo,
  createSignal,
  For,
  on,
  onCleanup,
  Show,
  type JSX,
} from 'solid-js';
import {
  ChevronDown,
  ChevronUp,
  CreditCard,
  File,
  Filter,
  KeyRound,
  SlidersHorizontal,
  Star,
  StickyNote,
  Terminal,
  UserRound,
  X,
} from 'lucide-solid';
import { ipc } from '../lib/ipc.ts';
import type { Folder, ItemDetail, ItemType, TotpCode, VaultItem } from '../lib/types.ts';
import {
  builtinMeta,
  columnKey,
  columns,
  isFilterable,
  isRevealed,
  sortKeyOf,
  TYPE_LABELS,
  type ColumnSpec,
  type SortDir,
  type SortKey,
} from '../state/columns.ts';
import {
  clearColumnFilters,
  columnFilter,
  filtersVisible,
  hasActiveFilters,
  NAME_FILTER_KEY,
  setColumnFilter,
  toggleFiltersVisible,
} from '../state/columnFilters.ts';
import Favicon from './Favicon.tsx';
import ColumnMenu from './ColumnMenu.tsx';
import './VaultList.css';

function typeIcon(t: ItemType) {
  switch (t) {
    case 'login':
      return KeyRound;
    case 'secureNote':
      return StickyNote;
    case 'card':
      return CreditCard;
    case 'identity':
      return UserRound;
    case 'sshKey':
      return Terminal;
    default:
      return File;
  }
}

function colWidth(c: ColumnSpec): string {
  if (c.kind === 'custom') return 'minmax(0, 1fr)';
  switch (c.id) {
    case 'type':
      return '96px';
    case 'totp':
      return '120px';
    case 'folder':
      return 'minmax(0, 0.8fr)';
    default:
      return 'minmax(0, 1fr)';
  }
}

const DETAIL_CONCURRENCY = 6;

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
}

export default function VaultList(props: VaultListProps) {
  const [menuOpen, setMenuOpen] = createSignal(false);

  // ---- lazy detail cache (website / password / custom / favicon host) ----
  const [detailCache, setDetailCache] = createSignal<Map<string, ItemDetail>>(new Map());
  const detailPending = new Set<string>();
  let detailQueue: { email: string; id: string }[] = [];
  let detailActive = 0;

  function pumpDetail() {
    while (detailActive < DETAIL_CONCURRENCY && detailQueue.length > 0) {
      const next = detailQueue.shift();
      if (next === undefined) break;
      const { email, id } = next;
      detailActive++;
      void ipc
        .itemDetail(email, id)
        .then((d) => setDetailCache((m) => new Map(m).set(id, d)))
        .catch(() => {
          // ignore: detail is best-effort for list cells; the cell shows blank
        })
        .finally(() => {
          detailActive--;
          detailPending.delete(id);
          pumpDetail();
        });
    }
  }
  function ensureDetail(email: string, id: string) {
    if (detailCache().has(id) || detailPending.has(id)) return;
    detailPending.add(id);
    detailQueue.push({ email, id });
    pumpDetail();
  }

  // ---- lazy TOTP cache (only when the TOTP column is revealed) ----
  const [totpCache, setTotpCache] = createSignal<Map<string, TotpCode>>(new Map());
  const totpPending = new Set<string>();
  function ensureTotp(email: string, id: string, force = false) {
    if (!force && (totpCache().has(id) || totpPending.has(id))) return;
    totpPending.add(id);
    void ipc
      .itemTotp(email, id)
      .then((c) => setTotpCache((m) => new Map(m).set(id, c)))
      .catch(() => {
        // ignore: TOTP is best-effort for the list cell
      })
      .finally(() => totpPending.delete(id));
  }

  // Single ticker: count down cached codes; refetch the ones that roll over.
  const ticker = setInterval(() => {
    const m = totpCache();
    if (m.size === 0) return;
    const next = new Map(m);
    let changed = false;
    for (const [id, code] of next) {
      if (code.remaining <= 1) {
        const email = props.items.find((it) => it.id === id)?.accountEmail;
        if (email) ensureTotp(email, id, true);
      } else {
        next.set(id, { ...code, remaining: code.remaining - 1 });
        changed = true;
      }
    }
    if (changed) setTotpCache(next);
  }, 1000);
  onCleanup(() => clearInterval(ticker));

  // Drop caches when the parent signals the vault changed.
  createEffect(
    on(
      () => props.cacheToken,
      () => {
        setDetailCache(new Map());
        setTotpCache(new Map());
        detailQueue = [];
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
      if (need) ensureDetail(it.accountEmail, it.id);
      if (wantTotp && it.hasTotp) ensureTotp(it.accountEmail, it.id);
    }
  });

  const gridTemplate = createMemo(() => {
    const mid = columns().columns.map(colWidth).join(' ');
    return `22px minmax(0, 1.6fr)${mid ? ` ${mid}` : ''} 76px`;
  });

  const folderName = (id: string | null): string => {
    if (!id) return '';
    return props.folders.find((f) => f.id === id)?.name ?? '';
  };

  // ---- cell content per column ----
  function cell(item: VaultItem, col: ColumnSpec): JSX.Element {
    if (col.kind === 'custom') return customCell(item, col.field, columnKey(col));
    switch (col.id) {
      case 'username':
        return <span class="vault-cell truncate">{item.username ?? ''}</span>;
      case 'website':
        return <span class="vault-cell truncate muted">{item.uri ?? ''}</span>;
      case 'folder':
        return <span class="vault-cell truncate muted">{folderName(item.folderId)}</span>;
      case 'type':
        return <span class="vault-cell vault-type-badge">{TYPE_LABELS[item.itemType]}</span>;
      case 'totp':
        return totpCell(item, columnKey(col));
      case 'password':
        return passwordCell(item, columnKey(col));
    }
  }

  function passwordCell(item: VaultItem, key: string): JSX.Element {
    if (item.itemType !== 'login') return <span class="vault-cell" />;
    if (!isRevealed(key)) return <span class="vault-cell vault-secret">••••••••</span>;
    const pw = detailCache().get(item.id)?.login?.password;
    return <span class="vault-cell mono truncate">{pw ?? '…'}</span>;
  }

  function totpCell(item: VaultItem, key: string): JSX.Element {
    if (!item.hasTotp) return <span class="vault-cell" />;
    if (!isRevealed(key)) return <span class="vault-cell vault-secret">••• •••</span>;
    const code = totpCache().get(item.id);
    return (
      <span class="vault-cell mono totp-code">
        {code ? code.code : '…'}
        <Show when={code}>
          <small class="totp-remaining">{code!.remaining}s</small>
        </Show>
      </span>
    );
  }

  function customCell(item: VaultItem, field: string, key: string): JSX.Element {
    const d = detailCache().get(item.id);
    if (!d) return <span class="vault-cell muted">…</span>;
    const f = d.fields.find((x) => x.name === field);
    if (!f || f.value === null) return <span class="vault-cell" />;
    if (f.fieldType === 'hidden' && !isRevealed(key)) {
      return <span class="vault-cell vault-secret">••••••</span>;
    }
    return <span class="vault-cell truncate">{f.value}</span>;
  }

  return (
    <Show
      when={props.items.length > 0}
      fallback={<div class="vault-empty muted">{props.emptyMessage}</div>}
    >
      <div class="vault-table" style={{ '--vault-cols': gridTemplate() }}>
        <div class="vault-head">
          <span class="vault-head-cell" />
          <SortHeader
            label="Name"
            active={props.sortKey === 'name'}
            dir={props.sortDir}
            onClick={() => props.onSort('name')}
          />
          <For each={columns().columns}>
            {(col) => {
              const sk = sortKeyOf(col);
              return sk ? (
                <SortHeader
                  label={builtinMeta(col.kind === 'builtin' ? col.id : 'username').label}
                  active={props.sortKey === sk}
                  dir={props.sortDir}
                  onClick={() => props.onSort(sk)}
                />
              ) : (
                <span class="vault-head-cell">
                  {col.kind === 'builtin' ? builtinMeta(col.id).label : col.field}
                </span>
              );
            }}
          </For>
          <div class="vault-head-cell vault-head-gear">
            <button
              class="ghost icon-btn vault-gear-btn"
              classList={{ 'filter-on': filtersVisible() || hasActiveFilters() }}
              title="Filter by column"
              onClick={() => toggleFiltersVisible()}
            >
              <Filter size={14} strokeWidth={1.75} />
            </button>
            <div class="column-menu-anchor">
              <button
                class="ghost icon-btn vault-gear-btn"
                title="Customize columns"
                onClick={() => setMenuOpen((v) => !v)}
              >
                <SlidersHorizontal size={14} strokeWidth={1.75} />
              </button>
              <Show when={menuOpen()}>
                <ColumnMenu onClose={() => setMenuOpen(false)} />
              </Show>
            </div>
          </div>
        </div>

        <Show when={filtersVisible()}>
          <div class="vault-filter-row">
            <span />
            <input
              class="vault-filter-input"
              placeholder="Filter name…"
              value={columnFilter(NAME_FILTER_KEY)}
              onInput={(e) => setColumnFilter(NAME_FILTER_KEY, e.currentTarget.value)}
            />
            <For each={columns().columns}>
              {(col) =>
                isFilterable(col) ? (
                  <input
                    class="vault-filter-input"
                    placeholder="Filter…"
                    value={columnFilter(columnKey(col))}
                    onInput={(e) => setColumnFilter(columnKey(col), e.currentTarget.value)}
                  />
                ) : (
                  <span />
                )
              }
            </For>
            <span class="vault-filter-clear">
              <Show when={hasActiveFilters()}>
                <button
                  class="ghost icon-btn vault-gear-btn"
                  title="Clear filters"
                  onClick={() => clearColumnFilters()}
                >
                  <X size={13} strokeWidth={1.75} />
                </button>
              </Show>
            </span>
          </div>
        </Show>

        <div class="vault-list-scroll">
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
                  <For each={columns().columns}>{(col) => cell(item, col)}</For>
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

function SortHeader(props: {
  label: string;
  active: boolean;
  dir: SortDir;
  onClick: () => void;
}) {
  return (
    <button
      class="vault-head-cell sortable"
      classList={{ sorted: props.active }}
      onClick={() => props.onClick()}
    >
      {props.label}
      <Show when={props.active}>
        <Show
          when={props.dir === 'asc'}
          fallback={<ChevronDown size={12} class="vault-head-sort" />}
        >
          <ChevronUp size={12} class="vault-head-sort" />
        </Show>
      </Show>
    </button>
  );
}
