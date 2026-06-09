import { beforeEach, describe, expect, it, vi } from 'vitest';

// Fresh module per case so the import-time localStorage read sees seeded state.
async function freshClipboard(seed?: string) {
  vi.resetModules();
  localStorage.clear();
  if (seed !== undefined) localStorage.setItem('agate.clipboardClearSeconds', seed);
  return import('./clipboard.ts');
}

describe('clipboard auto-clear preference', () => {
  beforeEach(() => localStorage.clear());

  it('defaults to 15 seconds when nothing is stored', async () => {
    const m = await freshClipboard();
    expect(m.clipboardClearSeconds()).toBe(15);
  });

  it('reads a valid persisted option at load', async () => {
    const m = await freshClipboard('30');
    expect(m.clipboardClearSeconds()).toBe(30);
  });

  it('accepts 0 (never auto-clear) as a valid persisted option', async () => {
    const m = await freshClipboard('0');
    expect(m.clipboardClearSeconds()).toBe(0);
  });

  it('falls back to the default for an out-of-set value', async () => {
    const m = await freshClipboard('7');
    expect(m.clipboardClearSeconds()).toBe(15);
  });

  it('falls back to the default for a corrupt/non-numeric value', async () => {
    const m = await freshClipboard('soon');
    expect(m.clipboardClearSeconds()).toBe(15);
  });

  it('set persists the chosen delay and updates the signal', async () => {
    const m = await freshClipboard();
    m.setClipboardClearSeconds(60);
    expect(m.clipboardClearSeconds()).toBe(60);
    expect(localStorage.getItem('agate.clipboardClearSeconds')).toBe('60');
  });

  it('exposes 0 as a member of the offered options', async () => {
    const m = await freshClipboard();
    expect(m.CLIPBOARD_CLEAR_OPTIONS).toContain(0);
  });
});
