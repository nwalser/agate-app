// A tiny browser-style history stack: a linear list of locations plus a cursor.
// `record` pushes a new location (dropping any forward branch — a new move from
// the middle of history) and dedups a location identical to the current one, so
// restoring via back/forward (which re-emits the restored location) never
// re-pushes it. Bounded so a long session can't grow it without limit. Pure and
// framework-free so it's unit-tested directly; the Solid wiring lives in
// hooks/useNavigationHistory.ts.

import type { VaultView } from './vaultConfig.ts';
import { filterEq } from './vaultConfig.ts';
import type { VaultFilter } from './search.ts';

/** A spot in the vault the user can navigate back/forward to. */
export interface NavLocation {
  view: VaultView;
  filter: VaultFilter;
  activeVault: string | null;
  selectedId: string | null;
}

export function navLocationEq(a: NavLocation, b: NavLocation): boolean {
  return (
    a.view === b.view &&
    a.activeVault === b.activeVault &&
    a.selectedId === b.selectedId &&
    filterEq(a.filter, b.filter)
  );
}

/** Hard cap on retained history so a long session stays bounded. */
export const NAV_HISTORY_MAX = 100;

export function createNavStack<T>(eq: (a: T, b: T) => boolean, max = NAV_HISTORY_MAX) {
  const entries: T[] = [];
  let cursor = -1;

  return {
    /** Land on a location. No-op if it equals the current one (e.g. a restore). */
    record(loc: T): void {
      if (cursor >= 0 && eq(entries[cursor], loc)) return;
      // A new move from the middle of history drops the forward branch.
      entries.length = cursor + 1;
      entries.push(loc);
      cursor = entries.length - 1;
      // Bound the stack: drop the oldest, keeping the cursor on the same entry.
      while (entries.length > max) {
        entries.shift();
        cursor -= 1;
      }
    },
    /** Step back one entry, or null if already at the oldest. */
    back(): T | null {
      if (cursor <= 0) return null;
      cursor -= 1;
      return entries[cursor];
    },
    /** Step forward one entry, or null if already at the newest. */
    forward(): T | null {
      if (cursor < 0 || cursor >= entries.length - 1) return null;
      cursor += 1;
      return entries[cursor];
    },
    canBack: (): boolean => cursor > 0,
    canForward: (): boolean => cursor >= 0 && cursor < entries.length - 1,
    /** Test/inspection helper: current length + cursor index. */
    state: (): { length: number; cursor: number } => ({ length: entries.length, cursor }),
  };
}
