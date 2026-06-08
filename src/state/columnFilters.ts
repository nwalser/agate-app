// Per-column filter state for the vault list. Transient (not persisted) — these
// narrow the visible rows by a substring match on a column's value. Keyed by a
// filter key: the literal 'name' for the always-on Name column, or a column key
// (state/columns.ts `columnKey`) for the rest. Only columns whose value is
// available without decrypting item detail are filterable (see `isFilterable`).

import { createSignal } from 'solid-js';

/** Filter key for the always-on Name column. */
export const NAME_FILTER_KEY = 'name';

const [filtersVisible, setFiltersVisible] = createSignal(false);
const [filters, setFilters] = createSignal<Record<string, string>>({});

export { filtersVisible, filters };

export function toggleFiltersVisible() {
  setFiltersVisible((v) => !v);
}

export function columnFilter(key: string): string {
  return filters()[key] ?? '';
}

export function setColumnFilter(key: string, value: string) {
  setFilters((prev) => {
    const next = { ...prev };
    if (value) next[key] = value;
    else delete next[key];
    return next;
  });
}

/** Whether any column filter is currently set. */
export function hasActiveFilters(): boolean {
  return Object.keys(filters()).length > 0;
}

export function clearColumnFilters() {
  setFilters({});
}
