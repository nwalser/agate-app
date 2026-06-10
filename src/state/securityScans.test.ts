// The scan-orchestration loop: consent must never be auto-granted by the scan
// itself (only the explicit Settings toggle grants it), scans defer off the
// unlock critical path, fresh cached results suppress re-runs, and locking
// cancels a pending deferred scan.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../lib/ipc.ts', () => ({
  ipc: {
    loadSecurityScans: vi.fn(async () => null),
    cacheSecurityScans: vi.fn(async () => undefined),
    darkwebScanVault: vi.fn(async () => ({ accounts: [], errored: [], pending: [] })),
    auditExposed: vi.fn(async () => []),
    setDarkwebConsent: vi.fn(async () => undefined),
  },
}));

vi.mock('./session.ts', async () => {
  const { createSignal } = await import('solid-js');
  const [status, setStatus] = createSignal({ unlocked: false });
  return { status, __setUnlocked: (v: boolean) => setStatus({ unlocked: v }) };
});

vi.mock('./security.ts', () => ({
  darkwebMonitor: () => true,
  exposedCheck: () => true,
}));

vi.mock('./toast.ts', () => ({ toastError: vi.fn() }));

import { ipc } from '../lib/ipc.ts';
import * as session from './session.ts';
import { initSecurity, runDarkwebScan, runExposedCheck, runStaleScans } from './securityScans.ts';

const setUnlocked = (session as unknown as { __setUnlocked: (v: boolean) => void }).__setUnlocked;

beforeEach(() => {
  vi.useFakeTimers();
  vi.clearAllMocks();
});
afterEach(() => {
  setUnlocked(false);
  vi.useRealTimers();
});

describe('securityScans', () => {
  it('runDarkwebScan never auto-grants backend consent', async () => {
    setUnlocked(true);
    await runDarkwebScan();
    expect(ipc.darkwebScanVault).toHaveBeenCalledTimes(1);
    expect(ipc.setDarkwebConsent).not.toHaveBeenCalled();
  });

  it('runStaleScans skips fresh results and re-runs stale ones', async () => {
    setUnlocked(true);
    await runDarkwebScan();
    await runExposedCheck();
    vi.clearAllMocks();

    runStaleScans(); // both results are fresh — nothing should run
    await vi.runAllTimersAsync();
    expect(ipc.darkwebScanVault).not.toHaveBeenCalled();
    expect(ipc.auditExposed).not.toHaveBeenCalled();

    vi.advanceTimersByTime(7 * 60 * 60 * 1000); // past the 6h freshness window
    runStaleScans();
    await vi.runAllTimersAsync();
    expect(ipc.darkwebScanVault).toHaveBeenCalledTimes(1);
    expect(ipc.auditExposed).toHaveBeenCalledTimes(1);
  });

  it('defers scans 20s after unlock, and locking cancels the pending defer', async () => {
    initSecurity();

    // Unlock: hydrate the cache immediately, but no scans yet.
    setUnlocked(true);
    await vi.advanceTimersByTimeAsync(1);
    expect(ipc.loadSecurityScans).toHaveBeenCalledTimes(1);
    expect(ipc.darkwebScanVault).not.toHaveBeenCalled();

    // Lock 10s in — the pending deferred scan must die with it.
    await vi.advanceTimersByTimeAsync(10_000);
    setUnlocked(false);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(ipc.darkwebScanVault).not.toHaveBeenCalled();
    expect(ipc.auditExposed).not.toHaveBeenCalled();

    // Unlock again and let the 20s defer elapse — now the scans run.
    setUnlocked(true);
    await vi.advanceTimersByTimeAsync(21_000);
    expect(ipc.darkwebScanVault).toHaveBeenCalledTimes(1);
    expect(ipc.auditExposed).toHaveBeenCalledTimes(1);
  });
});
