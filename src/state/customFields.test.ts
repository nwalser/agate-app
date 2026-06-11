import { describe, expect, it, vi } from 'vitest';
import { createCustomFields } from './customFields.ts';

describe('createCustomFields', () => {
  it('refresh loads field names and toggles loading', async () => {
    const list = vi.fn().mockResolvedValue(['Environment', 'PIN']);
    const s = createCustomFields({ list });
    expect(s.fields()).toEqual([]);
    const p = s.refresh();
    expect(s.loading()).toBe(true);
    await p;
    expect(s.loading()).toBe(false);
    expect(s.fields()).toEqual(['Environment', 'PIN']);
  });

  it('a failed scan keeps the prior list and reports the error', async () => {
    const onError = vi.fn();
    const s = createCustomFields({ list: () => Promise.reject(new Error('boom')), onError });
    s.setKnownFields(['kept']);
    await s.refresh();
    expect(s.fields()).toEqual(['kept']);
    expect(onError).toHaveBeenCalledOnce();
    expect(s.loading()).toBe(false);
  });

  it('collapses an overlapping refresh (second call is ignored while in flight)', async () => {
    let calls = 0;
    const list = () => {
      calls += 1;
      return new Promise<string[]>((r) => setTimeout(() => r(['a']), 5));
    };
    const s = createCustomFields({ list });
    const a = s.refresh();
    const b = s.refresh(); // ignored: one already in flight
    await Promise.all([a, b]);
    expect(calls).toBe(1);
  });

  it('setKnownFields seeds without IPC', () => {
    const s = createCustomFields({ list: vi.fn() });
    s.setKnownFields(['x', 'y']);
    expect(s.fields()).toEqual(['x', 'y']);
  });
});
