// Left-rail folder tree, like Bitwarden's. Bitwarden encodes nesting in folder
// names with "/" (e.g. "Work/Email"), so we split on "/" and build a tree;
// intermediate segments that aren't themselves folders render as collapsible
// group headers (not selectable). Items with no folder are reachable via the
// "All items" rail filter, so the tree shows no separate "No folder" entry.
//
// The tree is also where folders are MANAGED: create (header / "New subfolder"),
// rename (inline), move/re-parent (drag-and-drop or a "Move to…" menu), and delete
// (whole subtree, with a confirmation). Because folders are flat entities with
// "/"-encoded nesting, a rename/move is a batch rename of the folder + every
// descendant — all the path-math and validation lives in ../lib/folders.ts; this
// component only drives the interaction and surfaces validation errors as toasts.
//
// In the unified multi-connection view folders are per-account, so when more
// than one connection has folders we group the tree under a per-connection
// header. Selection always filters by the (globally unique) folderId; every
// management action routes to the folder's owning account.
//
// This file is a thin orchestrator: pure tree-shaping lives in ../lib/folderTree.ts,
// all stateful behavior in ../hooks/useFolderTree.ts, and row/sub-tree rendering in
// ./folders/FolderNode.tsx. It only wires those together and renders the chrome
// (headers, the context menu, the delete confirmation).

import { For, Show } from 'solid-js';
import {
  ArrowUpToLine,
  Folder as FolderIcon,
  FolderInput,
  FolderPlus,
  Pencil,
  Trash2,
} from 'lucide-solid';
import { leafName, segments } from '../lib/folders.ts';
import { t } from '../lib/i18n.ts';
import { EditRow, FolderNode } from './folders/FolderNode.tsx';
import { buildTree } from '../lib/folderTree.ts';
import { type FolderTreeProps, useFolderTree } from '../hooks/useFolderTree.ts';
import './FolderTree.css';

