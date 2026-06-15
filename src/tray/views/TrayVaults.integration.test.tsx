// Integration tests for the tray popup's vault-connection management view: the
// REAL TrayVaults component over the REAL lib/ipc wrappers, with the Tauri
// bridge mocked at its lowest boundary (mockIPC). Each test stands up a tiny
// fake backend (a connection list + a command switch), renders <TrayVaults/>,
// and drives the list / unlock / 2FA / add / edit / remove flows through the
// DOM, asserting on what the user sees and on the IPC the backend received.

import { cleanup, fireEvent, render, screen, waitFor } from '@solidjs/testing-library';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { clearMocks, mockIPC } from '@tauri-apps/api/mocks';
import TrayVaults from './TrayVaults.tsx';
import { t } from '../../lib/i18n.ts';
import { makeConnection } from '../../testing/factories.ts';
import type { ConnectionSummary, LoginResult, ServerConfig } from '../../lib/types.ts';

// ── Fake backend ─────────────────────────────────────────────────────────────
// Mutable connection list + a switch over every command TrayVaults can invoke.
// Unknown commands throw loudly so a new IPC call can't silently no-op.

const MASTER_PW = 'master-pw';
/** This email demands a second factor on unlock_connection / add_connection. */
const TFA_UNLOCK = 'tfa@x.com';
const TFA_ADD = 'tfa-add@x.com';
/** What the fake native file pickers return. */
const KDBX_PATH = 'C:\\vaults\\personal.kdbx';
const NEW_KDBX_PATH = 'C:\\vaults\\new.kdbx';
const KEYFILE_PATH = 'C:\\vaults\\personal.keyx';

function makeBackend(initial: ConnectionSummary[]) {
  const state = { connections: initial.map((c) => ({ ...c })) };
  const calls: { cmd: string; args: Record<string, unknown> }[] = [];

  mockIPC((cmd, payload) => {
    const a = (payload ?? {}) as Record<string, unknown>;
    calls.push({ cmd, args: a });
    switch (cmd) {
      case 'list_connections':
        return state.connections.map((c) => ({ ...c }));
      case 'unlock_connection': {
        const c = state.connections.find((x) => x.email === a.email);
        if (!c) throw new Error(`unlock_connection: no such connection ${String(a.email)}`);
        if (a.password !== MASTER_PW) throw new Error('Invalid credentials');
        if (c.email === TFA_UNLOCK && !a.twoFactor) {
          return {
            status: 'twoFactorRequired',
            providers: ['authenticator', 'email'],
          } satisfies LoginResult;
        }
        c.unlocked = true;
        return { status: 'success' } satisfies LoginResult;
      }
      case 'unlock_connection_2fa': {
        const c = state.connections.find((x) => x.email === a.email);
        if (!c) throw new Error(`unlock_connection_2fa: no such connection ${String(a.email)}`);
        c.unlocked = true;
        return null;
      }
      case 'send_connection_email_code':
      case 'send_email_code':
        return null;
      case 'add_connection': {
        if (a.email === TFA_ADD && !a.twoFactor) {
          return {
            status: 'twoFactorRequired',
            providers: ['authenticator', 'email'],
          } satisfies LoginResult;
        }
        state.connections.push(
          makeConnection({
            email: String(a.email),
            server: a.server as ServerConfig,
            storeCredentials: Boolean(a.storeCredentials),
            unlocked: true,
          }),
        );
        return { status: 'success' } satisfies LoginResult;
      }
      case 'update_connection':
        return { status: 'success' } satisfies LoginResult;
      case 'remove_connection': {
        state.connections = state.connections.filter((x) => x.email !== a.email);
        return null;
      }
      case 'pick_keepass_database':
        return KDBX_PATH;
      case 'pick_keepass_new_database':
        return NEW_KDBX_PATH;
      case 'pick_keepass_keyfile':
        return KEYFILE_PATH;
      case 'add_keepass_connection':
      case 'create_keepass_connection': {
        state.connections.push(
          makeConnection({
            kind: 'keepass',
            email: String(a.path),
            serverLabel: 'KeePass',
            storeCredentials: Boolean(a.storeCredentials),
            unlocked: true,
          }),
        );
        return null;
      }
      case 'unlock_keepass_connection': {
        const c = state.connections.find((x) => x.email === a.path);
        if (!c) throw new Error(`unlock_keepass_connection: no such db ${String(a.path)}`);
        if (a.password !== MASTER_PW) throw new Error('Invalid credentials');
        c.unlocked = true;
        return null;
      }
      default:
        throw new Error(`unmocked command: ${cmd}`);
    }
  });

  return { state, calls };
}

