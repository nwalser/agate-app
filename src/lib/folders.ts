// Folder path-math + validation for the left-rail folder tree.
//
// Bitwarden folders are FLAT entities; nesting is encoded in the name with "/"
// (e.g. "Work" and "Work/Email" are two separate folders). Folder ids are stable,
// so re-parenting / renaming a folder is a *batch rename* of the folder entity
// plus every descendant (their name prefix changes) — items keep their folderId.
// Deleting a "whole folder" deletes the entity + every descendant entity; the
// items inside are reassigned to "No folder" (never deleted).
//
// Everything here is pure (no IPC) so the rules are unit-testable in isolation.
// Comparison is done on trimmed, "/"-split segments (matching FolderTree's view),
// so "Work" never matches "Workshop" and stray whitespace can't fool a prefix.

import type { Folder, VaultItem } from './types.ts';
import { t } from './i18n.ts';

/** A folder that actually exists on the server (has an id), not a tree group. */
export type RealFolder = Folder & { id: string };

/** Split a folder name into trimmed, non-empty path segments. */
export function segments(name: string): string[] {
  return name.split('/').map((s) => s.trim()).filter(Boolean);
}

/** Canonical "/"-joined form of a folder name (trimmed segments). */
export function normalize(name: string): string {
  return segments(name).join('/');
}

/** Last path segment — the folder's own display name. */
export function leafName(name: string): string {
  const segs = segments(name);
  return segs[segs.length - 1] ?? '';
}

/** Path of the parent ("" when the folder is top-level). */
export function parentPath(name: string): string {
  return segments(name).slice(0, -1).join('/');
}

/** True when `child` segments begin with all of `prefix` segments and are longer. */
function startsWith(child: string[], prefix: string[]): boolean {
  if (child.length <= prefix.length) return false;
  return prefix.every((seg, i) => child[i] === seg);
}

/** Only the folders that exist on the server (skip null-id tree groups). */
export function realFolders(folders: Folder[]): RealFolder[] {
  return folders.filter((f): f is RealFolder => f.id !== null);
}

/** Same-account folders strictly nested under `folder`. */
export function descendantsOf(folders: Folder[], folder: Folder): RealFolder[] {
  const base = segments(folder.name);
  return realFolders(folders).filter(
    (f) => f.accountEmail === folder.accountEmail && startsWith(segments(f.name), base),
  );
}

/** `folder` plus all its descendants — the subtree a move/delete operates on. */
export function subtreeOf(folders: Folder[], folder: RealFolder): RealFolder[] {
  return [folder, ...descendantsOf(folders, folder)];
}

/**
 * True when `target` is `folder` itself or sits inside `folder`'s subtree — the
 * guard that stops a folder being moved into its own descendant (a cycle). A null
 * target is the top level and never a cycle.
 */
export function isSelfOrDescendant(target: Folder | null, folder: Folder): boolean {
  if (!target) return false;
  if (target.id !== null && target.id === folder.id) return true;
  const base = segments(folder.name);
  const t = segments(target.name);
  return t.length >= base.length && base.every((seg, i) => t[i] === seg);
}

/** Replace the leading `oldBase` segments of `name` with `newBase`, re-joined. */
function rewrite(oldBase: string[], newBase: string[], nameSegs: string[]): string {
  return [...newBase, ...nameSegs.slice(oldBase.length)].join('/');
}

export type FolderPlanError = { error: string };
export type RenamePlan = { renames: { id: string; newName: string }[] };
export type CreatePlan = { name: string };

export function isPlanError(p: RenamePlan | CreatePlan | FolderPlanError): p is FolderPlanError {
  return 'error' in p;
}

/** A same-account real folder (outside `excludeIds`) already occupies `path`. */
function pathTaken(
  folders: Folder[],
  account: string,
  path: string,
  excludeIds: ReadonlySet<string>,
): boolean {
  return realFolders(folders).some(
    (f) => f.accountEmail === account && !excludeIds.has(f.id) && normalize(f.name) === path,
  );
}

