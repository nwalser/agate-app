// The vault item list rendered as a sortable, customizable column table.
//
// Columns come from the columns store (state/columns.ts). The always-on Name
// cell shows a website favicon for logins. Columns that need decrypted content
// (website, password, TOTP, custom fields) read from small per-row caches that
// fill lazily and only when such a column is actually shown — and secret columns
// (password/TOTP/hidden custom) stay masked, never fetched, until that column is
// revealed. Sorting (Name/Username/Folder/Type/Security) is driven by the parent
// so it can stay in sync with selection order; when a "group by" column is set the
// parent also orders by group and this list draws a header row between groups.
//
// This component is a thin orchestrator: it owns the lazy caches (detailCache /
// totpCache), wires the "what to fetch" effects to the visible column set, and
// renders the header (VaultListHeader), filter row (FilterRow) and the row loop —
// each cell delegating its content to the pure cellContent + VaultListCell.

import { type Accessor, createEffect, createMemo, createSignal, For, on, Show } from 'solid-js';
import { CheckCheck, Star } from 'lucide-solid';
import type { Folder, ItemAudit, ItemType, VaultHealthReport, VaultItem } from '../lib/types.ts';
import { typeIcon } from '../lib/vaultIcons.ts';
import { CREATE_TYPES } from '../lib/vaultConfig.ts';
import { ContextMenu, CtxItem, CtxSep } from './ContextMenu.tsx';
import { cellContent, type CellContext } from '../lib/cellRendering.ts';
import { customFieldGroupValue, groupOf, type GroupContext } from '../lib/grouping.ts';
import { rectFromPoints, rectsIntersect } from '../lib/listSelection.ts';
import { clearDraggedItems, ITEM_DRAG_MIME, setDraggedItems } from '../state/itemDrag.ts';
import {
  builtinMeta,
  columnKey,
  columns,
  gridMetrics,
  isRevealed,
  type ColumnSpec,
  type SortDir,
  type SortKey,
} from '../state/columns.ts';
import type { DetailCache } from '../state/detailCache.ts';
import { createTotpCache } from '../state/totpCache.ts';
import Favicon from './Favicon.tsx';
import VaultListHeader from './VaultListHeader.tsx';
import FilterRow from './FilterRow.tsx';
import VaultListCell from './VaultListCell.tsx';
import { t } from '../lib/i18n.ts';
import './VaultList.css';

export interface VaultListProps {
  /** Already filtered + sorted, in the exact order rows render. */
  items: VaultItem[];
  folders: Folder[];
  sortKey: SortKey;
  sortDir: SortDir;
  onSort: (k: SortKey) => void;
  /** Set sort key + direction explicitly (the header menu's asc/desc items). */
  onSetSort: (k: SortKey, d: SortDir) => void;
  selectedId: string | null;
  selectedCount: number;
  isSelected: (id: string) => boolean;
  /** The keyboard-cursor row (focus ring + arrow-key anchor). */
  cursorId: string | null;
  onRowClick: (item: VaultItem, e: MouseEvent) => void;
  onRowContextMenu: (item: VaultItem, e: MouseEvent) => void;
  onCheckboxToggle: (item: VaultItem, checked: boolean) => void;
  /** Copy the value of one cell (the screen resolves what each column copies). */
  onCopyCell: (item: VaultItem, col: ColumnSpec) => void;
  /** Open the item's website (the Website column is click-to-open, not copy). */
  onOpenWebsite: (item: VaultItem) => void;
  /** File-explorer keyboard nav while the list is focused (↑/↓, shift, ctrl+a, …). */
  onListKeyDown: (e: KeyboardEvent) => void;
  /** Replace the selection with `ids` (in displayed order) from a marquee drag. */
  onMarqueeSelect: (ids: string[]) => void;
  /** Whether rows can be dragged into folders (false in Trash). */
  enableItemDrag: boolean;
  /** Empty-area context menu: create a new item of `type`. */
  onCreateItem: (type: ItemType) => void;
  /** Empty-area context menu: select every visible row. */
  onSelectAll: () => void;
  emptyMessage: string;
  /** Bumped by the parent after a mutation/sync to drop stale cached detail. */
  cacheToken: number;
  /** Offline vault-health report, used by the optional "Security" column. Null
   *  until the first audit completes; at-risk items come from its `atRisk`. */
  security: VaultHealthReport | null;
  /** The screen-owned per-row detail cache (ONE cache: the ordering layer needs
   *  it for custom-field grouping, the cells for secret/custom columns). The
   *  screen resets it on `cacheToken` bumps. */
  detailCache: DetailCache;
}

