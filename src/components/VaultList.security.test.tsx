// Integration test for the vault-list "Security" column badge. Renders the real
// VaultList with the security column visible and an offline-health report, then
// asserts each row's badge severity end-to-end (report → securityById → cellContent
// → VaultListCell → DOM). Captures the "always shows green" regression: an at-risk
// login must render a warn/risk badge, not the audited-clean (ok) one.

import { cleanup, render } from '@solidjs/testing-library';
import { createSignal } from 'solid-js';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import VaultList from './VaultList.tsx';
import { resetColumns, toggleColumn } from '../state/columns.ts';
import type { ItemAudit, VaultHealthReport, VaultItem } from '../lib/types.ts';

const login = (over: Partial<VaultItem> = {}): VaultItem => ({
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

const report = (atRisk: ItemAudit[]): VaultHealthReport => ({
  score: 50,
  band: 'fair',
  totalLogins: 10,
  reused: atRisk.filter((a) => a.reused).length,
  weak: atRisk.filter((a) => a.weak).length,
  old: atRisk.filter((a) => a.old).length,
  insecure: atRisk.filter((a) => a.insecureUri).length,
  noTotp: atRisk.filter((a) => a.noTotp).length,
  atRisk,
});

function renderList(items: VaultItem[], security: VaultHealthReport | null) {
  return render(() => (
    <VaultList
      items={items}
      folders={[]}
      sortKey="name"
      sortDir="asc"
      onSort={() => undefined}
      onSetSort={() => undefined}
      selectedId={null}
      selectedCount={0}
      isSelected={() => false}
      cursorId={null}
      onRowClick={() => undefined}
      onRowContextMenu={() => undefined}
      onCheckboxToggle={() => undefined}
      onCopyCell={() => undefined}
      onListKeyDown={() => undefined}
      onMarqueeSelect={() => undefined}
      enableItemDrag={false}
      onCreateItem={() => undefined}
      onSelectAll={() => undefined}
      emptyMessage="empty"
      cacheToken={0}
      security={security}
    />
  ));
}

const badgeIn = (row: Element) => row.querySelector('.vault-sec-badge');

describe('VaultList — Security column badge', () => {
  beforeEach(() => {
    localStorage.clear();
    resetColumns();
    // Make the Security column visible (defaults are [username, website]).
    toggleColumn({ kind: 'builtin', id: 'security' });
  });
  afterEach(cleanup);

  it('renders a red (risk) badge for a login flagged with a severe issue', () => {
    const item = login({ id: 'risky', name: 'Risky' });
    renderList([item], report([audit({ id: 'risky', reused: true })]));
    const row = document.querySelector('[data-item-id="risky"]')!;
    const badge = badgeIn(row)!;
    expect(badge).toBeTruthy();
    expect(badge.classList.contains('risk')).toBe(true);
    expect(badge.classList.contains('ok')).toBe(false);
  });

  it('renders an amber (warn) badge for a login with only minor issues', () => {
    const item = login({ id: 'minor', name: 'Minor' });
    renderList([item], report([audit({ id: 'minor', old: true })]));
    const badge = badgeIn(document.querySelector('[data-item-id="minor"]')!)!;
    expect(badge.classList.contains('warn')).toBe(true);
    expect(badge.classList.contains('ok')).toBe(false);
  });

  it('renders a green (ok) badge for an audited-clean login', () => {
    const item = login({ id: 'clean', name: 'Clean' });
    renderList([item], report([audit({ id: 'risky', reused: true })])); // clean not in atRisk
    const badge = badgeIn(document.querySelector('[data-item-id="clean"]')!)!;
    expect(badge.classList.contains('ok')).toBe(true);
  });

  it('distinguishes risky vs clean rows in the same list', () => {
    const risky = login({ id: 'r', name: 'Risky' });
    const clean = login({ id: 'c', name: 'Clean' });
    renderList([risky, clean], report([audit({ id: 'r', weak: true })]));
    expect(badgeIn(document.querySelector('[data-item-id="r"]')!)!.classList.contains('risk')).toBe(true);
    expect(badgeIn(document.querySelector('[data-item-id="c"]')!)!.classList.contains('ok')).toBe(true);
  });

  // The real app loads the offline-health report ASYNC, after the first render.
  // The badge must re-evaluate when it arrives — otherwise it stays stuck green.
  it('updates the badge when the health report loads after first render', () => {
    const item = login({ id: 'late', name: 'Late' });
    const [sec, setSec] = createSignal<VaultHealthReport | null>(null);
    render(() => (
      <VaultList
        items={[item]}
        folders={[]}
        sortKey="name"
        sortDir="asc"
        onSort={() => undefined}
        onSetSort={() => undefined}
        selectedId={null}
        selectedCount={0}
        isSelected={() => false}
        cursorId={null}
        onRowClick={() => undefined}
        onRowContextMenu={() => undefined}
        onCheckboxToggle={() => undefined}
        onCopyCell={() => undefined}
        onListKeyDown={() => undefined}
        onMarqueeSelect={() => undefined}
        enableItemDrag={false}
        onCreateItem={() => undefined}
        onSelectAll={() => undefined}
        emptyMessage="empty"
        cacheToken={0}
        security={sec()}
      />
    ));
    // No report yet → the column is blank (no badge).
    expect(badgeIn(document.querySelector('[data-item-id="late"]')!)).toBeNull();
    // Report arrives flagging the item → badge must switch to risk, not stay green/blank.
    setSec(report([audit({ id: 'late', reused: true })]));
    expect(badgeIn(document.querySelector('[data-item-id="late"]')!)!.classList.contains('risk')).toBe(true);
  });
});
