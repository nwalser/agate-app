import { beforeEach, describe, expect, it, vi, type Mock } from 'vitest';
import { createDetailCache } from './detailCache.ts';
import { ipc } from '../lib/ipc.ts';
import type { ItemDetail } from '../lib/types.ts';

vi.mock('../lib/ipc.ts', () => ({
  ipc: { itemDetail: vi.fn(), itemTotp: vi.fn() },
}));

const itemDetail = ipc.itemDetail as unknown as Mock;

interface Deferred {
  promise: Promise<ItemDetail>;
  resolve: (d: ItemDetail) => void;
}

// Every call to ipc.itemDetail parks on a fresh deferred we resolve by index, so a
// test can control exactly when a "pre-mutation" vs "fresh" fetch lands.
let pending: Deferred[];

function stubDetail(id: string, marker: string): ItemDetail {
  return {
    id,
    accountEmail: 'a@b.c',
    accountLabel: 'A',
    name: marker,
    itemType: 'login',
    favorite: false,
    reprompt: false,
    notes: marker,
    login: null,
    card: null,
    identity: null,
    sshKey: null,
    fields: [],
    folderId: null,
    organizationId: null,
  };
}

// Drain the microtask queue (then → catch → finally chain) via one macrotask turn.
const flush = () => new Promise<void>((r) => setTimeout(r, 0));

beforeEach(() => {
  itemDetail.mockReset();
  pending = [];
  itemDetail.mockImplementation(() => {
    let resolve!: (d: ItemDetail) => void;
    const promise = new Promise<ItemDetail>((res) => {
      resolve = res;
    });
    pending.push({ promise, resolve });
    return promise;
  });
});

describe('detailCache reset() invalidation', () => {
  it('discards a fetch that was in flight when reset() ran', async () => {
    const c = createDetailCache();
    c.ensure('a@b.c', 'x');
    expect(itemDetail).toHaveBeenCalledTimes(1);

    c.reset();
    pending[0].resolve(stubDetail('x', 'stale'));
    await flush();

    // The pre-reset (stale) result must not land in the freshly-cleared cache.
    expect(c.cache().has('x')).toBe(false);
  });

  it('re-queues an id whose previous fetch was still pending at reset()', async () => {
    const c = createDetailCache();
    c.ensure('a@b.c', 'x'); // call 0 — left in flight across the reset
    c.reset();

    // Pre-fix this early-returned (id still wedged in detailPending) and never
    // re-fetched; now it must fire a fresh fetch.
    c.ensure('a@b.c', 'x'); // call 1
    expect(itemDetail).toHaveBeenCalledTimes(2);

    pending[1].resolve(stubDetail('x', 'fresh'));
    pending[0].resolve(stubDetail('x', 'stale'));
    await flush();

    // Fresh wins; the stale resolution is dropped regardless of arrival order.
    expect(c.cache().get('x')?.notes).toBe('fresh');
  });

  it('does not let abandoned fetches double-decrement the active count', async () => {
    const c = createDetailCache();
    // Saturate the 6-wide concurrency window with pre-reset fetches.
    for (let i = 0; i < 6; i++) c.ensure('a@b.c', `old${i}`);
    expect(itemDetail).toHaveBeenCalledTimes(6);

    c.reset();

    // 6 fresh fetches refill the window; a 7th must wait (active === 6).
    for (let i = 0; i < 6; i++) c.ensure('a@b.c', `new${i}`);
    c.ensure('a@b.c', 'new6');
    expect(itemDetail).toHaveBeenCalledTimes(12);

    // Resolving the abandoned (old-generation) fetches must NOT free a slot — if
    // their .finally decremented detailActive, the queued 7th would fire early.
    for (let i = 0; i < 6; i++) pending[i].resolve(stubDetail(`old${i}`, 'stale'));
    await flush();
    expect(itemDetail).toHaveBeenCalledTimes(12);

    // A real (current-generation) completion frees exactly one slot → 7th runs.
    pending[6].resolve(stubDetail('new0', 'fresh'));
    await flush();
    expect(itemDetail).toHaveBeenCalledTimes(13);

    // And no stale value leaked into the cache.
    for (let i = 0; i < 6; i++) expect(c.cache().has(`old${i}`)).toBe(false);
  });
});
