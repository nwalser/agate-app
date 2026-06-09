// Stateful behavior for the left-rail folder tree, extracted from FolderTree.tsx
// so the component is a thin orchestrator. Owns every signal (expand/collapse,
// inline create/rename editing, the context menu + its move submenu, the
// subtree-delete confirmation, and drag-and-drop re-parent state) and the
// management actions that route validated plans (from ../lib/folders.ts) back to
// the caller's onCreate / onRename / onMove / onDelete callbacks.
//
// It reads the live props object so each closure stays reactive exactly as the
// original component did, and returns the shared `ctx` (handed to every
// FolderNode) plus the orchestration state/handlers the component still renders.

import { createSignal } from 'solid-js';
import type { Folder, VaultItem } from '../lib/types.ts';
import type { VaultFilter } from '../lib/search.ts';
import {
  deletePlan,
  type DeletePlan,
  isPlanError,
  isSelfOrDescendant,
  planCreate,
  planRename,
  planReparent,
  type RealFolder,
  realFolders,
  segments,
} from '../lib/folders.ts';
import { type Editing, type Node, type TreeCtx } from '../lib/folderTree.ts';
import { pushToast } from '../state/toast.ts';

export interface FolderTreeProps {
  folders: Folder[];
  items: VaultItem[];
  active: VaultFilter;
  onSelect: (f: VaultFilter) => void;
  onCreate: (account: string, fullName: string) => void;
  onRename: (account: string, renames: { id: string; newName: string }[]) => void;
  onMove: (account: string, renames: { id: string; newName: string }[]) => void;
  onDelete: (account: string, folderIds: string[], itemIds: string[]) => void;
  /** Account a top-level "New folder" targets when no folders exist yet. */
  defaultAccount: string;
}

