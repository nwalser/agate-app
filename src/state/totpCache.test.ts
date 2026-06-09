import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from 'vitest';
import { createRoot } from 'solid-js';
import { createTotpCache, type TotpCache } from './totpCache.ts';
import { ipc } from '../lib/ipc.ts';
import type { TotpCode } from '../lib/types.ts';

vi.mock('../lib/ipc.ts', () => ({
  ipc: { itemDetail: vi.fn(), itemTotp: vi.fn() },
}));

const itemTotp = ipc.itemTotp as unknown as Mock;

interface Deferred {
  promise: Promise<TotpCode>;
  resolve: (c: TotpCode) => void;
}

let pending: Deferred[];

const stubCode = (code: string): TotpCode => ({ code, period: 30, remaining: 30 });
const flush = () => new Promise<void>((r) => setTimeout(r, 0));

// createTotpCache registers a 1s ticker via onCleanup, so it must run under an
// owner; we dispose it after each case to stop the interval leaking between tests.
let dispose: (() => void) | null = null;
function makeCache(): TotpCache {
  let cache!: TotpCache;
  createRoot((d) => {
    dispose = d;
    cache = createTotpCache(() => 'a@b.c');
  });
  return cache;
}

beforeEach(() => {
  itemTotp.mockReset();
  pending = [];
  itemTotp.mockImplementation(() => {
    let resolve!: (c: TotpCode) => void;
    const promise = new Promise<TotpCode>((res) => {
      resolve = res;
    });
    pending.push({ promise, resolve });
    return promise;
  });
});

afterEach(() => {
  dispose?.();
  dispose = null;
});

describe('totpCache reset() invalidation', () => {
  it('discards a code that was in flight when reset() ran', async () => {
    const c = makeCache();
    c.ensure('a@b.c', 'x');
    expect(itemTotp).toHaveBeenCalledTimes(1);

    c.reset();
    pending[0].resolve(stubCode('111111'));
    await flush();

    expect(c.cache().has('x')).toBe(false);
  });

  it('re-fetches an id whose code was still pending at reset()', async () => {
    const c = makeCache();
    c.ensure('a@b.c', 'x'); // call 0 — in flight across the reset
    c.reset();

    // Pre-fix the id stayed wedged in totpPending and never refetched.
    c.ensure('a@b.c', 'x'); // call 1
    expect(itemTotp).toHaveBeenCalledTimes(2);

    pending[1].resolve(stubCode('222222'));
    pending[0].resolve(stubCode('111111'));
    await flush();

    expect(c.cache().get('x')?.code).toBe('222222');
  });
});
