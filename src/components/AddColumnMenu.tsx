// Inline "add column" popover, opened from the + button at the header's trailing
// edge. Three ways to add a column:
//   - one-click chips for the hidden built-in columns;
//   - a DISCOVERED custom-field picker — the vault is scanned (field names aren't
//     secret) so you pick an existing field instead of blind-typing it; the search
//     box also adds an exact name that hasn't been scanned yet;
//   - "Add custom column…", which opens the config popover (name + icon) via
//     `onNewCustom` (the header owns that popover so create + edit share one).
// A reset drops everything back to the default column set. Portaled to <body> and
// positioned against the trigger's rect so it escapes the table's scroll-clip.

import { createMemo, createSignal, For, onMount, Show } from 'solid-js';
import { Portal } from 'solid-js/web';
import { Plus, RotateCcw, Search, Settings2 } from 'lucide-solid';
import {
  addCustomColumn,
  ALL_BUILTINS,
  builtinMeta,
  isColumnVisible,
  resetColumns,
  toggleColumn,
} from '../state/columns.ts';
import { customFields, customFieldsLoading, refreshCustomFields } from '../state/customFields.ts';
import { t } from '../lib/i18n.ts';

export default function AddColumnMenu(props: {
  anchor?: HTMLElement;
  onClose: () => void;
  /** Open the full create popover (name + icon) at a point — owned by the header. */
  onNewCustom: (at: { x: number; y: number }) => void;
}) {
  const [query, setQuery] = createSignal('');
  const rect = props.anchor?.getBoundingClientRect();
  const pos = rect
    ? { top: `${rect.bottom + 6}px`, right: `${Math.max(8, window.innerWidth - rect.right)}px` }
    : { top: '56px', right: '12px' };

  // Scan for custom-field names when the menu opens (bounded; the store collapses
  // overlapping refreshes). Failures are surfaced by the store; the list stays put.
  onMount(() => void refreshCustomFields());

  const hidden = () => ALL_BUILTINS.filter((id) => !isColumnVisible({ kind: 'builtin', id }));

  // Discovered fields not already shown as a column, filtered by the search box.
  const discovered = createMemo(() => {
    const q = query().trim().toLowerCase();
    return customFields().filter(
      (f) => !isColumnVisible({ kind: 'custom', field: f }) && (!q || f.toLowerCase().includes(q)),
    );
  });

  // Offer "Add <typed>" only when the typed name isn't already a discovered match
  // or an existing column — the manual escape hatch for an un-scanned field.
  const typedNew = createMemo(() => {
    const f = query().trim();
    if (!f) return null;
    const lower = f.toLowerCase();
    if (isColumnVisible({ kind: 'custom', field: f })) return null;
    if (customFields().some((d) => d.toLowerCase() === lower)) return null;
    return f;
  });

  function quickAdd(field: string) {
    addCustomColumn(field);
    setQuery('');
  }

  function openCreate(e: MouseEvent) {
    const r = (e.currentTarget as HTMLElement).getBoundingClientRect();
    props.onClose();
    props.onNewCustom({ x: r.left, y: r.bottom + 4 });
  }

  return (
    <Portal>
      <div class="vault-menu-backdrop" onClick={() => props.onClose()} />
      <div class="column-add-menu" role="menu" style={pos}>
        <div class="column-add-label">{t('addColumn.title')}</div>
        <Show
          when={hidden().length > 0}
          fallback={<div class="muted column-add-empty">{t('addColumn.allShown')}</div>}
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

        <div class="column-add-sep" />
        <div class="column-add-label">{t('addColumn.customFields')}</div>
        <div class="column-add-search">
          <Search size={13} />
          <input
            placeholder={t('addColumn.searchPlaceholder')}
            value={query()}
            onInput={(e) => setQuery(e.currentTarget.value)}
          />
        </div>

        <div class="column-add-fields">
          <Show
            when={!customFieldsLoading() || customFields().length > 0}
            fallback={<div class="muted column-add-empty">{t('addColumn.scanning')}</div>}
          >
            <For
              each={discovered()}
              fallback={
                <Show when={!typedNew()}>
                  <div class="muted column-add-empty">
                    {query().trim() ? t('addColumn.noMatch') : t('addColumn.noFields')}
                  </div>
                </Show>
              }
            >
              {(field) => (
                <button class="column-add-field" title={field} onClick={() => quickAdd(field)}>
                  <Plus size={13} /> <span class="truncate">{field}</span>
                </button>
              )}
            </For>
            <Show when={typedNew()}>
              {(f) => (
                <button class="column-add-field" onClick={() => quickAdd(f())}>
                  <Plus size={13} /> {t('addColumn.addNamed', { name: f() })}
                </button>
              )}
            </Show>
          </Show>
        </div>

        <button class="column-add-newcustom" onClick={openCreate}>
          <Settings2 size={13} /> {t('addColumn.newCustom')}
        </button>

        <div class="column-add-sep" />
        <button
          class="column-add-reset"
          onClick={() => {
            resetColumns();
            props.onClose();
          }}
        >
          <RotateCcw size={13} /> {t('addColumn.reset')}
        </button>
      </div>
    </Portal>
  );
}
