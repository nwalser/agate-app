// Unit tests for the tray quick-access store (factory with injected deps — no
// module mocking, per the createSecurityScans pattern). Covers the pure
// filter/rank helper and the store's refresh/copy/reprompt behavior.

import { describe, expect, it, vi } from 'vitest';
import {
  makeCollection,
  makeConnection,
  makeDetail,
  makeFolder,
  makeItem,
  makeLoginDetail,
} from '../testing/factories.ts';
import type {
  AutofillCandidate,
  AutofillPending,
  SessionStatus,
  TotpCode,
  UnlockOutcome,
  VaultItem,
} from '../lib/types.ts';
import {
  type AddDraft,
  buildEditInput,
  connectionIdentity,
  connectionLabel,
  copyActionForKey,
  createTrayStore,
  domainOf,
  draftFromContext,
  fillQueryFromContext,
  filterTrayItems,
  findSimilarLogins,
  isWritableKind,
  loginNameFromUri,
  TRAY_MAX_RESULTS,
  type TrayStoreDeps,
} from './trayStore.ts';

/** A ranked autofill candidate (only the fields the popup reads). */
function makeCandidate(over: Partial<AutofillCandidate> = {}): AutofillCandidate {
  return {
    accountEmail: 'me@x.com',
    accountLabel: 'Bitwarden',
    itemId: 'cand',
    name: 'Candidate',
    username: 'neo',
    uri: 'https://example.com',
    reprompt: false,
    score: 100,
    ...over,
  };
}

function makePending(over: Partial<AutofillPending> = {}): AutofillPending {
  return {
    token: 'tok-1',
    context: { field: 'password', processName: 'outlook', windowTitle: 'Sign in', url: null, associateUri: null, typedUsername: null },
    candidates: [makeCandidate()],
    ...over,
  };
}

const unlockedStatus: SessionStatus = {
  appUnlockConfigured: true,
  unlocked: true,
  helloConfigured: false,
  connectionCount: 1,
  liveCount: 1,
};

const lockedStatus: SessionStatus = { ...unlockedStatus, unlocked: false };

function makeDeps(over: {
  status?: SessionStatus;
  items?: VaultItem[];
  password?: string | null;
  totp?: TotpCode;
  outcomes?: UnlockOutcome[];
  pending?: AutofillPending | null;
  connections?: ReturnType<typeof makeConnection>[];
  folders?: ReturnType<typeof makeFolder>[];
  collections?: ReturnType<typeof makeCollection>[];
  generated?: string;
  reuseCount?: number;
  strength?: number;
  defaultAccount?: string;
} = {}) {
  const deps = {
    ipc: {
      getSessionStatus: vi.fn(async () => over.status ?? unlockedStatus),
      // Fresh clones per call, like real IPC deserialization — so identity
      // tests prove the store reconciles, not that the fake reuses objects.
      listItems: vi.fn(async () => (over.items ?? []).map((i) => ({ ...i }))),
      itemDetail: vi.fn(async (accountEmail: string, id: string) =>
        makeDetail({
          id,
          name: 'detail',
          accountEmail,
          login: makeLoginDetail({ password: over.password ?? 'hunter2' }),
        }),
      ),
      itemTotp: vi.fn(async () => over.totp ?? { code: '123456', period: 30, remaining: 10 }),
      unlockAll: vi.fn(async () => over.outcomes ?? []),
      helloUnlock: vi.fn(async () => over.outcomes ?? []),
      autofillPending: vi.fn(async () => over.pending ?? null),
      autofillFill: vi.fn(async () => {}),
      autofillDismiss: vi.fn(async () => {}),
      autofillAssociate: vi.fn(async () => {}),
      listConnections: vi.fn(async () => over.connections ?? [makeConnection({ email: 'me@x.com' })]),
      listFolders: vi.fn(async () => over.folders ?? []),
      listCollections: vi.fn(async () => over.collections ?? []),
      generatePassword: vi.fn(async () => over.generated ?? 'Gen3rated!Pass'),
      saveItem: vi.fn(async () => {}),
      passwordInUse: vi.fn(async () => over.reuseCount ?? 0),
      passwordStrength: vi.fn(async () => over.strength ?? 0),
    },
    copy: vi.fn(async () => {}),
    onUsed: vi.fn(),
    onError: vi.fn(),
    onRepromptBlocked: vi.fn(),
    onTwoFactorPending: vi.fn(),
    defaultAccount: vi.fn(() => over.defaultAccount ?? ''),
  } satisfies TrayStoreDeps;
  return deps;
}

describe('filterTrayItems', () => {
  it('excludes deleted items', () => {
    const items = [
      makeItem({ id: 'a', name: 'Alive' }),
      makeItem({ id: 'b', name: 'Binned', deleted: true }),
    ];
    expect(filterTrayItems(items, '').map((i) => i.id)).toEqual(['a']);
  });

  it('in trash mode lists ONLY deleted items (the inverse set)', () => {
    const items = [
      makeItem({ id: 'a', name: 'Alive' }),
      makeItem({ id: 'b', name: 'Binned', deleted: true }),
    ];
    expect(filterTrayItems(items, '', true).map((i) => i.id)).toEqual(['b']);
  });

  it('with an empty query lists favorites first, then alphabetically', () => {
    const items = [
      makeItem({ id: 'z', name: 'Zeta' }),
      makeItem({ id: 'f', name: 'Mid', favorite: true }),
      makeItem({ id: 'a', name: 'Alpha' }),
    ];
    expect(filterTrayItems(items, '').map((i) => i.id)).toEqual(['f', 'a', 'z']);
  });

  it('matches name, username and uri case-insensitively', () => {
    const items = [
      makeItem({ id: 'n', name: 'GitHub' }),
      makeItem({ id: 'u', name: 'Forge', username: 'GITHUB-bot' }),
      makeItem({ id: 'r', name: 'Mirror', uri: 'https://github.com/login' }),
      makeItem({ id: 'x', name: 'Unrelated' }),
    ];
    expect(filterTrayItems(items, 'github').map((i) => i.id).sort()).toEqual(['n', 'r', 'u']);
  });

  it('ranks name prefix over name substring over username/uri-only matches', () => {
    const items = [
      makeItem({ id: 'uri-only', name: 'Zzz', uri: 'https://git.example.com' }),
      makeItem({ id: 'substr', name: 'My git' }),
      makeItem({ id: 'prefix', name: 'git server' }),
    ];
    expect(filterTrayItems(items, 'git').map((i) => i.id)).toEqual(['prefix', 'substr', 'uri-only']);
  });

  it('caps the result list', () => {
    const items = Array.from({ length: TRAY_MAX_RESULTS + 20 }, (_, i) =>
      makeItem({ id: `i${i}`, name: `Item ${String(i).padStart(3, '0')}` }),
    );
    expect(filterTrayItems(items, '')).toHaveLength(TRAY_MAX_RESULTS);
  });
});

describe('filterTrayItems ordering stability', () => {
  it('ignores recency entirely — order never changes because something was copied', () => {
    // Regression (user feedback): rows must NOT jump right after a copy.
    const items = [
      makeItem({ id: 'a', name: 'Alpha' }),
      makeItem({ id: 'f', name: 'Fav', favorite: true }),
      makeItem({ id: 'z', name: 'Zulu' }),
    ];
    expect(filterTrayItems(items, '').map((i) => i.id)).toEqual(['f', 'a', 'z']);
  });
});

describe('copyActionForKey', () => {
  const ev = (over: Partial<Pick<KeyboardEvent, 'key' | 'shiftKey' | 'ctrlKey' | 'metaKey'>>) => ({
    key: 'Enter',
    shiftKey: false,
    ctrlKey: false,
    metaKey: false,
    ...over,
  });

  it('Enter copies the password', () => {
    expect(copyActionForKey(ev({}))).toBe('password');
  });
  it('Shift+Enter copies the username', () => {
    expect(copyActionForKey(ev({ shiftKey: true }))).toBe('username');
  });
  it('Ctrl+Enter and Cmd+Enter copy the TOTP code', () => {
    expect(copyActionForKey(ev({ ctrlKey: true }))).toBe('totp');
    expect(copyActionForKey(ev({ metaKey: true }))).toBe('totp');
  });
  it('any other key maps to no action', () => {
    expect(copyActionForKey(ev({ key: 'a' }))).toBeNull();
    expect(copyActionForKey(ev({ key: 'Escape' }))).toBeNull();
  });
});

