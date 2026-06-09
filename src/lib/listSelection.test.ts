import { describe, expect, it } from 'vitest';
import { moveIndex, rangeBetween, rectFromPoints, rectsIntersect } from './listSelection.ts';

describe('rangeBetween', () => {
  const items = ['a', 'b', 'c', 'd', 'e'];
  it('returns an inclusive slice regardless of order', () => {
    expect(rangeBetween(items, 1, 3)).toEqual(['b', 'c', 'd']);
    expect(rangeBetween(items, 3, 1)).toEqual(['b', 'c', 'd']);
  });
  it('handles a single index', () => {
    expect(rangeBetween(items, 2, 2)).toEqual(['c']);
  });
  it('returns empty for out-of-range / missing indices', () => {
    expect(rangeBetween(items, -1, 2)).toEqual([]);
    expect(rangeBetween(items, 0, 99)).toEqual([]);
    expect(rangeBetween([], 0, 0)).toEqual([]);
  });
});

describe('moveIndex', () => {
  it('moves and clamps within bounds', () => {
    expect(moveIndex(0, 1, 5)).toBe(1);
    expect(moveIndex(4, 1, 5)).toBe(4); // clamp at end
    expect(moveIndex(0, -1, 5)).toBe(0); // clamp at start
  });
  it('seeds from an edge when there is no cursor', () => {
    expect(moveIndex(-1, 1, 5)).toBe(0);
    expect(moveIndex(-1, -1, 5)).toBe(4);
  });
  it('returns -1 for an empty list', () => {
    expect(moveIndex(-1, 1, 0)).toBe(-1);
  });
});

describe('rectsIntersect / rectFromPoints', () => {
  it('detects overlap and rejects disjoint rects', () => {
    const a = { left: 0, top: 0, right: 10, bottom: 10 };
    expect(rectsIntersect(a, { left: 5, top: 5, right: 15, bottom: 15 })).toBe(true);
    expect(rectsIntersect(a, { left: 20, top: 0, right: 30, bottom: 10 })).toBe(false);
  });
  it('treats edge-only contact as non-overlapping', () => {
    const a = { left: 0, top: 0, right: 10, bottom: 10 };
    expect(rectsIntersect(a, { left: 10, top: 0, right: 20, bottom: 10 })).toBe(false);
  });
  it('normalizes corner points into a rect', () => {
    expect(rectFromPoints(30, 40, 10, 20)).toEqual({ left: 10, top: 20, right: 30, bottom: 40 });
  });
});
