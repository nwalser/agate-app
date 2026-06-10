// Unit tests for the tray quick-access store (factory with injected deps — no
// module mocking, per the createSecurityScans pattern). Covers the pure
// filter/rank helper and the store's refresh/copy/reprompt behavior.

import { describe, expect, it, vi } from 'vitest';
import { makeDetail, makeItem } from '../testing/factories.ts';
import type { SessionStatus, TotpCode, VaultItem } from '../lib/types.ts';
import { createTrayStore, filterTrayItems, TRAY_MAX_RESULTS, type TrayStoreDeps } from './trayStore.ts';

const unlockedStatus: SessionStatus = {
  appUnlockConfigured: true,
  unlocked: true,
  helloConfigured: false,
  darkwebConsent: false,
  connectionCount: 1,
  liveCount: 1,
};

function makeDeps(over: {
  status?: SessionStatus;
  items?: VaultItem[];
  password?: string | null;
  totp?: TotpCode;
} = {}) {
  const deps = {
    ipc: {
      getSessionStatus: vi.fn(async () => over.status ?? unlockedStatus),
      listItems: vi.fn(async () => over.items ?? []),
      itemDetail: vi.fn(async (accountEmail: string, id: string) =>
        makeDetail({
          id,
          name: 'detail',
          accountEmail,
          login: { username: null, password: over.password ?? 'hunter2', totp: null, uris: [], hasTotp: false },
        }),
      ),
      itemTotp: vi.fn(async () => over.totp ?? { code: '123456', period: 30, remaining: 10 }),
    },
    copy: vi.fn(async () => {}),
    onError: vi.fn(),
    onRepromptBlocked: vi.fn(),
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

describe('createTrayStore.clear', () => {
  it('wipes items and the query (called when the popup hides)', async () => {
    const deps = makeDeps({ items: [makeItem({ id: 'a', name: 'A' })] });
    const store = createTrayStore(deps);
    await store.refresh();
    store.setQuery('a');
    store.clear();
    expect(store.filtered()).toEqual([]);
    expect(store.query()).toBe('');
  });
});
