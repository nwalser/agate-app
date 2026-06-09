import { describe, expect, it } from 'vitest';
import { headerMenuItems, type HeaderTarget } from './headerMenu.ts';

// A neutral, fully-featureless header; each test turns on just what it needs.
function target(over: Partial<HeaderTarget> = {}): HeaderTarget {
  return {
    isName: false,
    index: 1,
    count: 4,
    sortable: false,
    sorted: false,
    sortDir: 'asc',
    secret: false,
    revealed: false,
    filterable: false,
    groupable: false,
    grouped: false,
    hasWidth: false,
    ...over,
  };
}

const ids = (t: HeaderTarget) => headerMenuItems(t).map((i) => i.id);

describe('headerMenuItems', () => {
  it('Name column: sort + filter only, never move/hide/reveal/group', () => {
    expect(ids(target({ isName: true, index: -1, sortable: true, filterable: true }))).toEqual([
      'sort-asc',
      'sort-desc',
      'filter',
    ]);
  });

  it('a sortable, filterable text column gets sort, filter, move, hide', () => {
    expect(ids(target({ sortable: true, filterable: true }))).toEqual([
      'sort-asc',
      'sort-desc',
      'filter',
      'move-left',
      'move-right',
      'hide',
    ]);
  });

  it('a secret column shows reveal (then hide-values once revealed), no sort/filter', () => {
    expect(ids(target({ secret: true }))).toEqual(['reveal', 'move-left', 'move-right', 'hide']);
    expect(ids(target({ secret: true, revealed: true }))).toEqual([
      'hide-values',
      'move-left',
      'move-right',
      'hide',
    ]);
  });

  it('a groupable column toggles group ↔ ungroup', () => {
    expect(ids(target({ groupable: true }))).toContain('group');
    expect(ids(target({ groupable: true }))).not.toContain('ungroup');
    expect(ids(target({ groupable: true, grouped: true }))).toContain('ungroup');
    expect(ids(target({ groupable: true, grouped: true }))).not.toContain('group');
  });

  it('disables the active sort direction', () => {
    const items = headerMenuItems(target({ sortable: true, sorted: true, sortDir: 'asc' }));
    expect(items.find((i) => i.id === 'sort-asc')?.disabled).toBe(true);
    expect(items.find((i) => i.id === 'sort-desc')?.disabled).toBe(false);
  });

  it('disables move at the ends', () => {
    const first = headerMenuItems(target({ index: 0, count: 3 }));
    expect(first.find((i) => i.id === 'move-left')?.disabled).toBe(true);
    expect(first.find((i) => i.id === 'move-right')?.disabled).toBe(false);
    const last = headerMenuItems(target({ index: 2, count: 3 }));
    expect(last.find((i) => i.id === 'move-right')?.disabled).toBe(true);
  });

  it('offers reset-width only when a custom width is set', () => {
    expect(ids(target())).not.toContain('reset-width');
    expect(ids(target({ hasWidth: true }))).toContain('reset-width');
  });

  it('marks hide as danger', () => {
    const hide = headerMenuItems(target()).find((i) => i.id === 'hide');
    expect(hide?.danger).toBe(true);
  });

  it('never starts the first item with a section break', () => {
    const items = headerMenuItems(target({ secret: true })); // first item is reveal
    expect(items[0].section).toBe(false);
  });
});