describe('createTrayStore accounts + usage reporting', () => {
  it('multiAccount() flips only when items span more than one connection', async () => {
    const one = createTrayStore(
      makeDeps({ items: [makeItem({ id: 'a', name: 'A' }), makeItem({ id: 'b', name: 'B' })] }),
    );
    await one.refresh();
    expect(one.multiAccount()).toBe(false);

    const two = createTrayStore(
      makeDeps({
        items: [
          makeItem({ id: 'a', name: 'A', accountEmail: 'one@x.com' }),
          makeItem({ id: 'b', name: 'B', accountEmail: 'two@x.com' }),
        ],
      }),
    );
    await two.refresh();
    expect(two.multiAccount()).toBe(true);
  });

  it('successful copies report the item via onUsed', async () => {
    const deps = makeDeps();
    const store = createTrayStore(deps);
    const item = makeItem({ id: 'a', name: 'A', username: 'neo', hasTotp: true });
    await store.copyUsername(item);
    await store.copyPassword(item);
    await store.copyTotp(item);
    expect(deps.onUsed).toHaveBeenCalledTimes(3);
    expect(deps.onUsed).toHaveBeenCalledWith(item);
  });

  it('a reprompt-blocked or failed copy never reports onUsed', async () => {
    const deps = makeDeps();
    const store = createTrayStore(deps);
    await store.copyPassword(makeItem({ id: 'a', name: 'A', reprompt: true }));
    deps.ipc.itemDetail.mockRejectedValueOnce(new Error('boom'));
    await store.copyPassword(makeItem({ id: 'b', name: 'B' }));
    expect(deps.onUsed).not.toHaveBeenCalled();
  });

  it('copyUsername on an item without a username reports nothing', async () => {
    const deps = makeDeps();
    const store = createTrayStore(deps);
    await store.copyUsername(makeItem({ id: 'a', name: 'A', username: null }));
    expect(deps.onUsed).not.toHaveBeenCalled();
  });
});

describe('findSimilarLogins', () => {
  it('matches an existing login on the same website host despite a different name', () => {
    const items = [
      makeItem({ id: 'gh', name: 'Code forge', uri: 'https://github.com/login' }),
      makeItem({ id: 'other', name: 'Email', uri: 'https://mail.example.com' }),
    ];
    expect(
      findSimilarLogins(items, { name: 'GH work', uri: 'github.com' }).map((i) => i.id),
    ).toEqual(['gh']);
  });

  it('matches on exact name (case-insensitive) and on name substrings both ways', () => {
    const items = [
      makeItem({ id: 'exact', name: 'GitHub' }),
      makeItem({ id: 'longer', name: 'GitHub Enterprise' }),
      makeItem({ id: 'unrelated', name: 'Bank' }),
    ];
    const ids = findSimilarLogins(items, { name: 'github', uri: '' }).map((i) => i.id);
    expect(ids).toContain('exact');
    expect(ids).toContain('longer');
    expect(ids).not.toContain('unrelated');
    // Exact match outranks the substring match.
    expect(ids[0]).toBe('exact');
  });

  it('ignores very short name fragments (no noise from 1–2 letter drafts)', () => {
    const items = [makeItem({ id: 'a', name: 'Bank' })];
    expect(findSimilarLogins(items, { name: 'ba', uri: '' })).toEqual([]);
  });

  it('skips deleted items and non-logins', () => {
    const items = [
      makeItem({ id: 'del', name: 'GitHub', deleted: true }),
      makeItem({ id: 'note', name: 'GitHub', itemType: 'secureNote' }),
    ];
    expect(findSimilarLogins(items, { name: 'GitHub', uri: '' })).toEqual([]);
  });

  it('host match outranks a name-only match, and the list caps at 3', () => {
    const items = [
      makeItem({ id: 'name-only', name: 'Acme' }),
      makeItem({ id: 'host', name: 'Different', uri: 'https://acme.com' }),
      makeItem({ id: 'n2', name: 'Acme 2' }),
      makeItem({ id: 'n3', name: 'Acme 3' }),
      makeItem({ id: 'n4', name: 'Acme 4' }),
    ];
    const ids = findSimilarLogins(items, { name: 'Acme', uri: 'https://acme.com' }).map(
      (i) => i.id,
    );
    expect(ids[0]).toBe('host');
    expect(ids).toHaveLength(3);
  });

  it('an empty draft matches nothing', () => {
    const items = [makeItem({ id: 'a', name: 'Anything' })];
    expect(findSimilarLogins(items, { name: '', uri: '' })).toEqual([]);
  });
});

describe('loginNameFromUri', () => {
  it('derives the capitalized registrable label from a URL', () => {
    expect(loginNameFromUri('https://login.github.com/session')).toBe('Github');
    expect(loginNameFromUri('github.com')).toBe('Github');
    expect(loginNameFromUri('https://www.example.co/page')).toBe('Example');
  });

  it('handles a synthetic app:// association URI', () => {
    expect(loginNameFromUri('app://outlook')).toBe('Outlook');
  });

  it('returns empty for blank input', () => {
    expect(loginNameFromUri('')).toBe('');
    expect(loginNameFromUri('   ')).toBe('');
  });
});

describe('domainOf', () => {
  it('strips scheme, path, query, port, userinfo and a leading www.', () => {
    expect(domainOf('https://www.passwordmonster.com/test/page?x=1')).toBe('passwordmonster.com');
    expect(domainOf('http://user:pw@accounts.google.com:8443/signin')).toBe('accounts.google.com');
    expect(domainOf('passwordmonster.com')).toBe('passwordmonster.com');
  });

  it('keeps non-www subdomains (host-level, the registrable reduction is the matcher’s job)', () => {
    expect(domainOf('https://login.github.com/x')).toBe('login.github.com');
  });

  it('is empty for a hostless input (blank or a synthetic app:// association)', () => {
    expect(domainOf('')).toBe('');
    expect(domainOf('   ')).toBe('');
    expect(domainOf('app://outlook')).toBe('');
  });
});

describe('draftFromContext', () => {
  // Spread from the shared pending fixture so this survives the AutofillContext
  // struct gaining fields (only url/associateUri/processName matter here).
  const ctx = (over: Partial<AutofillPending['context']>) => ({ ...makePending().context, ...over });

  it('recommends just the domain of the real URL (no scheme/path) and a name guessed from it', () => {
    expect(
      draftFromContext(
        ctx({
          processName: 'msedgewebview2',
          url: 'https://accounts.google.com/signin?x=1',
          associateUri: 'app://msedgewebview2',
        }),
      ),
    ).toEqual({ name: 'Google', uri: 'accounts.google.com' });
  });

  it('falls back to the app-association URI and the process name', () => {
    expect(
      draftFromContext(ctx({ processName: 'outlook', url: null, associateUri: 'app://outlook' })),
    ).toEqual({ name: 'Outlook', uri: 'app://outlook' });
  });

  it('prefills the username the backend read from the detected field', () => {
    expect(
      draftFromContext(
        ctx({
          processName: 'msedgewebview2',
          url: 'https://accounts.google.com/signin',
          associateUri: 'app://msedgewebview2',
          typedUsername: 'neo@example.com',
        }),
      ),
    ).toEqual({ name: 'Google', uri: 'accounts.google.com', username: 'neo@example.com' });
  });

  it('ignores a blank / whitespace-only read username', () => {
    expect(
      draftFromContext(ctx({ processName: 'outlook', url: null, associateUri: 'app://outlook', typedUsername: '   ' })),
    ).toEqual({ name: 'Outlook', uri: 'app://outlook' });
  });

  it('returns nothing usable for an empty / null context', () => {
    expect(draftFromContext(null)).toEqual({});
    expect(
      draftFromContext(ctx({ processName: null, url: null, associateUri: null })),
    ).toEqual({});
  });
});