/**
 * Re-home `folder`'s subtree onto a new base path, returning the batch of folder
 * renames (folder + descendants) or a validation error. Shared by rename (leaf
 * changes, parent stays) and move (parent changes, leaf stays). No-op renames are
 * dropped, so an unchanged base yields an empty `renames` list.
 */
function rebase(folders: Folder[], folder: RealFolder, newBase: string[]): RenamePlan | FolderPlanError {
  const oldBase = segments(folder.name);
  const subtree = subtreeOf(folders, folder);
  const subtreeIds = new Set(subtree.map((f) => f.id));
  const renames: { id: string; newName: string }[] = [];
  for (const f of subtree) {
    const newName = rewrite(oldBase, newBase, segments(f.name));
    if (pathTaken(folders, folder.accountEmail, newName, subtreeIds)) {
      return { error: t('folder.errorExistsThere') };
    }
    if (newName !== f.name) renames.push({ id: f.id, newName });
  }
  return { renames };
}

/** Plan a create under `parent` (null = top level). Returns the full "/"-path. */
export function planCreate(
  folders: Folder[],
  account: string,
  parent: Folder | null,
  rawName: string,
): CreatePlan | FolderPlanError {
  const name = rawName.trim();
  if (!name) return { error: t('folder.errorNameRequired') };
  if (name.includes('/')) return { error: t('folder.errorNoSlash') };
  const path = [...(parent ? segments(parent.name) : []), name].join('/');
  if (pathTaken(folders, account, path, new Set())) {
    return { error: t('folder.errorExistsHere') };
  }
  return { name: path };
}

/** Plan a leaf rename (parent unchanged); cascades to descendants. */
export function planRename(
  folders: Folder[],
  folder: RealFolder,
  rawLeaf: string,
): RenamePlan | FolderPlanError {
  const leaf = rawLeaf.trim();
  if (!leaf) return { error: t('folder.errorNameRequired') };
  if (leaf.includes('/')) return { error: t('folder.errorNoSlash') };
  const newBase = [...segments(parentPath(folder.name)), leaf];
  return rebase(folders, folder, newBase);
}

/** Plan a move of `folder`'s subtree under `target` (null = top level). */
export function planReparent(
  folders: Folder[],
  folder: RealFolder,
  target: Folder | null,
): RenamePlan | FolderPlanError {
  if (target && target.accountEmail !== folder.accountEmail) {
    return { error: t('folder.errorSameAccount') };
  }
  if (isSelfOrDescendant(target, folder)) {
    return { error: t('folder.errorIntoSelf') };
  }
  const newBase = [...(target ? segments(target.name) : []), leafName(folder.name)];
  return rebase(folders, folder, newBase);
}

/** Ids of (non-deleted) items that live in any folder of `folderIds`. */
export function affectedItemIds(items: VaultItem[], folderIds: ReadonlySet<string>): string[] {
  return items
    .filter((it) => !it.deleted && it.folderId !== null && folderIds.has(it.folderId))
    .map((it) => it.id);
}

export interface DeletePlan {
  /** Folder ids to delete: the folder plus every descendant. */
  folderIds: string[];
  /** Count of descendant subfolders (subtree size minus the folder itself). */
  subfolderCount: number;
  /** Items that will be moved to "No folder" before the folders are deleted. */
  itemIds: string[];
}

/** Everything a subtree delete touches, for the confirmation dialog + execution. */
export function deletePlan(folders: Folder[], items: VaultItem[], folder: RealFolder): DeletePlan {
  const subtree = subtreeOf(folders, folder);
  const folderIds = subtree.map((f) => f.id);
  return {
    folderIds,
    subfolderCount: subtree.length - 1,
    itemIds: affectedItemIds(items, new Set(folderIds)),
  };
}
