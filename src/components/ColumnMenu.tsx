// "Display options" popover for the vault list: row density, website favicons,
// and full column control — show/hide, reorder (drag or arrows), reveal/hide
// secret content (password/TOTP/hidden custom), add custom-field columns, and a
// reset-to-default. Reads/writes the columns store (per-list) + ui store (density,
// a global viewing pref). Reveal is intentionally separate from visibility: a
// secret column can be shown while still masked.

import { createSignal, For, Show } from 'solid-js';
import { Portal } from 'solid-js/web';
import { ArrowDown, ArrowUp, Eye, EyeOff, GripVertical, Plus, RotateCcw } from 'lucide-solid';
import {
  addCustomColumn,
  ALL_BUILTINS,
  builtinMeta,
  columnKey,
  columnLabel,
  columns,
  GROUP_KEYS,
  GROUP_LABELS,
  isColumnVisible,
  isRevealed,
  moveColumn,
  removeColumn,
  reorderColumn,
  resetColumns,
  setFavicons,
  setGroupBy,
  toggleColumn,
  toggleReveal,
  type ColumnSpec,
} from '../state/columns.ts';
import { rowDensity, setRowDensity, type RowDensity } from '../state/ui.ts';
import './ColumnMenu.css';

function hasRevealToggle(c: ColumnSpec): boolean {
  return c.kind === 'custom' || builtinMeta(c.id).secret;
}

const DENSITIES: { key: RowDensity; label: string }[] = [
  { key: 'compact', label: 'Compact' },
  { key: 'default', label: 'Default' },
  { key: 'comfortable', label: 'Comfy' },
];

