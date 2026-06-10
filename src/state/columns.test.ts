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

describe('columns store — grid metrics (fit-to-width)', () => {
  it('every default column track has a non-zero natural floor (feeds minWidth)', async () => {
    const m = await freshColumns();
    for (const id of m.ALL_BUILTINS) {
      expect(m.columnTrack({ kind: 'builtin', id }).min).toBeGreaterThan(0);
    }
    expect(m.columnTrack({ kind: 'custom', field: 'x' }).min).toBeGreaterThan(0);
  });

  it('configurable column tracks are shrinkable (minmax floor 0) so the grid fits the pane instead of overflowing', async () => {
    const m = await freshColumns();
    // Flexible text columns and the fixed-size icon columns alike floor at 0, so
    // when the list pane is narrow the tracks compress rather than forcing a
    // horizontal scroll that would detach the last column from the detail pane.
    expect(m.columnTrack({ kind: 'builtin', id: 'username' }).template).toBe('minmax(0, 1fr)');
    expect(m.columnTrack({ kind: 'builtin', id: 'type' }).template).toBe('minmax(0, 96px)');
    expect(m.columnTrack({ kind: 'custom', field: 'x' }).template).toBe('minmax(0, 1fr)');
    // A user drag-width is an upper bound, not a hard size — it still shrinks to fit.
    const { template } = m.gridMetrics([{ kind: 'builtin', id: 'username' }], {
      'builtin:username': 300,
    });
    expect(template).toContain('minmax(0, 300px)');
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

  it('a user drag-width caps the track (still shrinkable) and feeds its natural width', async () => {
    const m = await freshColumns();
    const { template, minWidth } = m.gridMetrics([{ kind: 'builtin', id: 'username' }], {
      'builtin:username': 300,
      [m.NAME_COL_KEY]: 250,
    });
    expect(template).toBe(`${m.CHECK_COL_PX}px minmax(0, 250px) minmax(0, 300px) ${m.END_COL_PX}px`);
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
    m.setGroupBy('folder');
    m.resetColumns();
    expect(ids(m)).toEqual(['username', 'website']);
    expect(m.columns().revealed).toEqual([]);
    expect(m.columns().widths).toEqual({});
    expect(m.columns().favicons).toBe(true);
    expect(m.columns().groupBy).toBe(null);
    // Persisted, not just in-memory.
    const raw = JSON.parse(localStorage.getItem('agate.columns') ?? '{}');
    expect(raw.columns.map((c: { id: string }) => c.id)).toEqual(['username', 'website']);
  });
});

describe('columns store — grouping', () => {
  beforeEach(() => localStorage.clear());

  it('defaults to no grouping', async () => {
    const m = await freshColumns();
    expect(m.columns().groupBy).toBe(null);
  });

  it('setGroupBy persists the choice (string shorthand → builtin spec) and clears back to null', async () => {
    const m = await freshColumns();
    m.setGroupBy('security');
    expect(m.columns().groupBy).toEqual({ kind: 'builtin', key: 'security' });
    expect(JSON.parse(localStorage.getItem('agate.columns') ?? '{}').groupBy).toEqual({
      kind: 'builtin',
      key: 'security',
    });
    m.setGroupBy(null);
    expect(m.columns().groupBy).toBe(null);
  });

  it('drops an invalid persisted groupBy', async () => {
    const m = await freshColumns({
      columns: [{ kind: 'builtin', id: 'username' }],
      revealed: [],
      favicons: true,
      widths: {},
      groupBy: 'bogus',
    });
    expect(m.columns().groupBy).toBe(null);
  });

  it('migrates a LEGACY plain-string groupBy to the builtin spec', async () => {
    const m = await freshColumns({
      columns: [{ kind: 'builtin', id: 'username' }],
      revealed: [],
      favicons: true,
      widths: {},
      groupBy: 'folder', // pre-GroupSpec persisted form
    });
    expect(m.columns().groupBy).toEqual({ kind: 'builtin', key: 'folder' });
  });

  it('round-trips a custom-field group spec, rejecting malformed shapes', async () => {
    const m = await freshColumns();
    m.setGroupBy({ kind: 'custom', field: 'Environment' });
    expect(m.columns().groupBy).toEqual({ kind: 'custom', field: 'Environment' });
    const raw = JSON.parse(localStorage.getItem('agate.columns') ?? '{}');
    const m2 = await freshColumns(raw);
    expect(m2.columns().groupBy).toEqual({ kind: 'custom', field: 'Environment' });

    // Malformed custom shapes are dropped, not trusted.
    const bad = await freshColumns({ ...raw, groupBy: { kind: 'custom', field: '   ' } });
    expect(bad.columns().groupBy).toBe(null);
  });

  it('round-trips the presence/host group keys (website, totp, password) through storage', async () => {
    for (const key of ['website', 'totp', 'password'] as const) {
      localStorage.clear();
      const m = await freshColumns();
      m.setGroupBy(key);
      expect(m.columns().groupBy).toEqual({ kind: 'builtin', key });
      const raw = JSON.parse(localStorage.getItem('agate.columns') ?? '{}');
      // Survives a re-parse from storage (the trust-boundary path).
      const m2 = await freshColumns(raw);
      expect(m2.columns().groupBy).toEqual({ kind: 'builtin', key });
    }
  });
});

describe('columns store — display mode', () => {
  beforeEach(() => localStorage.clear());

  it('defaults to the table layout', async () => {
    const m = await freshColumns();
    expect(m.columns().displayMode).toBe('table');
  });

  it('setDisplayMode persists the choice', async () => {
    const m = await freshColumns();
    m.setDisplayMode('list');
    expect(m.columns().displayMode).toBe('list');
    expect(JSON.parse(localStorage.getItem('agate.columns') ?? '{}').displayMode).toBe('list');
  });

  it('drops an invalid persisted displayMode back to table', async () => {
    const m = await freshColumns({
      columns: [{ kind: 'builtin', id: 'username' }],
      revealed: [],
      favicons: true,
      widths: {},
      groupBy: null,
      displayMode: 'bogus',
    });
    expect(m.columns().displayMode).toBe('table');
  });

  it('resetColumns restores the table layout', async () => {
    const m = await freshColumns();
    m.setDisplayMode('list');
    m.resetColumns();
    expect(m.columns().displayMode).toBe('table');
  });
});
