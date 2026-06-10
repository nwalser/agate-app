import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createPersistedStore, parseOneOf, parseRawBool } from './persisted.ts';

beforeEach(() => localStorage.clear());
afterEach(() => localStorage.clear());

const OPTIONS = [10, 15, 30, 0] as const;

function numberStore() {
  return createPersistedStore<(typeof OPTIONS)[number]>({
    key: 'test.num',
    parse: parseOneOf(OPTIONS),
    fallback: () => 15,
    raw: true,
  });
}

describe('createPersistedStore', () => {
  it('falls back when absent and persists sets', () => {
    const s = numberStore();
    expect(s.value()).toBe(15);
    s.set(30);
    expect(s.value()).toBe(30);
    expect(localStorage.getItem('test.num')).toBe('30');
  });

  it('reads back a persisted value on a fresh store', () => {
    localStorage.setItem('test.num', '10');
    expect(numberStore().value()).toBe(10);
  });

  it('rejects corrupt/out-of-set values at the trust boundary', () => {
    localStorage.setItem('test.num', '999');
    expect(numberStore().value()).toBe(15);
    localStorage.setItem('test.num', 'garbage');
    expect(numberStore().value()).toBe(15);
  });

  it('round-trips JSON object stores through the validating parse', () => {
    interface Shape {
      mode: 'a' | 'b';
    }
    const parse = (v: unknown): Shape | null =>
      typeof v === 'object' && v !== null && ((v as Shape).mode === 'a' || (v as Shape).mode === 'b')
        ? { mode: (v as Shape).mode }
        : null;
    const make = () =>
      createPersistedStore<Shape>({ key: 'test.obj', parse, fallback: () => ({ mode: 'a' }) });

    const s = make();
    s.set({ mode: 'b' });
    expect(make().value()).toEqual({ mode: 'b' });

    localStorage.setItem('test.obj', '{"mode":"zzz"}');
    expect(make().value()).toEqual({ mode: 'a' }); // invalid shape → default
    localStorage.setItem('test.obj', 'not json{');
    expect(make().value()).toEqual({ mode: 'a' }); // corrupt JSON → default
  });

  it('reset restores and persists the fallback', () => {
    const s = numberStore();
    s.set(0);
    s.reset();
    expect(s.value()).toBe(15);
    expect(localStorage.getItem('test.num')).toBe('15');
  });
});

describe('parseRawBool', () => {
  it('accepts only the two literal strings', () => {
    expect(parseRawBool('true')).toBe(true);
    expect(parseRawBool('false')).toBe(false);
    expect(parseRawBool('1')).toBeNull();
    expect(parseRawBool(true)).toBeNull();
  });
});
