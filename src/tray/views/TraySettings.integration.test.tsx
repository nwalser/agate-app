// Integration tests for the tray Settings view's AUTOFILL section: the REAL
// TraySettings component over the REAL lib/ipc wrappers, with the Tauri bridge
// mocked at its lowest boundary (mockIPC). A tiny fake backend serves the
// on-mount probes (session / server / hello / autostart / autofill status) plus
// the autofill mutators, so the test asserts what the user sees and the exact
// IPC the toggles + denylist editor send. Same shape as TrayVaults.integration.

import { cleanup, fireEvent, render, screen, waitFor } from '@solidjs/testing-library';
import { afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { clearMocks, mockIPC } from '@tauri-apps/api/mocks';
import TraySettings from './TraySettings.tsx';
import { t } from '../../lib/i18n.ts';
import type { AutofillMode, AutofillStatus } from '../../lib/types.ts';

interface AutofillState {
  mode: AutofillMode;
  supported: boolean;
  hotkey: string;
  submit: boolean;
  denylist: string[];
}

function makeBackend(af: Partial<AutofillState> = {}) {
  const state: AutofillState = {
    mode: 'watch',
    supported: true,
    hotkey: 'Ctrl+Alt+\\',
    submit: false,
    denylist: [],
    ...af,
  };
  const calls: { cmd: string; args: Record<string, unknown> }[] = [];

  mockIPC((cmd, payload) => {
    const a = (payload ?? {}) as Record<string, unknown>;
    calls.push({ cmd, args: a });
    switch (cmd) {
      // ── On-mount probes ──
      case 'get_session_status':
        return { appUnlockConfigured: true, unlocked: true, helloConfigured: false, connectionCount: 1, liveCount: 1 };
      case 'get_server_config':
        return { region: 'eu' };
      case 'hello_available':
        return false;
      case 'get_autostart':
        return false;
      case 'autofill_status':
        return { ...state } satisfies AutofillStatus;
      case 'plugin:app|version':
        return '1.0.0';
      // ── Autofill mutators under test ──
      case 'autofill_set_submit':
        state.submit = a.submit as boolean;
        return null;
      case 'autofill_set_denylist':
        state.denylist = a.denylist as string[];
        return null;
      case 'autofill_set_mode':
        state.mode = a.mode as AutofillMode;
        return null;
      default:
        throw new Error(`unmocked command: ${cmd}`);
    }
  });

  return { state, calls };
}

beforeAll(() => {
  Element.prototype.scrollIntoView = () => undefined;
});

beforeEach(() => {
  localStorage.clear();
});

afterEach(() => {
  cleanup();
  clearMocks();
});

describe('TraySettings — autofill auto-submit', () => {
  it('toggling auto-submit persists through autofill_set_submit', async () => {
    const { calls } = makeBackend({ submit: false });
    render(() => <TraySettings onBack={() => {}} />);

    // The submit switch only renders once the status (mode='watch') has loaded.
    const sw = await screen.findByRole('switch', { name: t('autofill.submit') });
    expect(sw.getAttribute('aria-checked')).toBe('false');

    fireEvent.click(sw);

    await waitFor(() => expect(sw.getAttribute('aria-checked')).toBe('true'));
    const call = calls.find((c) => c.cmd === 'autofill_set_submit');
    expect(call?.args.submit).toBe(true);
  });

  it('hides the submit toggle + denylist editor when the mode is off', async () => {
    makeBackend({ mode: 'off' });
    render(() => <TraySettings onBack={() => {}} />);

    // The mode picker is present, but the per-mode controls are not.
    await screen.findByLabelText(t('autofill.modeLabel'));
    expect(screen.queryByRole('switch', { name: t('autofill.submit') })).toBeNull();
    expect(screen.queryByPlaceholderText(t('autofill.denylistPlaceholder'))).toBeNull();
  });
});

describe('TraySettings — autofill denylist editor', () => {
  it('adding a process name trims + lowercases it and persists the new list', async () => {
    const { calls } = makeBackend({ denylist: [] });
    render(() => <TraySettings onBack={() => {}} />);

    const input = await screen.findByPlaceholderText(t('autofill.denylistPlaceholder'));
    fireEvent.input(input, { target: { value: '  Discord  ' } });
    fireEvent.click(screen.getByText(t('autofill.denylistAdd')));

    // The normalized entry shows as a chip and the backend got the lowercased list.
    await screen.findByText('discord');
    const call = calls.find((c) => c.cmd === 'autofill_set_denylist');
    expect(call?.args.denylist).toEqual(['discord']);
  });

  it('removing a chip persists the shortened list', async () => {
    const { calls } = makeBackend({ denylist: ['discord', 'steam'] });
    render(() => <TraySettings onBack={() => {}} />);

    await screen.findByText('discord');
    // Two removable chips → two remove buttons.
    const removes = screen.getAllByRole('button', { name: t('common.remove') });
    expect(removes).toHaveLength(2);
    fireEvent.click(removes[0]);

    await waitFor(() => expect(screen.queryByText('discord')).toBeNull());
    const call = calls.find((c) => c.cmd === 'autofill_set_denylist');
    expect(call?.args.denylist).toEqual(['steam']);
  });

  it('ignores an empty / whitespace-only add (no IPC, no chip)', async () => {
    const { calls } = makeBackend({ denylist: [] });
    render(() => <TraySettings onBack={() => {}} />);

    const input = await screen.findByPlaceholderText(t('autofill.denylistPlaceholder'));
    fireEvent.input(input, { target: { value: '   ' } });
    fireEvent.submit(input.closest('form')!);

    expect(calls.find((c) => c.cmd === 'autofill_set_denylist')).toBeUndefined();
  });
});
