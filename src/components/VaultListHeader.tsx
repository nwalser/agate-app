// Sticky header row for the vault list. Every column header carries its own
// controls — click the label to sort, hover the caret (or right-click anywhere on
// the header) for the per-column menu: sort, reveal/hide secret values, filter,
// group, move left/right, reset width, hide. The trailing cell holds the filter-row
// toggle and the inline "add column" popover. There is no separate "display
// options" gear anymore: per-column ops live on the columns, and the app-wide list
// prefs (layout, density, favicons) live in Settings › Appearance. Reuses VaultList.css.

import { createSignal, For, Show } from 'solid-js';
import {
  ArrowDown,
  ArrowLeft,
  ArrowRight,
  ArrowUp,
  ChevronDown,
  ChevronUp,
  Eye,
  EyeOff,
  Filter,
  Group,
  Plus,
  RotateCcw,
  Ungroup,
} from 'lucide-solid';
import {
  builtinMeta,
  columnKey,
  columnLabel,
  columns,
  groupSpecKey,
  groupSpecOf,
  isFilterable,
  isRevealed,
  MIN_COL_WIDTH,
  moveColumn,
  NAME_COL_KEY,
  removeColumn,
  resetColumnWidth,
  setColumnWidth,
  setGroupBy,
  sortKeyOf,
  toggleReveal,
  type ColumnSpec,
  type GroupSpec,
  type SortDir,
  type SortKey,
} from '../state/columns.ts';
import {
  filtersVisible,
  hasActiveFilters,
  NAME_FILTER_KEY,
  showColumnFilters,
  toggleFiltersVisible,
} from '../state/columnFilters.ts';
import { ContextMenu, CtxItem, CtxSep } from './ContextMenu.tsx';
import { headerMenuItems, type HeaderMenuItemId, type HeaderTarget } from '../lib/headerMenu.ts';
import AddColumnMenu from './AddColumnMenu.tsx';

// A clicked header's identity: the column spec (null = the always-on Name column)
// and its position among the data columns, plus the cursor anchor for the menu.
interface MenuState {
  col: ColumnSpec | null;
  index: number;
  x: number;
  y: number;
}

