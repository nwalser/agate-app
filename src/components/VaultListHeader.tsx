// Sticky header row for the vault list: the always-on Name column, a sortable or
// plain header per visible column, drag-to-resize handles, and the trailing
// filter-toggle + "display options" (column menu) buttons. Sorting is driven by
// the parent (so it stays in sync with selection order); column width/visibility
// come straight from the columns store. Owns the column-menu popover trigger
// (portaled to <body> against the gear button's rect). Reuses VaultList.css.

import { createSignal, For, Show } from 'solid-js';
import { ChevronDown, ChevronUp, Filter, SlidersHorizontal } from 'lucide-solid';
import {
  columnKey,
  columnLabel,
  columns,
  MIN_COL_WIDTH,
  NAME_COL_KEY,
  resetColumnWidth,
  setColumnWidth,
  sortKeyOf,
  type SortDir,
  type SortKey,
} from '../state/columns.ts';
import { filtersVisible, hasActiveFilters, toggleFiltersVisible } from '../state/columnFilters.ts';
import ColumnMenu from './ColumnMenu.tsx';

export default function VaultListHeader(props: {
  sortKey: SortKey;
  sortDir: SortDir;
  onSort: (k: SortKey) => void;
}) {
  const [menuOpen, setMenuOpen] = createSignal(false);
  // Trigger element for the column ("display options") popover. The popover is
  // portaled to <body> and positioned against this rect, so it escapes the
  // table's overflow-scroll clip and the sticky header's stacking context.
  let gearBtn: HTMLButtonElement | undefined;

  return (
    <div class="vault-head">
      <span class="vault-head-cell" />
      <SortHeader
        label="Name"
        colKey={NAME_COL_KEY}
        active={props.sortKey === 'name'}
        dir={props.sortDir}
        onClick={() => props.onSort('name')}
      />
      <For each={columns().columns}>
        {(col) => {
          const sk = sortKeyOf(col);
          // The Security column is a right-aligned icon column with no title — its
          // header is the (empty) sort affordance + the chevron when it's active.
          const isSecurity = col.kind === 'builtin' && col.id === 'security';
          return sk ? (
            <SortHeader
              label={isSecurity ? '' : columnLabel(col)}
              title={isSecurity ? 'Sort by security status' : undefined}
              align={isSecurity ? 'end' : 'start'}
              colKey={columnKey(col)}
              active={props.sortKey === sk}
              dir={props.sortDir}
              onClick={() => props.onSort(sk)}
            />
          ) : (
            <span class="vault-head-cell vault-head-resizable">
              <span class="vault-head-label">{columnLabel(col)}</span>
              <ColResize colKey={columnKey(col)} />
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
            ref={gearBtn}
            class="ghost icon-btn vault-gear-btn"
            title="Customize columns"
            onClick={() => setMenuOpen((v) => !v)}
          >
            <SlidersHorizontal size={14} strokeWidth={1.75} />
          </button>
          <Show when={menuOpen()}>
            <ColumnMenu anchor={gearBtn} onClose={() => setMenuOpen(false)} />
          </Show>
        </div>
      </div>
    </div>
  );
}

function SortHeader(props: {
  label: string;
  colKey?: string;
  active: boolean;
  dir: SortDir;
  onClick: () => void;
  /** Header alignment within its track ('end' for the icon-only Security column). */
  align?: 'start' | 'end';
  /** Optional tooltip — useful when the header has no visible label. */
  title?: string;
}) {
  return (
    <button
      class="vault-head-cell sortable vault-head-resizable"
      classList={{ sorted: props.active, 'align-end': props.align === 'end' }}
      title={props.title}
      onClick={() => props.onClick()}
    >
      <Show when={props.label}>
        <span class="vault-head-label">{props.label}</span>
      </Show>
      <Show when={props.active}>
        <Show
          when={props.dir === 'asc'}
          fallback={<ChevronDown size={12} class="vault-head-sort" />}
        >
          <ChevronUp size={12} class="vault-head-sort" />
        </Show>
      </Show>
      <Show when={props.colKey}>{(k) => <ColResize colKey={k()} />}</Show>
    </button>
  );
}

// A thin drag handle on a header cell's right edge: drag to resize the column,
// double-click to reset it to its default width. Captures the pointer so the
// drag tracks smoothly and never triggers the header's sort click.
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
