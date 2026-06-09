// buildTree turns Bitwarden's FLAT "/"-encoded folders into the nested rail tree:
// intermediate path segments with no real folder become null-id group headers, and
// node paths are namespaced per account so multi-connection ids stay unique.

import { describe, expect, it } from 'vitest';
import { buildTree } from './folderTree.ts';
import type { Folder } from './types.ts';

const f = (id: string, name: string): Folder => ({
  id,
  name,
  accountEmail: 'me@example.com',
  accountLabel: 'Me',
});

describe('buildTree', () => {
  it('builds flat root nodes, each with its folder id', () => {
    const tree = buildTree([f('1', 'Personal'), f('2', 'Work')], 'me@example.com');
    expect(tree.map((n) => n.name)).toEqual(['Personal', 'Work']);
    expect(tree.map((n) => n.folderId)).toEqual(['1', '2']);
  });

  it('synthesises a group header for an intermediate segment with no real folder', () => {
    const tree = buildTree([f('1', 'Work/Email')], 'me@example.com');
    expect(tree).toHaveLength(1);
    const work = tree[0];
    expect(work).toMatchObject({ name: 'Work', fullName: 'Work', folderId: null });
    expect(work.children[0]).toMatchObject({ name: 'Email', fullName: 'Work/Email', folderId: '1' });
  });

  it('keeps the folder id when the intermediate path is itself a real folder', () => {
    const tree = buildTree([f('1', 'Work'), f('2', 'Work/Email')], 'me@example.com');
    expect(tree[0].folderId).toBe('1');
    expect(tree[0].children[0].folderId).toBe('2');
  });

  it('sorts case-insensitively', () => {
    const tree = buildTree([f('1', 'beta'), f('2', 'Alpha')], 'me@example.com');
    expect(tree.map((n) => n.name)).toEqual(['Alpha', 'beta']);
  });

  it('namespaces the path with keyPrefix while keeping fullName clean', () => {
    const tree = buildTree([f('1', 'Work/Email')], 'me@example.com', 'acct');
    expect(tree[0].path).toBe('acct/Work');
    expect(tree[0].children[0].path).toBe('acct/Work/Email');
    expect(tree[0].children[0].fullName).toBe('Work/Email');
    expect(tree[0].accountEmail).toBe('me@example.com');
  });

  it('collapses repeated/blank slash segments and skips empty folder names', () => {
    const tree = buildTree([f('1', 'Work//Email'), f('2', '   ')], 'me@example.com');
    expect(tree).toHaveLength(1);
    expect(tree[0].children[0].fullName).toBe('Work/Email');
  });
});
