// Pure cell-content logic for the vault list: given an item, a column, and the
// lazily-fetched caches, decide WHAT a cell shows — without rendering any JSX. It
// returns a small discriminated descriptor (blank / text / masked secret / a live
// TOTP / security chips) that `VaultListCell.tsx` turns into markup. Keeping this
// half pure (no signals, no DOM) makes the masked-vs-revealed and detail-lookup
// rules testable on their own and keeps the cell component a thin renderer.

import type { ColumnSpec } from '../state/columnConfig.ts';
import { columnKey, TYPE_LABELS } from '../state/columnConfig.ts';
import type { ItemAudit, ItemDetail, TotpCode, VaultItem } from './types.ts';
import { auditSeverity, itemAuditChips } from './audit.ts';
import { hostOf } from '../state/favicons.ts';
import { t } from './i18n.ts';

/**
 * What a vault-list cell should display. A discriminated union so the renderer
 * can't accidentally mix up a masked secret with a real value:
 *  - `blank`   — render an empty cell (wrong item type, missing value, etc.).
 *  - `text`    — a plain string value, with optional styling flags.
 *  - `secret`  — a masked placeholder for an un-revealed secret column.
 *  - `totp`    — a revealed one-time code (possibly still loading: `code` null).
 *  - `secBadge`— the Security column's single status badge (ok/warn/risk) with a
 *               tooltip listing the flags.
 *  - `passkey` — the Passkey column's presence icon for a login with a FIDO2 cred.
 */
export type CellContent =
  | { kind: 'blank' }
  | {
      kind: 'text';
      value: string;
      truncate?: boolean;
      muted?: boolean;
      mono?: boolean;
      badge?: boolean;
    }
  | { kind: 'secret'; mask: string }
  | { kind: 'totp'; code: TotpCode | undefined }
  | { kind: 'secBadge'; status: SecurityStatus; tooltip: string }
  | { kind: 'passkey' };

/** Security column status: clean / minor issues only / at least one severe issue. */
export type SecurityStatus = 'ok' | 'warn' | 'risk';

/** Lookups the cell logic needs from the surrounding list (kept side-effect-free). */
export interface CellContext {
  /** Whether a column key's secret content is currently revealed. */
  isRevealed: (key: string) => boolean;
  /** Decrypted detail for a row, if fetched. */
  detail: (id: string) => ItemDetail | undefined;
  /** Cached TOTP code for a row, if fetched. */
  totp: (id: string) => TotpCode | undefined;
  /** Folder display name for a folder id (empty for none/unknown). */
  folderName: (id: string | null) => string;
  /** Audit record for an at-risk login, if the report flags it. */
  audit: (id: string) => ItemAudit | undefined;
  /** Whether an offline health report is loaded (Security column shows nothing without it). */
  hasSecurityReport: boolean;
}

/** Decide the content of one cell for one item + column. Pure. */
export function cellContent(item: VaultItem, col: ColumnSpec, ctx: CellContext): CellContent {
  if (col.kind === 'custom') return customCell(item, col.field, columnKey(col), ctx);
  switch (col.id) {
    case 'username':
      return { kind: 'text', value: item.username ?? '', truncate: true };
    case 'website':
      // Show just the site host (drop scheme + path/query), falling back to the
      // raw value for things that aren't a real host (app schemes, bare words).
      return { kind: 'text', value: hostOf(item.uri) ?? item.uri ?? '', truncate: true, muted: true };
    case 'folder':
      return { kind: 'text', value: ctx.folderName(item.folderId), truncate: true, muted: true };
    case 'type':
      return { kind: 'text', value: TYPE_LABELS[item.itemType], badge: true };
    case 'totp':
      return totpCell(item, columnKey(col), ctx);
    case 'password':
      return passwordCell(item, columnKey(col), ctx);
    case 'security':
      return securityCell(item, ctx);
    case 'passkey':
      // Logins with a stored passkey only; blank for everything else.
      return item.itemType === 'login' && item.hasPasskey ? { kind: 'passkey' } : { kind: 'blank' };
  }
}

function securityCell(item: VaultItem, ctx: CellContext): CellContent {
  // The audit covers logins only; show nothing for other types or before the
  // first report arrives.
  if (item.itemType !== 'login' || !ctx.hasSecurityReport) return { kind: 'blank' };
  const audit = ctx.audit(item.id);
  if (!audit) return { kind: 'secBadge', status: 'ok', tooltip: t('audit.noKnownIssues') };
  // Collapse the per-flag chips into one status: red when any severe flag (reused
  // / weak / insecure URL) is present, amber when only minor flags are. The
  // tooltip still spells out every flag.
  const chips = itemAuditChips(audit);
  if (chips.length === 0) return { kind: 'secBadge', status: 'ok', tooltip: t('audit.noKnownIssues') };
  return {
    kind: 'secBadge',
    status: auditSeverity(audit),
    tooltip: chips.map((c) => c.label).join(', '),
  };
}

function passwordCell(item: VaultItem, key: string, ctx: CellContext): CellContent {
  if (item.itemType !== 'login') return { kind: 'blank' };
  if (!ctx.isRevealed(key)) return { kind: 'secret', mask: '••••••••' };
  const pw = ctx.detail(item.id)?.login?.password;
  return { kind: 'text', value: pw ?? '…', mono: true, truncate: true };
}

function totpCell(item: VaultItem, key: string, ctx: CellContext): CellContent {
  if (!item.hasTotp) return { kind: 'blank' };
  if (!ctx.isRevealed(key)) return { kind: 'secret', mask: '••• •••' };
  return { kind: 'totp', code: ctx.totp(item.id) };
}

function customCell(item: VaultItem, field: string, key: string, ctx: CellContext): CellContent {
  const d = ctx.detail(item.id);
  if (!d) return { kind: 'text', value: '…', muted: true };
  const f = d.fields.find((x) => x.name === field);
  if (!f || f.value === null) return { kind: 'blank' };
  if (f.fieldType === 'hidden' && !ctx.isRevealed(key)) return { kind: 'secret', mask: '••••••' };
  return { kind: 'text', value: f.value, truncate: true };
}
