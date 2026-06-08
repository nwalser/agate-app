import { beforeEach, describe, expect, it, vi } from 'vitest';

// Each case loads a fresh copy of the module so the global signal + the localStorage
// read at import happen against a clean, seeded state.
async function freshColumns(seed?: unknown) {
  vi.resetModules();
  localStorage.clear();
  if (seed !== undefined) localStorage.setItem('agate.columns', JSON.stringify(seed));
  return import('./columns.ts');
}

describe('columns store — widths (resize)', () => {
  beforeEach(() => localStorage.clear());

  it('defaults to no custom widths', async () => {
    const m = await freshColumns();
    expect(m.columns().widths).toEqual({});
  });

  it('setColumnWidth clamps to the minimum and persists', async () => {
    const m = await freshColumns();
    m.setColumnWidth('builtin:username', 10);
    expect(m.columns().widths['builtin:username']).toBe(m.MIN_COL_WIDTH);
    const raw = JSON.parse(localStorage.getItem('agate.columns') ?? '{}');
    expect(raw.widths['builtin:username']).toBe(m.MIN_COL_WIDTH);
  });

  it('stores a rounded width', async () => {
    const m = await freshColumns();
    m.setColumnWidth(m.NAME_COL_KEY, 123.6);
    expect(m.columns().widths[m.NAME_COL_KEY]).toBe(124);
  });

  it('resetColumnWidth removes the entry', async () => {
    const m = await freshColumns();
    m.setColumnWidth(m.NAME_COL_KEY, 200);
    m.resetColumnWidth(m.NAME_COL_KEY);
    expect(m.NAME_COL_KEY in m.columns().widths).toBe(false);
  });

  it('hiding a column forgets its width', async () => {
    const m = await freshColumns();
    // `username` is a default-visible column.
    m.setColumnWidth('builtin:username', 200);
    m.toggleColumn({ kind: 'builtin', id: 'username' }); // removes it
    expect('builtin:username' in m.columns().widths).toBe(false);
  });

  it('drops invalid persisted widths', async () => {
    const m = await freshColumns({
      columns: [{ kind: 'builtin', id: 'username' }],
      revealed: [],
      favicons: true,
      widths: { 'builtin:username': 200, bad: 'x', tiny: 5 },
    });
    expect(m.columns().widths).toEqual({ 'builtin:username': 200 });
  });
});