describe('fillQueryFromContext', () => {
  const ctx = (over: Partial<AutofillPending['context']>) => ({ ...makePending().context, ...over });

  it('seeds the site domain from the real URL so the list filters by URL not name', () => {
    expect(
      fillQueryFromContext(ctx({ processName: 'msedgewebview2', url: 'https://login.github.com/x' })),
    ).toBe('login.github.com');
    // The reported bug: on passwordmonster.com the box showed "Passwordmonster".
    expect(
      fillQueryFromContext(ctx({ processName: 'chrome', url: 'https://www.passwordmonster.com/test' })),
    ).toBe('passwordmonster.com');
  });

  it('falls back to the process name for a native app (no URL)', () => {
    expect(
      fillQueryFromContext(ctx({ processName: 'outlook', url: null, associateUri: 'app://outlook' })),
    ).toBe('outlook');
  });

  it('falls back to the process name when no URL/association is known', () => {
    expect(fillQueryFromContext(ctx({ processName: 'discord', url: null, associateUri: null }))).toBe(
      'discord',
    );
  });

  it('is empty when the context yields nothing usable', () => {
    expect(fillQueryFromContext(null)).toBe('');
    expect(fillQueryFromContext(ctx({ processName: null, url: null, associateUri: null }))).toBe('');
  });
});

