import { beforeEach, describe, expect, it, vi, type Mock } from 'vitest';

// ipc + toast are mocked; each fresh module load (vi.resetModules) re-runs these
// factories, so we grab the live mock fns from the same generation after load.
vi.mock('../lib/ipc.ts', () => ({
  ipc: { checkUpdate: vi.fn(), runUpdate: vi.fn() },
}));
vi.mock('./toast.ts', () => ({
  pushToast: vi.fn(),
}));

const CONFIG_KEY = 'agate.updateConfig';
const LAST_CHECKED_KEY = 'agate.updateLastChecked';

// Load a fresh copy of the module under test so its module-load read of
// localStorage sees whatever the test staged. Returns the module plus the mock
// fns from the same fresh module graph (references match what the module uses).
async function load(stagedConfig?: unknown) {
  vi.resetModules();
  if (stagedConfig !== undefined) {
    localStorage.setItem(
      CONFIG_KEY,
      typeof stagedConfig === 'string' ? stagedConfig : JSON.stringify(stagedConfig),
    );
  }
  const mod = await import('./update.ts');
  const { ipc } = await import('../lib/ipc.ts');
  const { pushToast } = await import('./toast.ts');
  return {
    mod,
    checkUpdate: ipc.checkUpdate as unknown as Mock,
    runUpdate: ipc.runUpdate as unknown as Mock,
    pushToast: pushToast as unknown as Mock,
  };
}

beforeEach(() => {
  localStorage.clear();
  // The mocked modules persist across vi.resetModules(), so clear call history
  // and implementations between cases to stop counts/return values leaking.
  vi.resetAllMocks();
});

describe('updateConfig persistence', () => {
  it('defaults to auto-check on, auto-install off when nothing is stored', async () => {
    const { mod } = await load();
    expect(mod.updateConfig()).toEqual({ autoCheck: true, autoInstall: false });
  });

  it('falls back to defaults on a corrupt stored value', async () => {
    const { mod } = await load('not json {');
    expect(mod.updateConfig()).toEqual(mod.DEFAULT_UPDATE_CONFIG);
  });

  it('ignores non-boolean fields and keeps the valid ones', async () => {
    const { mod } = await load({ autoCheck: false, autoInstall: 'yes' });
    expect(mod.updateConfig()).toEqual({ autoCheck: false, autoInstall: false });
  });

  it('persists a changed option to localStorage', async () => {
    const { mod } = await load();
    mod.setUpdateOption('autoInstall', true);
    expect(mod.updateConfig().autoInstall).toBe(true);
    expect(JSON.parse(localStorage.getItem(CONFIG_KEY) ?? '{}')).toMatchObject({ autoInstall: true });
  });
});

describe('checkForUpdate', () => {
  it('returns the version, records it, and stamps last-checked when an update exists', async () => {
    const { mod, checkUpdate } = await load();
    checkUpdate.mockResolvedValue('0.3.0');

    const result = await mod.checkForUpdate();

    expect(result).toBe('0.3.0');
    expect(mod.availableVersion()).toBe('0.3.0');
    expect(mod.lastCheckedAt()).toBeGreaterThan(0);
    expect(localStorage.getItem(LAST_CHECKED_KEY)).not.toBeNull();
  });

  it('records up-to-date (empty string) when there is no newer version', async () => {
    const { mod, checkUpdate } = await load();
    checkUpdate.mockResolvedValue(null);

    expect(await mod.checkForUpdate()).toBeNull();
    expect(mod.availableVersion()).toBe('');
  });
});

describe('runStartupUpdateCheck', () => {
  it('does nothing when auto-check is off', async () => {
    const { mod, checkUpdate } = await load({ autoCheck: false, autoInstall: true });
    await mod.runStartupUpdateCheck();
    expect(checkUpdate).not.toHaveBeenCalled();
  });

  it('toasts (but does not install) when an update is found and auto-install is off', async () => {
    const { mod, checkUpdate, runUpdate, pushToast } = await load({
      autoCheck: true,
      autoInstall: false,
    });
    checkUpdate.mockResolvedValue('0.3.0');

    await mod.runStartupUpdateCheck();

    expect(checkUpdate).toHaveBeenCalledTimes(1);
    expect(runUpdate).not.toHaveBeenCalled();
    expect(pushToast).toHaveBeenCalledWith('info', expect.stringContaining('0.3.0'));
  });

  it('installs automatically when an update is found and auto-install is on', async () => {
    const { mod, checkUpdate, runUpdate, pushToast } = await load({
      autoCheck: true,
      autoInstall: true,
    });
    checkUpdate.mockResolvedValue('0.3.0');
    runUpdate.mockResolvedValue(undefined);

    await mod.runStartupUpdateCheck();

    expect(runUpdate).toHaveBeenCalledTimes(1);
    expect(pushToast).not.toHaveBeenCalled();
  });

  it('stays silent when already up to date', async () => {
    const { mod, checkUpdate, runUpdate, pushToast } = await load({ autoCheck: true });
    checkUpdate.mockResolvedValue(null);

    await mod.runStartupUpdateCheck();

    expect(runUpdate).not.toHaveBeenCalled();
    expect(pushToast).not.toHaveBeenCalled();
  });

  it('swallows a failed check so startup is never blocked', async () => {
    const { mod, checkUpdate } = await load({ autoCheck: true });
    checkUpdate.mockRejectedValue(new Error('offline'));

    await expect(mod.runStartupUpdateCheck()).resolves.toBeUndefined();
  });
});
