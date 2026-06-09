// Pure drag-reorder math, shared by every reorderable list (column menu, sidebar
// settings, the live nav rail). The DOM wiring (a drag-handle grip + an insert-line
// drop indicator) lives in hooks/useDragReorder.ts; this module is the testable
// core. The model is gap-based: a drop lands in a "gap" — an insertion slot in
// [0, len] where 0 is before the first row and len is after the last — so the
// indicator and the resulting order can never disagree (the off-by-one that made
// the old "drop onto a row" reorder feel random).

/** Move the element at `from` to index `to`, returning a new array. No-op (a copy
 *  of the input, unchanged) for equal or out-of-range indices; never mutates `arr`. */
export function moveItem<T>(arr: readonly T[], from: number, to: number): T[] {
  const out = arr.slice();
  if (from < 0 || from >= out.length || to < 0 || to >= out.length || from === to) return out;
  const [moved] = out.splice(from, 1);
  out.splice(to, 0, moved);
  return out;
}

/** Convert a drop `gap` (insertion slot in [0, len]) into the destination index to
 *  pass to `moveItem(arr, from, …)`. Removing the dragged row first shifts every
 *  slot after it left by one, so a gap past `from` maps to `gap - 1`. */
export function gapToIndex(from: number, gap: number): number {
  return gap > from ? gap - 1 : gap;
}

/** The insertion gap for a pointer at `pointerY` over rows whose vertical midpoints
 *  are `midpoints` (in display order): the index of the first row whose midpoint is
 *  below the pointer (insert above it), or `len` when the pointer is past them all.
 *  Pointing at a row's top half inserts before it; its bottom half, after it. */
export function gapFromMidpoints(midpoints: readonly number[], pointerY: number): number {
  for (let i = 0; i < midpoints.length; i++) {
    if (pointerY < midpoints[i]) return i;
  }
  return midpoints.length;
}

/** The insertion gap for a pointer over a single row, from that row's rect alone —
 *  `index` if the pointer is in the row's top half, `index + 1` if in its bottom
 *  half. Lets a per-row `dragover` handler compute the gap without measuring every
 *  sibling (equivalent to `gapFromMidpoints` evaluated at this row). */
export function gapFromRow(index: number, rowTop: number, rowHeight: number, pointerY: number): number {
  return pointerY < rowTop + rowHeight / 2 ? index : index + 1;
}