describe('createTrayStore add-login', () => {
  it('enterAdd opens the form, prefills the name from the query and loads accounts', async () => {
    const deps = makeDeps();
    const store = createTrayStore(deps);
    await store.refresh();
    store.setQuery('GitHub');
    await store.enterAdd();
    expect(store.addMode()).toBe(true);
    expect(store.draft().name).toBe('GitHub');
    expect(store.account()).toBe('me@x.com');
    expect(deps.ipc.listConnections).toHaveBeenCalled();
  });

  it('offers only writable connections as destinations and tracks each provider kind', async () => {
    const deps = makeDeps({
      connections: [
        makeConnection({ email: 'bw@x.com', kind: 'bitwarden' }),
        makeConnection({ email: 'kp@x.com', kind: 'keepass' }),
        // Read-only providers can't take a new item — excluded from the picker.
        makeConnection({ email: 'pass@x.com', kind: 'pass' }),
      ],
    });
    const store = createTrayStore(deps);
    await store.enterAdd();
    expect(store.accounts()).toEqual(['bw@x.com', 'kp@x.com']);
    expect(store.account()).toBe('bw@x.com');
    expect(store.accountKind()).toBe('bitwarden');
    // Switching the destination re-derives the provider for the form's chrome.
    store.setAccount('kp@x.com');
    expect(store.accountKind()).toBe('keepass');
  });

  it('enterAdd preselects the pinned default account when it is an available destination', async () => {
    const deps = makeDeps({
      connections: [
        makeConnection({ email: 'bw@x.com', kind: 'bitwarden' }),
        makeConnection({ email: 'kp@x.com', kind: 'keepass' }),
      ],
      defaultAccount: 'kp@x.com',
    });
    const store = createTrayStore(deps);
    await store.enterAdd();
    // Not the first writable connection — the pinned default wins.
    expect(store.account()).toBe('kp@x.com');
  });

  it('enterAdd ignores a default that is not an available destination (locked / read-only / gone)', async () => {
    const deps = makeDeps({
      connections: [
        makeConnection({ email: 'bw@x.com', kind: 'bitwarden', unlocked: true }),
        // Pinned default, but locked → not offered as a destination this session.
        makeConnection({ email: 'kp@x.com', kind: 'keepass', unlocked: false }),
      ],
      defaultAccount: 'kp@x.com',
    });
    const store = createTrayStore(deps);
    await store.enterAdd();
    // Falls back to the first writable, unlocked connection.
    expect(store.account()).toBe('bw@x.com');
  });

  it('generateDraftPassword fills the draft from the generator', async () => {
    const deps = makeDeps({ generated: 'S3cure#Pass!' });
    const store = createTrayStore(deps);
    await store.enterAdd();
    await store.generateDraftPassword();
    expect(store.draft().password).toBe('S3cure#Pass!');
    expect(deps.ipc.generatePassword).toHaveBeenCalled();
  });

  it('checkReuse reports how many existing logins already use the draft password', async () => {
    const deps = makeDeps({ reuseCount: 2 });
    const store = createTrayStore(deps);
    await store.enterAdd();
    store.setDraft({ password: 'hunter2' });
    await store.checkReuse();
    expect(store.reuseCount()).toBe(2);
    expect(deps.ipc.passwordInUse).toHaveBeenCalledWith('hunter2');
  });

  it('checkReuse with an empty password short-circuits to 0 without IPC', async () => {
    const deps = makeDeps({ reuseCount: 9 });
    const store = createTrayStore(deps);
    await store.enterAdd();
    await store.checkReuse();
    expect(store.reuseCount()).toBe(0);
    expect(store.strength()).toBeNull();
    expect(deps.ipc.passwordInUse).not.toHaveBeenCalled();
    expect(deps.ipc.passwordStrength).not.toHaveBeenCalled();
  });

  it('checkReuse also scores the draft password, seeding zxcvbn with the draft fields', async () => {
    const deps = makeDeps({ strength: 4 });
    const store = createTrayStore(deps);
    await store.enterAdd();
    store.setDraft({ name: 'GitHub', username: 'neo', password: 'hunter2', uri: 'github.com' });
    await store.checkReuse();
    expect(store.strength()).toBe(4);
    expect(deps.ipc.passwordStrength).toHaveBeenCalledWith('hunter2', ['neo', 'github.com', 'GitHub']);
  });

  it('a failed strength check leaves strength null but still reports reuse', async () => {
    const deps = makeDeps({ reuseCount: 2 });
    deps.ipc.passwordStrength.mockRejectedValueOnce(new Error('boom'));
    const store = createTrayStore(deps);
    await store.enterAdd();
    store.setDraft({ password: 'hunter2' });
    await store.checkReuse();
    expect(store.reuseCount()).toBe(2);
    expect(store.strength()).toBeNull();
    expect(deps.onError).toHaveBeenCalledOnce();
  });

  it('enterAdd accepts a prefill that overrides the query-derived name', async () => {
    const deps = makeDeps();
    const store = createTrayStore(deps);
    await store.refresh();
    store.setQuery('stale search');
    await store.enterAdd({ name: 'Outlook', uri: 'app://outlook' });
    expect(store.draft().name).toBe('Outlook');
    expect(store.draft().uri).toBe('app://outlook');
  });

  it('saveNew refuses an empty name', async () => {
    const deps = makeDeps();
    const store = createTrayStore(deps);
    await store.enterAdd();
    await expect(store.saveNew()).resolves.toBe(false);
    expect(deps.ipc.saveItem).not.toHaveBeenCalled();
  });

  it('saveNew creates a login on the chosen account, refreshes and leaves the form', async () => {
    const deps = makeDeps();
    const store = createTrayStore(deps);
    await store.refresh();
    await store.enterAdd();
    store.setDraft({
      name: 'GitHub',
      username: 'neo',
      password: 'pw',
      uri: 'https://github.com',
    });
    const listCallsBefore = deps.ipc.listItems.mock.calls.length;

    await expect(store.saveNew()).resolves.toBe(true);
    expect(deps.ipc.saveItem).toHaveBeenCalledWith(
      'me@x.com',
      expect.objectContaining({
        id: null,
        itemType: 'login',
        name: 'GitHub',
        login: expect.objectContaining({
          username: 'neo',
          password: 'pw',
          uris: [{ uri: 'https://github.com', matchType: null }],
        }),
      }),
    );
    expect(store.addMode()).toBe(false);
    expect(deps.ipc.listItems.mock.calls.length).toBeGreaterThan(listCallsBefore);
  });

  it('derives the org list from the account collections and scopes collections to the chosen org', async () => {
    const deps = makeDeps({
      connections: [
        makeConnection({ email: 'bw@x.com', kind: 'bitwarden' }),
        makeConnection({ email: 'kp@x.com', kind: 'keepass' }),
      ],
      collections: [
        makeCollection({ id: 'c-eng', name: 'Engineering', accountEmail: 'bw@x.com', organizationId: 'org-9', organizationName: 'Acme' }),
        makeCollection({ id: 'c-ops', name: 'Ops', accountEmail: 'bw@x.com', organizationId: 'org-9', organizationName: 'Acme' }),
        makeCollection({ id: 'c-other', name: 'Other', accountEmail: 'someone@else.com', organizationId: 'org-x', organizationName: 'Else' }),
      ],
    });
    const store = createTrayStore(deps);
    await store.enterAdd();
    // Orgs come from the selected account's collections (each org once).
    expect(store.organizationOptions()).toEqual([{ id: 'org-9', name: 'Acme' }]);
    // No org chosen yet → personal vault → no collections shown.
    expect(store.organizationId()).toBeNull();
    expect(store.collectionOptions()).toEqual([]);
    // Choosing the org scopes its collections AND auto-selects the first (an org
    // cipher must belong to a collection).
    store.setOrganization('org-9');
    expect(store.collectionOptions().map((c) => c.id)).toEqual(['c-eng', 'c-ops']);
    expect(store.collectionId()).toBe('c-eng');
    // Back to the personal vault clears the collection.
    store.setOrganization(null);
    expect(store.collectionId()).toBeNull();
    // Switching the destination account resets org + collection (ids are per-vault).
    store.setOrganization('org-9');
    store.setAccount('kp@x.com');
    expect(store.organizationId()).toBeNull();
    expect(store.collectionId()).toBeNull();
    expect(store.collectionOptions()).toEqual([]);
  });

  it('saveNew into an org collection creates an org cipher (org + collectionIds from the collection)', async () => {
    const deps = makeDeps({
      connections: [makeConnection({ email: 'bw@x.com', kind: 'bitwarden' })],
      collections: [
        makeCollection({ id: 'c-eng', name: 'Engineering', accountEmail: 'bw@x.com', organizationId: 'org-9', organizationName: 'Acme' }),
      ],
    });
    const store = createTrayStore(deps);
    await store.refresh();
    await store.enterAdd();
    store.setDraft({ name: 'CI bot' });
    // Picking the org auto-selects its (only) collection.
    store.setOrganization('org-9');
    expect(store.collectionId()).toBe('c-eng');
    await expect(store.saveNew()).resolves.toBe(true);
    expect(deps.ipc.saveItem).toHaveBeenCalledWith(
      'bw@x.com',
      expect.objectContaining({ organizationId: 'org-9', collectionIds: ['c-eng'] }),
    );
  });

  it('saveNew with no collection creates a personal cipher (no org, empty collectionIds)', async () => {
    const deps = makeDeps({
      connections: [makeConnection({ email: 'bw@x.com', kind: 'bitwarden' })],
      collections: [
        makeCollection({ id: 'c-eng', name: 'Engineering', accountEmail: 'bw@x.com', organizationId: 'org-9' }),
      ],
    });
    const store = createTrayStore(deps);
    await store.refresh();
    await store.enterAdd();
    store.setDraft({ name: 'Personal note' });
    await expect(store.saveNew()).resolves.toBe(true);
    expect(deps.ipc.saveItem).toHaveBeenCalledWith(
      'bw@x.com',
      expect.objectContaining({ organizationId: null, collectionIds: [] }),
    );
  });

  it('saveNew sends the TOTP, notes, favorite and reprompt from the draft', async () => {
    const deps = makeDeps();
    const store = createTrayStore(deps);
    await store.refresh();
    await store.enterAdd();
    store.setDraft({
      name: 'GitHub',
      totp: 'JBSWY3DPEHPK3PXP',
      notes: 'work account',
      favorite: true,
      reprompt: true,
    });
    await expect(store.saveNew()).resolves.toBe(true);
    expect(deps.ipc.saveItem).toHaveBeenCalledWith(
      'me@x.com',
      expect.objectContaining({
        favorite: true,
        reprompt: true,
        notes: 'work account',
        login: expect.objectContaining({ totp: 'JBSWY3DPEHPK3PXP' }),
      }),
    );
  });

  it('a failed save surfaces onError and keeps the form open', async () => {
    const deps = makeDeps();
    deps.ipc.saveItem.mockRejectedValueOnce(new Error('offline'));
    const store = createTrayStore(deps);
    await store.enterAdd();
    store.setDraft({ name: 'GitHub' });
    await expect(store.saveNew()).resolves.toBe(false);
    expect(deps.onError).toHaveBeenCalledOnce();
    expect(store.addMode()).toBe(true);
  });

  it('exitAdd clears the form state', async () => {
    const deps = makeDeps({ reuseCount: 3 });
    const store = createTrayStore(deps);
    await store.enterAdd();
    store.setDraft({ name: 'X', password: 'pw' });
    await store.checkReuse();
    store.setFolderId('f-1');
    store.exitAdd();
    expect(store.addMode()).toBe(false);
    expect(store.draft()).toEqual({
      name: '',
      username: '',
      password: '',
      uri: '',
      totp: '',
      notes: '',
      favorite: false,
      reprompt: false,
    });
    expect(store.reuseCount()).toBe(0);
    expect(store.folderId()).toBeNull();
  });

  it('enterAdd loads folders and saveNew stores the login in the chosen folder', async () => {
    const deps = makeDeps({
      folders: [
        makeFolder({ id: 'f-work', name: 'Work', accountEmail: 'me@x.com' }),
        makeFolder({ id: 'f-home', name: 'Home', accountEmail: 'me@x.com' }),
      ],
    });
    const store = createTrayStore(deps);
    await store.enterAdd();
    // Name-sorted, account-scoped options; the form defaults to no folder (root).
    expect(store.folderOptions().map((f) => f.id)).toEqual(['f-home', 'f-work']);
    expect(store.folderId()).toBeNull();

    store.setDraft({ name: 'GitHub' });
    store.setFolderId('f-work');
    await expect(store.saveNew()).resolves.toBe(true);
    expect(deps.ipc.saveItem).toHaveBeenCalledWith(
      'me@x.com',
      expect.objectContaining({ folderId: 'f-work' }),
    );
  });

  it('saveNew with no folder chosen stores at the vault root (folderId null)', async () => {
    const deps = makeDeps({
      folders: [makeFolder({ id: 'f-work', name: 'Work', accountEmail: 'me@x.com' })],
    });
    const store = createTrayStore(deps);
    await store.enterAdd();
    store.setDraft({ name: 'GitHub' });
    await expect(store.saveNew()).resolves.toBe(true);
    expect(deps.ipc.saveItem).toHaveBeenCalledWith(
      'me@x.com',
      expect.objectContaining({ folderId: null }),
    );
  });

  it('folderOptions is scoped to the selected account; switching account resets the folder', async () => {
    const deps = makeDeps({
      connections: [makeConnection({ email: 'me@x.com' }), makeConnection({ email: 'you@y.com' })],
      folders: [
        makeFolder({ id: 'mine', name: 'Mine', accountEmail: 'me@x.com' }),
        makeFolder({ id: 'yours', name: 'Yours', accountEmail: 'you@y.com' }),
      ],
    });
    const store = createTrayStore(deps);
    await store.enterAdd();
    expect(store.account()).toBe('me@x.com');
    expect(store.folderOptions().map((f) => f.id)).toEqual(['mine']);

    store.setFolderId('mine');
    store.setAccount('you@y.com');
    // A folder id is per-vault, so switching the destination clears it.
    expect(store.folderId()).toBeNull();
    expect(store.folderOptions().map((f) => f.id)).toEqual(['yours']);
  });

  it('a failed folder load leaves the picker empty but keeps the form usable', async () => {
    const deps = makeDeps();
    deps.ipc.listFolders.mockRejectedValueOnce(new Error('offline'));
    const store = createTrayStore(deps);
    await store.enterAdd();
    expect(store.folderOptions()).toEqual([]);
    expect(store.addMode()).toBe(true);
    expect(store.account()).toBe('me@x.com');
    expect(deps.onError).toHaveBeenCalledOnce();
  });
});

