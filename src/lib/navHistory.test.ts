import { describe, expect, it } from 'vitest';
import { createNavStack, navLocationEq, type NavLocation } from './navHistory.ts';

const numEq = (a: number, b: number) => a === b;

describe('createNavStack', () => {
  it('starts empty: no back/forward', () => {
    const s = createNavStack(numEq);
    expect(s.canBack()).toBe(false);
    expect(s.canForward()).toBe(false);
    expect(s.back()).toBe(null);
    expect(s.forward()).toBe(null);
  });

  it('records distinct entries and walks back/forward, clamped at the ends', () => {
    const s = createNavStack(numEq);
    s.record(1);
    s.record(2);
    s.record(3);
    expect(s.state()).toEqual({ length: 3, cursor: 2 });
    expect(s.canBack()).toBe(true);
    expect(s.canForward()).toBe(false);

    expect(s.back()).toBe(2);
    expect(s.back()).toBe(1);
    expect(s.back()).toBe(null); // already at the oldest
    expect(s.canBack()).toBe(false);

    expect(s.forward()).toBe(2);
    expect(s.forward()).toBe(3);
    expect(s.forward()).toBe(null); // already at the newest
  });

  it('dedups a record identical to the current entry (a restore is a no-op)', () => {
    const s = createNavStack(numEq);
    s.record(1);
    s.record(2);
    expect(s.back()).toBe(1); // cursor -> 0
    s.record(1); // re-emitted by apply(); must not push
    expect(s.state()).toEqual({ length: 2, cursor: 0 });
    expect(s.forward()).toBe(2); // forward branch intact
  });

  it('drops the forward branch when recording from the middle', () => {
    const s = createNavStack(numEq);
    s.record(1);
    s.record(2);
    s.record(3);
    s.back(); // cursor -> 1 (value 2)
    s.record(9); // a new branch off 2
    expect(s.state()).toEqual({ length: 3, cursor: 2 });
    expect(s.canForward()).toBe(false);
    expect(s.back()).toBe(2);
    expect(s.back()).toBe(1);
  });

  it('bounds the stack to max, evicting the oldest', () => {
    const s = createNavStack(numEq, 3);
    s.record(1);
    s.record(2);
    s.record(3);
    s.record(4);
    expect(s.state()).toEqual({ length: 3, cursor: 2 });
    expect(s.back()).toBe(3);
    expect(s.back()).toBe(2);
    expect(s.back()).toBe(null); // 1 was evicted
  });
});

describe('navLocationEq', () => {
  const base: NavLocation = { view: 'vault', filter: { kind: 'all' }, activeVault: null, selectedId: null };

  it('is true for the same shape', () => {
    expect(navLocationEq(base, { ...base })).toBe(true);
  });

  it('differs on view, vault, or open item', () => {
    expect(navLocationEq(base, { ...base, view: 'security' })).toBe(false);
    expect(navLocationEq(base, { ...base, activeVault: 'a@b.c' })).toBe(false);
    expect(navLocationEq(base, { ...base, selectedId: 'x' })).toBe(false);
  });

  it('compares the filter deeply', () => {
    const f1: NavLocation = { ...base, filter: { kind: 'type', itemType: 'login' } };
    const f2: NavLocation = { ...base, filter: { kind: 'type', itemType: 'card' } };
    expect(navLocationEq(f1, { ...f1 })).toBe(true);
    expect(navLocationEq(f1, f2)).toBe(false);
  });
});
