import { describe, expect, it } from 'vitest';
import { groupOf, type GroupContext } from './grouping.ts';
import type { ItemAudit, VaultItem } from './types.ts';

const item = (over: Partial<VaultItem> = {}): VaultItem => ({
  id: 'i1',
  accountEmail: 'a@b.c',
  accountLabel: 'Cloud',
  name: 'Example',
  itemType: 'login',
  username: 'user',
  uri: 'https://example.com',
  hasTotp: false,
  hasPasskey: false,
  favorite: false,
  deleted: false,
  folderId: null,
  organizationId: null,
  ...over,
});

const audit = (over: Partial<ItemAudit> = {}): ItemAudit => ({
  id: 'i1',
  name: 'Example',
  reused: false,
  weak: false,
  weakScore: null,
  old: false,
  insecureUri: false,
  noTotp: false,
  ...over,
});

const ctx = (over: Partial<GroupContext> = {}): GroupContext => ({
  folderName: () => '',
  audit: () => undefined,
  hasSecurityReport: true,
  ...over,
});

describe('groupOf', () => {
  it('groups by folder, trailing the unfoldered rows', () => {
    const named = groupOf(item({ folderId: 'f1' }), 'folder', ctx({ folderName: () => 'Work' }));
    const none = groupOf(item({ folderId: null }), 'folder', ctx());
    expect(named).toMatchObject({ id: 'f:f1', label: 'Work', rank: 0 });
    expect(none).toMatchObject({ id: 'f:none', label: 'No folder', rank: 1 });
    expect(none.rank).toBeGreaterThan(named.rank); // unfoldered sorts last
  });

  it('groups by type using the type label', () => {
    expect(groupOf(item({ itemType: 'card' }), 'type', ctx())).toMatchObject({
      id: 't:card',
      label: 'Card',
    });
  });

  it('ranks security risk above warn above ok above not-applicable', () => {
    const risk = groupOf(item(), 'security', ctx({ audit: () => audit({ reused: true }) }));
    const warn = groupOf(item(), 'security', ctx({ audit: () => audit({ old: true }) }));
    const ok = groupOf(item(), 'security', ctx());
    const na = groupOf(item({ itemType: 'card' }), 'security', ctx());
    expect(risk).toMatchObject({ id: 's:risk', label: 'At risk' });
    expect(warn).toMatchObject({ id: 's:warn', label: 'Minor issues' });
    expect(ok).toMatchObject({ id: 's:ok', label: 'No issues' });
    expect(na).toMatchObject({ id: 's:na', label: 'Not applicable' });
    expect(risk.rank).toBeLessThan(warn.rank);
    expect(warn.rank).toBeLessThan(ok.rank);
    expect(ok.rank).toBeLessThan(na.rank);
  });

  it('treats logins as not-applicable until a report is loaded', () => {
    expect(groupOf(item(), 'security', ctx({ hasSecurityReport: false }))).toMatchObject({
      id: 's:na',
    });
  });
});
