// Shared presentation helpers for the offline vault-health audit. The audit
// itself runs in the backend (`audit_offline`, see src-tauri/src/audit.rs); these
// helpers turn a per-item `ItemAudit` into the chips shown in the detail pane and
// the vault-list "Security" column, so both render the same flag set.

import type { ItemAudit } from './types.ts';
import { t } from './i18n.ts';

export interface AuditChip {
  label: string;
  /** Worst-tier issue (reused / weak / insecure URL) — render destructive. */
  severe: boolean;
}

/** Audit flags for one item, ordered worst-first. Empty when the item is clean. */
export function itemAuditChips(a: ItemAudit): AuditChip[] {
  return [
    a.reused && { label: t('audit.reused'), severe: true },
    a.weak && { label: t('audit.weak'), severe: true },
    a.insecureUri && { label: t('audit.insecureUrl'), severe: true },
    a.old && { label: t('audit.old'), severe: false },
    a.noTotp && { label: t('audit.noTwoFactor'), severe: false },
  ].filter((c): c is AuditChip => Boolean(c));
}

/**
 * Worst severity for an at-risk item: `risk` when any severe flag (reused / weak
 * / insecure URL) is present, else `warn` (minor flags only). The single source
 * for the Security column's badge colour and its sort/group ranking.
 */
export function auditSeverity(a: ItemAudit): 'warn' | 'risk' {
  return itemAuditChips(a).some((c) => c.severe) ? 'risk' : 'warn';
}