export default function VaultListHeader(props: {
  sortKey: SortKey;
  sortDir: SortDir;
  onSort: (k: SortKey) => void;
  onSetSort: (k: SortKey, d: SortDir) => void;
}) {
  const [menu, setMenu] = createSignal<MenuState | null>(null);
  const [addOpen, setAddOpen] = createSignal(false);
  let addBtn: HTMLButtonElement | undefined;

  // ---- per-column helpers (null col = the Name column) ----
  const isNameCol = (col: ColumnSpec | null) => col === null;
  const sortKeyFor = (col: ColumnSpec | null): SortKey | null =>
    isNameCol(col) ? 'name' : sortKeyOf(col as ColumnSpec);
  const filterKeyFor = (col: ColumnSpec | null): string =>
    isNameCol(col) ? NAME_FILTER_KEY : columnKey(col as ColumnSpec);
  const widthKeyFor = (col: ColumnSpec | null): string =>
    isNameCol(col) ? NAME_COL_KEY : columnKey(col as ColumnSpec);
  const isSecret = (col: ColumnSpec | null): boolean => {
    if (col === null) return false;
    return col.kind === 'custom' || builtinMeta(col.id).secret;
  };

  // Every column maps to a group spec (the Name column groups by initial).
  const groupSpecFor = (col: ColumnSpec | null): GroupSpec =>
    isNameCol(col) ? { kind: 'builtin', key: 'name' } : groupSpecOf(col as ColumnSpec);

  function buildTarget(col: ColumnSpec | null, index: number): HeaderTarget {
    const sk = sortKeyFor(col);
    const gs = groupSpecFor(col);
    const secret = isSecret(col);
    const wKey = widthKeyFor(col);
    return {
      isName: isNameCol(col),
      index: isNameCol(col) ? -1 : index,
      count: columns().columns.length,
      sortable: sk !== null,
      sorted: sk !== null && props.sortKey === sk,
      sortDir: props.sortDir,
      secret,
      revealed: secret && isRevealed(wKey),
      filterable: isNameCol(col) ? true : isFilterable(col as ColumnSpec),
      groupable: true,
      grouped: groupSpecKey(columns().groupBy) === groupSpecKey(gs),
      hasWidth: wKey in columns().widths,
    };
  }

  function focusFilter(key: string) {
    requestAnimationFrame(() => {
      const el = document.querySelector<HTMLInputElement>(`[data-filter-key="${key}"]`);
      el?.focus();
      el?.select();
    });
  }

  function runItem(id: HeaderMenuItemId, col: ColumnSpec | null, index: number) {
    const sk = sortKeyFor(col);
    const gk = groupSpecFor(col);
    switch (id) {
      case 'sort-asc':
        if (sk) props.onSetSort(sk, 'asc');
        break;
      case 'sort-desc':
        if (sk) props.onSetSort(sk, 'desc');
        break;
      case 'reveal':
      case 'hide-values':
        toggleReveal(widthKeyFor(col));
        break;
      case 'filter':
        showColumnFilters(true);
        focusFilter(filterKeyFor(col));
        break;
      case 'group':
        if (gk) setGroupBy(gk);
        break;
      case 'ungroup':
        setGroupBy(null);
        break;
      case 'move-left':
        moveColumn(index, -1);
        break;
      case 'move-right':
        moveColumn(index, 1);
        break;
      case 'reset-width':
        resetColumnWidth(widthKeyFor(col));
        break;
      case 'hide':
        if (col) removeColumn(col);
        break;
    }
    setMenu(null);
  }

  // Open the menu from a right-click (cursor anchor) or the caret button (its rect).
  function openAt(x: number, y: number, col: ColumnSpec | null, index: number) {
    setMenu({ col, index, x, y });
  }
  function onCellContext(e: MouseEvent, col: ColumnSpec | null, index: number) {
    e.preventDefault();
    e.stopPropagation();
    openAt(e.clientX, e.clientY, col, index);
  }
  function onCaret(e: MouseEvent, col: ColumnSpec | null, index: number) {
    e.preventDefault();
    e.stopPropagation();
    const r = (e.currentTarget as HTMLElement).getBoundingClientRect();
    openAt(r.left, r.bottom + 4, col, index);
  }

  return (
    <div class="vault-head">
      <span class="vault-head-cell" />
      <HeaderCell col={null} index={-1} />
      <For each={columns().columns}>{(col, i) => <HeaderCell col={col} index={i()} />}</For>

      <div class="vault-head-cell vault-head-gear">
        <button
          class="ghost icon-btn vault-gear-btn"
          classList={{ 'filter-on': filtersVisible() || hasActiveFilters() }}
          title="Toggle column filters"
          onClick={() => toggleFiltersVisible()}
        >
          <Filter size={14} strokeWidth={1.75} />
        </button>
        <div class="column-add-anchor">
          <button
            ref={addBtn}
            class="ghost icon-btn vault-gear-btn"
            title="Add column"
            onClick={() => setAddOpen((v) => !v)}
          >
            <Plus size={15} strokeWidth={1.9} />
          </button>
          <Show when={addOpen()}>
            <AddColumnMenu anchor={addBtn} onClose={() => setAddOpen(false)} />
          </Show>
        </div>
      </div>

      <Show when={menu()}>
        {(m) => (
          <ContextMenu x={m().x} y={m().y} onClose={() => setMenu(null)}>
            <For each={headerMenuItems(buildTarget(m().col, m().index))}>
              {(it) => (
                <>
                  <Show when={it.section}>
                    <CtxSep />
                  </Show>
                  <CtxItem
                    disabled={it.disabled}
                    danger={it.danger}
                    onClick={() => runItem(it.id, m().col, m().index)}
                  >
                    <ItemIcon id={it.id} /> {it.label}
                  </CtxItem>
                </>
              )}
            </For>
          </ContextMenu>
        )}
      </Show>
    </div>
  );

  // A single header cell: sortable label button + hover caret + resize handle, with
  // a right-click menu. The Name column (col === null) renders the same way minus
  // the move/hide items (handled by the menu model).
  function HeaderCell(cp: { col: ColumnSpec | null; index: number }) {
    const label = () => (isNameCol(cp.col) ? 'Name' : columnLabel(cp.col as ColumnSpec));
    const sk = () => sortKeyFor(cp.col);
    const sorted = () => sk() !== null && props.sortKey === sk();
    const isSecurity = () => {
      const c = cp.col;
      return c !== null && c.kind === 'builtin' && c.id === 'security';
    };
    // Columns whose cells are right-aligned (totp code + security badge); the
    // header label/chevron follow so they sit over the right-aligned content.
    const isTotp = () => {
      const c = cp.col;
      return c !== null && c.kind === 'builtin' && c.id === 'totp';
    };
    return (
      <div
        class="vault-head-cell vault-head-resizable"
        classList={{ sortable: sk() !== null, sorted: sorted(), 'align-end': isSecurity() || isTotp() }}
        onContextMenu={(e) => onCellContext(e, cp.col, cp.index)}
      >
        <button
          class="vault-head-labelbtn"
          title={isSecurity() ? 'Sort by security status' : `Sort by ${label()}`}
          disabled={sk() === null}
          onClick={() => {
            const k = sk();
            if (k) props.onSort(k);
          }}
        >
          <Show when={!isSecurity()}>
            <span class="vault-head-label">{label()}</span>
          </Show>
          <Show when={sorted()}>
            <Show when={props.sortDir === 'asc'} fallback={<ChevronDown size={12} class="vault-head-sort" />}>
              <ChevronUp size={12} class="vault-head-sort" />
            </Show>
          </Show>
        </button>
        <button
          class="vault-head-caret"
          title="Column options"
          aria-haspopup="menu"
          onClick={(e) => onCaret(e, cp.col, cp.index)}
        >
          <ChevronDown size={12} strokeWidth={2} />
        </button>
        <ColResize colKey={widthKeyFor(cp.col)} />
      </div>
    );
  }
}