describe('createTrayStore.refresh', () => {
  it('loads the item list when unlocked', async () => {
    const deps = makeDeps({ items: [makeItem({ id: 'a', name: 'A' })] });
    const store = createTrayStore(deps);
    await store.refresh();
    expect(store.ready()).toBe(true);
    expect(store.unlocked()).toBe(true);
    expect(store.filtered().map((i) => i.id)).toEqual(['a']);
  });

  it('when locked clears items and never calls listItems', async () => {
    const deps = makeDeps({ status: { ...unlockedStatus, unlocked: false } });
    const store = createTrayStore(deps);
    await store.refresh();
    expect(store.ready()).toBe(true);
    expect(store.unlocked()).toBe(false);
    expect(store.filtered()).toEqual([]);
    expect(deps.ipc.listItems).not.toHaveBeenCalled();
  });

  it('surfaces a status failure via onError and still becomes ready (as locked)', async () => {
    const deps = makeDeps();
    deps.ipc.getSessionStatus.mockRejectedValueOnce(new Error('ipc down'));
    const store = createTrayStore(deps);
    await store.refresh();
    expect(deps.onError).toHaveBeenCalledOnce();
    expect(store.ready()).toBe(true);
    expect(store.unlocked()).toBe(false);
  });
});

describe('createTrayStore copy actions', () => {
  it('copyUsername copies the list value without a detail fetch', async () => {
    const deps = makeDeps();
    const store = createTrayStore(deps);
    await store.copyUsername(makeItem({ id: 'a', name: 'A', username: 'neo' }));
    expect(deps.copy).toHaveBeenCalledWith('Username', 'neo');
    expect(deps.ipc.itemDetail).not.toHaveBeenCalled();
  });

  it('copyPassword fetches the detail for the owning account and copies the password', async () => {
    const deps = makeDeps({ password: 's3cret' });
    const store = createTrayStore(deps);
    await store.copyPassword(makeItem({ id: 'a', name: 'A', accountEmail: 'me@x.com' }));
    expect(deps.ipc.itemDetail).toHaveBeenCalledWith('me@x.com', 'a');
    expect(deps.copy).toHaveBeenCalledWith('Password', 's3cret');
  });

  it('copyPassword on a reprompt item blocks: no fetch, no copy', async () => {
    const deps = makeDeps();
    const store = createTrayStore(deps);
    const item = makeItem({ id: 'a', name: 'A', reprompt: true });
    await store.copyPassword(item);
    expect(deps.onRepromptBlocked).toHaveBeenCalledWith(item);
    expect(deps.ipc.itemDetail).not.toHaveBeenCalled();
    expect(deps.copy).not.toHaveBeenCalled();
  });

  it('copyTotp copies the generated code', async () => {
    const deps = makeDeps({ totp: { code: '654321', period: 30, remaining: 5 } });
    const store = createTrayStore(deps);
    await store.copyTotp(makeItem({ id: 'a', name: 'A', accountEmail: 'me@x.com', hasTotp: true }));
    expect(deps.ipc.itemTotp).toHaveBeenCalledWith('me@x.com', 'a');
    expect(deps.copy).toHaveBeenCalledWith('TOTP code', '654321');
  });

  it('copyTotp on a reprompt item blocks', async () => {
    const deps = makeDeps();
    const store = createTrayStore(deps);
    const item = makeItem({ id: 'a', name: 'A', reprompt: true, hasTotp: true });
    await store.copyTotp(item);
    expect(deps.onRepromptBlocked).toHaveBeenCalledWith(item);
    expect(deps.copy).not.toHaveBeenCalled();
  });

  it('routes a detail-fetch failure to onError without copying', async () => {
    const deps = makeDeps();
    deps.ipc.itemDetail.mockRejectedValueOnce(new Error('boom'));
    const store = createTrayStore(deps);
    await store.copyPassword(makeItem({ id: 'a', name: 'A' }));
    expect(deps.onError).toHaveBeenCalledOnce();
    expect(deps.copy).not.toHaveBeenCalled();
  });
});

describe('createTrayStore unlock', () => {
  /** Locked first; unlocked after `unlockAll`/`helloUnlock` resolve (the real
   *  backend flips the session, the popup re-reads it on refresh). */
  function unlockableDeps(over: Parameters<typeof makeDeps>[0] = {}) {
    const deps = makeDeps(over);
    deps.ipc.getSessionStatus.mockResolvedValueOnce(over.status ?? lockedStatus);
    return deps;
  }

  it('refresh exposes appUnlockConfigured and helloConfigured for the locked view', async () => {
    const deps = makeDeps({ status: { ...lockedStatus, helloConfigured: true } });
    const store = createTrayStore(deps);
    await store.refresh();
    expect(store.appUnlockConfigured()).toBe(true);
    expect(store.helloConfigured()).toBe(true);
  });

  it('unlock(password) calls unlockAll, refreshes to unlocked and resolves true', async () => {
    const deps = unlockableDeps({
      items: [makeItem({ id: 'a', name: 'A' })],
      outcomes: [{ status: 'unlocked', email: 'me@x.com', serverLabel: 'EU' }],
    });
    const store = createTrayStore(deps);
    await store.refresh();
    expect(store.unlocked()).toBe(false);

    await expect(store.unlock('app-pw')).resolves.toBe(true);
    expect(deps.ipc.unlockAll).toHaveBeenCalledWith('app-pw');
    expect(store.unlocked()).toBe(true);
    expect(store.filtered().map((i) => i.id)).toEqual(['a']);
  });

  it('unlock with an empty password is a no-op', async () => {
    const deps = makeDeps();
    const store = createTrayStore(deps);
    await expect(store.unlock('')).resolves.toBe(false);
    expect(deps.ipc.unlockAll).not.toHaveBeenCalled();
  });

  it('a wrong app password (rejected call) routes to onError, resolves false, stays locked', async () => {
    const deps = unlockableDeps({ status: lockedStatus });
    deps.ipc.unlockAll.mockRejectedValueOnce(new Error('bad tag'));
    const store = createTrayStore(deps);
    await store.refresh();

    await expect(store.unlock('wrong')).resolves.toBe(false);
    expect(deps.onError).toHaveBeenCalledOnce();
    expect(store.unlocked()).toBe(false);
  });

  it('failed connection outcomes surface via onError; the rest still unlock', async () => {
    const deps = unlockableDeps({
      outcomes: [
        { status: 'unlocked', email: 'ok@x.com', serverLabel: 'EU' },
        { status: 'failed', message: 'server down', email: 'bad@x.com', serverLabel: 'US' },
      ],
    });
    const store = createTrayStore(deps);
    await store.refresh();

    await expect(store.unlock('app-pw')).resolves.toBe(true);
    expect(deps.onError).toHaveBeenCalledOnce();
    expect(String(deps.onError.mock.calls[0]?.[0])).toContain('bad@x.com');
    expect(store.unlocked()).toBe(true);
  });

  it('2FA-pending connections are reported via onTwoFactorPending (the popup defers to the main window)', async () => {
    const deps = unlockableDeps({
      outcomes: [
        { status: 'unlocked', email: 'ok@x.com', serverLabel: 'EU' },
        { status: 'twoFactorRequired', providers: ['authenticator'], email: '2fa@x.com', serverLabel: 'US' },
      ],
    });
    const store = createTrayStore(deps);
    await store.refresh();

    await store.unlock('app-pw');
    expect(deps.onTwoFactorPending).toHaveBeenCalledWith(['2fa@x.com']);
  });

  it('unlockHello refreshes to unlocked on success', async () => {
    const deps = unlockableDeps({
      outcomes: [{ status: 'unlocked', email: 'me@x.com', serverLabel: 'EU' }],
    });
    const store = createTrayStore(deps);
    await store.refresh();

    await store.unlockHello();
    expect(deps.ipc.helloUnlock).toHaveBeenCalledOnce();
    expect(store.unlocked()).toBe(true);
  });

  it('a hello failure routes to onError and stays locked', async () => {
    const deps = unlockableDeps({ status: lockedStatus });
    deps.ipc.helloUnlock.mockRejectedValueOnce(new Error('consent denied'));
    const store = createTrayStore(deps);
    await store.refresh();

    await store.unlockHello();
    expect(deps.onError).toHaveBeenCalledOnce();
    expect(store.unlocked()).toBe(false);
  });
});