export default function ColumnMenu(props: { onClose: () => void; anchor?: HTMLElement }) {
  const [custom, setCustom] = createSignal('');
  // Fixed position anchored to the gear button's rect (computed once on open —
  // the menu closes on outside click, so it needn't track scroll/resize). Opens
  // below the trigger, right-aligned to it; clamped into the viewport.
  const rect = props.anchor?.getBoundingClientRect();
  const pos = rect
    ? { top: `${rect.bottom + 6}px`, right: `${Math.max(8, window.innerWidth - rect.right)}px` }
    : { top: '56px', right: '12px' };
  // Drag-reorder state: the row being dragged and the row it's hovering over.
  const [dragIdx, setDragIdx] = createSignal<number | null>(null);
  const [overIdx, setOverIdx] = createSignal<number | null>(null);

  const hiddenBuiltins = () =>
    ALL_BUILTINS.filter((id) => !isColumnVisible({ kind: 'builtin', id }));

  function addCustom() {
    addCustomColumn(custom());
    setCustom('');
  }

  function drop(target: number) {
    const from = dragIdx();
    if (from !== null && from !== target) reorderColumn(from, target);
    setDragIdx(null);
    setOverIdx(null);
  }

  return (
    <Portal>
      <div class="vault-menu-backdrop" onClick={() => props.onClose()} />
      <div class="column-menu" role="menu" style={pos}>
        <div class="column-menu-label">Row density</div>
        <div class="column-menu-seg" role="group" aria-label="Row density">
          <For each={DENSITIES}>
            {(d) => (
              <button
                class="column-menu-seg-btn"
                classList={{ active: rowDensity() === d.key }}
                aria-pressed={rowDensity() === d.key}
                onClick={() => setRowDensity(d.key)}
              >
                {d.label}
              </button>
            )}
          </For>
        </div>

        <div class="column-menu-sep" />
        <label class="column-menu-check">
          <input
            type="checkbox"
            checked={columns().favicons}
            onChange={(e) => setFavicons(e.currentTarget.checked)}
          />
          Website favicons
        </label>

        <div class="column-menu-sep" />
        <div class="column-menu-label">Group by</div>
        <div class="column-menu-seg" role="group" aria-label="Group rows by">
          <button
            class="column-menu-seg-btn"
            classList={{ active: columns().groupBy === null }}
            aria-pressed={columns().groupBy === null}
            onClick={() => setGroupBy(null)}
          >
            None
          </button>
          <For each={GROUP_KEYS}>
            {(k) => (
              <button
                class="column-menu-seg-btn"
                classList={{ active: columns().groupBy === k }}
                aria-pressed={columns().groupBy === k}
                onClick={() => setGroupBy(k)}
              >
                {GROUP_LABELS[k]}
              </button>
            )}
          </For>
        </div>

        <div class="column-menu-sep" />
        <div class="column-menu-label">Shown columns</div>
        <div class="column-menu-row column-menu-fixed">
          <span class="column-menu-grip" aria-hidden="true">
            <GripVertical size={13} />
          </span>
          <span class="column-menu-name">Name</span>
          <span class="muted column-menu-hint">always</span>
        </div>
        <For each={columns().columns}>
          {(col, i) => (
            <div
              class="column-menu-row"
              classList={{ dragging: dragIdx() === i(), dropover: overIdx() === i() && dragIdx() !== i() }}
              draggable={true}
              onDragStart={(e) => {
                setDragIdx(i());
                e.dataTransfer?.setData('text/plain', String(i()));
                if (e.dataTransfer) e.dataTransfer.effectAllowed = 'move';
              }}
              onDragOver={(e) => {
                e.preventDefault();
                setOverIdx(i());
                if (e.dataTransfer) e.dataTransfer.dropEffect = 'move';
              }}
              onDrop={(e) => {
                e.preventDefault();
                drop(i());
              }}
              onDragEnd={() => {
                setDragIdx(null);
                setOverIdx(null);
              }}
            >
              <span class="column-menu-grip" title="Drag to reorder" aria-hidden="true">
                <GripVertical size={13} />
              </span>
              <span class="column-menu-name">{columnLabel(col)}</span>
              <Show when={hasRevealToggle(col)}>
                <button
                  class="ghost icon-btn column-menu-btn"
                  title={isRevealed(columnKey(col)) ? 'Hide values' : 'Reveal values'}
                  onClick={() => toggleReveal(columnKey(col))}
                >
                  <Show when={isRevealed(columnKey(col))} fallback={<EyeOff size={13} />}>
                    <Eye size={13} />
                  </Show>
                </button>
              </Show>
              <button
                class="ghost icon-btn column-menu-btn"
                title="Move up"
                disabled={i() === 0}
                onClick={() => moveColumn(i(), -1)}
              >
                <ArrowUp size={13} />
              </button>
              <button
                class="ghost icon-btn column-menu-btn"
                title="Move down"
                disabled={i() === columns().columns.length - 1}
                onClick={() => moveColumn(i(), 1)}
              >
                <ArrowDown size={13} />
              </button>
              <button
                class="ghost icon-btn column-menu-btn"
                title="Hide column"
                onClick={() => removeColumn(col)}
              >
                <EyeOff size={13} />
              </button>
            </div>
          )}
        </For>

        <Show when={hiddenBuiltins().length > 0}>
          <div class="column-menu-sep" />
          <div class="column-menu-label">Add column</div>
          <div class="column-menu-add">
            <For each={hiddenBuiltins()}>
              {(id) => (
                <button class="column-menu-chip" onClick={() => toggleColumn({ kind: 'builtin', id })}>
                  <Plus size={12} /> {builtinMeta(id).label}
                </button>
              )}
            </For>
          </div>
        </Show>
        <form
          class="column-menu-customadd"
          onSubmit={(e) => {
            e.preventDefault();
            addCustom();
          }}
        >
          <input
            placeholder="Custom field name…"
            value={custom()}
            onInput={(e) => setCustom(e.currentTarget.value)}
          />
          <button type="submit" class="ghost icon-btn column-menu-btn" title="Add custom column">
            <Plus size={14} />
          </button>
        </form>

        <div class="column-menu-sep" />
        <button class="column-menu-reset" onClick={() => { resetColumns(); setRowDensity('default'); }}>
          <RotateCcw size={13} /> Reset to default
        </button>
      </div>
    </Portal>
  );
}
