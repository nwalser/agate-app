// Integration tests for the system-tray quick-access popup: the REAL TrayApp
// component wired to the REAL trayStore and the REAL lib/ipc wrappers, with the
// Tauri bridge mocked at its lowest boundary (window.__TAURI_INTERNALS__ via
// @tauri-apps/api/mocks). Each test stands up a tiny fake Rust backend (a state
// object + a command switch), renders <TrayApp/>, and drives it through the DOM
// — keyboard, clicks, and the real `agate://…` / `autofill://…` event channel —
// asserting on what the user sees and on the IPC the backend received.
//
// Run ONLY these tests with:  npm run test:tray

import { cleanup, fireEvent, render, screen, waitFor } from '@solidjs/testing-library';
import { afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { clearMocks, mockIPC, mockWindows } from '@tauri-apps/api/mocks';
import { emit } from '@tauri-apps/api/event';
import TrayApp from './TrayApp.tsx';
import { dismissToast, toasts } from '../state/toast.ts';
import {
  makeConnection,
  makeDetail,
  makeFolder,
  makeItem,
  makeLoginDetail,
} from '../testing/factories.ts';
import type {
  AutofillPending,
  Folder,
  ItemInput,
  SessionStatus,
  UnlockOutcome,
  VaultItem,
} from '../lib/types.ts';

// ── Fake backend ─────────────────────────────────────────────────────────────
// One mutable state blob + a switch over every command the popup can invoke.
// Unknown commands throw loudly so a new IPC call in TrayApp can't silently
// no-op its way through these tests.

const APP_PASSWORD = 'app-pw';

interface BackendState {
  status: SessionStatus;
  items: VaultItem[];
  /** itemId → cleartext password returned by item_detail. */
  passwords: Record<string, string>;
  /** Folders/groups the add-form picker offers (per the unified list_folders). */
  folders: Folder[];
  pending: AutofillPending | null;
  clipboard: string;
}

function makeStatus(over: Partial<SessionStatus> = {}): SessionStatus {
  return {
    appUnlockConfigured: true,
    unlocked: true,
    helloConfigured: false,
    connectionCount: 1,
    liveCount: 1,
    ...over,
  };
}

function makePending(over: Partial<AutofillPending> = {}): AutofillPending {
  return {
    token: 'tok-1',
    context: {
      field: 'password',
      processName: 'outlook',
      windowTitle: 'Sign in – Outlook',
      url: null,
      associateUri: null,
    },
    candidates: [],
    ...over,
  };
}

function makeBackend(over: Partial<BackendState> = {}) {
  const state: BackendState = {
    status: makeStatus(),
    items: [],
    passwords: {},
    folders: [],
    pending: null,
    clipboard: '',
    ...over,
  };
  const calls: { cmd: string; args: Record<string, unknown> }[] = [];

  const unlockedOutcome: UnlockOutcome[] = [
    { status: 'unlocked', email: 'me@x.com', serverLabel: 'EU' },
  ];

  function handle(cmd: string, args: Record<string, unknown>): unknown {
    switch (cmd) {
      case 'get_session_status':
        return { ...state.status };
      // Fresh clones per call, like real IPC deserialization.
      case 'list_items':
        return state.items.map((i) => ({ ...i }));
      case 'item_detail': {
        const item = state.items.find((i) => i.id === args.id && i.accountEmail === args.accountEmail);
        if (!item) throw new Error(`item_detail: no such item ${String(args.id)}`);
        return makeDetail({
          id: item.id,
          name: item.name,
          accountEmail: item.accountEmail,
          login: makeLoginDetail({
            username: item.username,
            password: state.passwords[item.id] ?? null,
          }),
        });
      }
      case 'item_totp':
        return { code: '123456', period: 30, remaining: 20 };
      case 'unlock_all':
        if (args.appPassword !== APP_PASSWORD) throw new Error('Invalid app password');
        state.status = { ...state.status, unlocked: true };
        return unlockedOutcome;
      case 'hello_unlock':
        state.status = { ...state.status, unlocked: true };
        return unlockedOutcome;
      case 'autofill_pending':
        return state.pending;
      case 'autofill_fill':
        state.pending = null;
        return null;
      case 'autofill_dismiss':
        state.pending = null;
        return null;
      case 'autofill_associate':
        // Backend would add the association URI to the login + re-rank; the
        // subsequent autofill_pending re-sync returns whatever the test set.
        return null;
      case 'list_connections':
        return [makeConnection({ email: 'me@x.com' })];
      case 'list_folders':
        return state.folders.map((f) => ({ ...f }));
      case 'list_collections':
        return [];
      case 'generate_password':
        return 'Gen3rated!Pass';
      case 'save_item': {
        const input = args.input as ItemInput;
        // Edit (id present) updates the row in place; create (id null) appends.
        if (input.id != null) {
          state.items = state.items.map((it) =>
            it.id === input.id
              ? { ...it, name: input.name, username: input.login?.username ?? null }
              : it,
          );
          if (input.login?.password) state.passwords[input.id] = input.login.password;
          return null;
        }
        state.items = [
          ...state.items,
          makeItem({
            id: `new-${state.items.length}`,
            name: input.name,
            username: input.login?.username ?? null,
            accountEmail: args.accountEmail as string,
          }),
        ];
        return null;
      }
      case 'password_in_use':
        return 0;
      case 'password_strength':
        return 3;
      case 'show_main_window':
      case 'hide_tray_window':
      case 'show_tray_window':
      case 'set_tray_pinned':
        return null;
      case 'plugin:clipboard-manager|write_text':
        state.clipboard = String(args.text);
        return null;
      case 'plugin:clipboard-manager|read_text':
        return state.clipboard;
      // Window sizing is best-effort cosmetics in TrayApp — sane defaults.
      case 'plugin:window|scale_factor':
        return 1;
      case 'plugin:window|outer_size':
        return { width: 380, height: 520 };
      case 'plugin:window|outer_position':
        return { x: 0, y: 0 };
      case 'plugin:window|set_size':
      case 'plugin:window|set_position':
        return null;
      default:
        throw new Error(`unmocked IPC command: ${cmd}`);
    }
  }

  return {
    state,
    calls,
    install() {
      mockWindows('tray');
      mockIPC(
        (cmd, payload) => {
          const args = (payload ?? {}) as Record<string, unknown>;
          calls.push({ cmd, args });
          return handle(cmd, args);
        },
        { shouldMockEvents: true },
      );
    },
    invoked(cmd: string) {
      return calls.filter((c) => c.cmd === cmd);
    },
  };
}

function renderTray(backend: ReturnType<typeof makeBackend>) {
  backend.install();
  return render(() => <TrayApp />);
}

beforeAll(() => {
  // jsdom has no scrollIntoView; TrayApp calls it when moving the selection.
  Element.prototype.scrollIntoView = () => undefined;
});

beforeEach(() => {
  localStorage.clear();
  // The toast pipeline is a module-level singleton — drop leftovers so a toast
  // from one test can't satisfy an assertion in the next.
  for (const t of toasts()) dismissToast(t.id);
});

afterEach(async () => {
  cleanup();
  // Let the component's unlisten promises settle against the still-installed
  // mock before tearing it down.
  await new Promise((resolve) => setTimeout(resolve, 0));
  clearMocks();
});

// ── Locked view ──────────────────────────────────────────────────────────────

describe('TrayApp integration — locked view + unlock', () => {
  it('unlocks end-to-end through the app-password form and shows the vault list', async () => {
    const backend = makeBackend({
      status: makeStatus({ unlocked: false }),
      items: [makeItem({ id: 'gh', name: 'GitHub', username: 'neo' })],
    });
    renderTray(backend);

    const pw = await screen.findByPlaceholderText('App password…');
    expect(screen.getByText('Vault is locked')).toBeTruthy();

    fireEvent.input(pw, { target: { value: APP_PASSWORD } });
    fireEvent.submit(pw.closest('form')!);

    await screen.findByPlaceholderText('Search vault…');
    // refresh() flips `unlocked` before the item fetch resolves — await the rows.
    await screen.findByText('GitHub');
    expect(screen.getByText('neo')).toBeTruthy();
    expect(backend.invoked('unlock_all')).toHaveLength(1);
    expect(backend.invoked('unlock_all')[0]?.args.appPassword).toBe(APP_PASSWORD);
  });

  it('a wrong app password surfaces an error toast and stays locked', async () => {
    const backend = makeBackend({ status: makeStatus({ unlocked: false }) });
    renderTray(backend);

    const pw = await screen.findByPlaceholderText('App password…');
    fireEvent.input(pw, { target: { value: 'nope' } });
    fireEvent.submit(pw.closest('form')!);

    await screen.findByText('Invalid app password');
    expect(screen.getByPlaceholderText('App password…')).toBeTruthy();
    expect(screen.queryByPlaceholderText('Search vault…')).toBeNull();
  });

  it('before app-unlock is configured the popup runs onboarding in place', async () => {
    const backend = makeBackend({
      status: makeStatus({ unlocked: false, appUnlockConfigured: false }),
    });
    renderTray(backend);

    // First-run onboarding renders instead of the unlock form.
    await screen.findByText('Set app password');
    expect(screen.queryByPlaceholderText('App password…')).toBeNull();
  });

  it('unlocks via the Windows Hello button when Hello is configured', async () => {
    const backend = makeBackend({
      status: makeStatus({ unlocked: false, helloConfigured: true }),
      items: [makeItem({ id: 'a', name: 'Alpha' })],
    });
    renderTray(backend);

    fireEvent.click(await screen.findByText('Unlock with Windows Hello'));

    await screen.findByPlaceholderText('Search vault…');
    await screen.findByText('Alpha');
    expect(backend.invoked('hello_unlock')).toHaveLength(1);
  });
});

// ── Unlocked list: search + copy chords ──────────────────────────────────────

describe('TrayApp integration — list, search and copy', () => {
  it('renders the unified list and filters it as the user types', async () => {
    const backend = makeBackend({
      items: [
        makeItem({ id: 'gh', name: 'GitHub', username: 'neo' }),
        makeItem({ id: 'bank', name: 'Bank Account' }),
      ],
    });
    renderTray(backend);

    await screen.findByText('GitHub');
    expect(screen.getByText('Bank Account')).toBeTruthy();

    const search = screen.getByPlaceholderText('Search vault…');
    fireEvent.input(search, { target: { value: 'git' } });
    await waitFor(() => expect(screen.queryByText('Bank Account')).toBeNull());
    expect(screen.getByText('GitHub')).toBeTruthy();

    fireEvent.input(search, { target: { value: 'zzz' } });
    await screen.findByText('No matches.');
  });

  it('Enter copies the selected item password: detail fetch + clipboard write', async () => {
    const backend = makeBackend({
      items: [makeItem({ id: 'gh', name: 'GitHub', username: 'neo' })],
      passwords: { gh: 's3cret' },
    });
    renderTray(backend);
    await screen.findByText('GitHub');

    fireEvent.keyDown(document, { key: 'Enter' });

    await waitFor(() => expect(backend.state.clipboard).toBe('s3cret'));
    expect(backend.invoked('item_detail')).toHaveLength(1);
    expect(backend.invoked('item_detail')[0]?.args).toMatchObject({ accountEmail: 'tester@example.com', id: 'gh' });
  });

  it('ArrowDown moves the selection; Shift+Enter copies that username with no detail fetch', async () => {
    const backend = makeBackend({
      items: [
        makeItem({ id: 'a', name: 'Alpha', username: 'a-user' }),
        makeItem({ id: 'b', name: 'Beta', username: 'b-user' }),
      ],
    });
    renderTray(backend);
    await screen.findByText('Alpha');

    fireEvent.keyDown(document, { key: 'ArrowDown' });
    fireEvent.keyDown(document, { key: 'Enter', shiftKey: true });

    await waitFor(() => expect(backend.state.clipboard).toBe('b-user'));
    expect(backend.invoked('item_detail')).toHaveLength(0);
  });

  it('Ctrl+Enter copies the TOTP code', async () => {
    const backend = makeBackend({
      items: [makeItem({ id: 'gh', name: 'GitHub', hasTotp: true })],
    });
    renderTray(backend);
    await screen.findByText('GitHub');

    fireEvent.keyDown(document, { key: 'Enter', ctrlKey: true });

    await waitFor(() => expect(backend.state.clipboard).toBe('123456'));
    expect(backend.invoked('item_totp')).toHaveLength(1);
  });

  it('a reprompt-protected copy opens the detail view behind the app-password gate', async () => {
    const backend = makeBackend({
      items: [makeItem({ id: 'r', name: 'Protected', reprompt: true })],
      passwords: { r: 'never-leaks' },
    });
    renderTray(backend);
    await screen.findByText('Protected');

    fireEvent.keyDown(document, { key: 'Enter' });

    // The detail view's RepromptGate is up; nothing was fetched or copied.
    await screen.findAllByText("Verify it's you");
    expect(backend.invoked('item_detail')).toHaveLength(0);
    expect(backend.state.clipboard).toBe('');
  });

  it('Escape hides the popup via the backend', async () => {
    const backend = makeBackend({ items: [makeItem({ id: 'a', name: 'Alpha' })] });
    renderTray(backend);
    await screen.findByText('Alpha');

    fireEvent.keyDown(document, { key: 'Escape' });

    await waitFor(() => expect(backend.invoked('hide_tray_window')).toHaveLength(1));
  });
});

// ── Cross-window events ──────────────────────────────────────────────────────

describe('TrayApp integration — backend event channel', () => {
  it('agate://session-changed drops the items the moment the session locks (fail closed)', async () => {
    const backend = makeBackend({ items: [makeItem({ id: 'gh', name: 'GitHub' })] });
    renderTray(backend);
    await screen.findByText('GitHub');

    backend.state.status = makeStatus({ unlocked: false });
    await emit('agate://session-changed');

    await screen.findByText('Vault is locked');
    expect(screen.queryByText('GitHub')).toBeNull();
  });

  it('agate://tray-shown re-reads session + items but keeps the query (popup state survives)', async () => {
    const backend = makeBackend({ items: [makeItem({ id: 'gh', name: 'GitHub' })] });
    renderTray(backend);
    await screen.findByText('GitHub');

    const search = screen.getByPlaceholderText('Search vault…');
    fireEvent.input(search, { target: { value: 'git' } });

    backend.state.items = [...backend.state.items, makeItem({ id: 'gl', name: 'GitLab' })];
    await emit('agate://tray-shown');

    await screen.findByText('GitLab');
    expect((search as HTMLInputElement).value).toBe('git');
    expect(screen.getByText('GitHub')).toBeTruthy();
  });
});

// ── Autofill fill mode ───────────────────────────────────────────────────────

describe('TrayApp integration — autofill fill mode', () => {
  it('autofill://detected shows the normal list pre-filtered to the app; clicking the match fills + dismisses', async () => {
    const backend = makeBackend({
      items: [makeItem({ id: 'gh', name: 'Outlook', username: 'neo', uri: 'https://outlook.com' })],
      pending: makePending({ token: 'tok-9' }),
    });
    renderTray(backend);
    await screen.findByPlaceholderText('Search vault…');

    await emit('autofill://detected');
    await screen.findByText('Fill into Sign in – Outlook');
    // The detection seeds the normal search box with a filter for the app.
    const search = screen.getByPlaceholderText('Search vault…') as HTMLInputElement;
    await waitFor(() => expect(search.value).toBe('outlook'));

    fireEvent.click(screen.getByText('Outlook'));

    await waitFor(() => expect(backend.invoked('autofill_fill')).toHaveLength(1));
    expect(backend.invoked('autofill_fill')[0]?.args).toMatchObject({
      token: 'tok-9',
      accountEmail: 'tester@example.com',
      itemId: 'gh',
    });
    await waitFor(() => expect(screen.queryByText('Fill into Sign in – Outlook')).toBeNull());
  });

  it('fill mode stays searchable: typing finds another item and clicking fills it; the window never resizes', async () => {
    const backend = makeBackend({
      items: [
        makeItem({ id: 'ms', name: 'Outlook', uri: 'https://outlook.com' }),
        makeItem({ id: 'gh', name: 'GitHub', uri: 'https://github.com' }),
      ],
      pending: makePending({ token: 'tok-7' }),
    });
    renderTray(backend);
    await screen.findByPlaceholderText('Search vault…');

    await emit('autofill://detected');
    await screen.findByText('Fill into Sign in – Outlook');

    // Pre-filtered to the detected app: Outlook shown, GitHub hidden.
    const search = screen.getByPlaceholderText('Search vault…') as HTMLInputElement;
    await waitFor(() => expect(search.value).toBe('outlook'));
    expect(screen.getByText('Outlook')).toBeTruthy();
    expect(screen.queryByText('GitHub')).toBeNull();

    // The user can still search for a different item, then fill it.
    fireEvent.input(search, { target: { value: 'github' } });
    await screen.findByText('GitHub');
    expect(screen.queryByText('Outlook')).toBeNull();

    fireEvent.click(screen.getByText('GitHub'));
    await waitFor(() => expect(backend.invoked('autofill_fill')).toHaveLength(1));
    expect(backend.invoked('autofill_fill')[0]?.args).toMatchObject({ token: 'tok-7', itemId: 'gh' });

    // One fixed window size — autofill never resizes the popup.
    expect(backend.invoked('plugin:window|set_size')).toHaveLength(0);
  });

  it('Escape in fill mode dismisses the backend detection and hides the popup', async () => {
    const backend = makeBackend({
      pending: makePending(),
    });
    renderTray(backend);
    await screen.findByPlaceholderText('Search vault…');

    await emit('autofill://detected');
    await screen.findByText('Fill into Sign in – Outlook');

    fireEvent.keyDown(document, { key: 'Escape' });

    await waitFor(() => expect(backend.invoked('autofill_dismiss')).toHaveLength(1));
    await waitFor(() => expect(backend.invoked('hide_tray_window')).toHaveLength(1));
    expect(backend.state.pending).toBeNull();
  });
});

// ── Add-login quick capture ──────────────────────────────────────────────────

describe('TrayApp integration — add-login form', () => {
  it('captures a new login end-to-end: open, generate password, save, lands in the list', async () => {
    const backend = makeBackend();
    renderTray(backend);
    await screen.findByPlaceholderText('Search vault…');

    fireEvent.click(screen.getByTitle('Add login'));
    const name = await screen.findByPlaceholderText('Name');
    fireEvent.input(name, { target: { value: 'Example Site' } });
    fireEvent.input(screen.getByPlaceholderText('Username'), { target: { value: 'neo' } });

    fireEvent.click(screen.getByTitle('Generate password'));
    const pwInput = screen.getByPlaceholderText('Password') as HTMLInputElement;
    await waitFor(() => expect(pwInput.value).toBe('Gen3rated!Pass'));

    fireEvent.submit(name.closest('form')!);

    await screen.findByText('Login saved.');
    expect(backend.invoked('save_item')).toHaveLength(1);
    const args = backend.invoked('save_item')[0]!.args;
    expect(args.accountEmail).toBe('me@x.com');
    expect(args.input).toMatchObject({
      itemType: 'login',
      name: 'Example Site',
      login: expect.objectContaining({ username: 'neo', password: 'Gen3rated!Pass' }) as unknown,
    });
    // The saved login is back in the (refreshed) list view.
    await screen.findByText('Example Site');
    expect(screen.getByPlaceholderText('Search vault…')).toBeTruthy();
  });

  it('shows the destination-vault picker even with a single connection', async () => {
    const backend = makeBackend();
    renderTray(backend);
    await screen.findByPlaceholderText('Search vault…');

    fireEvent.click(screen.getByTitle('Add login'));
    await screen.findByPlaceholderText('Name');
    // The lone connection is still offered as an explicit destination.
    await screen.findByRole('option', { name: 'me@x.com' });
  });

  it('lets the user pick a destination folder, which is sent on save', async () => {
    const backend = makeBackend({
      folders: [
        makeFolder({ id: 'work', name: 'Work', accountEmail: 'me@x.com' }),
        makeFolder({ id: 'personal', name: 'Personal', accountEmail: 'me@x.com' }),
      ],
    });
    renderTray(backend);
    await screen.findByPlaceholderText('Search vault…');

    fireEvent.click(screen.getByTitle('Add login'));
    const name = await screen.findByPlaceholderText('Name');
    fireEvent.input(name, { target: { value: 'Example Site' } });

    // The folder picker shows once list_folders resolves; find it via its unique
    // "No folder" option (the vault picker is also a combobox). Choose "Work".
    const folderSelect = (await screen.findByRole('option', { name: 'No folder' })).closest(
      'select',
    ) as HTMLSelectElement;
    await waitFor(() => expect(folderSelect.querySelector('option[value="work"]')).toBeTruthy());
    fireEvent.change(folderSelect, { target: { value: 'work' } });

    fireEvent.submit(name.closest('form')!);

    await screen.findByText('Login saved.');
    const args = backend.invoked('save_item')[0]!.args;
    expect((args.input as ItemInput).folderId).toBe('work');
  });

  it('pins the popup while adding and releases it once the login is saved', async () => {
    const backend = makeBackend();
    renderTray(backend);
    await screen.findByPlaceholderText('Search vault…');
    const lastPinned = () => {
      const calls = backend.invoked('set_tray_pinned');
      return calls[calls.length - 1]?.args.pinned;
    };

    fireEvent.click(screen.getByTitle('Add login'));
    await screen.findByPlaceholderText('Name');
    await waitFor(() => expect(lastPinned()).toBe(true));

    fireEvent.input(screen.getByPlaceholderText('Name'), { target: { value: 'Example Site' } });
    // Wait until the account list has loaded (Save enables) before submitting.
    const save = screen.getByText('Save login') as HTMLButtonElement;
    await waitFor(() => expect(save.disabled).toBe(false));
    fireEvent.click(save);

    await screen.findByText('Login saved.');
    // Form closed → popup is back to hiding on click-away.
    await waitFor(() => expect(lastPinned()).toBe(false));
  });
});

// ── Edit-login quick edit ────────────────────────────────────────────────────

describe('TrayApp integration — edit-login form', () => {
  it('edits a login end-to-end: open seeded form, rotate password, save, list updates', async () => {
    const backend = makeBackend({
      items: [makeItem({ id: 'gh', name: 'GitHub', username: 'neo' })],
      passwords: { gh: 's3cret' },
    });
    renderTray(backend);
    await screen.findByText('GitHub');

    fireEvent.click(screen.getByTitle('Edit login'));

    // The form opens seeded from item_detail.
    const name = (await screen.findByPlaceholderText('Name')) as HTMLInputElement;
    expect(name.value).toBe('GitHub');
    expect((screen.getByPlaceholderText('Username') as HTMLInputElement).value).toBe('neo');
    expect(screen.getByText('Edit login')).toBeTruthy();
    expect(backend.invoked('item_detail')).toHaveLength(1);

    // Rename + rotate the password, then save.
    fireEvent.input(name, { target: { value: 'GitHub Work' } });
    fireEvent.input(screen.getByPlaceholderText('Password'), { target: { value: 'rotated-pw' } });
    fireEvent.click(screen.getByText('Save changes'));

    await screen.findByText('Login updated.');
    const saves = backend.invoked('save_item');
    expect(saves).toHaveLength(1);
    expect(saves[0]?.args.accountEmail).toBe('tester@example.com');
    expect(saves[0]?.args.input).toMatchObject({
      id: 'gh',
      itemType: 'login',
      name: 'GitHub Work',
      login: expect.objectContaining({ password: 'rotated-pw' }) as unknown,
    });
    // Back in the list, renamed.
    await screen.findByText('GitHub Work');
    expect(screen.getByPlaceholderText('Search vault…')).toBeTruthy();
  });

  it('opening the edit form pins the popup, and cancelling releases it', async () => {
    const backend = makeBackend({
      items: [makeItem({ id: 'gh', name: 'GitHub', username: 'neo' })],
      passwords: { gh: 's3cret' },
    });
    renderTray(backend);
    await screen.findByText('GitHub');
    const lastPinned = () => {
      const calls = backend.invoked('set_tray_pinned');
      return calls[calls.length - 1]?.args.pinned;
    };

    fireEvent.click(screen.getByTitle('Edit login'));
    await screen.findByText('Edit login');
    // Pinned while the form is open — a click-away must not discard the draft.
    await waitFor(() => expect(lastPinned()).toBe(true));

    // Escape cancels the form (not the popup) and releases the pin.
    fireEvent.keyDown(document, { key: 'Escape' });
    await waitFor(() => expect(lastPinned()).toBe(false));
  });

  it('editing a reprompt-protected login routes to the gated detail view instead of the edit form', async () => {
    const backend = makeBackend({
      items: [makeItem({ id: 'r', name: 'Protected', reprompt: true })],
      passwords: { r: 'never-leaks' },
    });
    renderTray(backend);
    await screen.findByText('Protected');

    fireEvent.click(screen.getByTitle('Edit login'));

    // The gate is up, nothing fetched, and no edit form rendered.
    await screen.findAllByText("Verify it's you");
    expect(backend.invoked('item_detail')).toHaveLength(0);
    expect(screen.queryByPlaceholderText('Name')).toBeNull();
  });
});
