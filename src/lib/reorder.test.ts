import { describe, expect, it } from 'vitest';
import { gapFromMidpoints, gapFromRow, gapToIndex, moveItem } from './reorder.ts';

describe('reorder — moveItem', () => {
  it('moves an element to an earlier index', () => {
    expect(moveItem(['a', 'b', 'c', 'd'], 2, 0)).toEqual(['c', 'a', 'b', 'd']);
  });

  it('moves an element to a later index', () => {
    expect(moveItem(['a', 'b', 'c', 'd'], 0, 2)).toEqual(['b', 'c', 'a', 'd']);
  });

  it('is a no-op when from === to', () => {
    expect(moveItem(['a', 'b', 'c'], 1, 1)).toEqual(['a', 'b', 'c']);
  });

  it('is a no-op for out-of-range indices and never mutates the input', () => {
    const src = ['a', 'b', 'c'];
    expect(moveItem(src, -1, 1)).toEqual(['a', 'b', 'c']);
    expect(moveItem(src, 0, 9)).toEqual(['a', 'b', 'c']);
    expect(src).toEqual(['a', 'b', 'c']); // input untouched
  });
});

describe('reorder — gapToIndex', () => {
  // A "gap" is an insertion slot in [0, len]: 0 = before the first row, len =
  // after the last. The dragged row is removed first, so a gap past it shifts
  // the destination index left by one. The pair (gapFromMidpoints → gapToIndex →
  // moveItem) must round-trip to the slot the user actually pointed at.
  it('a gap at or before the dragged row maps to that gap unchanged', () => {
    expect(gapToIndex(3, 0)).toBe(0);
    expect(gapToIndex(3, 3)).toBe(3); // the dragged row's own leading edge → no move
  });

  it('a gap after the dragged row shifts left by one (removal compensation)', () => {
    expect(gapToIndex(0, 2)).toBe(1); // drag row 0 into the gap after row 1
    expect(gapToIndex(1, 4)).toBe(3); // drag row 1 to the end (len 4)
  });

  it('round-trips through moveItem to land at the pointed slot', () => {
    const arr = ['a', 'b', 'c', 'd'];
    // Drag 'a' (0) into the gap after 'c' (gap=3) → expect a between c and d.
    expect(moveItem(arr, 0, gapToIndex(0, 3))).toEqual(['b', 'c', 'a', 'd']);
    // Drag 'd' (3) into the gap before 'b' (gap=1) → expect d between a and b.
    expect(moveItem(arr, 3, gapToIndex(3, 1))).toEqual(['a', 'd', 'b', 'c']);
    // Drag 'a' to the very end (gap=4).
    expect(moveItem(arr, 0, gapToIndex(0, 4))).toEqual(['b', 'c', 'd', 'a']);
  });
});

describe('reorder — gapFromMidpoints', () => {
  // midpoints are the vertical centers of each row, in order.
  const mids = [10, 30, 50, 70];

  it('returns 0 when the pointer is above the first midpoint', () => {
    expect(gapFromMidpoints(mids, 5)).toBe(0);
  });

  it('returns len when the pointer is below the last midpoint', () => {
    expect(gapFromMidpoints(mids, 100)).toBe(4);
  });

  it('inserts before a row when the pointer is in its top half', () => {
    // pointer at 25 is below mid[0]=10 and above mid[1]=30 → gap 1 (after row 0).
    expect(gapFromMidpoints(mids, 25)).toBe(1);
  });

  it('inserts after a row when the pointer is past its midpoint', () => {
    expect(gapFromMidpoints(mids, 55)).toBe(3); // past mid[2]=50, before mid[3]=70
  });

  it('handles an empty list', () => {
    expect(gapFromMidpoints([], 42)).toBe(0);
  });
});

describe('reorder — gapFromRow', () => {
  // row at top=20, height=40 → midpoint 40.
  it('returns the row index in its top half', () => {
    expect(gapFromRow(2, 20, 40, 30)).toBe(2);
  });

  it('returns index+1 in its bottom half', () => {
    expect(gapFromRow(2, 20, 40, 50)).toBe(3);
  });

  it('treats the exact midpoint as the bottom half (insert after)', () => {
    expect(gapFromRow(2, 20, 40, 40)).toBe(3);
  });
});