describe('createTrayStore autofill fill-mode', () => {
  it('syncFill enters fill mode with an EMPTY search box but filters secretly to the target', async () => {
    const deps = makeDeps({
      items: [
        makeItem({ id: 'gh', name: 'GitHub', uri: 'https://github.com' }),
        makeItem({ id: 'bank', name: 'Bank', uri: 'https://bank.example' }),
      ],
      pending: makePending({ context: { field: 'password', processName: 'chrome', windowTitle: 'Sign in', url: 'https://github.com/login', associateUri: null, typedUsername: null } }),
    });
    const store = createTrayStore(deps);
    await store.refresh();
    await store.syncFill();
    expect(store.fillMode()).toBe(true);
    expect(store.pending()?.token).toBe('tok-1');
    // No visible query — the search box stays empty — but the list is filtered to
    // the detected target (github.com) "secretly".
    expect(store.query()).toBe('');
    expect(store.filtered().map((i) => i.id)).toEqual(['gh']);
  });

  it('syncFill resolves to off (no fill mode) when nothing is pending', async () => {
    const deps = makeDeps({ pending: null });
    const store = createTrayStore(deps);
    await store.syncFill();
    expect(store.fillMode()).toBe(false);
    expect(store.pending()).toBeNull();
  });

  it('fill() injects via the one-shot token + account/item and leaves fill mode', async () => {
    const deps = makeDeps({
      pending: makePending({ token: 'tok-9', candidates: [makeCandidate({ itemId: 'x', accountEmail: 'me@x.com' })] }),
    });
    const store = createTrayStore(deps);
    await store.syncFill();
    await store.fill({ accountEmail: 'me@x.com', itemId: 'x', reprompt: false });
    expect(deps.ipc.autofillFill).toHaveBeenCalledWith('tok-9', 'me@x.com', 'x');
    expect(store.fillMode()).toBe(false);
  });

  it('fill() copies the login’s TOTP to the clipboard after a username/password fill', async () => {
    const deps = makeDeps({
      pending: makePending({ token: 'tok-t' }),
      totp: { code: '987654', period: 30, remaining: 12 },
    });
    const store = createTrayStore(deps);
    await store.syncFill();
    await store.fill({ accountEmail: 'me@x.com', itemId: 'x', reprompt: false, hasTotp: true });
    // The password was filled, then the current code copied for the (later) TOTP step.
    expect(deps.ipc.autofillFill).toHaveBeenCalledOnce();
    expect(deps.ipc.itemTotp).toHaveBeenCalledWith('me@x.com', 'x');
    expect(deps.copy).toHaveBeenCalledWith('TOTP code', '987654');
  });

  it('fill() does NOT copy a TOTP when the filled field WAS the one-time-code box', async () => {
    const deps = makeDeps({
      pending: makePending({
        context: { field: 'totp', processName: 'outlook', windowTitle: 'Sign in', url: null, associateUri: null, typedUsername: null },
      }),
    });
    const store = createTrayStore(deps);
    await store.syncFill();
    await store.fill({ accountEmail: 'me@x.com', itemId: 'x', reprompt: false, hasTotp: true });
    // The injector already typed the code into that field — no clipboard copy.
    expect(deps.ipc.itemTotp).not.toHaveBeenCalled();
    expect(deps.copy).not.toHaveBeenCalled();
  });

  it('fill() does NOT copy a TOTP when the login has none', async () => {
    const deps = makeDeps({ pending: makePending() });
    const store = createTrayStore(deps);
    await store.syncFill();
    await store.fill({ accountEmail: 'me@x.com', itemId: 'x', reprompt: false, hasTotp: false });
    expect(deps.ipc.itemTotp).not.toHaveBeenCalled();
    expect(deps.copy).not.toHaveBeenCalled();
  });

  it('a failed TOTP copy never makes the completed fill look failed', async () => {
    const deps = makeDeps({ pending: makePending({ token: 'tok-t2' }) });
    deps.ipc.itemTotp.mockRejectedValueOnce(new Error('totp gen failed'));
    const store = createTrayStore(deps);
    await store.syncFill();
    await store.fill({ accountEmail: 'me@x.com', itemId: 'x', reprompt: false, hasTotp: true });
    // The fill went through; only the TOTP copy failed (surfaced, not fatal).
    expect(deps.ipc.autofillFill).toHaveBeenCalledOnce();
    expect(deps.onError).toHaveBeenCalledOnce();
    expect(store.fillMode()).toBe(false);
  });

  it('fill() on a reprompt target blocks: defers to the main window, never injects', async () => {
    const deps = makeDeps({ pending: makePending() });
    const store = createTrayStore(deps);
    await store.syncFill();
    await store.fill({ accountEmail: 'me@x.com', itemId: 'x', reprompt: true });
    expect(deps.onRepromptBlocked).toHaveBeenCalledOnce();
    expect(deps.ipc.autofillFill).not.toHaveBeenCalled();
    expect(store.fillMode()).toBe(true);
  });

  it('a failed inject routes to onError and stays in fill mode', async () => {
    const deps = makeDeps({ pending: makePending() });
    deps.ipc.autofillFill.mockRejectedValueOnce(new Error('UIPI blocked'));
    const store = createTrayStore(deps);
    await store.syncFill();
    await store.fill({ accountEmail: 'me@x.com', itemId: 'x', reprompt: false });
    expect(deps.onError).toHaveBeenCalledOnce();
    expect(store.fillMode()).toBe(true);
  });

  it('enters fill mode even when the detection matched nothing (the user can still search)', async () => {
    const deps = makeDeps({ pending: makePending({ candidates: [] }) });
    const store = createTrayStore(deps);
    await store.syncFill();
    expect(store.fillMode()).toBe(true);
    expect(store.pending()?.candidates).toEqual([]);
  });

  it('exitFill drops the backend detection and leaves fill mode', async () => {
    const deps = makeDeps({ pending: makePending() });
    const store = createTrayStore(deps);
    await store.syncFill();
    store.exitFill();
    expect(deps.ipc.autofillDismiss).toHaveBeenCalledOnce();
    expect(store.fillMode()).toBe(false);
    expect(store.pending()).toBeNull();
  });

  it('fill(remember) stores the site DOMAIN on the login (browser), then fills', async () => {
    const deps = makeDeps({
      pending: makePending({
        token: 'tok-5',
        context: { field: 'password', processName: 'chrome', windowTitle: 'Sign in', url: 'https://www.github.com/login', associateUri: null, typedUsername: null },
      }),
    });
    const store = createTrayStore(deps);
    await store.syncFill();

    await store.fill({ accountEmail: 'me@x.com', itemId: 'x', reprompt: false }, true);

    // Remembers the DOMAIN (www/path stripped), not the full URL — then fills.
    expect(deps.ipc.autofillAssociate).toHaveBeenCalledWith('me@x.com', 'x', 'github.com');
    expect(deps.ipc.autofillFill).toHaveBeenCalledWith('tok-5', 'me@x.com', 'x');
    expect(store.fillMode()).toBe(false);
  });

  it('fill(remember) on a native app remembers the app:// association', async () => {
    const deps = makeDeps({
      pending: makePending({
        token: 'tok-6',
        context: { field: 'password', processName: 'discord', windowTitle: 'Discord', url: null, associateUri: 'app://discord', typedUsername: null },
      }),
    });
    const store = createTrayStore(deps);
    await store.syncFill();

    await store.fill({ accountEmail: 'me@x.com', itemId: 'x', reprompt: false }, true);

    expect(deps.ipc.autofillAssociate).toHaveBeenCalledWith('me@x.com', 'x', 'app://discord');
    expect(deps.ipc.autofillFill).toHaveBeenCalledWith('tok-6', 'me@x.com', 'x');
  });

  it('fill(remember) still fills when the association fails (best-effort)', async () => {
    const deps = makeDeps({
      pending: makePending({
        token: 'tok-8',
        context: { field: 'password', processName: 'discord', windowTitle: 'Discord', url: null, associateUri: 'app://discord', typedUsername: null },
      }),
    });
    deps.ipc.autofillAssociate.mockRejectedValueOnce(new Error('sync first'));
    const store = createTrayStore(deps);
    await store.syncFill();

    await store.fill({ accountEmail: 'me@x.com', itemId: 'x', reprompt: false }, true);

    // The failed remember is surfaced, but the fill the user asked for still happens.
    expect(deps.onError).toHaveBeenCalledOnce();
    expect(deps.ipc.autofillFill).toHaveBeenCalledWith('tok-8', 'me@x.com', 'x');
    expect(store.fillMode()).toBe(false);
  });

  it('fill(remember=false) fills without remembering', async () => {
    const deps = makeDeps({
      pending: makePending({
        token: 'tok-2',
        context: { field: 'password', processName: 'discord', windowTitle: 'Discord', url: null, associateUri: 'app://discord', typedUsername: null },
      }),
    });
    const store = createTrayStore(deps);
    await store.syncFill();

    await store.fill({ accountEmail: 'me@x.com', itemId: 'x', reprompt: false }, false);

    expect(deps.ipc.autofillAssociate).not.toHaveBeenCalled();
    expect(deps.ipc.autofillFill).toHaveBeenCalledOnce();
  });

  it('canRemember + userSearchedInFill gate the "remember this site?" prompt', async () => {
    const deps = makeDeps({
      items: [makeItem({ id: 'gh', name: 'GitHub', uri: 'https://github.com' })],
      pending: makePending({ context: { field: 'password', processName: 'chrome', windowTitle: 'Sign in', url: 'https://github.com/login', associateUri: null, typedUsername: null } }),
    });
    const store = createTrayStore(deps);
    await store.refresh();
    await store.syncFill();
    // Something to remember (a URL), but no manual query yet → no prompt.
    expect(store.canRemember()).toBe(true);
    expect(store.userSearchedInFill()).toBe(false);
    // The user types their own query → a manual pick should now prompt.
    store.setQuery('git');
    expect(store.userSearchedInFill()).toBe(true);
  });

  it('canRemember is false when the detection exposes neither a URL nor an app association', async () => {
    const deps = makeDeps({
      pending: makePending({
        context: { field: 'password', processName: null, windowTitle: 'Sign in', url: null, associateUri: null, typedUsername: null },
      }),
    });
    const store = createTrayStore(deps);
    await store.syncFill();
    expect(store.canRemember()).toBe(false);
  });
});

