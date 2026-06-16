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
  PasskeyCredential,
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
  /** itemId → stored passkeys returned by item_detail. */
  passkeys: Record<string, PasskeyCredential[]>;
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
      typedUsername: null,
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
    passkeys: {},
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
          passkeys: state.passkeys[item.id] ?? [],
        });
      }
      case 'remove_passkey': {
        const itemId = args.itemId as string;
        state.passkeys[itemId] = (state.passkeys[itemId] ?? []).filter(
          (p) => p.credentialId !== args.credentialId,
        );
        return null;
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
      case 'delete_items': {
        const ids = args.ids as string[];
        // permanent → drop the row; else soft-delete (the recycle-bin move).
        if (args.permanent) {
          state.items = state.items.filter((i) => !ids.includes(i.id));
        } else {
          state.items = state.items.map((i) =>
            ids.includes(i.id) ? { ...i, deleted: true } : i,
          );
        }
        return null;
      }
      case 'restore_items': {
        const ids = args.ids as string[];
        state.items = state.items.map((i) =>
          ids.includes(i.id) ? { ...i, deleted: false } : i,
        );
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

  it('removes a stored passkey from the detail view', async () => {
    const backend = makeBackend({
      items: [makeItem({ id: 'gh', name: 'GitHub', username: 'neo', hasPasskey: true })],
      passkeys: {
        gh: [
          {
            credentialId: 'cred-abc',
            rpId: 'github.com',
            rpName: 'GitHub',
            userName: 'neo',
            userDisplayName: null,
            keyAlgorithm: 'ES256',
            creationDate: '2026-01-01T00:00:00Z',
          },
        ],
      },
    });
    renderTray(backend);
    await screen.findByText('GitHub');

    // Open the detail view (row click) → the passkey shows with a remove button.
    fireEvent.click(screen.getByText('GitHub'));
    const removeBtn = await screen.findByTitle('Remove passkey');
    fireEvent.click(removeBtn);

    await waitFor(() => expect(backend.invoked('remove_passkey')).toHaveLength(1));
    expect(backend.invoked('remove_passkey')[0]?.args).toMatchObject({
      accountEmail: 'tester@example.com',
      itemId: 'gh',
      credentialId: 'cred-abc',
    });
    // The passkey row disappears from the pane.
    await waitFor(() => expect(screen.queryByTitle('Remove passkey')).toBeNull());
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

// ── Trash: view, restore, purge ───────────────────────────────────────────────
// A trashed item is filtered out of the active list, so the Trash entry is the
// ONLY way back to it — to restore it or delete it for good. The restore /
// delete-permanently buttons live in TrayDetail, gated on item.deleted, and were
// previously unreachable because nothing surfaced a trashed item.

describe('TrayApp integration — trash', () => {
  it('reaches a trashed item through the Trash entry and restores it to the list', async () => {
    const backend = makeBackend({
      items: [
        makeItem({ id: 'gh', name: 'GitHub', username: 'neo' }),
        makeItem({ id: 'old', name: 'Old Account', deleted: true }),
      ],
      passwords: { old: 'stale' },
    });
    renderTray(backend);

    // The active list shows the live item, never the trashed one.
    await screen.findByText('GitHub');
    expect(screen.queryByText('Old Account')).toBeNull();

    // The Trash entry (count = 1) is the only way back to the trashed item.
    fireEvent.click(await screen.findByRole('button', { name: /trash/i }));
    fireEvent.click(await screen.findByText('Old Account'));

    // Detail offers Restore — only on a trashed item — and restoring returns it live.
    fireEvent.click(await screen.findByTitle('Restore'));

    await waitFor(() => expect(backend.invoked('restore_items')).toHaveLength(1));
    expect(backend.invoked('restore_items')[0]?.args).toMatchObject({
      accountEmail: 'tester@example.com',
      ids: ['old'],
    });
    // Trash now empty → back on the active list, which shows BOTH items (the
    // trash view never lists the live GitHub, so seeing both proves we exited).
    await waitFor(() => {
      expect(screen.getByText('Old Account')).toBeTruthy();
      expect(screen.getByText('GitHub')).toBeTruthy();
    });
  });

  it('permanently deletes a trashed item behind the inline confirm', async () => {
    const backend = makeBackend({
      items: [makeItem({ id: 'old', name: 'Old Account', deleted: true })],
      passwords: { old: 'stale' },
    });
    renderTray(backend);

    // No live items; the Trash entry is the only affordance.
    await screen.findByText('No matches.');
    fireEvent.click(await screen.findByRole('button', { name: /trash/i }));
    fireEvent.click(await screen.findByText('Old Account'));

    // Delete-permanently is irreversible → inline-confirmed before it fires.
    fireEvent.click(await screen.findByTitle('Delete permanently'));
    fireEvent.click(await screen.findByText('Delete'));

    await waitFor(() => expect(backend.invoked('delete_items')).toHaveLength(1));
    expect(backend.invoked('delete_items')[0]?.args).toMatchObject({
      accountEmail: 'tester@example.com',
      ids: ['old'],
      permanent: true,
    });
    // Gone for good: trash empties → back to the (now empty) active list.
    await waitFor(() => expect(screen.queryByText('Old Account')).toBeNull());
    expect(screen.getByText('No matches.')).toBeTruthy();
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
  it('autofill://detected filters the list SECRETLY (empty search box); clicking the match fills + dismisses', async () => {
    const backend = makeBackend({
      items: [makeItem({ id: 'gh', name: 'Outlook', username: 'neo', uri: 'https://outlook.com' })],
      pending: makePending({ token: 'tok-9' }),
    });
    renderTray(backend);
    await screen.findByPlaceholderText('Search vault…');

    await emit('autofill://detected');
    await screen.findByText('Fill into Sign in – Outlook');
    // The list is filtered to the app SECRETLY — the search box stays empty…
    const search = screen.getByPlaceholderText('Search vault…') as HTMLInputElement;
    expect(search.value).toBe('');
    // …but the matching login is shown.
    expect(screen.getByText('Outlook')).toBeTruthy();

    fireEvent.click(screen.getByText('Outlook'));

    // An auto-matched pick (no manual query) fills straight away — no remember prompt.
    await waitFor(() => expect(backend.invoked('autofill_fill')).toHaveLength(1));
    expect(backend.invoked('autofill_fill')[0]?.args).toMatchObject({
      token: 'tok-9',
      accountEmail: 'tester@example.com',
      itemId: 'gh',
    });
    expect(backend.invoked('autofill_associate')).toHaveLength(0);
    await waitFor(() => expect(screen.queryByText('Fill into Sign in – Outlook')).toBeNull());
  });

  it('a manual-search pick prompts to remember the site; "Remember & fill" stores the domain then fills', async () => {
    const backend = makeBackend({
      items: [
        makeItem({ id: 'gh', name: 'GitHub', uri: 'https://github.com' }),
        makeItem({ id: 'note', name: 'Secret Note', uri: '' }),
      ],
      pending: makePending({
        token: 'tok-4',
        context: {
          field: 'password',
          processName: 'chrome',
          windowTitle: 'GitHub',
          url: 'https://github.com/login',
          associateUri: null,
          typedUsername: null,
        },
      }),
    });
    renderTray(backend);
    await screen.findByPlaceholderText('Search vault…');

    await emit('autofill://detected');
    await screen.findByText('Fill into GitHub');
    // Secret filter (github.com): the GitHub login shows, the unrelated note hides.
    expect(screen.getByText('GitHub')).toBeTruthy();
    expect(screen.queryByText('Secret Note')).toBeNull();

    // The user searches for a DIFFERENT login (one that doesn't match the site).
    const search = screen.getByPlaceholderText('Search vault…') as HTMLInputElement;
    fireEvent.input(search, { target: { value: 'note' } });
    fireEvent.click(await screen.findByText('Secret Note'));

    // Picking it asks whether to remember the site for it (instead of filling).
    await screen.findByText('Remember Secret Note for GitHub?');
    expect(backend.invoked('autofill_fill')).toHaveLength(0);

    fireEvent.click(screen.getByText('Remember & fill'));

    // Remembers the site DOMAIN on that login, then fills it.
    await waitFor(() => expect(backend.invoked('autofill_associate')).toHaveLength(1));
    expect(backend.invoked('autofill_associate')[0]?.args).toMatchObject({
      accountEmail: 'tester@example.com',
      itemId: 'note',
      uri: 'github.com',
    });
    await waitFor(() => expect(backend.invoked('autofill_fill')).toHaveLength(1));
    expect(backend.invoked('autofill_fill')[0]?.args).toMatchObject({ token: 'tok-4', itemId: 'note' });
  });

  it('after filling a login that also has a TOTP, the current code lands on the clipboard', async () => {
    const backend = makeBackend({
      items: [makeItem({ id: 'gh', name: 'Outlook', uri: 'https://outlook.com', hasTotp: true })],
      pending: makePending({ token: 'tok-totp' }),
    });
    renderTray(backend);
    await screen.findByPlaceholderText('Search vault…');

    await emit('autofill://detected');
    await screen.findByText('Fill into Sign in – Outlook');
    fireEvent.click(screen.getByText('Outlook'));

    // The password is filled, then the TOTP code is copied for the next step.
    await waitFor(() => expect(backend.invoked('autofill_fill')).toHaveLength(1));
    await waitFor(() => expect(backend.state.clipboard).toBe('123456'));
    expect(backend.invoked('item_totp')).toHaveLength(1);
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

    // Secretly filtered to the detected app: search box empty, Outlook shown, GitHub hidden.
    const search = screen.getByPlaceholderText('Search vault…') as HTMLInputElement;
    expect(search.value).toBe('');
    expect(screen.getByText('Outlook')).toBeTruthy();
    expect(screen.queryByText('GitHub')).toBeNull();

    // The user can still search for a different item, then fill it. This detection
    // exposed no URL/app association, so there's nothing to remember → fills directly.
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

  it('offers to save a new login when nothing matches; opens the add form prefilled with the read username', async () => {
    const backend = makeBackend({
      items: [], // an empty vault: the detection has nothing to fill
      pending: makePending({
        token: 'tok-3',
        context: {
          field: 'password',
          processName: 'msedgewebview2',
          windowTitle: 'Sign in',
          url: 'https://accounts.example.com/login',
          associateUri: 'app://msedgewebview2',
          typedUsername: 'neo@example.com',
        },
        candidates: [],
      }),
    });
    renderTray(backend);
    await screen.findByPlaceholderText('Search vault…');

    await emit('autofill://detected');

    // The save-new-login prompt appears (browser-style "save this login?").
    const save = await screen.findByText('Save login');
    fireEvent.click(save);

    // Lands in the add form, prefilled from the detection: the site name + URI and
    // the username the backend read from the target field.
    const name = (await screen.findByPlaceholderText('Name')) as HTMLInputElement;
    expect(name.value).toBe('Example');
    expect((screen.getByPlaceholderText('Username') as HTMLInputElement).value).toBe(
      'neo@example.com',
    );
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
    // The lone connection is still offered as an explicit destination: the picker
    // shows it, and opening the dropdown lists it as an option.
    const picker = await screen.findByRole('combobox', { name: 'Save to' });
    expect(picker.textContent).toContain('me@x.com');
    fireEvent.click(picker);
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

    // The folder picker shows once list_folders resolves (it's the "Folder"
    // combobox — the vault picker is "Save to"). Open it and choose "Work".
    fireEvent.click(await screen.findByRole('combobox', { name: 'Folder' }));
    fireEvent.click(await screen.findByRole('option', { name: 'Work' }));

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
