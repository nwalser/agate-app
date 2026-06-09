import { describe, expect, it } from 'vitest';
import { DEFAULT_VIEW_ICON, VIEW_ICONS, isViewIcon, viewIcon } from './viewIcons.ts';

describe('viewIcons', () => {
  it('isViewIcon recognises known ids only', () => {
    expect(isViewIcon('bookmark')).toBe(true);
    expect(isViewIcon('shield')).toBe(true);
    expect(isViewIcon('nope')).toBe(false);
    expect(isViewIcon(42)).toBe(false);
    expect(isViewIcon(undefined)).toBe(false);
  });

  it('viewIcon resolves a known id and falls back to the default for unknown/undefined', () => {
    const fallback = viewIcon(DEFAULT_VIEW_ICON);
    expect(viewIcon('shield')).not.toBe(fallback);
    expect(viewIcon('nonexistent')).toBe(fallback);
    expect(viewIcon(undefined)).toBe(fallback);
  });

  it('the default icon id is itself a known icon', () => {
    expect(isViewIcon(DEFAULT_VIEW_ICON)).toBe(true);
  });

  it('VIEW_ICONS is a non-empty picker list whose ids are all valid', () => {
    expect(VIEW_ICONS.length).toBeGreaterThan(0);
    for (const opt of VIEW_ICONS) expect(isViewIcon(opt.id)).toBe(true);
    expect(VIEW_ICONS.some((o) => o.id === DEFAULT_VIEW_ICON)).toBe(true);
  });
});
