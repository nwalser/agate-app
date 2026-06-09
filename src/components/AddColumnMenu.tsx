// Small inline "add column" popover, opened from the + button at the header's
// trailing edge. Lists the hidden built-in columns as one-click chips and takes a
// custom-field name; a reset drops everything back to the default column set. This
// is the only column affordance that isn't a per-column header menu — every
// show/hide/reorder/sort op lives on the column headers themselves now. Portaled to
// <body> and positioned against the trigger's rect (same pattern the old column
// menu used) so it escapes the table's scroll-clip.

import { createSignal, For, Show } from 'solid-js';
import { Portal } from 'solid-js/web';
import { Plus, RotateCcw } from 'lucide-solid';
import {
  addCustomColumn,
  ALL_BUILTINS,
  builtinMeta,
  isColumnVisible,
  resetColumns,
  toggleColumn,
} from '../state/columns.ts';

export default function AddColumnMenu(props: { anchor?: HTMLElement; onClose: () => void }) {
  const [custom, setCustom] = createSignal('');
  const rect = props.anchor?.getBoundingClientRect();
  const pos = rect
    ? { top: `${rect.bottom + 6}px`, right: `${Math.max(8, window.innerWidth - rect.right)}px` }
    : { top: '56px', right: '12px' };

  const hidden = () => ALL_BUILTINS.filter((id) => !isColumnVisible({ kind: 'builtin', id }));

  function addCustom() {
    const f = custom().trim();
    if (!f) return;
    addCustomColumn(f);
    setCustom('');
    props.onClose();
  }

  return (
    <Portal>
      <div class="vault-menu-backdrop" onClick={() => props.onClose()} />
      <div class="column-add-menu" role="menu" style={pos}>
        <div class="column-add-label">Add column</div>
        <Show
          when={hidden().length > 0}
          fallback={<div class="muted column-add-empty">All built-in columns shown.</div>}
        >
          <div class="column-add-chips">
            <For each={hidden()}>
              {(id) => (
                <button class="column-add-chip" onClick={() => toggleColumn({ kind: 'builtin', id })}>
                  <Plus size={12} /> {builtinMeta(id).label}
                </button>
              )}
            </For>
          </div>
        </Show>

        <form
          class="column-add-custom"
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
          <button type="submit" class="ghost icon-btn" title="Add custom column">
            <Plus size={14} />
          </button>
        </form>

        <div class="column-add-sep" />
        <button
          class="column-add-reset"
          onClick={() => {
            resetColumns();
            props.onClose();
          }}
        >
          <RotateCcw size={13} /> Reset columns
        </button>
      </div>
    </Portal>
  );
}
