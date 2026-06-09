// The per-column filter store. Its load-bearing invariant: empty values are never
// stored, so `hasActiveFilters` (which drives the funnel highlight + the saved-view
// snapshot) stays accurate. Each case re-imports a fresh module so the singleton
// signals start clean.

import { beforeEach, describe, expect, it, vi } from 'vitest';

async function fresh() {
  vi.resetModules();
  return import('./columnFilters.ts');
}

describe('columnFilters store', () => {
  beforeEach(() => vi.resetModules());

  it('starts with no filters and the row hidden', async () => {
    const m = await fresh();
    expect(m.hasActiveFilters()).toBe(false);
    expect(m.filtersVisible()).toBe(false);
    expect(m.columnFilter('name')).toBe('');
  });

  it('setColumnFilter stores a value and clears on empty', async () => {
    const m = await fresh();
    m.setColumnFilter('name', 'git');
    expect(m.columnFilter('name')).toBe('git');
    expect(m.hasActiveFilters()).toBe(true);
    m.setColumnFilter('name', '');
    expect(m.columnFilter('name')).toBe('');
    expect(m.hasActiveFilters()).toBe(false);
  });

  it('setAllColumnFilters drops empty values when restoring a snapshot', async () => {
    const m = await fresh();
    m.setAllColumnFilters({ name: 'a', 'builtin:username': '', 'builtin:folder': 'work' });
    expect(m.filters()).toEqual({ name: 'a', 'builtin:folder': 'work' });
    expect(m.hasActiveFilters()).toBe(true);
  });

  it('clearColumnFilters empties the set', async () => {
    const m = await fresh();
    m.setColumnFilter('name', 'x');
    m.clearColumnFilters();
    expect(m.filters()).toEqual({});
    expect(m.hasActiveFilters()).toBe(false);
  });

  it('toggle/show control the filter-row visibility', async () => {
    const m = await fresh();
    m.toggleFiltersVisible();
    expect(m.filtersVisible()).toBe(true);
    m.showColumnFilters(false);
    expect(m.filtersVisible()).toBe(false);
  });
});
