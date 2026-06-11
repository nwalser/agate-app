import { describe, expect, it } from 'vitest';
import { COLUMN_ICONS, columnIcon, isColumnIconId } from './columnIcons.ts';

describe('columnIcons', () => {
  it('every entry has a unique id and a resolvable component', () => {
    const ids = COLUMN_ICONS.map((d) => d.id);
    expect(new Set(ids).size).toBe(ids.length); // no dupes
    for (const d of COLUMN_ICONS) {
      expect(typeof d.icon).toBe('function');
      expect(columnIcon(d.id)).toBe(d.icon);
    }
  });

  it('columnIcon returns null for unknown / empty / nullish ids', () => {
    expect(columnIcon('definitely-not-an-icon')).toBeNull();
    expect(columnIcon('')).toBeNull();
    expect(columnIcon(null)).toBeNull();
    expect(columnIcon(undefined)).toBeNull();
  });

  it('isColumnIconId guards the closed set', () => {
    expect(isColumnIconId('key')).toBe(true);
    expect(isColumnIconId('zzz')).toBe(false);
    expect(isColumnIconId(42)).toBe(false);
    expect(isColumnIconId(null)).toBe(false);
  });
});
