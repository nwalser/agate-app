import { afterEach, describe, expect, it } from 'vitest';
import {
  DEFAULT_ORDER,
  SIDEBAR_STORAGE_KEY,
  defaultSidebar,
  isDividerId,
  parseCustomQuery,
  parseSavedFilter,
  readSidebarConfig,
  reconcile,
  type CustomQuery,
} from './sidebarConfig.ts';

const query = (over: Partial<CustomQuery> = {}): CustomQuery => ({
  id: 'query:abc',
  name: 'AWS',
  query: 'aws',
  filter: { kind: 'all' },
  ...over,
});

afterEach(() => localStorage.clear());

describe('reconcile', () => {
  it('appends every missing builtin in canonical order', () => {
    const out = reconcile({ order: ['trash'], hidden: [], queries: [] });
    expect(out.order).toEqual(['trash', ...DEFAULT_ORDER.filter((id) => id !== 'trash')]);
  });

  it('drops unknown ids and duplicates, preserving first position', () => {
    const out = reconcile({ order: ['bogus', 'all', 'all', 'favorites'], hidden: [], queries: [] });
    expect(out.order).not.toContain('bogus');
    expect(out.order.filter((id) => id === 'all')).toHaveLength(1);
    expect(out.order[0]).toBe('all');
  });

  it('keeps saved-query ids that have a backing definition and appends orphans', () => {
    const q = query({ id: 'query:1' });
    const out = reconcile({ order: ['query:gone', 'all'], hidden: [], queries: [q] });
    expect(out.order).not.toContain('query:gone'); // no backing query → dropped
    expect(out.order).toContain('query:1'); // backed but unordered → appended
  });

  it('clamps hidden to ids present in the final order', () => {
    const out = reconcile({ order: ['all'], hidden: ['all', 'bogus', 'all'], queries: [] });
    expect(out.hidden).toEqual(['all']);
  });

  it('preserves divider ids in place and de-dupes them', () => {
    const out = reconcile({
      order: ['all', 'divider:1', 'favorites', 'divider:1'],
      hidden: [],
      queries: [],
    });
    expect(out.order.filter((id) => id === 'divider:1')).toHaveLength(1);
    expect(out.order.indexOf('divider:1')).toBe(1); // kept between all + favorites
  });
});

describe('isDividerId', () => {
  it('matches only divider-prefixed strings', () => {
    expect(isDividerId('divider:abc')).toBe(true);
    expect(isDividerId('query:abc')).toBe(false);
    expect(isDividerId('all')).toBe(false);
    expect(isDividerId(42)).toBe(false);
  });
});

describe('parseSavedFilter', () => {
  it('accepts the closed kinds', () => {
    expect(parseSavedFilter({ kind: 'favorites' })).toEqual({ kind: 'favorites' });
    expect(parseSavedFilter({ kind: 'type', itemType: 'login' })).toEqual({ kind: 'type', itemType: 'login' });
  });

  it('rejects unknown kinds, bad item types, and non-objects', () => {
    expect(parseSavedFilter({ kind: 'folder', folderId: null })).toBeNull();
    expect(parseSavedFilter({ kind: 'type', itemType: 'nope' })).toBeNull();
    expect(parseSavedFilter({ kind: 'type' })).toBeNull();
    expect(parseSavedFilter(null)).toBeNull();
    expect(parseSavedFilter('all')).toBeNull();
  });
});

describe('parseCustomQuery', () => {
  it('accepts a well-formed query', () => {
    expect(parseCustomQuery(query())).toEqual(query());
  });

  it('rejects bad ids, empty names, missing query text, and bad filters', () => {
    expect(parseCustomQuery({ ...query(), id: 'abc' })).toBeNull();
    expect(parseCustomQuery({ ...query(), name: '   ' })).toBeNull();
    expect(parseCustomQuery({ ...query(), query: 42 })).toBeNull();
    expect(parseCustomQuery({ ...query(), filter: { kind: 'folder' } })).toBeNull();
    expect(parseCustomQuery(null)).toBeNull();
  });
});

describe('readSidebarConfig', () => {
  it('returns defaults when nothing is stored', () => {
    expect(readSidebarConfig()).toEqual(defaultSidebar());
  });

  it('falls back to defaults on corrupt JSON', () => {
    localStorage.setItem(SIDEBAR_STORAGE_KEY, '{not json');
    expect(readSidebarConfig()).toEqual(defaultSidebar());
  });

  it('round-trips a stored config through reconcile, dropping corrupt queries', () => {
    const good = query({ id: 'query:keep' });
    localStorage.setItem(
      SIDEBAR_STORAGE_KEY,
      JSON.stringify({
        order: ['favorites', 'all', 'query:keep'],
        hidden: ['trash'],
        queries: [good, { id: 'query:bad', name: '', query: '', filter: { kind: 'all' } }],
      }),
    );
    const out = readSidebarConfig();
    expect(out.order[0]).toBe('favorites');
    expect(out.queries).toEqual([good]); // empty-name query dropped
    expect(out.hidden).toEqual(['trash']);
    expect(out.order).toContain('query:keep');
  });
});
