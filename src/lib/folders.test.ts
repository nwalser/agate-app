import { describe, expect, it } from 'vitest';
import {
  affectedItemIds,
  deletePlan,
  descendantsOf,
  isPlanError,
  isSelfOrDescendant,
  leafName,
  parentPath,
  planCreate,
  planRename,
  planReparent,
  type RealFolder,
  segments,
  subtreeOf,
} from './folders.ts';
import type { VaultItem } from './types.ts';

const ACCT = 'a@example.com';

function folder(id: string, name: string, account = ACCT): RealFolder {
  return { id, name, accountEmail: account, accountLabel: 'Bitwarden US' };
}

function item(id: string, folderId: string | null, account = ACCT): VaultItem {
  return {
    id,
    accountEmail: account,
    accountLabel: 'Bitwarden US',
    name: id,
    itemType: 'login',
    username: null,
    uri: null,
    hasTotp: false,
    favorite: false,
    deleted: false,
    folderId,
    organizationId: null,
  };
}

// A small tree:  Work, Work/Email, Work/Projects, Personal, Workshop
const work = folder('w', 'Work');
const workEmail = folder('we', 'Work/Email');
const workProjects = folder('wp', 'Work/Projects');
const personal = folder('p', 'Personal');
const workshop = folder('ws', 'Workshop');
const tree = [work, workEmail, workProjects, personal, workshop];

describe('path parsing', () => {
  it('splits and trims segments', () => {
    expect(segments(' Work / Email ')).toEqual(['Work', 'Email']);
    expect(segments('//Work//')).toEqual(['Work']);
  });
  it('derives leaf + parent', () => {
    expect(leafName('Work/Email')).toBe('Email');
    expect(parentPath('Work/Email')).toBe('Work');
    expect(parentPath('Work')).toBe('');
  });
});

describe('subtree gathering', () => {
  it('finds descendants by segment prefix (not string prefix)', () => {
    const ds = descendantsOf(tree, work).map((f) => f.name).sort();
    expect(ds).toEqual(['Work/Email', 'Work/Projects']);
    // "Workshop" must NOT count as a descendant of "Work".
    expect(ds).not.toContain('Workshop');
  });
  it('subtree includes the folder itself', () => {
    expect(subtreeOf(tree, work).map((f) => f.id).sort()).toEqual(['w', 'we', 'wp']);
  });
});

describe('isSelfOrDescendant (cycle guard)', () => {
  it('flags self and descendants, clears unrelated + top level', () => {
    expect(isSelfOrDescendant(work, work)).toBe(true);
    expect(isSelfOrDescendant(workEmail, work)).toBe(true);
    expect(isSelfOrDescendant(personal, work)).toBe(false);
    expect(isSelfOrDescendant(null, work)).toBe(false);
  });
});

describe('planCreate', () => {
  it('rejects blank + slashed names', () => {
    expect(isPlanError(planCreate(tree, ACCT, null, '  '))).toBe(true);
    expect(isPlanError(planCreate(tree, ACCT, null, 'a/b'))).toBe(true);
  });
  it('builds a nested path under a parent', () => {
    const p = planCreate(tree, ACCT, work, 'Receipts');
    expect(p).toEqual({ name: 'Work/Receipts' });
  });
  it('rejects a duplicate path', () => {
    expect(isPlanError(planCreate(tree, ACCT, work, 'Email'))).toBe(true);
  });
});

describe('planRename', () => {
  it('cascades a leaf rename to descendants', () => {
    const p = planRename(tree, work, 'Job');
    if (isPlanError(p)) throw new Error(p.error);
    expect(p.renames.sort((a, b) => a.id.localeCompare(b.id))).toEqual([
      { id: 'w', newName: 'Job' },
      { id: 'we', newName: 'Job/Email' },
      { id: 'wp', newName: 'Job/Projects' },
    ]);
  });
  it('forbids "/" in the leaf and blank names', () => {
    expect(isPlanError(planRename(tree, work, 'a/b'))).toBe(true);
    expect(isPlanError(planRename(tree, work, ''))).toBe(true);
  });
  it('rejects a name that collides with a sibling', () => {
    expect(isPlanError(planRename(tree, work, 'Personal'))).toBe(true);
  });
  it('an unchanged leaf is a no-op (empty renames)', () => {
    const p = planRename(tree, work, 'Work');
    expect(p).toEqual({ renames: [] });
  });
});

describe('planReparent', () => {
  it('moves a subtree under a new parent', () => {
    const p = planReparent(tree, work, personal);
    if (isPlanError(p)) throw new Error(p.error);
    expect(p.renames.sort((a, b) => a.id.localeCompare(b.id))).toEqual([
      { id: 'w', newName: 'Personal/Work' },
      { id: 'we', newName: 'Personal/Work/Email' },
      { id: 'wp', newName: 'Personal/Work/Projects' },
    ]);
  });
  it('moves a nested folder back to the top level', () => {
    const p = planReparent(tree, workEmail, null);
    if (isPlanError(p)) throw new Error(p.error);
    expect(p.renames).toEqual([{ id: 'we', newName: 'Email' }]);
  });
  it('rejects moving a folder into its own descendant (cycle)', () => {
    expect(isPlanError(planReparent(tree, work, workEmail))).toBe(true);
  });
  it('rejects a cross-account move', () => {
    const other = folder('o', 'Other', 'b@example.com');
    expect(isPlanError(planReparent([...tree, other], work, other))).toBe(true);
  });
  it('rejects a move that would collide at the destination', () => {
    // Personal/Work already exists → moving another "Work" under Personal collides.
    const tree2 = [...tree, folder('pw', 'Personal/Work')];
    expect(isPlanError(planReparent(tree2, work, personal))).toBe(true);
  });
});

describe('delete planning', () => {
  const items = [item('i1', 'w'), item('i2', 'we'), item('i3', 'p'), item('i4', null)];
  it('gathers subtree folders + the items inside them', () => {
    const plan = deletePlan(tree, items, work);
    expect(plan.folderIds.sort()).toEqual(['w', 'we', 'wp']);
    expect(plan.subfolderCount).toBe(2);
    expect(plan.itemIds.sort()).toEqual(['i1', 'i2']);
  });
  it('affectedItemIds skips deleted items + other folders', () => {
    expect(affectedItemIds(items, new Set(['p']))).toEqual(['i3']);
  });
});
