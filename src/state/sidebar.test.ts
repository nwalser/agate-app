// Sidebar store mutators (the stateful half — the pure resolve/parse/reconcile is
// covered in lib/sidebarConfig.test.ts + lib/sidebarDividers.test.ts). The store is
// a module singleton; resetSidebar() in beforeEach restores the default rail for a
// clean slate (cheaper + more reliable than re-importing the module per case).

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  addDivider,
  addQuery,
  duplicateQuery,
  queryById,
  removeEntry,
  resetSidebar,
  setDividerLabel,
  sidebar,
} from './sidebar.ts';

beforeEach(() => {
  localStorage.clear();
  resetSidebar();
});
afterEach(() => localStorage.clear());

const VIEW_CONFIG = {
  filter: { kind: 'type', itemType: 'login' } as const,
  query: 'aws',
  columnFilters: { name: 'prod' },
};

describe('sidebar store — saved views', () => {
  it('addQuery without a config seeds a default empty config', () => {
    const id = addQuery({ name: 'Blank', icon: 'bookmark' });
    expect(id).toBeTruthy();
    expect(queryById(id!)?.config).toEqual({ filter: { kind: 'all' }, query: '', columnFilters: {} });
    expect(sidebar().order).toContain(id);
  });

  it('addQuery with a config seeds it in one step (Save as new view)', () => {
    const id = addQuery({ name: 'AWS prod', icon: 'cloud', config: VIEW_CONFIG });
    const q = queryById(id!);
    expect(q?.name).toBe('AWS prod');
    expect(q?.config).toEqual(VIEW_CONFIG);
  });

  it('addQuery rejects a blank name', () => {
    expect(addQuery({ name: '   ', icon: 'bookmark' })).toBeNull();
    expect(sidebar().queries).toHaveLength(0);
  });

  it('removeEntry deletes a saved view from order + queries', () => {
    const id = addQuery({ name: 'Temp', icon: 'bookmark' })!;
    removeEntry(id);
    expect(sidebar().order).not.toContain(id);
    expect(queryById(id)).toBeNull();
  });

  it('duplicateQuery clones config + icon under a new id, right after the original', () => {
    const id = addQuery({ name: 'AWS prod', icon: 'cloud', config: VIEW_CONFIG })!;
    const copyId = duplicateQuery(id);
    expect(copyId).toBeTruthy();
    expect(copyId).not.toBe(id);
    const copy = queryById(copyId!);
    expect(copy?.name).toBe('AWS prod copy');
    expect(copy?.icon).toBe('cloud');
    expect(copy?.config).toEqual(VIEW_CONFIG); // deep-equal, fresh object
    expect(copy?.config).not.toBe(queryById(id)?.config); // not the same reference
    const order = sidebar().order;
    expect(order.indexOf(copyId!)).toBe(order.indexOf(id) + 1);
  });

  it('duplicateQuery returns null for a non-query id', () => {
    expect(duplicateQuery('all')).toBeNull();
    expect(duplicateQuery('query:nope')).toBeNull();
  });
});

describe('sidebar store — dividers', () => {
  it('addDivider with a label persists the section header', () => {
    const id = addDivider(undefined, 'Work');
    expect(sidebar().dividerLabels[id]).toBe('Work');
  });

  it('setDividerLabel sets then clears the label', () => {
    const id = addDivider();
    setDividerLabel(id, 'Personal');
    expect(sidebar().dividerLabels[id]).toBe('Personal');
    setDividerLabel(id, '   ');
    expect(id in sidebar().dividerLabels).toBe(false);
  });

  it('setDividerLabel ignores non-divider ids', () => {
    setDividerLabel('all', 'Nope');
    expect(sidebar().dividerLabels).toEqual({});
  });
});
