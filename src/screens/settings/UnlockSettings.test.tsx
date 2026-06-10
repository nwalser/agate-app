// The Unlock page's Connections section: one row per connection with its
// unlock state, and a jump to the Connections page for locked ones (the
// unlock/2FA flow itself lives there — one path).

import { cleanup, fireEvent, render, waitFor } from '@solidjs/testing-library';
import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../lib/ipc.ts', () => ({
  ipc: {
    helloAvailable: vi.fn(async () => false),
    listConnections: vi.fn(async () => [
      {
        email: 'auto@example.com',
        serverLabel: 'Bitwarden EU',
        server: { kind: 'eu' },
        unlocked: true,
        storeCredentials: true,
      },
      {
        email: 'manual@example.com',
        serverLabel: 'Bitwarden US',
        server: { kind: 'us' },
        unlocked: false,
        storeCredentials: false,
      },
    ]),
    changeAppUnlock: vi.fn(async () => undefined),
    helloEnable: vi.fn(async () => undefined),
    helloDisable: vi.fn(async () => undefined),
  },
}));

vi.mock('../../state/session.ts', () => ({
  status: () => ({ helloConfigured: false }),
  refreshSession: vi.fn(async () => undefined),
}));

import UnlockSettings from './UnlockSettings.tsx';

describe('UnlockSettings — connections section', () => {
  afterEach(cleanup);

  it('lists every connection with its unlock state', async () => {
    render(() => <UnlockSettings />);
    await waitFor(() => {
      expect(document.body.textContent).toContain('auto@example.com');
      expect(document.body.textContent).toContain('manual@example.com');
    });
    expect(document.body.textContent).toContain('Auto-unlocks with the app');
    expect(document.body.textContent).toContain('Manual unlock only');
  });

  it('offers the Unlock jump only for locked connections', async () => {
    const goto = vi.fn();
    render(() => <UnlockSettings goto={goto} />);
    await waitFor(() => {
      expect(document.body.textContent).toContain('manual@example.com');
    });
    const jumps = Array.from(document.querySelectorAll('button')).filter((b) =>
      (b.textContent ?? '').includes('Unlock…'),
    );
    expect(jumps).toHaveLength(1); // only the locked connection
    fireEvent.click(jumps[0]);
    expect(goto).toHaveBeenCalledWith('connections');
  });

  it('stacks the unlock methods one after the other, in order', async () => {
    render(() => <UnlockSettings />);
    await waitFor(() => {
      expect(document.body.textContent).toContain('auto@example.com');
    });
    const heads = Array.from(document.querySelectorAll('.settings-section h3')).map(
      (h) => h.textContent ?? '',
    );
    expect(heads.length).toBe(4);
    expect(heads[0]).toContain('App password');
    expect(heads[1]).toContain('This device');
    expect(heads[3]).toContain('Connections');
  });
});
