// Structural equality for saved-view snapshots — drives the "unsaved changes to
// this view" indicator (compare the live captured config against the stored one).
// Pure (no signals); compares field-by-field rather than JSON.stringify so that
// record key-order differences don't read as a spurious change.

import type { ViewConfig } from './sidebarConfig.ts';
import { columnKey, groupSpecKey, type ColumnConfig } from '../state/columnConfig.ts';

function sameStringRecord(a: Record<string, string>, b: Record<string, string>): boolean {
  const ak = Object.keys(a);
  if (ak.length !== Object.keys(b).length) return false;
  return ak.every((k) => a[k] === b[k]);
}

function sameNumberRecord(a: Record<string, number>, b: Record<string, number>): boolean {
  const ak = Object.keys(a);
  if (ak.length !== Object.keys(b).length) return false;
  return ak.every((k) => a[k] === b[k]);
}

function sameColumns(a: ColumnConfig | undefined, b: ColumnConfig | undefined): boolean {
  if (!a || !b) return !a && !b; // both absent = equal; one absent = different
  if (a.favicons !== b.favicons) return false;
  if (groupSpecKey(a.groupBy) !== groupSpecKey(b.groupBy)) return false;
  if (a.displayMode !== b.displayMode) return false;
  if (a.columns.length !== b.columns.length) return false;
  for (let i = 0; i < a.columns.length; i++) {
    const ca = a.columns[i];
    const cb = b.columns[i];
    if (columnKey(ca) !== columnKey(cb)) return false;
    // A custom column's presentation (display label + icon) is part of the view, so
    // renaming/re-iconing it marks the view dirty too.
    const la = ca.kind === 'custom' ? ca.label : undefined;
    const lb = cb.kind === 'custom' ? cb.label : undefined;
    if (la !== lb) return false;
    const ia = ca.kind === 'custom' ? ca.icon : undefined;
    const ib = cb.kind === 'custom' ? cb.icon : undefined;
    if (ia !== ib) return false;
  }
  if (a.revealed.length !== b.revealed.length) return false;
  const ar = new Set(a.revealed);
  if (!b.revealed.every((r) => ar.has(r))) return false;
  return sameNumberRecord(a.widths, b.widths);
}

/** True when two view snapshots are equivalent (so the view isn't "dirty"). */
export function sameViewConfig(a: ViewConfig, b: ViewConfig): boolean {
  if (a.filter.kind !== b.filter.kind) return false;
  if (a.filter.kind === 'type' && b.filter.kind === 'type' && a.filter.itemType !== b.filter.itemType) {
    return false;
  }
  if (a.query !== b.query) return false;
  if (!sameStringRecord(a.columnFilters, b.columnFilters)) return false;
  if ((a.sort?.key ?? null) !== (b.sort?.key ?? null)) return false;
  if ((a.sort?.dir ?? null) !== (b.sort?.dir ?? null)) return false;
  return sameColumns(a.columns, b.columns);
}