describe('createTrayStore state retention', () => {
  it('refresh preserves object identity of unchanged items (keeps DOM rows, so scroll survives)', async () => {
    const deps = makeDeps({ items: [makeItem({ id: 'a', name: 'A' }), makeItem({ id: 'b', name: 'B' })] });
    const store = createTrayStore(deps);
    await store.refresh();
    const before = store.filtered();
    await store.refresh();
    const after = store.filtered();
    expect(after[0]).toBe(before[0]);
    expect(after[1]).toBe(before[1]);
  });

  it('refresh swaps in the new object when an item changed', async () => {
    const deps = makeDeps({ items: [makeItem({ id: 'a', name: 'A' })] });
    const store = createTrayStore(deps);
    await store.refresh();
    const before = store.filtered()[0];
    deps.ipc.listItems.mockResolvedValueOnce([makeItem({ id: 'a', name: 'Renamed' })]);
    await store.refresh();
    expect(store.filtered()[0]).not.toBe(before);
    expect(store.filtered()[0]?.name).toBe('Renamed');
  });

  it('keeps the query across refreshes, and across a lock (only items are dropped)', async () => {
    const deps = makeDeps({ items: [makeItem({ id: 'a', name: 'A' })] });
    const store = createTrayStore(deps);
    await store.refresh();
    store.setQuery('a');
    deps.ipc.getSessionStatus.mockResolvedValueOnce({ ...unlockedStatus, unlocked: false });
    await store.refresh();
    expect(store.filtered()).toEqual([]);
    expect(store.query()).toBe('a');
  });
});

describe('buildEditInput', () => {
  // A login detail carrying everything the compact form can't touch — the edit
  // must preserve all of it.
  const rich = () =>
    makeDetail({
      id: 'i1',
      name: 'GitHub',
      accountEmail: 'me@x.com',
      favorite: true,
      reprompt: true,
      notes: 'keep me',
      folderId: 'fold-1',
      organizationId: 'org-1',
      login: makeLoginDetail({
        username: 'neo',
        password: 'old-pw',
        totp: 'JBSWY3DPEHPK3PXP',
        hasTotp: true,
        autofillOnPageLoad: true,
        uris: [
          { uri: 'https://github.com', matchType: 3 },
          { uri: 'https://gist.github.com', matchType: null },
        ],
      }),
      fields: [
        { name: 'PIN', value: '1234', fieldType: 'hidden', linkedId: null },
        { name: 'flag', value: 'true', fieldType: 'boolean', linkedId: null },
      ],
    });

  // A full draft (the form owns every editable field now); tests override only
  // what they exercise.
  const draft = (over: Partial<AddDraft> = {}): AddDraft => ({
    name: 'X',
    username: '',
    password: '',
    uri: '',
    totp: '',
    notes: '',
    favorite: false,
    reprompt: false,
    ...over,
  });

  it('writes name/username/password/first-uri/totp/notes/favorite/reprompt from the draft and preserves the rest', () => {
    const input = buildEditInput(
      rich(),
      draft({
        name: '  GitHub Work  ',
        username: '  morpheus  ',
        password: 'new-pw',
        uri: 'https://github.com/login',
        totp: 'JBSWY3DPEHPK3PXP',
        notes: 'keep me',
        favorite: true,
        reprompt: true,
      }),
      'fold-1',
    );
    expect(input.id).toBe('i1');
    expect(input.itemType).toBe('login');
    expect(input.name).toBe('GitHub Work');
    expect(input.login?.username).toBe('morpheus');
    expect(input.login?.password).toBe('new-pw');
    // First URI is replaced but keeps its matchType; the extra URI is untouched.
    expect(input.login?.uris).toEqual([
      { uri: 'https://github.com/login', matchType: 3 },
      { uri: 'https://gist.github.com', matchType: null },
    ]);
    // Form-owned fields come from the draft (here unchanged from the original).
    expect(input.login?.totp).toBe('JBSWY3DPEHPK3PXP');
    expect(input.notes).toBe('keep me');
    expect(input.favorite).toBe(true);
    expect(input.reprompt).toBe(true);
    // Preserved, can't-edit-here fields.
    expect(input.login?.autofillOnPageLoad).toBe(true);
    expect(input.folderId).toBe('fold-1');
    expect(input.organizationId).toBe('org-1');
    // Custom fields survive, with the string kind mapped back to its int code
    // (hidden=1, boolean=2) — not collapsed to Text.
    expect(input.fields).toEqual([
      { name: 'PIN', value: '1234', fieldType: 1, linkedId: null },
      { name: 'flag', value: 'true', fieldType: 2, linkedId: null },
    ]);
  });

  it('empty username/password/totp/notes become null (not empty strings)', () => {
    const input = buildEditInput(
      rich(),
      draft({ username: '   ', password: '', uri: 'x', totp: '   ', notes: '  ' }),
      'fold-1',
    );
    expect(input.login?.username).toBeNull();
    expect(input.login?.password).toBeNull();
    // The form owns TOTP/notes now: emptied fields clear them, they are NOT
    // restored from the original (regression guard for the "form owns it" pivot).
    expect(input.login?.totp).toBeNull();
    expect(input.notes).toBeNull();
  });

  it('persists toggled favorite/reprompt from the draft, not the original', () => {
    // The original is favorite:true / reprompt:true; the draft turns both off.
    const input = buildEditInput(rich(), draft({ favorite: false, reprompt: false }), 'fold-1');
    expect(input.favorite).toBe(false);
    expect(input.reprompt).toBe(false);
  });

  it('clearing the URI drops the first URI but keeps the rest', () => {
    const input = buildEditInput(rich(), draft({ username: 'u', password: 'p', uri: '   ' }), 'fold-1');
    expect(input.login?.uris).toEqual([{ uri: 'https://gist.github.com', matchType: null }]);
  });

  it('adds a first URI when the original had none', () => {
    const detail = makeDetail({ id: 'i1', name: 'X', login: makeLoginDetail({ uris: [] }) });
    const input = buildEditInput(detail, draft({ uri: 'site.com' }), null);
    expect(input.login?.uris).toEqual([{ uri: 'site.com', matchType: null }]);
  });
});