export default function VaultList(props: VaultListProps) {
  // The shared lazy detail cache (screen-owned) + the list-scoped TOTP cache.
  const detail = props.detailCache;
  const totp = createTotpCache((id) => props.items.find((it) => it.id === id)?.accountEmail);

  // Drop the TOTP cache when the parent signals the vault changed (the screen
  // resets the shared detail cache itself — one owner, one resetter).
  createEffect(
    on(
      () => props.cacheToken,
      () => totp.reset(),
      { defer: true },
    ),
  );

  const totpColKey = createMemo(() => {
    const col = columns().columns.find((c) => c.kind === 'builtin' && c.id === 'totp');
    return col ? columnKey(col) : null;
  });
  const totpRevealed = () => {
    // The compact list layout draws no column cells, so no TOTP is shown/needed.
    if (columns().displayMode === 'list') return false;
    const k = totpColKey();
    return k !== null && isRevealed(k);
  };

  // Whether any visible column needs decrypted detail (a custom field, or a
  // revealed secret). Website + favicon come from the list's `uri` now, so they
  // no longer force a per-row detail fetch. The compact list layout renders no
  // column cells, so it never needs (or decrypts) any per-row detail.
  const detailNeeded = createMemo(() => {
    if (columns().displayMode === 'list') return false;
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

  // The grid template, derived from the visible columns and any user drag-widths.
  // Every configurable track is shrinkable, so the grid fits the list pane width
  // (columns compress) rather than overflowing it.
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

  // ---- item drag → folder (native HTML5 DnD; folder rail is the drop target) ----
  // Drag the whole multi-selection when the pressed row is part of it, else just
  // that row. Publishes the set (with accounts) so the rail can validate per
  // account; payload also rides on dataTransfer for completeness.
  function onItemDragStart(item: VaultItem, e: DragEvent) {
    const inSelection = props.selectedCount > 0 && props.isSelected(item.id);
    const dragged = inSelection ? props.items.filter((it) => props.isSelected(it.id)) : [item];
    setDraggedItems(dragged.map((it) => ({ id: it.id, accountEmail: it.accountEmail })));
    if (e.dataTransfer) {
      e.dataTransfer.effectAllowed = 'move';
      e.dataTransfer.setData(ITEM_DRAG_MIME, dragged.map((it) => it.id).join(','));
      e.dataTransfer.setData('text/plain', dragged.map((it) => it.name).join('\n'));
    }
  }

  // ---- marquee ("bungee") box selection over empty list space ----
  let tableRef: HTMLDivElement | undefined;
  const [marquee, setMarquee] = createSignal<{ x0: number; y0: number; x1: number; y1: number } | null>(
    null,
  );
  let pointer: number | null = null;
  let baseIds: Set<string> = new Set();

  function recompute(x1: number, y1: number, m: { x0: number; y0: number }) {
    const box = rectFromPoints(m.x0, m.y0, x1, y1);
    const hit = new Set<string>(baseIds);
    tableRef?.querySelectorAll<HTMLElement>('.vault-row').forEach((row) => {
      const id = row.dataset.itemId;
      if (!id) return;
      const r = row.getBoundingClientRect();
      if (rectsIntersect(box, { left: r.left, top: r.top, right: r.right, bottom: r.bottom })) {
        hit.add(id);
      }
    });
    // Preserve displayed (sorted) order.
    props.onMarqueeSelect(props.items.filter((it) => hit.has(it.id)).map((it) => it.id));
  }

  function onTablePointerDown(e: PointerEvent) {
    const el = tableRef;
    if (!el || e.button !== 0) return;
    const target = e.target as HTMLElement;
    // Solid routes DELEGATED events (pointerdown) up the COMPONENT tree, so a
    // pointerdown inside a <Portal>ed popover (the add-column menu) lands here even
    // though its DOM lives at <body>, outside the table. Ignore anything not
    // physically in the table — otherwise a marquee starts and the pointer-capture
    // below swallows the popover's chip/Reset clicks (they'd never fire).
    if (!el.contains(target)) return;
    // Rows handle their own click/drag (and focus the list); the sticky header
    // owns sort/filter/resize — don't steal focus from a filter input there.
    if (target.closest('.vault-row') || target.closest('.vault-thead')) return;
    // Ignore the scrollbar gutter (clientWidth/Height exclude the scrollbars).
    if (e.offsetX >= el.clientWidth || e.offsetY >= el.clientHeight) return;
    el.focus();
    // Ctrl/Shift keeps the current selection as a base to add to.
    baseIds =
      e.ctrlKey || e.metaKey || e.shiftKey
        ? new Set(props.items.filter((it) => props.isSelected(it.id)).map((it) => it.id))
        : new Set();
    pointer = e.pointerId;
    el.setPointerCapture(e.pointerId);
    setMarquee({ x0: e.clientX, y0: e.clientY, x1: e.clientX, y1: e.clientY });
  }

  function onTablePointerMove(e: PointerEvent) {
    const m = marquee();
    if (pointer !== e.pointerId || !m) return;
    setMarquee({ ...m, x1: e.clientX, y1: e.clientY });
    recompute(e.clientX, e.clientY, m);
  }

  function onTablePointerUp(e: PointerEvent) {
    const m = marquee();
    if (pointer !== e.pointerId) return;
    // A plain click on empty space (no drag, no base) clears the selection.
    if (m && baseIds.size === 0 && Math.abs(e.clientX - m.x0) < 3 && Math.abs(e.clientY - m.y0) < 3) {
      props.onMarqueeSelect([]);
    }
    try {
      tableRef?.releasePointerCapture(e.pointerId);
    } catch {
      // ignore: capture may already be released
    }
    pointer = null;
    baseIds = new Set();
    setMarquee(null);
  }

  // ---- empty-area context menu (New item / Select all) ----
  const [emptyMenu, setEmptyMenu] = createSignal<{ x: number; y: number } | null>(null);
  function onTableContextMenu(e: MouseEvent) {
    const target = e.target as HTMLElement;
    // Same Portal caveat as onTablePointerDown: a right-click inside the portaled
    // add-column menu bubbles here via the component tree — ignore anything not
    // physically in the table so it doesn't open the empty-area menu.
    if (tableRef && !tableRef.contains(target)) return;
    // Rows + the sticky header have their own menus / actions; only blank space.
    if (target.closest('.vault-row') || target.closest('.vault-thead')) return;
    e.preventDefault();
    setEmptyMenu({ x: e.clientX, y: e.clientY });
  }

  // Marquee rectangle in table-content coordinates (anchored to scrolled content).
  const marqueeBox = createMemo(() => {
    const m = marquee();
    if (!m || !tableRef) return null;
    const r = tableRef.getBoundingClientRect();
    const left = Math.min(m.x0, m.x1) - r.left + tableRef.scrollLeft;
    const top = Math.min(m.y0, m.y1) - r.top + tableRef.scrollTop;
    return { left, top, width: Math.abs(m.x1 - m.x0), height: Math.abs(m.y1 - m.y0) };
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

  // ---- optional row grouping (header rows between groups) ----
  // The parent already orders `items` by group (useVaultFiltering), so a header
  // is emitted whenever a row's group differs from the row above it. The same
  // pure `groupOf` decides ordering there and labels here, so they never diverge.
  const groupCtx = (): GroupContext => ({
    folderName,
    audit: (id) => securityById().get(id),
    hasSecurityReport: props.security !== null,
    // Same shared helper + cache as the ordering layer, so headers and order
    // can never disagree on a custom-field bucket.
    fieldValue: (id, field) => customFieldGroupValue(detail.cache(), id, field),
  });
  const startsGroup = (item: VaultItem, i: Accessor<number>): boolean => {
    const gb = columns().groupBy;
    if (!gb) return false;
    const idx = i();
    if (idx <= 0) return true;
    const prev = props.items[idx - 1];
    if (!prev) return true;
    const ctx = groupCtx();
    return groupOf(prev, gb, ctx).id !== groupOf(item, gb, ctx).id;
  };
  const groupLabel = (item: VaultItem): string => {
    const gb = columns().groupBy;
    return gb ? groupOf(item, gb, groupCtx()).label : '';
  };

  // Whether a column's cell carries a copyable value for this row. Value columns
  // get a hover copy button; the icon/category columns (type/security/passkey)
  // and empty values don't. The screen (onCopyCell) resolves what each one copies.
  // Website is excluded — it's click-to-open (see `canOpen`), not copy.
  const canCopy = (item: VaultItem, col: ColumnSpec): boolean => {
    if (col.kind === 'custom') return true;
    switch (col.id) {
      case 'username':
        return !!item.username;
      case 'folder':
        return !!folderName(item.folderId);
      case 'password':
        return item.itemType === 'login';
      case 'totp':
        return item.hasTotp;
      default:
        return false;
    }
  };

  // The Website column opens the site on click (instead of copying), when the row
  // has a URI to open.
  const canOpen = (item: VaultItem, col: ColumnSpec): boolean =>
    col.kind === 'builtin' && col.id === 'website' && !!item.uri;

  return (
    <Show
      when={props.items.length > 0}
      fallback={<div class="vault-empty muted">{props.emptyMessage}</div>}
    >
      <div
        ref={tableRef}
        class="vault-table"
        classList={{ 'list-mode': columns().displayMode === 'list' }}
        tabindex={0}
        style={{ '--vault-cols': metrics().template }}
        onKeyDown={(e) => props.onListKeyDown(e)}
        onPointerDown={onTablePointerDown}
        onPointerMove={onTablePointerMove}
        onPointerUp={onTablePointerUp}
        onContextMenu={onTableContextMenu}
      >
        {/* Header + filter row are sticky as one block, pinned vertically while the
            rows scroll under them — same scroller + the shared --vault-cols
            template keeps every track aligned. Hidden in the compact list layout,
            which has no columns to sort/filter. */}
        <Show when={columns().displayMode === 'table'}>
          <div class="vault-thead">
            <VaultListHeader
              sortKey={props.sortKey}
              sortDir={props.sortDir}
              onSort={props.onSort}
              onSetSort={props.onSetSort}
            />
            <FilterRow />
          </div>
        </Show>

        <div class="vault-rows">
          <For each={props.items}>
            {(item, i) => {
              const Icon = typeIcon(item.itemType);
              const typeFallback = (
                <Icon size={16} strokeWidth={1.6} class="vault-row-icon" />
              );
              return (
                <>
                  <Show when={startsGroup(item, i)}>
                    <div class="vault-group-head">{groupLabel(item)}</div>
                  </Show>
                  <div
                    class="vault-row"
                    data-item-id={item.id}
                    classList={{
                      active: props.selectedId === item.id && props.selectedCount === 0,
                      'multi-selected': props.isSelected(item.id),
                      cursor: props.cursorId === item.id,
                    }}
                    draggable={props.enableItemDrag}
                    onClick={(e) => {
                      tableRef?.focus();
                      props.onRowClick(item, e);
                    }}
                    onContextMenu={(e) => props.onRowContextMenu(item, e)}
                    onDragStart={(e) => props.enableItemDrag && onItemDragStart(item, e)}
                    onDragEnd={() => clearDraggedItems()}
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
                    <Show
                      when={columns().displayMode === 'table'}
                      fallback={
                        <Show when={item.username || item.uri}>
                          <span class="vault-row-secondary truncate">{item.username || item.uri}</span>
                        </Show>
                      }
                    >
                      <For each={columns().columns}>
                        {(col) => (
                          <VaultListCell
                            content={cellContent(item, col, cellCtx())}
                            onCopy={canCopy(item, col) ? () => props.onCopyCell(item, col) : undefined}
                            onOpen={canOpen(item, col) ? () => props.onOpenWebsite(item) : undefined}
                          />
                        )}
                      </For>
                    </Show>
                    <span class="vault-row-end">
                      <Show when={item.favorite}>
                        <Star size={13} strokeWidth={1.75} class="vault-row-fav" />
                      </Show>
                    </span>
                  </div>
                </>
              );
            }}
          </For>
        </div>

        <Show when={marqueeBox()}>
          {(box) => (
            <div
              class="vault-marquee"
              style={{
                left: `${box().left}px`,
                top: `${box().top}px`,
                width: `${box().width}px`,
                height: `${box().height}px`,
              }}
            />
          )}
        </Show>
      </div>

      <Show when={emptyMenu()}>
        {(m) => {
          const close = () => setEmptyMenu(null);
          return (
            <ContextMenu x={m().x} y={m().y} onClose={close}>
              <For each={CREATE_TYPES}>
                {(ct) => {
                  const Icon = typeIcon(ct.type);
                  return (
                    <CtxItem
                      onClick={() => {
                        props.onCreateItem(ct.type);
                        close();
                      }}
                    >
                      <Icon size={14} /> {t('vault.newItemType', { type: ct.label.toLowerCase() })}
                    </CtxItem>
                  );
                }}
              </For>
              <CtxSep />
              <CtxItem
                onClick={() => {
                  props.onSelectAll();
                  close();
                }}
              >
                <CheckCheck size={14} /> {t('vault.selectAll')}
              </CtxItem>
            </ContextMenu>
          );
        }}
      </Show>
    </Show>
  );
}
