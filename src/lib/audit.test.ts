import { describe, expect, it } from 'vitest';
import { auditSeverity, itemAuditChips } from './audit.ts';
import type { ItemAudit } from './types.ts';

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

describe('itemAuditChips', () => {
  it('is empty for a clean item', () => {
    expect(itemAuditChips(audit())).toEqual([]);
  });

  it('orders flags worst-first and marks severity', () => {
    const chips = itemAuditChips(
      audit({ reused: true, weak: true, insecureUri: true, old: true, noTotp: true }),
    );
    expect(chips.map((c) => c.label)).toEqual(['Reused', 'Weak', 'Insecure URL', 'Old', 'No 2FA']);
    expect(chips.map((c) => c.severe)).toEqual([true, true, true, false, false]);
  });

  it('includes only the flags that are set', () => {
    expect(itemAuditChips(audit({ old: true })).map((c) => c.label)).toEqual(['Old']);
  });
});

describe('auditSeverity', () => {
  it('is "risk" when any severe flag is present', () => {
    expect(auditSeverity(audit({ reused: true }))).toBe('risk');
    expect(auditSeverity(audit({ weak: true, old: true }))).toBe('risk');
    expect(auditSeverity(audit({ insecureUri: true }))).toBe('risk');
  });

  it('is "warn" when only minor flags are present', () => {
    expect(auditSeverity(audit({ old: true }))).toBe('warn');
    expect(auditSeverity(audit({ noTotp: true }))).toBe('warn');
    expect(auditSeverity(audit({ old: true, noTotp: true }))).toBe('warn');
  });
});
