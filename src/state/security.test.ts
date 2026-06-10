// The consent contract: the Settings toggle is the ONE place backend dark-web
// consent is granted AND revoked. Regression for the bug where the revoke was
// dropped during the scans-factory refactor (turning the monitor off left the
// backend free to keep calling out until logout).

import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('../lib/ipc.ts', () => ({
  ipc: { setDarkwebConsent: vi.fn(async () => undefined) },
}));

vi.mock('./securityScans.ts', () => ({
  initSecurity: vi.fn(),
  runDarkwebScan: vi.fn(async () => undefined),
  runExposedCheck: vi.fn(async () => undefined),
  clearDarkwebScan: vi.fn(),
  clearExposedCheck: vi.fn(),
}));

import { ipc } from '../lib/ipc.ts';
import { clearDarkwebScan, runDarkwebScan } from './securityScans.ts';
import { setDarkwebMonitor } from './security.ts';

afterEach(() => vi.clearAllMocks());

describe('setDarkwebMonitor — the one consent gate', () => {
  it('grants backend consent BEFORE the first scan when switched on', async () => {
    await setDarkwebMonitor(true);
    expect(ipc.setDarkwebConsent).toHaveBeenCalledWith(true);
    expect(runDarkwebScan).toHaveBeenCalledTimes(1);
    expect(
      vi.mocked(ipc.setDarkwebConsent).mock.invocationCallOrder[0],
    ).toBeLessThan(vi.mocked(runDarkwebScan).mock.invocationCallOrder[0]);
  });

  it('REVOKES backend consent when switched off (not just clears results)', async () => {
    await setDarkwebMonitor(false);
    expect(ipc.setDarkwebConsent).toHaveBeenCalledWith(false);
    expect(clearDarkwebScan).toHaveBeenCalledTimes(1);
  });
});
