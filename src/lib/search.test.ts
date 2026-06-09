import { describe, expect, it } from 'vitest';
import { filterItems, fuzzyContains, matchesQuery, passesFilter } from './search.ts';
import type { VaultItem } from './types.ts';

function item(partial: Partial<VaultItem>): VaultItem {
  return {
    id: partial.id ?? 'id',
    accountEmail: partial.accountEmail ?? 'a@example.com',
    accountLabel: partial.accountLabel ?? 'Bitwarden US',
    name: partial.name ?? 'name',
    itemType: partial.itemType ?? 'login',
    username: partial.username ?? null,
    uri: partial.uri ?? null,
    hasTotp: partial.hasTotp ?? false,
    hasPasskey: partial.hasPasskey ?? false,
    favorite: partial.favorite ?? false,
    deleted: partial.deleted ?? false,
    folderId: partial.folderId ?? null,
    organizationId: partial.organizationId ?? null,
  };
}

describe('fuzzyContains', () => {
  it('matches everything on empty query', () => {
    expect(fuzzyContains('GitHub', '')).toBe(true);
  });

  it('matches an ordered subsequence, case-insensitively', () => {
    expect(fuzzyContains('GitHub', 'gh')).toBe(true);
    expect(fuzzyContains('GitHub', 'git')).toBe(true);
    expect(fuzzyContains('GitHub', 'hub')).toBe(true);
  });

  it('rejects out-of-order or absent characters', () => {
    expect(fuzzyContains('GitHub', 'hg')).toBe(false);
    expect(fuzzyContains('GitHub', 'lab')).toBe(false);
  });
});

describe('matchesQuery', () => {
  it('matches everything on empty query', () => {
    expect(matchesQuery(item({ name: 'GitHub' }), '   ')).toBe(true);
  });

  it('matches on name, case-insensitively (subsequence)', () => {
    expect(matchesQuery(item({ name: 'GitHub' }), 'git')).toBe(true);
    expect(matchesQuery(item({ name: 'GitHub' }), 'gh')).toBe(true);
    expect(matchesQuery(item({ name: 'GitHub' }), 'lab')).toBe(false);
  });

  it('matches on username', () => {
    expect(matchesQuery(item({ name: 'x', username: 'alice@example.com' }), 'alice')).toBe(true);
  });
});

describe('passesFilter', () => {
  it('all hides trashed items', () => {
    expect(passesFilter(item({ deleted: false }), { kind: 'all' })).toBe(true);
    expect(passesFilter(item({ deleted: true }), { kind: 'all' })).toBe(false);
  });

  it('favorites shows only non-trashed favorites', () => {
    expect(passesFilter(item({ favorite: true }), { kind: 'favorites' })).toBe(true);
    expect(passesFilter(item({ favorite: false }), { kind: 'favorites' })).toBe(false);
    expect(passesFilter(item({ favorite: true, deleted: true }), { kind: 'favorites' })).toBe(false);
  });

  it('trash shows only trashed items', () => {
    expect(passesFilter(item({ deleted: true }), { kind: 'trash' })).toBe(true);
    expect(passesFilter(item({ deleted: false }), { kind: 'trash' })).toBe(false);
  });

  it('type matches the given item type and hides trash', () => {
    expect(passesFilter(item({ itemType: 'card' }), { kind: 'type', itemType: 'card' })).toBe(true);
    expect(passesFilter(item({ itemType: 'login' }), { kind: 'type', itemType: 'card' })).toBe(false);
    expect(
      passesFilter(item({ itemType: 'card', deleted: true }), { kind: 'type', itemType: 'card' }),
    ).toBe(false);
  });

  it('folder matches by folderId and hides trash', () => {
    expect(passesFilter(item({ folderId: 'f1' }), { kind: 'folder', folderId: 'f1' })).toBe(true);
    expect(passesFilter(item({ folderId: 'f2' }), { kind: 'folder', folderId: 'f1' })).toBe(false);
    expect(
      passesFilter(item({ folderId: 'f1', deleted: true }), { kind: 'folder', folderId: 'f1' }),
    ).toBe(false);
  });

  it('folder with null id matches items with no folder', () => {
    expect(passesFilter(item({ folderId: null }), { kind: 'folder', folderId: null })).toBe(true);
    expect(passesFilter(item({ folderId: 'f1' }), { kind: 'folder', folderId: null })).toBe(false);
  });

  it('atRisk behaves like all here (the report-based narrowing lives in the hook)', () => {
    // At item granularity it only drops trash; membership in the at-risk set is
    // applied by useVaultFiltering, which has the health report.
    expect(passesFilter(item({ deleted: false }), { kind: 'atRisk' })).toBe(true);
    expect(passesFilter(item({ deleted: true }), { kind: 'atRisk' })).toBe(false);
  });
});

describe('filterItems', () => {
  it('sorts favorites first, then alphabetically', () => {
    const items = [
      item({ id: 'a', name: 'Zeta' }),
      item({ id: 'b', name: 'alpha', favorite: true }),
      item({ id: 'c', name: 'Beta' }),
    ];
    const sorted = filterItems(items, '');
    expect(sorted.map((i) => i.id)).toEqual(['b', 'c', 'a']);
  });

  it('filters by query before sorting', () => {
    const items = [item({ name: 'GitHub' }), item({ name: 'GitLab' }), item({ name: 'Email' })];
    expect(filterItems(items, 'git').map((i) => i.name)).toEqual(['GitHub', 'GitLab']);
  });

  it('hides trashed items under the default filter', () => {
    const items = [item({ name: 'Live' }), item({ name: 'Gone', deleted: true })];
    expect(filterItems(items, '').map((i) => i.name)).toEqual(['Live']);
  });

  it('shows only trashed items under the trash filter', () => {
    const items = [item({ name: 'Live' }), item({ name: 'Gone', deleted: true })];
    expect(filterItems(items, '', { kind: 'trash' }).map((i) => i.name)).toEqual(['Gone']);
  });
});