export function useFolderTree(props: FolderTreeProps) {
  const real = () => realFolders(props.folders);
  // Distinct owning connections (by email — the server label can repeat).
  const accounts = () => {
    const seen = new Map<string, string>();
    for (const f of real()) if (!seen.has(f.accountEmail)) seen.set(f.accountEmail, f.accountLabel);
    return [...seen.entries()]
      .map(([email, label]) => ({ email, label }))
      .sort((a, b) => a.email.localeCompare(b.email));
  };
  const multi = () => accounts().length > 1;
  const soleAccount = () => real()[0]?.accountEmail ?? '';
  // Account a single-mode "New folder" targets: the sole account that owns folders,
  // or the caller's default when the vault has no folders yet.
  const createAccountFor = () => soleAccount() || props.defaultAccount;

  const folderById = (id: string): RealFolder | undefined => real().find((f) => f.id === id);

  const [expanded, setExpanded] = createSignal<Set<string>>(new Set());
  const isExpanded = (path: string) => expanded().has(path);
  function toggle(path: string) {
    const next = new Set(expanded());
    if (next.has(path)) next.delete(path);
    else next.add(path);
    setExpanded(next);
  }
  function expand(path: string) {
    if (expanded().has(path)) return;
    const next = new Set(expanded());
    next.add(path);
    setExpanded(next);
  }
  const isActive = (folderId: string | null) =>
    props.active.kind === 'folder' && props.active.folderId === folderId;

  // ---- inline name editing (create / rename) ----
  const [editing, setEditing] = createSignal<Editing | null>(null);
  const [editValue, setEditValue] = createSignal('');
  const cancelEdit = () => {
    setEditing(null);
    setEditValue('');
  };
  function beginCreateTop(account: string) {
    setEditValue('');
    setEditing({ kind: 'create-top', account });
  }
  function beginCreateChild(node: Node) {
    expand(node.path);
    setEditValue('');
    setEditing({ kind: 'create-child', node });
  }
  function beginRename(node: Node) {
    setEditValue(node.name);
    setEditing({ kind: 'rename', node });
  }
  function submitEdit() {
    const e = editing();
    if (!e) return;
    const value = editValue();
    cancelEdit();
    if (e.kind === 'create-top') {
      runCreate(e.account, null, value);
    } else if (e.kind === 'create-child') {
      // The parent may be a real folder or a group header; planCreate only needs
      // its name + account, both of which the node carries.
      const parent: Folder = {
        id: e.node.folderId,
        name: e.node.fullName,
        accountEmail: e.node.accountEmail,
        accountLabel: '',
      };
      runCreate(e.node.accountEmail, parent, value);
    } else {
      const folder = e.node.folderId ? folderById(e.node.folderId) : undefined;
      if (!folder) return;
      const plan = planRename(props.folders, folder, value);
      if (isPlanError(plan)) {
        pushToast('error', plan.error);
        return;
      }
      if (plan.renames.length) props.onRename(folder.accountEmail, plan.renames);
    }
  }
  function runCreate(account: string, parent: Folder | null, name: string) {
    if (!name.trim()) return;
    const plan = planCreate(props.folders, account, parent, name);
    if (isPlanError(plan)) {
      pushToast('error', plan.error);
      return;
    }
    props.onCreate(account, plan.name);
  }

  // ---- context menu ----
  const [menu, setMenu] = createSignal<{ node: Node; x: number; y: number } | null>(null);
  const [menuMode, setMenuMode] = createSignal<'main' | 'move'>('main');
  function openMenu(node: Node, x: number, y: number) {
    const MENU_W = 210;
    const MENU_H = 260;
    setMenu({
      node,
      x: Math.max(8, Math.min(x, window.innerWidth - MENU_W)),
      y: Math.max(8, Math.min(y, window.innerHeight - MENU_H)),
    });
    setMenuMode('main');
  }
  const closeMenu = () => setMenu(null);

  // Candidate parents for "Move to…": same-account real folders that aren't the
  // folder itself or inside its own subtree (a cycle).
  function moveTargets(folder: RealFolder): RealFolder[] {
    return real()
      .filter((f) => f.accountEmail === folder.accountEmail && !isSelfOrDescendant(f, folder))
      .sort((a, b) => a.name.localeCompare(b.name, undefined, { sensitivity: 'base' }));
  }

  function doMove(folder: RealFolder, target: Folder | null) {
    closeMenu();
    const plan = planReparent(props.folders, folder, target);
    if (isPlanError(plan)) {
      pushToast('error', plan.error);
      return;
    }
    if (plan.renames.length) props.onMove(folder.accountEmail, plan.renames);
  }

  // ---- delete confirmation ----
  const [confirm, setConfirm] = createSignal<{ folder: RealFolder; plan: DeletePlan } | null>(null);
  function askDelete(node: Node) {
    closeMenu();
    if (!node.folderId) return;
    const folder = folderById(node.folderId);
    if (!folder) return;
    setConfirm({ folder, plan: deletePlan(props.folders, props.items, folder) });
  }
  function confirmDelete() {
    const c = confirm();
    setConfirm(null);
    if (!c) return;
    props.onDelete(c.folder.accountEmail, c.plan.folderIds, c.plan.itemIds);
  }

  // ---- drag-and-drop (re-parent) ----
  const [dragId, setDragId] = createSignal<string | null>(null);
  const [dropKey, setDropKey] = createSignal<string | null>(null);
  const startDrag = (node: Node) => node.folderId && setDragId(node.folderId);
  const endDrag = () => {
    setDragId(null);
    setDropKey(null);
  };
  // A drag is valid onto a real folder in the same account that isn't the dragged
  // folder or one of its descendants. `null` target = the top-level drop zone.
  function canDrop(target: Folder | null): boolean {
    const id = dragId();
    if (!id) return false;
    const dragged = folderById(id);
    if (!dragged) return false;
    if (!target) return segments(dragged.name).length > 1; // already top-level → no-op
    return target.accountEmail === dragged.accountEmail && !isSelfOrDescendant(target, dragged);
  }
  function tryDragOver(node: Node, e: DragEvent) {
    if (!node.folderId) return;
    const target = folderById(node.folderId);
    if (target && canDrop(target)) {
      e.preventDefault();
      if (dropKey() !== node.path) setDropKey(node.path);
    }
  }
  function clearDropTarget(key: string) {
    if (dropKey() === key) setDropKey(null);
  }
  function drop(node: Node) {
    const id = dragId();
    const target = node.folderId ? folderById(node.folderId) : undefined;
    endDrag();
    if (!id || !target) return;
    const dragged = folderById(id);
    if (dragged) doMove(dragged, target);
  }
  function dropTop(account: string) {
    const id = dragId();
    endDrag();
    if (!id) return;
    const dragged = folderById(id);
    if (dragged && dragged.accountEmail === account) doMove(dragged, null);
  }

  const ctx: TreeCtx = {
    isExpanded,
    toggle,
    expand,
    isActive,
    onSelect: props.onSelect,
    editing,
    editValue,
    setEditValue,
    beginRename,
    beginCreateChild,
    submitEdit,
    cancelEdit,
    openMenu,
    dragId,
    dropKey,
    startDrag,
    endDrag,
    tryDragOver,
    clearDropTarget,
    drop,
  };

  // The top-level drop zone + a "New folder" affordance live on the "Folders"
  // header (single account) or each per-account header (multi). Returns the drag
  // handlers only — the highlight `classList` is inlined on the element so it
  // stays reactive (a spread object would be evaluated once).
  const topDropKey = (account: string) => `top:${account}`;
  function topZoneHandlers(account: string) {
    return {
      onDragOver: (e: DragEvent) => {
        if (canDrop(null) && folderById(dragId() ?? '')?.accountEmail === account) {
          e.preventDefault();
          setDropKey(topDropKey(account));
        }
      },
      onDragLeave: () => clearDropTarget(topDropKey(account)),
      onDrop: () => dropTop(account),
    };
  }

  return {
    // derived account/folder state
    real,
    accounts,
    multi,
    createAccountFor,
    folderById,
    // selection
    isActive,
    // inline editing
    editing,
    beginCreateTop,
    beginCreateChild,
    beginRename,
    // context menu
    menu,
    menuMode,
    setMenuMode,
    closeMenu,
    moveTargets,
    doMove,
    askDelete,
    // delete confirmation
    confirm,
    setConfirm,
    confirmDelete,
    // drag-and-drop
    dropKey,
    topDropKey,
    topZoneHandlers,
    // shared context for FolderNode
    ctx,
  };
}
