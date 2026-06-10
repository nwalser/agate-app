// The scan-orchestration loop, tested through the FACTORY with injected deps —
// no module mocking, no shared singleton state between tests. Consent is not
// even part of the scan's dependency surface (`SecurityScanIpc`), so the old
// "scan auto-grants consent" bug is now unrepresentable by construction.

import { createSignal } from 'solid-js';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createSecurityScans, type SecurityScansDeps } from './securityScans.ts';
import type { DarkWebReport } from '../lib/types.ts';

const emptyRun = (): DarkWebReport => ({
  accounts: [],
  errored: [],
  pending: [],
  lockedConnections: [],
  totalBreaches: 0,
  clean: 0,
});

function makeHarness(over: Partial<SecurityScansDeps> = {}) {
  const [unlocked, setUnlocked] = createSignal(false);
  const calls = { darkweb: 0, exposed: 0, load: 0, cache: 0 };
  const deps: SecurityScansDeps = {
    ipc: {
      loadSecurityScans: async () => {
        calls.load += 1;
        return null;
      },
      cacheSecurityScans: async () => {
        calls.cache += 1;
      },
      darkwebScanVault: async () => {
        calls.darkweb += 1;
        return emptyRun();
      },
      auditExposed: async () => {
        calls.exposed += 1;
        return [];
      },
    },
    unlocked,
    darkwebEnabled: () => true,
    exposedEnabled: () => true,
    onError: (err) => {
      throw err instanceof Error ? err : new Error(String(err));
    },
    ...over,
  };
  return { scans: createSecurityScans(deps), setUnlocked, calls };
}

beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());

describe('createSecurityScans', () => {
  it('runs the dark-web scan with no consent call — consent is not in its IPC surface', async () => {
    const { scans, setUnlocked, calls } = makeHarness();
    setUnlocked(true);
    await scans.runDarkwebScan();
    expect(calls.darkweb).toBe(1);
    // Nothing else was touched beyond the scan + the cache write.
    expect(calls.load).toBe(0);
  });

  it('skips scans while locked or disabled', async () => {
    const { scans, calls } = makeHarness(); // locked
    await scans.runDarkwebScan();
    await scans.runExposedCheck();
    expect(calls.darkweb + calls.exposed).toBe(0);

    const disabled = makeHarness({ darkwebEnabled: () => false, exposedEnabled: () => false });
    disabled.setUnlocked(true);
    await disabled.scans.runDarkwebScan();
    await disabled.scans.runExposedCheck();
    expect(disabled.calls.darkweb + disabled.calls.exposed).toBe(0);
  });

  it('runStaleScans skips fresh results and re-runs stale ones', async () => {
    const { scans, setUnlocked, calls } = makeHarness();
    setUnlocked(true);
    await scans.runDarkwebScan();
    await scans.runExposedCheck();
    expect(calls.darkweb).toBe(1);
    expect(calls.exposed).toBe(1);

    scans.runStaleScans(); // both fresh — nothing runs
    await vi.runAllTimersAsync();
    expect(calls.darkweb).toBe(1);
    expect(calls.exposed).toBe(1);

    vi.advanceTimersByTime(7 * 60 * 60 * 1000); // past the 6h freshness window
    scans.runStaleScans();
    await vi.runAllTimersAsync();
    expect(calls.darkweb).toBe(2);
    expect(calls.exposed).toBe(2);
  });

  it('defers scans after unlock, and locking cancels the pending defer', async () => {
    const { scans, setUnlocked, calls } = makeHarness();
    scans.initSecurity();

    // Unlock: hydrate the cache immediately, but no scans yet.
    setUnlocked(true);
    await vi.advanceTimersByTimeAsync(1);
    expect(calls.load).toBe(1);
    expect(calls.darkweb).toBe(0);

    // Lock 10s in — the pending deferred scan must die with it.
    await vi.advanceTimersByTimeAsync(10_000);
    setUnlocked(false);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(calls.darkweb + calls.exposed).toBe(0);

    // Unlock again and let the 20s defer elapse — now the scans run.
    setUnlocked(true);
    await vi.advanceTimersByTimeAsync(21_000);
    expect(calls.darkweb).toBe(1);
    expect(calls.exposed).toBe(1);
  });
});
