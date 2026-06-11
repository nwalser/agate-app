// Pure row-grouping logic for the vault list: given an item and a group key,
// decide which group header it belongs under. Kept side-effect-free (no signals,
// no DOM) so the list ordering (useVaultFiltering) and the header rendering
// (VaultList) agree on the same group identity/label/order from one definition.

import type { GroupKey, GroupSpec } from '../state/columnConfig.ts';
import { TYPE_LABELS } from '../state/columnConfig.ts';
import type { ItemAudit, ItemDetail, VaultItem } from './types.ts';
import { auditSeverity } from './audit.ts';
import { hostOf } from '../state/favicons.ts';
import { t } from './i18n.ts';

/** A row's value for a custom-field grouping, by readiness/secrecy. */
export type CustomFieldGroupValue =
  | { state: 'loading' } // detail not decrypted yet — bucket is provisional
  | { state: 'missing' } // item has no such field (or it's empty)
  | { state: 'hidden' } // hidden-type field: NEVER show the value in a header
  | { state: 'value'; value: string };

/** Resolve a custom-field group value from a (possibly not-yet-filled) detail
 *  cache map. Shared by the ordering layer and the list's header renderer so
 *  both see identical buckets. Hidden fields are masked unconditionally — a
 *  group header outlives any reveal toggle, so it must never carry the value. */
export function customFieldGroupValue(
  details: Map<string, ItemDetail>,
  id: string,
  field: string,
): CustomFieldGroupValue {
  const d = details.get(id);
  if (!d) return { state: 'loading' };
  const f = d.fields.find((x) => x.name === field);
  if (!f || !f.value) return { state: 'missing' };
  if (f.fieldType === 'hidden') return { state: 'hidden' };
  return { state: 'value', value: f.value };
}

/** Lookups grouping needs from the surrounding list. */
export interface GroupContext {
  /** Folder display name for a folder id (empty for none/unknown). */
  folderName: (id: string | null) => string;
  /** Audit record for an at-risk login, if the report flags it. */
  audit: (id: string) => ItemAudit | undefined;
  /** Whether an offline health report is loaded (security grouping needs it). */
  hasSecurityReport: boolean;
  /** A row's value for a custom-field grouping (absent ⇒ treated as loading). */
  fieldValue?: (id: string, field: string) => CustomFieldGroupValue;
}

/** One item's group placement. */
export interface GroupValue {
  /** Stable id used to detect group boundaries between adjacent rows. */
  id: string;
  /** Human-readable header label. */
  label: string;
  /** Sort rank between groups (lower first); ties broken by `label`. */
  rank: number;
}

/** Order two group placements: rank always pins the special buckets ('No X',
 *  'Not applicable') to the tail; within a rank the label order follows
 *  `labelDir`, so sorting descending BY the grouped column flips the groups
 *  too, not just the rows inside them. */
export function compareGroups(a: GroupValue, b: GroupValue, labelDir: 1 | -1): number {
  if (a.rank !== b.rank) return a.rank - b.rank;
  if (a.id === b.id) return 0;
  return labelDir * a.label.localeCompare(b.label, undefined, { sensitivity: 'base' });
}

/** The group an item falls into for a given grouping. Pure. A bare GroupKey
 *  string is shorthand for the builtin spec. */
export function groupOf(item: VaultItem, by: GroupKey | GroupSpec, ctx: GroupContext): GroupValue {
  const spec: GroupSpec = typeof by === 'string' ? { kind: 'builtin', key: by } : by;
  if (spec.kind === 'custom') {
    const fv = ctx.fieldValue?.(item.id, spec.field) ?? { state: 'loading' as const };
    switch (fv.state) {
      case 'value':
        return { id: `cf:${fv.value.toLowerCase()}`, label: fv.value, rank: 0 };
      // Hidden fields share ONE bucket — the value never reaches a header.
      case 'hidden':
        return { id: 'cf:hidden', label: t('group.hidden'), rank: 1 };
      case 'missing':
        return { id: 'cf:none', label: t('group.noField', { field: spec.field }), rank: 2 };
      case 'loading':
        return { id: 'cf:loading', label: t('group.loading'), rank: 3 };
    }
  }
  const key = spec.key;
  switch (key) {
    case 'name': {
      // Bucket by the first character: A–Z, "#" for digits/symbols, "—" for empty.
      const ch = item.name.trim().charAt(0).toUpperCase();
      if (!ch) return { id: 'n:none', label: '—', rank: 1 };
      if (ch >= 'A' && ch <= 'Z') return { id: `n:${ch}`, label: ch, rank: 0 };
      return { id: 'n:#', label: '#', rank: 0 };
    }
    case 'username': {
      const u = item.username?.trim();
      return u
        ? { id: `u:${u.toLowerCase()}`, label: u, rank: 0 }
        : { id: 'u:none', label: t('group.noUsername'), rank: 1 };
    }
    case 'passkey':
      return item.hasPasskey
        ? { id: 'k:yes', label: t('group.hasPasskey'), rank: 0 }
        : { id: 'k:no', label: t('group.noPasskey'), rank: 1 };
    case 'website': {
      // Bucket by bare lowercase host (the same derivation favicons use), so
      // https://login.x.com and login.x.com/path land together.
      const host = hostOf(item.uri);
      return host
        ? { id: `w:${host}`, label: host, rank: 0 }
        : { id: 'w:none', label: t('group.noWebsite'), rank: 1 };
    }
    case 'totp':
      // Presence only — the code itself is a secret and lives behind a detail
      // fetch; group headers must never carry secret-derived values.
      return item.hasTotp
        ? { id: 'o:yes', label: t('group.hasOneTimeCode'), rank: 0 }
        : { id: 'o:no', label: t('group.none'), rank: 1 };
    case 'password':
      // Presence proxy: only login rows carry a password, and the list row
      // can't (and must not) see the value. Same never-by-value rule as totp.
      return item.itemType === 'login'
        ? { id: 'p:yes', label: t('group.hasPassword'), rank: 0 }
        : { id: 'p:no', label: t('group.noPassword'), rank: 1 };
    case 'folder': {
      const name = ctx.folderName(item.folderId);
      // Foldered rows sort alphabetically (rank 0); "No folder" trails (rank 1).
      return name
        ? { id: `f:${item.folderId}`, label: name, rank: 0 }
        : { id: 'f:none', label: t('folder.noFolder'), rank: 1 };
    }
    case 'type':
      return { id: `t:${item.itemType}`, label: TYPE_LABELS[item.itemType], rank: 0 };
    case 'security': {
      // The audit covers logins only and needs a report; everything else trails.
      if (item.itemType !== 'login' || !ctx.hasSecurityReport) {
        return { id: 's:na', label: t('group.notApplicable'), rank: 9 };
      }
      const a = ctx.audit(item.id);
      if (!a) return { id: 's:ok', label: t('group.noIssues'), rank: 3 };
      return auditSeverity(a) === 'risk'
        ? { id: 's:risk', label: t('group.atRisk'), rank: 1 }
        : { id: 's:warn', label: t('group.minorIssues'), rank: 2 };
    }
  }
}
