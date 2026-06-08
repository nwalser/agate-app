// Dropdown to customize the vault-list columns: toggle favicons, show/hide and
// reorder columns, reveal/hide secret column content (password/TOTP/hidden
// custom fields), and add custom-field columns. Reads/writes the columns store.

import { createSignal, For, Show } from 'solid-js';
import { ArrowDown, ArrowUp, Eye, EyeOff, Plus, X } from 'lucide-solid';
import {
  addCustomColumn,
  ALL_BUILTINS,
  builtinMeta,
  columnKey,
  columnLabel,
  columns,
  isColumnVisible,
  isRevealed,
  moveColumn,
  removeColumn,
  setFavicons,
  toggleColumn,
  toggleReveal,
  type ColumnSpec,
} from '../state/columns.ts';
import './ColumnMenu.css';

function hasRevealToggle(c: ColumnSpec): boolean {
  return c.kind === 'custom' || builtinMeta(c.id).secret;
}

export default function ColumnMenu(props: { onClose: () => void }) {
  const [custom, setCustom] = createSignal('');
  const hiddenBuiltins = () =>
    ALL_BUILTINS.filter((id) => !isColumnVisible({ kind: 'builtin', id }));

  function addCustom() {
    addCustomColumn(custom());
    setCustom('');
  }

  return (
    <>
      <div class="vault-menu-backdrop" onClick={() => props.onClose()} />
      <div class="column-menu" role="menu">
        <label class="column-menu-check">
          <input
            type="checkbox"
            checked={columns().favicons}
            onChange={(e) => setFavicons(e.currentTarget.checked)}
          />
          Website favicons
        </label>

        <div class="column-menu-sep" />
        <div class="column-menu-label">Shown columns</div>
        <div class="column-menu-row column-menu-fixed">
          <span class="column-menu-name">Name</span>
          <span class="muted column-menu-hint">always</span>
        </div>
        <For each={columns().columns}>
          {(col, i) => (
            <div class="column-menu-row">
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
                <X size={13} />
              </button>
            </div>
          )}
        </For>

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
      </div>
    </>
  );
}
