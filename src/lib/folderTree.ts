// Pure tree-shaping for the left-rail folder tree.
//
// Bitwarden folders are FLAT entities with nesting encoded in the name via "/"
// (see ./folders.ts for the path-math). This module turns that flat list into a
// nested `Node` tree for rendering: intermediate path segments that aren't
// themselves real folders become null-id group headers, and every node is
// namespaced per account so ids stay globally unique in the multi-connection
// view. Everything here is pure (no IPC, no signals) so it's unit-testable.

import type { Folder } from './types.ts';
import { segments } from './folders.ts';

export interface Node {
  /** Leaf segment shown on the row. */
  name: string;
  /** Full folder-name path (e.g. "Work/Email") — the management key. */
  fullName: string;
  /** Owning connection — every management action routes here. */
  accountEmail: string;
  /** Unique key for expand state (namespaced per account). */
  path: string;
  /** Set when an actual folder exists at this exact path; null for a group. */
  folderId: string | null;
  children: Node[];
}

export function buildTree(folders: Folder[], account: string, keyPrefix = ''): Node[] {
  const root: Node[] = [];
  const index = new Map<string, Node>();
  const sorted = folders
    .slice()
    .sort((a, b) => a.name.localeCompare(b.name, undefined, { sensitivity: 'base' }));
  for (const f of sorted) {
    const parts = segments(f.name);
    if (!parts.length) continue;
    let fullName = '';
    let key = keyPrefix;
    let siblings = root;
    let node: Node | undefined;
    for (const part of parts) {
      fullName = fullName ? `${fullName}/${part}` : part;
      key = key ? `${key}/${part}` : part;
      node = index.get(key);
      if (!node) {
        node = { name: part, fullName, accountEmail: account, path: key, folderId: null, children: [] };
        index.set(key, node);
        siblings.push(node);
      }
      siblings = node.children;
    }
    if (node) node.folderId = f.id;
  }
  return root;
}

// What the inline name input is for: a top-level create in an account, a child
// create under a node, or a rename of a node.
export type Editing =
  | { kind: 'create-top'; account: string }
  | { kind: 'create-child'; node: Node }
  | { kind: 'rename'; node: Node };

// Shared interaction context handed to every (recursive) FolderNode.
export interface TreeCtx {
  isExpanded: (path: string) => boolean;
  toggle: (path: string) => void;
  expand: (path: string) => void;
  isActive: (folderId: string | null) => boolean;
  onSelect: (f: import('./search.ts').VaultFilter) => void;
  editing: () => Editing | null;
  editValue: () => string;
  setEditValue: (v: string) => void;
  beginRename: (node: Node) => void;
  beginCreateChild: (node: Node) => void;
  submitEdit: () => void;
  cancelEdit: () => void;
  openMenu: (node: Node, x: number, y: number) => void;
  // drag-and-drop
  dragId: () => string | null;
  dropKey: () => string | null;
  startDrag: (node: Node) => void;
  endDrag: () => void;
  tryDragOver: (node: Node, e: DragEvent) => void;
  clearDropTarget: (key: string) => void;
  drop: (node: Node) => void;
}
