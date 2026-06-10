import { describe, expect, it } from 'vitest';
import { compareGroups, customFieldGroupValue, groupOf, type GroupContext } from './grouping.ts';
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
  reprompt: false,
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

  it('groups by name initial, bucketing digits/symbols and empty names', () => {
    expect(groupOf(item({ name: 'apple' }), 'name', ctx())).toMatchObject({ id: 'n:A', label: 'A', rank: 0 });
    expect(groupOf(item({ name: '7-Zip' }), 'name', ctx())).toMatchObject({ id: 'n:#', label: '#', rank: 0 });
    expect(groupOf(item({ name: '  ' }), 'name', ctx())).toMatchObject({ id: 'n:none', label: '—', rank: 1 });
  });

  it('groups by username, trailing the rows with no username', () => {
    const named = groupOf(item({ username: 'Alice' }), 'username', ctx());
    const none = groupOf(item({ username: null }), 'username', ctx());
    expect(named).toMatchObject({ id: 'u:alice', label: 'Alice', rank: 0 });
    expect(none).toMatchObject({ id: 'u:none', label: 'No username', rank: 1 });
    expect(none.rank).toBeGreaterThan(named.rank);
  });

  it('groups by passkey presence', () => {
    expect(groupOf(item({ hasPasskey: true }), 'passkey', ctx())).toMatchObject({ id: 'k:yes', label: 'Has passkey' });
    expect(groupOf(item({ hasPasskey: false }), 'passkey', ctx())).toMatchObject({ id: 'k:no', label: 'No passkey' });
  });

  it('groups by website host (lowercased), trailing rows with no/unparseable website', () => {
    const named = groupOf(item({ uri: 'https://Login.Example.com/path' }), 'website', ctx());
    const bare = groupOf(item({ uri: 'example.com' }), 'website', ctx());
    const none = groupOf(item({ uri: null }), 'website', ctx());
    expect(named).toMatchObject({ id: 'w:login.example.com', label: 'login.example.com', rank: 0 });
    expect(bare).toMatchObject({ id: 'w:example.com', label: 'example.com', rank: 0 });
    expect(none).toMatchObject({ id: 'w:none', label: 'No website', rank: 1 });
  });

  it('groups by one-time-code presence — never by value', () => {
    expect(groupOf(item({ hasTotp: true }), 'totp', ctx())).toMatchObject({
      id: 'o:yes',
      label: 'Has one-time code',
      rank: 0,
    });
    expect(groupOf(item({ hasTotp: false }), 'totp', ctx())).toMatchObject({ id: 'o:no', label: 'None', rank: 1 });
  });

  it('compareGroups follows the label direction but keeps rank-pinned buckets last', () => {
    const a = { id: 'u:alice', label: 'alice', rank: 0 };
    const b = { id: 'u:bob', label: 'bob', rank: 0 };
    const none = { id: 'u:none', label: 'No username', rank: 1 };
    expect(compareGroups(a, b, 1)).toBeLessThan(0);
    expect(compareGroups(a, b, -1)).toBeGreaterThan(0); // desc flips label order
    expect(compareGroups(a, none, -1)).toBeLessThan(0); // 'No username' stays last
    expect(compareGroups(none, b, -1)).toBeGreaterThan(0);
  });

  it('groups by password presence (login rows), trailing non-logins', () => {
    expect(groupOf(item({ itemType: 'login' }), 'password', ctx())).toMatchObject({
      id: 'p:yes',
      label: 'Has password',
      rank: 0,
    });
    expect(groupOf(item({ itemType: 'secureNote' }), 'password', ctx())).toMatchObject({
      id: 'p:no',
      label: 'No password',
      rank: 1,
    });
  });

  it('groups by a custom field value; hidden fields bucket as Hidden, never the value', () => {
    const spec = { kind: 'custom', field: 'Environment' } as const;
    const fv = (v: ReturnType<NonNullable<GroupContext['fieldValue']>>) =>
      ctx({ fieldValue: () => v });

    expect(groupOf(item(), spec, fv({ state: 'value', value: 'Prod' }))).toMatchObject({
      id: 'cf:prod',
      label: 'Prod',
      rank: 0,
    });
    const hidden = groupOf(item(), spec, fv({ state: 'hidden' }));
    expect(hidden).toMatchObject({ id: 'cf:hidden', label: 'Hidden' });
    expect(JSON.stringify(hidden)).not.toContain('Prod'); // value never leaks
    expect(groupOf(item(), spec, fv({ state: 'missing' }))).toMatchObject({
      id: 'cf:none',
      label: 'No Environment',
    });
    // No fieldValue provided at all ⇒ provisional Loading bucket, ranked last.
    expect(groupOf(item(), spec, ctx())).toMatchObject({ id: 'cf:loading', label: 'Loading…' });
  });

  it('customFieldGroupValue resolves loading/missing/hidden/value from a detail map', () => {
    const detail = (fields: { name: string; value: string | null; fieldType: string }[]) =>
      ({ id: 'i1', fields }) as never;
    const m = new Map<string, never>([
      ['i1', detail([{ name: 'Env', value: 'Prod', fieldType: 'text' }])],
      ['i2', detail([{ name: 'Env', value: 'secret', fieldType: 'hidden' }])],
      ['i3', detail([])],
    ]);
    expect(customFieldGroupValue(m, 'i1', 'Env')).toEqual({ state: 'value', value: 'Prod' });
    expect(customFieldGroupValue(m, 'i2', 'Env')).toEqual({ state: 'hidden' });
    expect(customFieldGroupValue(m, 'i3', 'Env')).toEqual({ state: 'missing' });
    expect(customFieldGroupValue(m, 'not-fetched', 'Env')).toEqual({ state: 'loading' });
  });
});
