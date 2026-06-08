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