export default function FolderTree(props: FolderTreeProps) {
  const tree = useFolderTree(props);
  const {
    real,
    accounts,
    multi,
    createAccountFor,
    folderById,
    editing,
    beginCreateTop,
    beginCreateChild,
    beginRename,
    menu,
    menuMode,
    setMenuMode,
    closeMenu,
    moveTargets,
    doMove,
    askDelete,
    confirm,
    setConfirm,
    confirmDelete,
    dropKey,
    topDropKey,
    topZoneHandlers,
    ctx,
  } = tree;

  return (
    <Show when={real().length > 0 || createAccountFor()}>
      <Show when={!multi()}>
        <div
          class="folder-tree-head"
          classList={{ 'drop-target': dropKey() === topDropKey(createAccountFor()) }}
          {...topZoneHandlers(createAccountFor())}
        >
          <span class="folder-tree-label">{t('folderUi.folders')}</span>
          <Show when={createAccountFor()}>
            <button
              class="folder-add-btn"
              title={t('folderUi.newFolder')}
              onClick={() => beginCreateTop(createAccountFor())}
            >
              <FolderPlus size={13} strokeWidth={1.7} />
            </button>
          </Show>
        </div>
        <Show when={editing()?.kind === 'create-top'}>
          <EditRow ctx={ctx} depth={0} placeholder={t('folderUi.folderNamePlaceholder')} />
        </Show>
        <For each={buildTree(real(), createAccountFor())}>
          {(node) => <FolderNode node={node} depth={0} ctx={ctx} />}
        </For>
      </Show>

      <Show when={multi()}>
        <div class="folder-tree-label">{t('folderUi.folders')}</div>
        <For each={accounts()}>
          {(acct) => (
            <>
              <div
                class="folder-conn folder-tree-head"
                classList={{ 'drop-target': dropKey() === topDropKey(acct.email) }}
                title={acct.email}
                {...topZoneHandlers(acct.email)}
              >
                <span class="folder-conn-name">{acct.email}</span>
                <button
                  class="folder-add-btn"
                  title={t('folderUi.newFolder')}
                  onClick={() => beginCreateTop(acct.email)}
                >
                  <FolderPlus size={13} strokeWidth={1.7} />
                </button>
              </div>
              <Show when={editing()?.kind === 'create-top' && (editing() as { account: string }).account === acct.email}>
                <EditRow ctx={ctx} depth={1} placeholder={t('folderUi.folderNamePlaceholder')} />
              </Show>
              <For each={buildTree(real().filter((f) => f.accountEmail === acct.email), acct.email, acct.email)}>
                {(node) => <FolderNode node={node} depth={1} ctx={ctx} />}
              </For>
            </>
          )}
        </For>
      </Show>

      {/* Context menu (one at a time, mirrors the item row menu in Vault.tsx). */}
      <Show when={menu()}>
        {(m) => {
          const node = () => m().node;
          const folder = () => (node().folderId ? folderById(node().folderId!) : undefined);
          return (
            <>
              <div
                class="vault-menu-backdrop"
                onClick={closeMenu}
                onContextMenu={(e) => {
                  e.preventDefault();
                  closeMenu();
                }}
              />
              <div class="vault-ctx" role="menu" style={{ left: m().x + 'px', top: m().y + 'px' }}>
                <div class="vault-ctx-title">{node().name}</div>
                <div class="vault-ctx-sep" />
                <Show
                  when={menuMode() === 'main'}
                  fallback={
                    <Show when={folder()}>
                      {(f) => (
                        <>
                          <button class="vault-ctx-item" onClick={() => doMove(f(), null)}>
                            <ArrowUpToLine size={14} /> {t('folderUi.topLevel')}
                          </button>
                          <div class="vault-ctx-sep" />
                          <div class="folder-move-list">
                            <For each={moveTargets(f())}>
                              {(t) => (
                                <button class="vault-ctx-item" onClick={() => doMove(f(), t)}>
                                  <FolderIcon size={14} /> {t.name}
                                </button>
                              )}
                            </For>
                          </div>
                        </>
                      )}
                    </Show>
                  }
                >
                  <button
                    class="vault-ctx-item"
                    onClick={() => {
                      const n = node();
                      closeMenu();
                      beginCreateChild(n);
                    }}
                  >
                    <FolderPlus size={14} /> {t('folderUi.newSubfolder')}
                  </button>
                  <Show when={folder()}>
                    {(f) => (
                      <>
                        <button
                          class="vault-ctx-item"
                          onClick={() => {
                            const n = node();
                            closeMenu();
                            beginRename(n);
                          }}
                        >
                          <Pencil size={14} /> {t('folderUi.rename')}
                        </button>
                        <Show when={moveTargets(f()).length > 0 || segments(f().name).length > 1}>
                          <button class="vault-ctx-item" onClick={() => setMenuMode('move')}>
                            <FolderInput size={14} /> {t('folderUi.moveTo')}
                          </button>
                        </Show>
                        <div class="vault-ctx-sep" />
                        <button class="vault-ctx-item danger" onClick={() => askDelete(node())}>
                          <Trash2 size={14} /> {t('common.delete')}
                        </button>
                      </>
                    )}
                  </Show>
                </Show>
              </div>
            </>
          );
        }}
      </Show>

      {/* Subtree-delete confirmation. */}
      <Show when={confirm()}>
        {(c) => (
          <>
            <div class="folder-confirm-backdrop" onClick={() => setConfirm(null)}>
              <div
                class="folder-confirm"
                role="dialog"
                aria-modal="true"
                onClick={(e) => e.stopPropagation()}
              >
                <h3 class="folder-confirm-title">
                  {t('folderUi.deleteConfirmTitle', { name: leafName(c().folder.name) })}
                </h3>
                <div class="folder-confirm-body">
                  <Show when={c().plan.subfolderCount > 0}>
                    <p>
                      {c().plan.subfolderCount === 1
                        ? t('folderUi.alsoDeletesSubfolderOne', { count: c().plan.subfolderCount })
                        : t('folderUi.alsoDeletesSubfolderOther', { count: c().plan.subfolderCount })}
                    </p>
                  </Show>
                  <Show
                    when={c().plan.itemIds.length > 0}
                    fallback={<p>{t('folderUi.noItemsInFolder')}</p>}
                  >
                    <p>
                      {c().plan.itemIds.length === 1
                        ? t('folderUi.itemsMoveToNoFolderOne', { count: c().plan.itemIds.length })
                        : t('folderUi.itemsMoveToNoFolderOther', { count: c().plan.itemIds.length })}
                    </p>
                  </Show>
                  <p class="folder-confirm-warn">{t('folderUi.cannotBeUndone')}</p>
                </div>
                <div class="folder-confirm-actions">
                  <button class="ghost" onClick={() => setConfirm(null)}>
                    {t('common.cancel')}
                  </button>
                  <button class="danger" onClick={confirmDelete}>
                    <Trash2 size={14} strokeWidth={1.7} /> {t('folderUi.deleteFolder')}
                  </button>
                </div>
              </div>
            </div>
          </>
        )}
      </Show>
    </Show>
  );
}
