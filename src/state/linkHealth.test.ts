// The link-health checker, tested through the FACTORY with injected deps — no
// module mocking, no shared singleton state. Mirrors securityScans.test.ts.

import { createSignal } from 'solid-js';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createLinkHealth, type LinkHealthDeps } from './linkHealth.ts';
import type { LinkCheckReport } from '../lib/types.ts';

const emptyReport = (): LinkCheckReport => ({
  scanned: 0,
  ok: 0,
  broken: 0,
  unreachable: 0,
  uncertain: 0,
  skipped: 0,
  items: [],
});

function makeHarness(over: Partial<LinkHealthDeps> = {}) {
  const [unlocked, setUnlocked] = createSignal(false);
  const calls = { scan: 0 };
  let resolveScan: ((r: LinkCheckReport) => void) | null = null;
  const deps: LinkHealthDeps = {
    ipc: {
      linkCheckVault: () => {
        calls.scan += 1;
        // A controllable promise so a test can assert `busy` mid-flight.
        return new Promise<LinkCheckReport>((resolve) => {
          resolveScan = resolve;
        });
      },
    },
    unlocked,
    onError: (err) => {
      throw err instanceof Error ? err : new Error(String(err));
    },
    ...over,
  };
  return { linkHealth: createLinkHealth(deps), setUnlocked, calls, settle: () => resolveScan };
}

beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());

describe('createLinkHealth', () => {
  it('runs the scan, toggles busy, and stores the report', async () => {
    const { linkHealth, setUnlocked, calls, settle } = makeHarness();
    setUnlocked(true);

    const p = linkHealth.runScan();
    expect(linkHealth.busy()).toBe(true); // in flight
    expect(calls.scan).toBe(1);

    settle()!(emptyReport());
    await p;
    expect(linkHealth.busy()).toBe(false);
    expect(linkHealth.report()).toEqual(emptyReport());
    expect(linkHealth.runAt()).not.toBeNull();
  });

  it('is a no-op while locked', async () => {
    const { linkHealth, calls } = makeHarness(); // locked
    await linkHealth.runScan();
    expect(calls.scan).toBe(0);
    expect(linkHealth.report()).toBeNull();
  });

  it('does not start a second scan while one is in flight', async () => {
    const { linkHealth, setUnlocked, calls } = makeHarness();
    setUnlocked(true);
    void linkHealth.runScan();
    void linkHealth.runScan();
    expect(calls.scan).toBe(1);
  });

  it('surfaces errors through onError and clears busy', async () => {
    const errors: unknown[] = [];
    const { linkHealth, setUnlocked } = makeHarness({
      ipc: { linkCheckVault: () => Promise.reject(new Error('network down')) },
      onError: (e) => errors.push(e),
    });
    setUnlocked(true);
    await linkHealth.runScan();
    expect(errors).toHaveLength(1);
    expect(linkHealth.busy()).toBe(false);
    expect(linkHealth.report()).toBeNull();
  });

  it('clears the report on lock', async () => {
    const { linkHealth, setUnlocked, settle } = makeHarness();
    linkHealth.initLinkHealth();
    setUnlocked(true);
    await vi.advanceTimersByTimeAsync(1);

    const p = linkHealth.runScan();
    settle()!(emptyReport());
    await p;
    expect(linkHealth.report()).not.toBeNull();

    setUnlocked(false);
    await vi.advanceTimersByTimeAsync(1);
    expect(linkHealth.report()).toBeNull();
    expect(linkHealth.runAt()).toBeNull();
  });
});