describe('isWritableKind', () => {
  it('accepts the writable providers and rejects the read-only ones', () => {
    expect(isWritableKind('bitwarden')).toBe(true);
    expect(isWritableKind('keepass')).toBe(true);
    expect(isWritableKind('pass')).toBe(false);
    expect(isWritableKind('enpass')).toBe(false);
    expect(isWritableKind('proton')).toBe(false);
  });
});

describe('connectionLabel / connectionIdentity', () => {
  it('prefers the user-given name over the derived identity', () => {
    expect(connectionLabel({ kind: 'bitwarden', email: 'me@x.com', name: 'Work' })).toBe('Work');
    expect(
      connectionLabel({ kind: 'keepass', email: 'C:\\vaults\\personal.kdbx', name: 'Personal' }),
    ).toBe('Personal');
  });

  it('falls back to the derived identity when there is no name (or only blanks)', () => {
    // Bitwarden → the account email; KeePass → the .kdbx file name, not the path.
    expect(connectionLabel({ kind: 'bitwarden', email: 'me@x.com', name: null })).toBe('me@x.com');
    expect(connectionLabel({ kind: 'keepass', email: 'C:\\vaults\\personal.kdbx', name: '  ' })).toBe(
      'personal.kdbx',
    );
    expect(connectionIdentity({ kind: 'keepass', email: '/home/u/vault.kdbx' })).toBe('vault.kdbx');
  });
});

describe('createTrayStore edit-login', () => {
  it('enterEdit fetches the detail, seeds the draft and locks the account', async () => {
    const deps = makeDeps();
    deps.ipc.itemDetail.mockResolvedValueOnce(
      makeDetail({
        id: 'i1',
        name: 'GitHub',
        accountEmail: 'me@x.com',
        login: makeLoginDetail({
          username: 'neo',
          password: 's3cret',
          uris: [{ uri: 'https://github.com', matchType: null }],
        }),
      }),
    );
    const store = createTrayStore(deps);
    await store.enterEdit(makeItem({ id: 'i1', name: 'GitHub', accountEmail: 'me@x.com' }));
    expect(deps.ipc.itemDetail).toHaveBeenCalledWith('me@x.com', 'i1');
    expect(store.addMode()).toBe(true);
    expect(store.editing()?.id).toBe('i1');
    expect(store.draft()).toEqual({
      name: 'GitHub',
      username: 'neo',
      password: 's3cret',
      uri: 'https://github.com',
      totp: '',
      notes: '',
      favorite: false,
      reprompt: false,
    });
    // Account is fixed to the item's owner — no account picker on edit.
    expect(store.accounts()).toEqual(['me@x.com']);
    expect(store.account()).toBe('me@x.com');
    // The owner's provider is learned so the form renders the right fields.
    expect(store.accountKind()).toBe('bitwarden');
  });

  it('enterEdit on a reprompt item defers to the main window: no fetch, no form', async () => {
    const deps = makeDeps();
    const store = createTrayStore(deps);
    const item = makeItem({ id: 'i1', name: 'X', reprompt: true });
    await store.enterEdit(item);
    expect(deps.onRepromptBlocked).toHaveBeenCalledWith(item);
    expect(deps.ipc.itemDetail).not.toHaveBeenCalled();
    expect(store.addMode()).toBe(false);
    expect(store.editing()).toBeNull();
  });

  it('enterEdit ignores non-login items (the compact form only edits logins)', async () => {
    const deps = makeDeps();
    const store = createTrayStore(deps);
    await store.enterEdit(makeItem({ id: 'i1', name: 'Note', itemType: 'secureNote' }));
    expect(deps.ipc.itemDetail).not.toHaveBeenCalled();
    expect(store.addMode()).toBe(false);
  });

  it('save() in edit mode writes the id back to the owning account, refreshes and closes', async () => {
    const deps = makeDeps();
    deps.ipc.itemDetail.mockResolvedValueOnce(
      makeDetail({
        id: 'i1',
        name: 'GitHub',
        accountEmail: 'me@x.com',
        login: makeLoginDetail({ username: 'neo', password: 'old', totp: 'SEED' }),
      }),
    );
    const store = createTrayStore(deps);
    await store.refresh();
    await store.enterEdit(makeItem({ id: 'i1', name: 'GitHub', accountEmail: 'me@x.com' }));
    store.setDraft({ password: 'rotated' });
    const listCallsBefore = deps.ipc.listItems.mock.calls.length;

    await expect(store.save()).resolves.toBe(true);
    expect(deps.ipc.saveItem).toHaveBeenCalledWith(
      'me@x.com',
      expect.objectContaining({
        id: 'i1',
        itemType: 'login',
        login: expect.objectContaining({ password: 'rotated', totp: 'SEED' }),
      }),
    );
    expect(store.addMode()).toBe(false);
    expect(store.editing()).toBeNull();
    expect(deps.ipc.listItems.mock.calls.length).toBeGreaterThan(listCallsBefore);
  });

  it('enterEdit seeds the folder from the item and save can move it to another folder', async () => {
    const deps = makeDeps({
      folders: [
        makeFolder({ id: 'a', name: 'A', accountEmail: 'me@x.com' }),
        makeFolder({ id: 'b', name: 'B', accountEmail: 'me@x.com' }),
      ],
    });
    deps.ipc.itemDetail.mockResolvedValueOnce(
      makeDetail({
        id: 'i1',
        name: 'GitHub',
        accountEmail: 'me@x.com',
        folderId: 'a',
        login: makeLoginDetail({ username: 'neo', password: 'pw' }),
      }),
    );
    const store = createTrayStore(deps);
    await store.enterEdit(makeItem({ id: 'i1', name: 'GitHub', accountEmail: 'me@x.com' }));
    // Picker opens on the item's current folder.
    expect(store.folderId()).toBe('a');

    store.setFolderId('b');
    await expect(store.save()).resolves.toBe(true);
    expect(deps.ipc.saveItem).toHaveBeenCalledWith(
      'me@x.com',
      expect.objectContaining({ id: 'i1', folderId: 'b' }),
    );
  });

  it('a failed edit surfaces onError and keeps the form (and editing) open', async () => {
    const deps = makeDeps();
    deps.ipc.itemDetail.mockResolvedValueOnce(makeDetail({ id: 'i1', name: 'X' }));
    deps.ipc.saveItem.mockRejectedValueOnce(new Error('offline'));
    const store = createTrayStore(deps);
    await store.enterEdit(makeItem({ id: 'i1', name: 'X', accountEmail: 'tester@example.com' }));
    await expect(store.save()).resolves.toBe(false);
    expect(deps.onError).toHaveBeenCalledOnce();
    expect(store.addMode()).toBe(true);
    expect(store.editing()?.id).toBe('i1');
  });

  it('save() without editing falls through to the create path (id: null)', async () => {
    const deps = makeDeps();
    const store = createTrayStore(deps);
    await store.refresh();
    await store.enterAdd();
    store.setDraft({ name: 'New' });
    await expect(store.save()).resolves.toBe(true);
    expect(deps.ipc.saveItem).toHaveBeenCalledWith('me@x.com', expect.objectContaining({ id: null }));
  });

  it('exitAdd clears edit state too', async () => {
    const deps = makeDeps();
    deps.ipc.itemDetail.mockResolvedValueOnce(makeDetail({ id: 'i1', name: 'X' }));
    const store = createTrayStore(deps);
    await store.enterEdit(makeItem({ id: 'i1', name: 'X' }));
    store.exitAdd();
    expect(store.editing()).toBeNull();
    expect(store.addMode()).toBe(false);
  });

  it('opening add after an edit is not stuck in edit mode', async () => {
    const deps = makeDeps();
    deps.ipc.itemDetail.mockResolvedValueOnce(makeDetail({ id: 'i1', name: 'X' }));
    const store = createTrayStore(deps);
    await store.enterEdit(makeItem({ id: 'i1', name: 'X' }));
    store.exitAdd();
    await store.enterAdd();
    expect(store.editing()).toBeNull();
    expect(store.addMode()).toBe(true);
  });
});
