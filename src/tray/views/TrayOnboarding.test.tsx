// Integration tests for the tray first-run onboarding view: the REAL
// TrayOnboarding over the real lib/ipc wrapper, with the Tauri bridge mocked
// at its lowest boundary (@tauri-apps/api/mocks), same pattern as
// TrayApp.integration.test.tsx. Covers: inline validation (min length,
// mismatch) blocks the IPC call; a valid submit configures app unlock and
// fires onDone; an IPC failure surfaces as an error toast and keeps the user
// on the form.

import { cleanup, fireEvent, render, waitFor } from '@solidjs/testing-library';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { clearMocks, mockIPC, mockWindows } from '@tauri-apps/api/mocks';
import TrayOnboarding from './TrayOnboarding.tsx';
import { dismissToast, toasts } from '../../state/toast.ts';

function installBackend(opts: { fail?: string } = {}) {
  const calls: { cmd: string; args: Record<string, unknown> }[] = [];
  mockWindows('tray');
  mockIPC((cmd, payload) => {
    const args = (payload ?? {}) as Record<string, unknown>;
    calls.push({ cmd, args });
    if (cmd !== 'configure_app_unlock') throw new Error(`unmocked IPC command: ${cmd}`);
    if (opts.fail) throw new Error(opts.fail);
    return null;
  });
  return calls;
}

function setup(opts: { fail?: string } = {}) {
  const calls = installBackend(opts);
  const onDone = vi.fn();
  const r = render(() => <TrayOnboarding onDone={onDone} />);
  const form = r.container.querySelector('form');
  if (!form) throw new Error('TrayOnboarding rendered no form');
  // Stable ids, not label text: the trayOnboard.* locale keys are wired in a
  // separate change, and t() renders the bare key until then.
  const pw = r.container.querySelector<HTMLInputElement>('#tray-onboard-pw');
  const confirm = r.container.querySelector<HTMLInputElement>('#tray-onboard-confirm');
  if (!pw || !confirm) throw new Error('TrayOnboarding rendered without its password inputs');
  return { ...r, calls, onDone, form, pw, confirm };
}

beforeEach(() => {
  localStorage.clear();
  // The toast pipeline is a module-level singleton — drop leftovers so a toast
  // from one test can't satisfy an assertion in the next.
  for (const toast of toasts()) dismissToast(toast.id);
});

afterEach(() => {
  cleanup();
  clearMocks();
});

describe('TrayOnboarding', () => {
  it('rejects a password under 8 chars inline, without calling IPC', async () => {
    const { form, pw, confirm, calls, onDone, findByRole } = setup();
    fireEvent.input(pw, { target: { value: 'short' } });
    fireEvent.input(confirm, { target: { value: 'short' } });
    fireEvent.submit(form);

    const alert = await findByRole('alert');
    expect(alert.textContent).toBe('App password must be at least 8 characters.');
    expect(calls).toHaveLength(0);
    expect(onDone).not.toHaveBeenCalled();
  });

  it('rejects mismatched passwords inline, without calling IPC', async () => {
    const { form, pw, confirm, calls, onDone, findByRole } = setup();
    fireEvent.input(pw, { target: { value: 'long-enough-pw' } });
    fireEvent.input(confirm, { target: { value: 'different-pw' } });
    fireEvent.submit(form);

    const alert = await findByRole('alert');
    expect(alert.textContent).toBe('Passwords do not match.');
    expect(calls).toHaveLength(0);
    expect(onDone).not.toHaveBeenCalled();
  });

  it('clears the inline error live once the input is fixed', async () => {
    const { form, pw, confirm, findByRole, queryByRole } = setup();
    fireEvent.input(pw, { target: { value: 'short' } });
    fireEvent.input(confirm, { target: { value: 'short' } });
    fireEvent.submit(form);
    await findByRole('alert');

    fireEvent.input(pw, { target: { value: 'long-enough-pw' } });
    fireEvent.input(confirm, { target: { value: 'long-enough-pw' } });
    await waitFor(() => expect(queryByRole('alert')).toBeNull());
  });

  it('configures app unlock and fires onDone on a valid submit', async () => {
    const { form, pw, confirm, calls, onDone } = setup();
    fireEvent.input(pw, { target: { value: 'long-enough-pw' } });
    fireEvent.input(confirm, { target: { value: 'long-enough-pw' } });
    fireEvent.submit(form);

    await waitFor(() => expect(onDone).toHaveBeenCalledTimes(1));
    expect(calls).toEqual([
      { cmd: 'configure_app_unlock', args: { appPassword: 'long-enough-pw' } },
    ]);
    // Secrets don't linger in the inputs after success.
    expect(pw.value).toBe('');
    expect(confirm.value).toBe('');
  });

  it('surfaces an IPC failure as an error toast and stays on the form', async () => {
    const { form, pw, confirm, onDone } = setup({ fail: 'keychain unavailable' });
    fireEvent.input(pw, { target: { value: 'long-enough-pw' } });
    fireEvent.input(confirm, { target: { value: 'long-enough-pw' } });
    fireEvent.submit(form);

    await waitFor(() => expect(toasts().some((t) => t.kind === 'error')).toBe(true));
    expect(onDone).not.toHaveBeenCalled();
  });
});
