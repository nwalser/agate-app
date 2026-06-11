// The vault list's per-column filter row, shown under the header when the filter
// toggle is on. One text input per filterable column (Name is always filterable),
// plus a trailing clear-all button when any filter is set. All filter state lives
// in state/columnFilters.ts (transient, not persisted). Self-gates on
// `filtersVisible()` so the parent can drop it in unconditionally. Reuses
// VaultList.css for the .vault-filter-* classes.

import { For, Show } from 'solid-js';
import { X } from 'lucide-solid';
import { columnKey, columns, isFilterable } from '../state/columns.ts';
import {
  clearColumnFilters,
  columnFilter,
  filtersVisible,
  hasActiveFilters,
  NAME_FILTER_KEY,
  setColumnFilter,
} from '../state/columnFilters.ts';
import { t } from '../lib/i18n.ts';

export default function FilterRow() {
  return (
    <Show when={filtersVisible()}>
      <div class="vault-filter-row">
        <span />
        <input
          class="vault-filter-input"
          data-filter-key={NAME_FILTER_KEY}
          placeholder={t('filter.namePlaceholder')}
          value={columnFilter(NAME_FILTER_KEY)}
          onInput={(e) => setColumnFilter(NAME_FILTER_KEY, e.currentTarget.value)}
        />
        <For each={columns().columns}>
          {(col) =>
            isFilterable(col) ? (
              <input
                class="vault-filter-input"
                data-filter-key={columnKey(col)}
                placeholder={t('filter.placeholder')}
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
              title={t('filter.clear')}
              onClick={() => clearColumnFilters()}
            >
              <X size={13} strokeWidth={1.75} />
            </button>
          </Show>
        </span>
      </div>
    </Show>
  );
}
