// Left-rail folder tree, like Bitwarden's. Bitwarden encodes nesting in folder
// names with "/" (e.g. "Work/Email"), so we split on "/" and build a tree;
// intermediate segments that aren't themselves folders render as collapsible
// group headers (not selectable). A trailing "No folder" entry filters to items
// with no folder.

import { createSignal, For, Show } from 'solid-js';
import { ChevronDown, ChevronRight, Folder as FolderIcon, FolderOpen } from 'lucide-solid';
import type { Folder } from '../lib/types.ts';
import type { VaultFilter } from '../lib/search.ts';
import './FolderTree.css';

interface Node {
  name: string;
  path: string;
  /** Set when an actual folder exists at this exact path; null for a group. */
  folderId: string | null;
  children: Node[];
}

function buildTree(folders: Folder[]): Node[] {
  const root: Node[] = [];
  const index = new Map<string, Node>();
  const real = folders
    .filter((f) => f.id !== null)
    .slice()
    .sort((a, b) => a.name.localeCompare(b.name, undefined, { sensitivity: 'base' }));
  for (const f of real) {
    const parts = f.name.split('/').map((s) => s.trim()).filter(Boolean);
    if (!parts.length) continue;
    let prefix = '';
    let siblings = root;
    let node: Node | undefined;
    for (const part of parts) {
      prefix = prefix ? `${prefix}/${part}` : part;
      node = index.get(prefix);
      if (!node) {
        node = { name: part, path: prefix, folderId: null, children: [] };
        index.set(prefix, node);
        siblings.push(node);
      }
      siblings = node.children;
    }
    if (node) node.folderId = f.id;
  }
  return root;
}

export default function FolderTree(props: {
  folders: Folder[];
  active: VaultFilter;
  onSelect: (f: VaultFilter) => void;
}) {
  const tree = () => buildTree(props.folders);
  const hasFolders = () => props.folders.some((f) => f.id !== null);
  const [expanded, setExpanded] = createSignal<Set<string>>(new Set());
  const isExpanded = (path: string) => expanded().has(path);
  function toggle(path: string) {
    const next = new Set(expanded());
    if (next.has(path)) next.delete(path);
    else next.add(path);
    setExpanded(next);
  }
  const isActive = (folderId: string | null) =>
    props.active.kind === 'folder' && props.active.folderId === folderId;

  return (
    <Show when={hasFolders()}>
      <div class="vault-rail-sep" />
      <div class="folder-tree-label">Folders</div>
      <For each={tree()}>
        {(node) => (
          <FolderNode
            node={node}
            depth={0}
            isExpanded={isExpanded}
            toggle={toggle}
            isActive={isActive}
            onSelect={props.onSelect}
          />
        )}
      </For>
      <button
        class="folder-row"
        classList={{ active: isActive(null) }}
        onClick={() => props.onSelect({ kind: 'folder', folderId: null })}
      >
        <span class="folder-twist" />
        <FolderIcon size={14} strokeWidth={1.6} />
        <span class="folder-name">No folder</span>
      </button>
    </Show>
  );
}

function FolderNode(props: {
  node: Node;
  depth: number;
  isExpanded: (p: string) => boolean;
  toggle: (p: string) => void;
  isActive: (id: string | null) => boolean;
  onSelect: (f: VaultFilter) => void;
}) {
  const hasChildren = () => props.node.children.length > 0;
  const selectable = () => props.node.folderId !== null;
  const open = () => props.isExpanded(props.node.path);
  const pad = () => `${9 + props.depth * 14}px`;

  function onClick() {
    if (selectable()) props.onSelect({ kind: 'folder', folderId: props.node.folderId });
    else if (hasChildren()) props.toggle(props.node.path);
  }

  return (
    <>
      <button
        class="folder-row"
        classList={{ active: props.isActive(props.node.folderId) }}
        style={{ 'padding-left': pad() }}
        onClick={onClick}
      >
        <span
          class="folder-twist"
          onClick={(e) => {
            if (hasChildren()) {
              e.stopPropagation();
              props.toggle(props.node.path);
            }
          }}
        >
          <Show when={hasChildren()}>
            <Show when={open()} fallback={<ChevronRight size={13} strokeWidth={1.6} />}>
              <ChevronDown size={13} strokeWidth={1.6} />
            </Show>
          </Show>
        </span>
        <Show when={open() && hasChildren()} fallback={<FolderIcon size={14} strokeWidth={1.6} />}>
          <FolderOpen size={14} strokeWidth={1.6} />
        </Show>
        <span class="folder-name">{props.node.name}</span>
      </button>
      <Show when={open()}>
        <For each={props.node.children}>
          {(child) => (
            <FolderNode
              node={child}
              depth={props.depth + 1}
              isExpanded={props.isExpanded}
              toggle={props.toggle}
              isActive={props.isActive}
              onSelect={props.onSelect}
            />
          )}
        </For>
      </Show>
    </>
  );
}
