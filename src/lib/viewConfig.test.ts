import { describe, expect, it } from 'vitest';
import { sameViewConfig } from './viewConfig.ts';
import { parseCustomQuery, type ViewConfig } from './sidebarConfig.ts';
import { DEFAULT } from '../state/columnConfig.ts';

const base = (over: Partial<ViewConfig> = {}): ViewConfig => ({
  filter: { kind: 'all' },
  query: '',
  columnFilters: {},
  ...over,
});

describe('sameViewConfig', () => {
  it('treats structurally-equal configs as equal', () => {
    expect(sameViewConfig(base(), base())).toBe(true);
    expect(
      sameViewConfig(base({ columnFilters: { 'builtin:username': 'a' } }), base({ columnFilters: { 'builtin:username': 'a' } })),
    ).toBe(true);
  });
  it('detects differences in filter / query / column filters', () => {
    expect(sameViewConfig(base(), base({ query: 'x' }))).toBe(false);
    expect(sameViewConfig(base(), base({ filter: { kind: 'favorites' } }))).toBe(false);
    expect(sameViewConfig(base(), base({ columnFilters: { 'builtin:website': 'g' } }))).toBe(false);
  });
  it('detects sort differences and treats both-absent as equal', () => {
    expect(sameViewConfig(base(), base({ sort: { key: 'name', dir: 'asc' } }))).toBe(false);
    expect(
      sameViewConfig(base({ sort: { key: 'name', dir: 'asc' } }), base({ sort: { key: 'name', dir: 'desc' } })),
    ).toBe(false);
    expect(sameViewConfig(base(), base())).toBe(true);
  });
  it('treats one-columns-absent as different and equal columns as same', () => {
    expect(sameViewConfig(base(), base({ columns: DEFAULT }))).toBe(false);
    expect(sameViewConfig(base({ columns: DEFAULT }), base({ columns: { ...DEFAULT } }))).toBe(true);
  });
});

describe('parseCustomQuery', () => {
  it('upgrades a legacy {query,filter} into a config (bookmark icon, no layout)', () => {
    const q = parseCustomQuery({ id: 'query:1', name: 'AWS', query: 'aws', filter: { kind: 'favorites' } });
    expect(q).toEqual({
      id: 'query:1',
      name: 'AWS',
      icon: 'bookmark',
      config: { filter: { kind: 'favorites' }, query: 'aws', columnFilters: {} },
    });
  });
  it('round-trips the new shape and keeps a valid icon', () => {
    const q = parseCustomQuery({
      id: 'query:2',
      name: 'Logins',
      icon: 'star',
      config: { filter: { kind: 'type', itemType: 'login' }, query: 'g', columnFilters: { 'builtin:username': 'bob' } },
    });
    expect(q?.icon).toBe('star');
    expect(q?.config.filter).toEqual({ kind: 'type', itemType: 'login' });
    expect(q?.config.columnFilters).toEqual({ 'builtin:username': 'bob' });
  });
  it('falls back to the bookmark icon for an unknown icon id', () => {
    const q = parseCustomQuery({ id: 'query:3', name: 'X', icon: 'bogus', config: {} });
    expect(q?.icon).toBe('bookmark');
    expect(q?.config).toEqual({ filter: { kind: 'all' }, query: '', columnFilters: {} });
  });
  it('rejects a bad id or empty name', () => {
    expect(parseCustomQuery({ id: 'nope', name: 'X', config: {} })).toBeNull();
    expect(parseCustomQuery({ id: 'query:4', name: '  ', config: {} })).toBeNull();
  });
});
