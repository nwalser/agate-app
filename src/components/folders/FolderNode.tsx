// Row rendering for the left-rail folder tree: the inline name input (EditRow,
// used for create + rename) and the recursive FolderNode that draws a folder row
// (twist, icon, name) plus its children. Both are driven entirely by the shared
// TreeCtx — no local state, no IPC — so all behavior stays in useFolderTree.
// Reuses the parent FolderTree.css classes (imported by FolderTree.tsx).

import { For, Show } from 'solid-js';
import {
  Check,
  ChevronDown,
  ChevronRight,
  Folder as FolderIcon,
  FolderOpen,
  X,
} from 'lucide-solid';
import type { Node, TreeCtx } from '../../lib/folderTree.ts';
import { t } from '../../lib/i18n.ts';

// An inline name input used for create + rename. Submits on Enter, cancels on
// Escape or blur.
export function EditRow(props: { ctx: TreeCtx; depth: number; placeholder: string }) {
  const pad = () => `${9 + props.depth * 14}px`;
  return (
    <div class="folder-edit-row" style={{ 'padding-left': pad() }}>
      <span class="folder-twist" />
      <FolderIcon size={14} strokeWidth={1.6} />
      <input
        ref={(el) => queueMicrotask(() => el.focus())}
        class="folder-edit-input"
        placeholder={props.placeholder}
        value={props.ctx.editValue()}
        onInput={(e) => props.ctx.setEditValue(e.currentTarget.value)}
        onKeyDown={(e) => {
          if (e.key === 'Enter') {
            e.preventDefault();
            props.ctx.submitEdit();
          } else if (e.key === 'Escape') {
            e.preventDefault();
            props.ctx.cancelEdit();
          }
        }}
        onBlur={() => props.ctx.cancelEdit()}
      />
      <button
        class="folder-edit-confirm"
        title={t('common.save')}
        // mousedown (not click) so it fires before the input's blur cancels.
        onMouseDown={(e) => {
          e.preventDefault();
          props.ctx.submitEdit();
        }}
      >
        <Check size={13} strokeWidth={2} />
      </button>
      <button
        class="folder-edit-cancel"
        title={t('common.cancel')}
        onMouseDown={(e) => {
          e.preventDefault();
          props.ctx.cancelEdit();
        }}
      >
        <X size={13} strokeWidth={2} />
      </button>
    </div>
  );
}

export function FolderNode(props: { node: Node; depth: number; ctx: TreeCtx }) {
  const ctx = props.ctx;
  const hasChildren = () => props.node.children.length > 0;
  const selectable = () => props.node.folderId !== null;
  const open = () => ctx.isExpanded(props.node.path);
  const pad = () => `${9 + props.depth * 14}px`;
  const renaming = () => {
    const e = ctx.editing();
    return e?.kind === 'rename' && e.node.path === props.node.path;
  };
  const creatingChild = () => {
    const e = ctx.editing();
    return e?.kind === 'create-child' && e.node.path === props.node.path;
  };

  function onClick() {
    if (selectable()) ctx.onSelect({ kind: 'folder', folderId: props.node.folderId });
    else if (hasChildren()) ctx.toggle(props.node.path);
  }

  return (
    <>
      <Show
        when={!renaming()}
        fallback={<EditRow ctx={ctx} depth={props.depth} placeholder={t('folderUi.folderNamePlaceholder')} />}
      >
        <button
          class="folder-row"
          classList={{
            active: ctx.isActive(props.node.folderId),
            'drop-target': ctx.dropKey() === props.node.path,
            dragging: ctx.dragId() !== null && ctx.dragId() === props.node.folderId,
          }}
          style={{ 'padding-left': pad() }}
          draggable={selectable()}
          onClick={onClick}
          onContextMenu={(e) => {
            e.preventDefault();
            e.stopPropagation();
            ctx.openMenu(props.node, e.clientX, e.clientY);
          }}
          onDragStart={(e) => {
            if (!selectable()) return;
            e.dataTransfer?.setData('text/plain', props.node.folderId ?? '');
            ctx.startDrag(props.node);
          }}
          onDragEnd={() => ctx.endDrag()}
          onDragOver={(e) => ctx.tryDragOver(props.node, e)}
          onDragLeave={() => ctx.clearDropTarget(props.node.path)}
          onDrop={(e) => {
            e.preventDefault();
            ctx.drop(props.node);
          }}
        >
          <span
            class="folder-twist"
            onClick={(e) => {
              if (hasChildren()) {
                e.stopPropagation();
                ctx.toggle(props.node.path);
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
      </Show>
      <Show when={open() || creatingChild()}>
        <Show when={creatingChild()}>
          <EditRow ctx={ctx} depth={props.depth + 1} placeholder={t('folderUi.subfolderNamePlaceholder')} />
        </Show>
        <For each={props.node.children}>
          {(child) => <FolderNode node={child} depth={props.depth + 1} ctx={ctx} />}
        </For>
      </Show>
    </>
  );
}
