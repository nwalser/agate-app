// Startup section: launch-at-login + close-to-tray toggles, each loaded on
// mount and persisted on change through their ipc commands.

import { cleanup, fireEvent, render, waitFor } from '@solidjs/testing-library';
import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../lib/ipc.ts', () => ({
  ipc: {
    getAutostart: vi.fn(async () => false),
    setAutostart: vi.fn(async () => undefined),
    getCloseToTray: vi.fn(async () => false),
    setCloseToTray: vi.fn(async () => undefined),
    getStartInTray: vi.fn(async () => false),
    setStartInTray: vi.fn(async () => undefined),
  },
}));

import StartupSettings from './StartupSettings.tsx';
import { ipc } from '../../lib/ipc.ts';

const trayToggle = () =>
  document.querySelector<HTMLButtonElement>(
    '[role="switch"][aria-label="Keep running in the tray when the window is closed"]',
  );

const startInTrayToggle = () =>
  document.querySelector<HTMLButtonElement>(
    '[role="switch"][aria-label="Start hidden in the tray"]',
  );

describe('StartupSettings', () => {
  afterEach(cleanup);

  it('loads both stored states on mount', async () => {
    vi.mocked(ipc.getCloseToTray).mockResolvedValueOnce(true);
    render(() => <StartupSettings />);
    await waitFor(() => {
      expect(ipc.getAutostart).toHaveBeenCalled();
      expect(ipc.getCloseToTray).toHaveBeenCalled();
    });
    await waitFor(() => expect(trayToggle()?.getAttribute('aria-checked')).toBe('true'));
  });

  it('persists a close-to-tray change', async () => {
    render(() => <StartupSettings />);
    await waitFor(() => expect(trayToggle()).not.toBeNull());
    fireEvent.click(trayToggle()!);
    await waitFor(() => expect(ipc.setCloseToTray).toHaveBeenCalledWith(true));
    expect(trayToggle()?.getAttribute('aria-checked')).toBe('true');
  });

  it('keeps the old state when persisting fails', async () => {
    vi.mocked(ipc.setCloseToTray).mockRejectedValueOnce(new Error('disk full'));
    render(() => <StartupSettings />);
    await waitFor(() => expect(trayToggle()).not.toBeNull());
    fireEvent.click(trayToggle()!);
    await waitFor(() => expect(ipc.setCloseToTray).toHaveBeenCalled());
    expect(trayToggle()?.getAttribute('aria-checked')).toBe('false');
  });

  it('loads the stored start-in-tray state', async () => {
    vi.mocked(ipc.getAutostart).mockResolvedValueOnce(true);
    vi.mocked(ipc.getStartInTray).mockResolvedValueOnce(true);
    render(() => <StartupSettings />);
    await waitFor(() => expect(startInTrayToggle()?.getAttribute('aria-checked')).toBe('true'));
  });

  it('start-in-tray is disabled while autostart is off (it only affects login launches)', async () => {
    render(() => <StartupSettings />);
    await waitFor(() => expect(startInTrayToggle()).not.toBeNull());
    expect(startInTrayToggle()?.disabled).toBe(true);
    fireEvent.click(startInTrayToggle()!);
    expect(ipc.setStartInTray).not.toHaveBeenCalled();
  });

  it('persists a start-in-tray change once autostart is on', async () => {
    vi.mocked(ipc.getAutostart).mockResolvedValueOnce(true);
    render(() => <StartupSettings />);
    await waitFor(() => expect(startInTrayToggle()?.disabled).toBe(false));
    fireEvent.click(startInTrayToggle()!);
    await waitFor(() => expect(ipc.setStartInTray).toHaveBeenCalledWith(true));
    expect(startInTrayToggle()?.getAttribute('aria-checked')).toBe('true');
  });
});
