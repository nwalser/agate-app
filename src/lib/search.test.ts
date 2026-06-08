import { describe, expect, it } from 'vitest';
import { filterItems, matchesQuery } from './search.ts';
import type { VaultItem } from './types.ts';

function item(partial: Partial<VaultItem>): VaultItem {
  return {
    id: partial.id ?? 'id',
    name: partial.name ?? 'name',
    itemType: partial.itemType ?? 'login',
    username: partial.username ?? null,
    hasTotp: partial.hasTotp ?? false,
    favorite: partial.favorite ?? false,
    folderId: partial.folderId ?? null,
    organizationId: partial.organizationId ?? null,
  };
}

describe('matchesQuery', () => {
  it('matches everything on empty query', () => {
    expect(matchesQuery(item({ name: 'GitHub' }), '   ')).toBe(true);
  });

  it('matches on name, case-insensitively', () => {
    expect(matchesQuery(item({ name: 'GitHub' }), 'git')).toBe(true);
    expect(matchesQuery(item({ name: 'GitHub' }), 'lab')).toBe(false);
  });

  it('matches on username', () => {
    expect(matchesQuery(item({ name: 'x', username: 'alice@example.com' }), 'alice')).toBe(true);
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
});
