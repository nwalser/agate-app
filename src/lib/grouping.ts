// Pure row-grouping logic for the vault list: given an item and a group key,
// decide which group header it belongs under. Kept side-effect-free (no signals,
// no DOM) so the list ordering (useVaultFiltering) and the header rendering
// (VaultList) agree on the same group identity/label/order from one definition.

import type { GroupKey } from '../state/columnConfig.ts';
import { TYPE_LABELS } from '../state/columnConfig.ts';
import type { ItemAudit, VaultItem } from './types.ts';
import { auditSeverity } from './audit.ts';

/** Lookups grouping needs from the surrounding list (no detail fetch). */
export interface GroupContext {
  /** Folder display name for a folder id (empty for none/unknown). */
  folderName: (id: string | null) => string;
  /** Audit record for an at-risk login, if the report flags it. */
  audit: (id: string) => ItemAudit | undefined;
  /** Whether an offline health report is loaded (security grouping needs it). */
  hasSecurityReport: boolean;
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

/** The group an item falls into for a given grouping. Pure. */
export function groupOf(item: VaultItem, key: GroupKey, ctx: GroupContext): GroupValue {
  switch (key) {
    case 'folder': {
      const name = ctx.folderName(item.folderId);
      // Foldered rows sort alphabetically (rank 0); "No folder" trails (rank 1).
      return name
        ? { id: `f:${item.folderId}`, label: name, rank: 0 }
        : { id: 'f:none', label: 'No folder', rank: 1 };
    }
    case 'type':
      return { id: `t:${item.itemType}`, label: TYPE_LABELS[item.itemType], rank: 0 };
    case 'security': {
      // The audit covers logins only and needs a report; everything else trails.
      if (item.itemType !== 'login' || !ctx.hasSecurityReport) {
        return { id: 's:na', label: 'Not applicable', rank: 9 };
      }
      const a = ctx.audit(item.id);
      if (!a) return { id: 's:ok', label: 'No issues', rank: 3 };
      return auditSeverity(a) === 'risk'
        ? { id: 's:risk', label: 'At risk', rank: 1 }
        : { id: 's:warn', label: 'Minor issues', rank: 2 };
    }
  }
}
