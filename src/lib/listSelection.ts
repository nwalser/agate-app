// Pure helpers for vault-list multi-selection: range math for shift/keyboard
// range selection, cursor movement for arrow-key navigation, and rectangle
// intersection for the marquee ("bungee") box selection. Kept free of SolidJS /
// DOM so the rules are unit-testable; the stateful wiring lives in
// hooks/useVaultSelection.ts and the DOM marquee in components/VaultList.tsx.

/** Inclusive slice of `items` between two indices, in either order. Empty when
 *  either index is out of range (e.g. no anchor yet). */
export function rangeBetween<T>(items: T[], aIdx: number, bIdx: number): T[] {
  if (aIdx < 0 || bIdx < 0 || aIdx >= items.length || bIdx >= items.length) return [];
  const [lo, hi] = aIdx <= bIdx ? [aIdx, bIdx] : [bIdx, aIdx];
  return items.slice(lo, hi + 1);
}

/** Next cursor index after moving by `delta`, clamped to `[0, len-1]`. With no
 *  current cursor (-1), a downward move lands on the first row and an upward move
 *  on the last. Returns -1 for an empty list. */
export function moveIndex(cur: number, delta: number, len: number): number {
  if (len === 0) return -1;
  if (cur < 0) return delta > 0 ? 0 : len - 1;
  return Math.max(0, Math.min(len - 1, cur + delta));
}

/** Axis-aligned rectangle (viewport coords, like a DOMRect). */
export interface Rect {
  left: number;
  top: number;
  right: number;
  bottom: number;
}

/** True when two rectangles overlap (touching edges don't count as overlap). */
export function rectsIntersect(a: Rect, b: Rect): boolean {
  return a.left < b.right && a.right > b.left && a.top < b.bottom && a.bottom > b.top;
}

/** Build a normalized rect from two corner points (marquee start + current). */
export function rectFromPoints(x0: number, y0: number, x1: number, y1: number): Rect {
  return {
    left: Math.min(x0, x1),
    right: Math.max(x0, x1),
    top: Math.min(y0, y1),
    bottom: Math.max(y0, y1),
  };
}
