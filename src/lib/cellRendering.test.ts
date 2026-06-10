import { describe, expect, it } from 'vitest';
import { cellContent, type CellContext } from './cellRendering.ts';
import type { ColumnSpec } from '../state/columnConfig.ts';
import { makeAudit as audit, makeItem } from '../testing/factories.ts';
import type { VaultItem } from './types.ts';

const SECURITY_COL: ColumnSpec = { kind: 'builtin', id: 'security' };

const login = (over: Partial<VaultItem> = {}): VaultItem =>
  makeItem({
    id: 'i1',
    name: 'Example',
    accountEmail: 'a@b.c',
    accountLabel: 'Cloud',
    username: 'user',
    uri: 'https://example.com',
    ...over,
  });

const ctx = (over: Partial<CellContext> = {}): CellContext => ({
  isRevealed: () => false,
  detail: () => undefined,
  totp: () => undefined,
  folderName: () => '',
  audit: () => undefined,
  hasSecurityReport: true,
  ...over,
});

describe('securityCell', () => {
  it('is blank for non-logins', () => {
    expect(cellContent(login({ itemType: 'card' }), SECURITY_COL, ctx())).toEqual({ kind: 'blank' });
  });

  it('is blank before a report is loaded', () => {
    expect(cellContent(login(), SECURITY_COL, ctx({ hasSecurityReport: false }))).toEqual({
      kind: 'blank',
    });
  });

  it('shows an ok badge when the item is not flagged', () => {
    expect(cellContent(login(), SECURITY_COL, ctx())).toEqual({
      kind: 'secBadge',
      status: 'ok',
      tooltip: 'No known security issues',
    });
  });

  it('shows a risk badge when a severe flag is present', () => {
    const c = cellContent(login(), SECURITY_COL, ctx({ audit: () => audit({ reused: true, old: true }) }));
    expect(c).toEqual({ kind: 'secBadge', status: 'risk', tooltip: 'Reused, Old' });
  });

  it('shows a warn badge when only minor flags are present', () => {
    const c = cellContent(login(), SECURITY_COL, ctx({ audit: () => audit({ old: true, noTotp: true }) }));
    expect(c).toEqual({ kind: 'secBadge', status: 'warn', tooltip: 'Old, No 2FA' });
  });
});

const PASSKEY_COL: ColumnSpec = { kind: 'builtin', id: 'passkey' };

describe('passkeyCell', () => {
  it('shows the passkey icon for a login that has one', () => {
    expect(cellContent(login({ hasPasskey: true }), PASSKEY_COL, ctx())).toEqual({ kind: 'passkey' });
  });

  it('is blank for a login without a passkey', () => {
    expect(cellContent(login({ hasPasskey: false }), PASSKEY_COL, ctx())).toEqual({ kind: 'blank' });
  });

  it('is blank for non-logins even if flagged', () => {
    expect(cellContent(login({ itemType: 'card', hasPasskey: true }), PASSKEY_COL, ctx())).toEqual({
      kind: 'blank',
    });
  });
});
