import { beforeEach, describe, expect, it, vi } from 'vitest';

// Fresh module per case so the import-time localStorage read sees seeded state.
async function freshUi(seed?: Record<string, string>) {
  vi.resetModules();
  localStorage.clear();
  if (seed) for (const [k, v] of Object.entries(seed)) localStorage.setItem(k, v);
  return import('./ui.ts');
}

describe('ui state — sidebar + active vault', () => {
  beforeEach(() => localStorage.clear());

  it('defaults: sidebar expanded, all vaults', async () => {
    const m = await freshUi();
    expect(m.sidebarCollapsed()).toBe(false);
    expect(m.activeVault()).toBe(null);
  });

  it('toggleSidebar flips the state and persists it', async () => {
    const m = await freshUi();
    m.toggleSidebar();
    expect(m.sidebarCollapsed()).toBe(true);
    expect(localStorage.getItem('agate.sidebarCollapsed')).toBe('1');
    m.toggleSidebar();
    expect(m.sidebarCollapsed()).toBe(false);
    expect(localStorage.getItem('agate.sidebarCollapsed')).toBe('0');
  });

  it('reads the persisted collapsed state at load', async () => {
    const m = await freshUi({ 'agate.sidebarCollapsed': '1' });
    expect(m.sidebarCollapsed()).toBe(true);
  });

  it('setActiveVault scopes to an email and persists; null clears', async () => {
    const m = await freshUi();
    m.setActiveVault('a@b.com');
    expect(m.activeVault()).toBe('a@b.com');
    expect(localStorage.getItem('agate.activeVault')).toBe('a@b.com');
    m.setActiveVault(null);
    expect(m.activeVault()).toBe(null);
    expect(localStorage.getItem('agate.activeVault')).toBe(null);
  });

  it('reads the persisted active vault at load', async () => {
    const m = await freshUi({ 'agate.activeVault': 'x@y.com' });
    expect(m.activeVault()).toBe('x@y.com');
  });
});

describe('ui state — preview (detail) pane', () => {
  beforeEach(() => localStorage.clear());

  it('defaults to expanded (preview shown)', async () => {
    const m = await freshUi();
    expect(m.previewCollapsed()).toBe(false);
  });

  it('togglePreview flips and persists', async () => {
    const m = await freshUi();
    m.togglePreview();
    expect(m.previewCollapsed()).toBe(true);
    expect(localStorage.getItem('agate.previewCollapsed')).toBe('1');
    m.togglePreview();
    expect(m.previewCollapsed()).toBe(false);
    expect(localStorage.getItem('agate.previewCollapsed')).toBe('0');
  });

  it('reads the persisted collapsed state at load', async () => {
    const m = await freshUi({ 'agate.previewCollapsed': '1' });
    expect(m.previewCollapsed()).toBe(true);
  });
});

describe('ui state — sidebar width', () => {
  beforeEach(() => localStorage.clear());

  it('defaults to SIDEBAR_DEFAULT_WIDTH', async () => {
    const m = await freshUi();
    expect(m.sidebarWidth()).toBe(m.SIDEBAR_DEFAULT_WIDTH);
  });

  it('setSidebarWidth rounds, persists, and re-reads', async () => {
    const m = await freshUi();
    m.setSidebarWidth(240.6);
    expect(m.sidebarWidth()).toBe(241);
    expect(localStorage.getItem('agate.sidebarWidth')).toBe('241');
  });

  it('clamps below the minimum', async () => {
    const m = await freshUi();
    m.setSidebarWidth(10);
    expect(m.sidebarWidth()).toBe(m.SIDEBAR_MIN_WIDTH);
  });

  it('clamps above the maximum', async () => {
    const m = await freshUi();
    m.setSidebarWidth(9999);
    expect(m.sidebarWidth()).toBe(m.SIDEBAR_MAX_WIDTH);
  });

  it('reads + clamps a persisted width at load', async () => {
    const m = await freshUi({ 'agate.sidebarWidth': '300' });
    expect(m.sidebarWidth()).toBe(300);
    const tooWide = await freshUi({ 'agate.sidebarWidth': '5000' });
    expect(tooWide.sidebarWidth()).toBe(tooWide.SIDEBAR_MAX_WIDTH);
  });

  it('falls back to the default on a bogus persisted value', async () => {
    const m = await freshUi({ 'agate.sidebarWidth': 'wide' });
    expect(m.sidebarWidth()).toBe(m.SIDEBAR_DEFAULT_WIDTH);
  });

  it('resetSidebarWidth restores the default', async () => {
    const m = await freshUi();
    m.setSidebarWidth(300);
    m.resetSidebarWidth();
    expect(m.sidebarWidth()).toBe(m.SIDEBAR_DEFAULT_WIDTH);
    expect(localStorage.getItem('agate.sidebarWidth')).toBe(String(m.SIDEBAR_DEFAULT_WIDTH));
  });
});

describe('ui state — row density', () => {
  beforeEach(() => localStorage.clear());

  it('defaults to "default"', async () => {
    const m = await freshUi();
    expect(m.rowDensity()).toBe('default');
  });

  it('setRowDensity persists a valid value', async () => {
    const m = await freshUi();
    m.setRowDensity('compact');
    expect(m.rowDensity()).toBe('compact');
    expect(localStorage.getItem('agate.rowDensity')).toBe('compact');
    m.setRowDensity('comfortable');
    expect(m.rowDensity()).toBe('comfortable');
  });

  it('reads a persisted density at load', async () => {
    const m = await freshUi({ 'agate.rowDensity': 'comfortable' });
    expect(m.rowDensity()).toBe('comfortable');
  });

  it('falls back to "default" on a bogus persisted value', async () => {
    const m = await freshUi({ 'agate.rowDensity': 'huge' });
    expect(m.rowDensity()).toBe('default');
  });
});
