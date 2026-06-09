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

describe('columns store — grid metrics (anti-squish)', () => {
  it('every default column track has a non-zero floor', async () => {
    const m = await freshColumns();
    for (const id of m.ALL_BUILTINS) {
      expect(m.columnTrack({ kind: 'builtin', id }).min).toBeGreaterThan(0);
    }
    expect(m.columnTrack({ kind: 'custom', field: 'x' }).min).toBeGreaterThan(0);
  });

  it('builds the template: fixed checkbox · name · column tracks · fixed end', async () => {
    const m = await freshColumns();
    const u = m.columnTrack({ kind: 'builtin', id: 'username' });
    const { template } = m.gridMetrics([{ kind: 'builtin', id: 'username' }], {});
    expect(template.startsWith(`${m.CHECK_COL_PX}px `)).toBe(true);
    expect(template.endsWith(` ${m.END_COL_PX}px`)).toBe(true);
    expect(template).toContain(` ${u.template} `);
  });

  it('min-width sums every track floor plus the inter-track gaps', async () => {
    const m = await freshColumns();
    const cols = [
      { kind: 'builtin', id: 'username' } as const,
      { kind: 'builtin', id: 'type' } as const,
    ];
    // Derive the (private) name floor from a no-column metric so the test stays
    // correct if any floor is retuned.
    const nameFloor = m.gridMetrics([], {}).minWidth - m.CHECK_COL_PX - m.END_COL_PX - 2 * m.COL_GAP;
    const expected =
      m.CHECK_COL_PX +
      nameFloor +
      m.columnTrack(cols[0]).min +
      m.columnTrack(cols[1]).min +
      m.END_COL_PX +
      4 * m.COL_GAP; // 5 tracks → 4 gaps
    expect(m.gridMetrics(cols, {}).minWidth).toBe(expected);
  });

  it('more columns → strictly larger minimum width', async () => {
    const m = await freshColumns();
    const one = m.gridMetrics([{ kind: 'builtin', id: 'username' }], {}).minWidth;
    const two = m.gridMetrics(
      [
        { kind: 'builtin', id: 'username' },
        { kind: 'builtin', id: 'website' },
      ],
      {},
    ).minWidth;
    expect(two).toBeGreaterThan(one);
  });

  it('a user drag-width overrides the track and its floor', async () => {
    const m = await freshColumns();
    const { template, minWidth } = m.gridMetrics([{ kind: 'builtin', id: 'username' }], {
      'builtin:username': 300,
      [m.NAME_COL_KEY]: 250,
    });
    expect(template).toBe(`${m.CHECK_COL_PX}px 250px 300px ${m.END_COL_PX}px`);
    // 22 + 250 + 300 + 76 + 3 gaps × 10
    expect(minWidth).toBe(m.CHECK_COL_PX + 250 + 300 + m.END_COL_PX + 3 * m.COL_GAP);
  });
});

describe('columns store — reorder + reset', () => {
  beforeEach(() => localStorage.clear());

  const ids = (m: { columns: () => { columns: { kind: string; id?: string }[] } }) =>
    m.columns().columns.map((c) => c.id);

  it('reorderColumn moves an item to a new index', async () => {
    const m = await freshColumns();
    // Defaults: [username, website].
    m.reorderColumn(0, 1);
    expect(ids(m)).toEqual(['website', 'username']);
  });

  it('reorderColumn is a no-op for out-of-range or equal indices', async () => {
    const m = await freshColumns();
    const before = ids(m);
    m.reorderColumn(0, 0);
    m.reorderColumn(-1, 1);
    m.reorderColumn(0, 5);
    expect(ids(m)).toEqual(before);
  });

  it('resetColumns restores defaults and clears widths/reveal', async () => {
    const m = await freshColumns();
    m.toggleColumn({ kind: 'builtin', id: 'totp' });
    m.toggleReveal('builtin:totp');
    m.setColumnWidth('builtin:username', 200);
    m.setFavicons(false);
    m.resetColumns();
    expect(ids(m)).toEqual(['username', 'website']);
    expect(m.columns().revealed).toEqual([]);
    expect(m.columns().widths).toEqual({});
    expect(m.columns().favicons).toBe(true);
    // Persisted, not just in-memory.
    const raw = JSON.parse(localStorage.getItem('agate.columns') ?? '{}');
    expect(raw.columns.map((c: { id: string }) => c.id)).toEqual(['username', 'website']);
  });
});
