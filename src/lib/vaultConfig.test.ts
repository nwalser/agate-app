import { describe, expect, it } from 'vitest';
import { CREATE_TYPES, TYPE_FILTERS, createLabel, filterEq } from './vaultConfig.ts';
import type { VaultFilter } from './search.ts';

describe('filterEq', () => {
  it('matches simple same-kind filters', () => {
    expect(filterEq({ kind: 'all' }, { kind: 'all' })).toBe(true);
    expect(filterEq({ kind: 'favorites' }, { kind: 'favorites' })).toBe(true);
  });

  it('distinguishes different kinds', () => {
    expect(filterEq({ kind: 'all' }, { kind: 'trash' })).toBe(false);
  });

  it('compares the item type for type filters', () => {
    expect(filterEq({ kind: 'type', itemType: 'login' }, { kind: 'type', itemType: 'login' })).toBe(true);
    expect(filterEq({ kind: 'type', itemType: 'login' }, { kind: 'type', itemType: 'card' })).toBe(false);
  });

  it('compares the folder id for folder filters', () => {
    const a: VaultFilter = { kind: 'folder', folderId: 'f1' };
    expect(filterEq(a, { kind: 'folder', folderId: 'f1' })).toBe(true);
    expect(filterEq(a, { kind: 'folder', folderId: 'f2' })).toBe(false);
  });
});

describe('createLabel', () => {
  it('returns the singular label for a known type', () => {
    expect(createLabel('login')).toBe('Login');
    expect(createLabel('secureNote')).toBe('Secure note');
  });

  it('falls back to "item" for an unknown type', () => {
    expect(createLabel('unknown')).toBe('item');
  });
});

describe('type lists', () => {
  it('CREATE_TYPES and TYPE_FILTERS cover the same five creatable types', () => {
    expect(CREATE_TYPES.map((t) => t.type)).toEqual(TYPE_FILTERS.map((t) => t.type));
  });

  it('never offers the synthetic "unknown" type for creation', () => {
    expect(CREATE_TYPES.some((t) => t.type === 'unknown')).toBe(false);
  });
});