// Leading icon for each header-menu item.
function ItemIcon(props: { id: HeaderMenuItemId }) {
  switch (props.id) {
    case 'sort-asc':
      return <ArrowUp size={14} />;
    case 'sort-desc':
      return <ArrowDown size={14} />;
    case 'reveal':
      return <Eye size={14} />;
    case 'hide-values':
      return <EyeOff size={14} />;
    case 'filter':
      return <Filter size={14} />;
    case 'group':
      return <Group size={14} />;
    case 'ungroup':
      return <Ungroup size={14} />;
    case 'move-left':
      return <ArrowLeft size={14} />;
    case 'move-right':
      return <ArrowRight size={14} />;
    case 'reset-width':
      return <RotateCcw size={14} />;
    case 'hide':
      return <EyeOff size={14} />;
  }
}

// A thin drag handle on a header cell's right edge: drag to resize the column,
// double-click to reset it to its default width. Captures the pointer so the drag
// tracks smoothly and never triggers the header's sort click.
function ColResize(props: { colKey: string }) {
  let startX = 0;
  let startW = 0;

  function onMove(e: PointerEvent) {
    setColumnWidth(props.colKey, startW + (e.clientX - startX));
  }
  function onUp(e: PointerEvent) {
    const h = e.currentTarget as HTMLElement;
    h.releasePointerCapture(e.pointerId);
    h.removeEventListener('pointermove', onMove);
    h.removeEventListener('pointerup', onUp);
  }
  function onDown(e: PointerEvent) {
    e.preventDefault();
    e.stopPropagation();
    const h = e.currentTarget as HTMLElement;
    const cell = h.parentElement as HTMLElement;
    startX = e.clientX;
    startW = Math.max(MIN_COL_WIDTH, cell.getBoundingClientRect().width);
    h.setPointerCapture(e.pointerId);
    h.addEventListener('pointermove', onMove);
    h.addEventListener('pointerup', onUp);
  }

  return (
    <span
      class="vault-col-resize"
      onPointerDown={onDown}
      onClick={(e) => e.stopPropagation()}
      onDblClick={(e) => {
        e.stopPropagation();
        resetColumnWidth(props.colKey);
      }}
    />
  );
}