afterEach(() => {
  cleanup();
  clearMocks();
});

describe('TrayVaults', () => {
  it('lists connections with per-state actions and hands back to the shell', async () => {
    makeBackend([
      makeConnection({ email: 'open@x.com', unlocked: true }),
      makeConnection({ email: 'closed@x.com', unlocked: false, storeCredentials: false }),
    ]);
    const onBack = vi.fn();
    render(() => <TrayVaults onBack={onBack} />);

    await screen.findByText('open@x.com');
    expect(screen.getByText('closed@x.com')).toBeTruthy();
    // Only the locked row offers an unlock action.
    expect(screen.getAllByTitle(t('connections.unlockNow'))).toHaveLength(1);

    fireEvent.click(screen.getByTitle(t('common.back')));
    expect(onBack).toHaveBeenCalledOnce();
  });

  it('unlocks a manual connection with its master password', async () => {
    const { calls } = makeBackend([
      makeConnection({ email: 'man@x.com', unlocked: false, storeCredentials: false }),
    ]);
    render(() => <TrayVaults onBack={() => {}} />);

    fireEvent.click(await screen.findByTitle(t('connections.unlockNow')));
    fireEvent.input(screen.getByLabelText(t('connections.masterPassword')), {
      target: { value: MASTER_PW },
    });
    fireEvent.click(screen.getByText(t('connections.unlock')));

    await waitFor(() => expect(screen.queryByTitle(t('connections.unlockNow'))).toBeNull());
    const call = calls.find((c) => c.cmd === 'unlock_connection');
    expect(call?.args.email).toBe('man@x.com');
    expect(call?.args.password).toBe(MASTER_PW);
    expect(call?.args.twoFactor).toBeNull();
  });

  it('walks the inline 2FA step when the server demands a second factor', async () => {
    const { calls } = makeBackend([
      makeConnection({ email: TFA_UNLOCK, unlocked: false, storeCredentials: false }),
    ]);
    render(() => <TrayVaults onBack={() => {}} />);

    fireEvent.click(await screen.findByTitle(t('connections.unlockNow')));
    fireEvent.input(screen.getByLabelText(t('connections.masterPassword')), {
      target: { value: MASTER_PW },
    });
    fireEvent.click(screen.getByText(t('connections.unlock')));

    const code = await screen.findByLabelText(t('connections.verificationCode'));
    fireEvent.input(code, { target: { value: '123456' } });
    fireEvent.click(screen.getByText(t('connections.verifyAndUnlock')));

    await waitFor(() => expect(screen.queryByTitle(t('connections.unlockNow'))).toBeNull());
    const second = calls.filter((c) => c.cmd === 'unlock_connection')[1];
    expect((second?.args.twoFactor as { token: string }).token).toBe('123456');
  });

  it('unlocks a stored-credential connection with just a 2FA code (incl. email send)', async () => {
    const { calls } = makeBackend([
      makeConnection({ email: 'stored@x.com', unlocked: false, storeCredentials: true }),
    ]);
    render(() => <TrayVaults onBack={() => {}} />);

    fireEvent.click(await screen.findByTitle(t('connections.unlockNow')));
    // Stored connections go straight to the code step — no master password.
    fireEvent.change(screen.getByLabelText(t('connections.provider')), {
      target: { value: 'email' },
    });
    fireEvent.click(screen.getByText(t('connections.sendCodeToEmail')));
    await waitFor(() =>
      expect(calls.some((c) => c.cmd === 'send_connection_email_code')).toBe(true),
    );

    fireEvent.input(screen.getByLabelText(t('connections.verificationCode')), {
      target: { value: '654321' },
    });
    // findByText: the send-code busy flag clears on a microtask after waitFor.
    fireEvent.click(await screen.findByText(t('connections.verifyAndUnlock')));

    await waitFor(() => expect(screen.queryByTitle(t('connections.unlockNow'))).toBeNull());
    expect(
      calls.some((c) => c.cmd === 'unlock_connection_2fa' && c.args.email === 'stored@x.com'),
    ).toBe(true);
  });

  it('adds a self-hosted vault and returns to the refreshed list', async () => {
    const { calls } = makeBackend([]);
    render(() => <TrayVaults onBack={() => {}} />);

    fireEvent.click(await screen.findByTitle(t('trayVaults.addVault')));
    fireEvent.click(screen.getByText(t('trayVaults.sourceBitwarden')));
    fireEvent.change(screen.getByLabelText(t('connections.server')), {
      target: { value: 'selfHosted' },
    });
    fireEvent.input(screen.getByLabelText(t('connections.serverUrl')), {
      target: { value: 'https://vault.example.com' },
    });
    fireEvent.input(screen.getByLabelText(t('onboarding.email')), {
      target: { value: 'new@x.com' },
    });
    fireEvent.input(screen.getByLabelText(t('onboarding.masterPassword')), {
      target: { value: 'pw' },
    });
    fireEvent.click(screen.getByText(t('onboarding.addConnection')));

    await screen.findByText('new@x.com'); // back on the list, refreshed
    const call = calls.find((c) => c.cmd === 'add_connection');
    expect(call?.args.server).toEqual({ region: 'selfHosted', baseUrl: 'https://vault.example.com' });
    expect(call?.args.storeCredentials).toBe(true);
  });

  it('finishes adding a vault through the 2FA step', async () => {
    const { calls } = makeBackend([]);
    render(() => <TrayVaults onBack={() => {}} />);

    fireEvent.click(await screen.findByTitle(t('trayVaults.addVault')));
    fireEvent.click(screen.getByText(t('trayVaults.sourceBitwarden')));
    fireEvent.input(screen.getByLabelText(t('onboarding.email')), {
      target: { value: TFA_ADD },
    });
    fireEvent.input(screen.getByLabelText(t('onboarding.masterPassword')), {
      target: { value: 'pw' },
    });
    fireEvent.click(screen.getByText(t('onboarding.addConnection')));

    const code = await screen.findByLabelText(t('connections.verificationCode'));
    fireEvent.input(code, { target: { value: '111222' } });
    fireEvent.click(screen.getByText(t('onboarding.verifyAndAdd')));

    await screen.findByText(TFA_ADD);
    const second = calls.filter((c) => c.cmd === 'add_connection')[1];
    expect((second?.args.twoFactor as { token: string }).token).toBe('111222');
  });

  it('adds a KeePass database: pick file → password → connection added', async () => {
    const { calls } = makeBackend([]);
    render(() => <TrayVaults onBack={() => {}} />);

    fireEvent.click(await screen.findByTitle(t('trayVaults.addVault')));
    fireEvent.click(screen.getByText(t('trayVaults.sourceKeepass')));
    // No 2FA / server / email fields anywhere in the KeePass flow.
    expect(screen.queryByLabelText(t('connections.server'))).toBeNull();
    expect(screen.queryByLabelText(t('onboarding.email'))).toBeNull();

    // The database picker button shows the picked file's NAME (path as title).
    // Two pickers show the choose-file label: database first, key file second.
    fireEvent.click(screen.getAllByText(t('trayVaults.chooseFile'))[0]);
    const fileBtn = await screen.findByText('personal.kdbx');
    expect(fileBtn.getAttribute('title')).toBe(KDBX_PATH);

    fireEvent.input(screen.getByLabelText(t('trayVaults.dbPassword')), {
      target: { value: 'db-pw' },
    });
    fireEvent.click(screen.getByText(t('trayVaults.addKeepass')));

    // Back on the refreshed list (the add form is gone), new row by file name.
    await waitFor(() =>
      expect(screen.queryByLabelText(t('trayVaults.dbPassword'))).toBeNull(),
    );
    expect(await screen.findByText('personal.kdbx')).toBeTruthy();
    const call = calls.find((c) => c.cmd === 'add_keepass_connection');
    expect(call?.args).toEqual({
      path: KDBX_PATH,
      password: 'db-pw',
      keyfile: null, // untouched optional key file goes over as null
      storeCredentials: true, // "remember database password" defaults on
    });
  });

  it('creates a new KeePass database: toggle → pick location → password + confirm', async () => {
    const { calls } = makeBackend([]);
    render(() => <TrayVaults onBack={() => {}} />);

    fireEvent.click(await screen.findByTitle(t('trayVaults.addVault')));
    fireEvent.click(screen.getByText(t('trayVaults.sourceKeepass')));

    // Default mode is "open" — no confirm field until we switch to "create".
    expect(screen.queryByLabelText(t('trayVaults.confirmDbPassword'))).toBeNull();
    fireEvent.click(screen.getByText(t('trayVaults.createNew')));

    // The save-as picker button shows the chosen file NAME (path as title).
    fireEvent.click(screen.getByText(t('trayVaults.chooseLocation')));
    const fileBtn = await screen.findByText('new.kdbx');
    expect(fileBtn.getAttribute('title')).toBe(NEW_KDBX_PATH);

    fireEvent.input(screen.getByLabelText(t('trayVaults.dbPassword')), {
      target: { value: 'db-pw' },
    });
    fireEvent.input(screen.getByLabelText(t('trayVaults.confirmDbPassword')), {
      target: { value: 'db-pw' },
    });
    fireEvent.click(screen.getByText(t('trayVaults.createKeepass')));

    // Back on the refreshed list, new row by file name.
    await waitFor(() =>
      expect(screen.queryByLabelText(t('trayVaults.confirmDbPassword'))).toBeNull(),
    );
    expect(await screen.findByText('new.kdbx')).toBeTruthy();
    const call = calls.find((c) => c.cmd === 'create_keepass_connection');
    expect(call?.args).toEqual({
      path: NEW_KDBX_PATH,
      password: 'db-pw',
      keyfile: null,
      storeCredentials: true,
    });
    // Creating must never go through the open-existing path.
    expect(calls.some((c) => c.cmd === 'add_keepass_connection')).toBe(false);
  });

  it('refuses to create a database when the confirm password does not match', async () => {
    const { calls } = makeBackend([]);
    render(() => <TrayVaults onBack={() => {}} />);

    fireEvent.click(await screen.findByTitle(t('trayVaults.addVault')));
    fireEvent.click(screen.getByText(t('trayVaults.sourceKeepass')));
    fireEvent.click(screen.getByText(t('trayVaults.createNew')));
    fireEvent.click(screen.getByText(t('trayVaults.chooseLocation')));
    await screen.findByText('new.kdbx');

    fireEvent.input(screen.getByLabelText(t('trayVaults.dbPassword')), {
      target: { value: 'db-pw' },
    });
    fireEvent.input(screen.getByLabelText(t('trayVaults.confirmDbPassword')), {
      target: { value: 'mismatch' },
    });
    fireEvent.click(screen.getByText(t('trayVaults.createKeepass')));

    // The mismatch bails before any IPC; the form stays open.
    expect(calls.some((c) => c.cmd === 'create_keepass_connection')).toBe(false);
    expect(screen.getByLabelText(t('trayVaults.confirmDbPassword'))).toBeTruthy();
  });

  it('renders a KeePass row by file name and unlocks it with the database password', async () => {
    const { calls } = makeBackend([
      makeConnection({
        kind: 'keepass',
        email: 'C:\\vaults\\work.kdbx',
        unlocked: false,
        storeCredentials: false,
      }),
    ]);
    render(() => <TrayVaults onBack={() => {}} />);

    // File name as the primary label; the full path only rides the title attr.
    await screen.findByText('work.kdbx');
    expect(screen.queryByText('C:\\vaults\\work.kdbx')).toBeNull();

    fireEvent.click(screen.getByTitle(t('connections.unlockNow')));
    // KeePass unlock = one password field, no stored/2FA modes.
    expect(screen.queryByLabelText(t('connections.provider'))).toBeNull();
    fireEvent.input(screen.getByLabelText(t('trayVaults.dbPassword')), {
      target: { value: MASTER_PW },
    });
    fireEvent.click(screen.getByText(t('connections.unlock')));

    await waitFor(() => expect(screen.queryByTitle(t('connections.unlockNow'))).toBeNull());
    const call = calls.find((c) => c.cmd === 'unlock_keepass_connection');
    expect(call?.args.path).toBe('C:\\vaults\\work.kdbx');
    expect(call?.args.password).toBe(MASTER_PW);
  });

  it('offers no edit action on KeePass rows and no row unlock for stored ones', async () => {
    makeBackend([
      makeConnection({ email: 'bw@x.com', unlocked: false, storeCredentials: false }),
      makeConnection({
        kind: 'keepass',
        email: 'C:\\vaults\\manual.kdbx',
        unlocked: false,
        storeCredentials: false,
      }),
      makeConnection({
        kind: 'keepass',
        email: 'C:\\vaults\\stored.kdbx',
        unlocked: false,
        storeCredentials: true,
      }),
    ]);
    render(() => <TrayVaults onBack={() => {}} />);

    await screen.findByText('manual.kdbx');
    // Edit (server/password change) is Bitwarden-only.
    expect(screen.getAllByTitle(t('connections.editConnection'))).toHaveLength(1);
    // Stored KeePass rows wait for the app-level unlock — no row unlock action.
    expect(screen.getAllByTitle(t('connections.unlockNow'))).toHaveLength(2);
    // Remove stays available on every row.
    expect(screen.getAllByTitle(t('connections.removeConnection'))).toHaveLength(3);
  });

  it('edits a connection: switching auto-unlock off needs no password', async () => {
    const { calls } = makeBackend([
      makeConnection({ email: 'me@x.com', unlocked: true, storeCredentials: true }),
    ]);
    render(() => <TrayVaults onBack={() => {}} />);

    fireEvent.click(await screen.findByTitle(t('connections.editConnection')));
    fireEvent.click(screen.getByLabelText(t('connections.storeLogin')));
    fireEvent.click(screen.getByText(t('connections.saveChanges')));

    await waitFor(() => {
      const call = calls.find((c) => c.cmd === 'update_connection');
      expect(call?.args.storeCredentials).toBe(false);
      expect(call?.args.password).toBeNull();
    });
  });

  it('removes a connection only after the inline confirm', async () => {
    const { calls } = makeBackend([makeConnection({ email: 'gone@x.com' })]);
    render(() => <TrayVaults onBack={() => {}} />);

    fireEvent.click(await screen.findByTitle(t('connections.removeConnection')));
    expect(calls.some((c) => c.cmd === 'remove_connection')).toBe(false);

    fireEvent.click(screen.getByText(t('common.remove')));
    await waitFor(() => expect(screen.queryByText('gone@x.com')).toBeNull());
    expect(
      calls.some((c) => c.cmd === 'remove_connection' && c.args.email === 'gone@x.com'),
    ).toBe(true);
  });
});
