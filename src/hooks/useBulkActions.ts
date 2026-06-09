// Every vault mutation the screen can trigger, in one place: clipboard copy (with
// auto-clear), the selection-bulk ops (favorite / move / delete / restore), the
// single-item detail ops, the right-click row ops, the inline-editor save, and
// folder create/rename/move/delete. They all share one `reloadAfterMutation`
// (re-sync → clear selection → bump the list cache token) and route per owning
// account via the data layer's `groupByAccount`/`accountFor`, since the unified
// list mixes connections. IPC lives in lib/ipc.ts; this only orchestrates it.

import { type Accessor, createSignal } from 'solid-js';
import { readText, writeText } from '@tauri-apps/plugin-clipboard-manager';
import { openUrl } from '@tauri-apps/plugin-opener';
import { ipc } from '../lib/ipc.ts';
import type { Folder, ItemDetail, ItemType, VaultItem } from '../lib/types.ts';
import type { VaultFilter } from '../lib/search.ts';
import type { EditorState } from '../lib/vaultConfig.ts';
import { pushToast, toastError } from '../state/toast.ts';
import { clipboardClearSeconds } from '../state/clipboard.ts';

export function useBulkActions(deps: {
  items: Accessor<VaultItem[]>;
  folders: Accessor<Folder[]>;
  accountFor: (id: string) => string;
  groupByAccount: (ids: string[]) => Map<string, string[]>;
  runSync: (manual: boolean) => Promise<void>;
  // selection
  selectedIds: Accessor<Set<string>>;
  clearSelection: () => void;
  setMoveMenuOpen: (v: boolean) => void;
  // detail / selection-of-open-item
  selectedId: Accessor<string | null>;
  setSelectedId: (id: string | null) => void;
  setDetail: (d: ItemDetail | null) => void;
  // filtering
  filter: Accessor<VaultFilter>;
  setFilter: (f: VaultFilter) => void;
  // editor + main-view switch (creating returns to the vault view)
  editor: Accessor<EditorState>;
  setEditor: (s: EditorState) => void;
  showVaultView: () => void;
}) {
  // Bumped after a vault mutation so the list drops stale cached row detail.
  const [cacheToken, setCacheToken] = createSignal(0);

  // Re-sync + reload after any vault mutation, then clear selection.
  async function reloadAfterMutation() {
    await deps.runSync(false);
    deps.clearSelection();
    setCacheToken((t) => t + 1);
  }

  async function copy(label: string, value: string | null | undefined) {
    if (!value) return;
    try {
      await writeText(value);
      // Seconds before a copied secret is wiped from the clipboard (0 = never),
      // configurable in Settings → Security.
      const clearSeconds = clipboardClearSeconds();
      pushToast(
        'success',
        clearSeconds > 0 ? `${label} copied — clears in ${clearSeconds}s.` : `${label} copied.`,
      );
      if (clearSeconds <= 0) return;
      const copied = value;
      // Auto-clear, but only if the clipboard still holds what we wrote (don't
      // clobber something the user copied afterwards).
      setTimeout(() => {
        void (async () => {
          try {
            if ((await readText()) === copied) await writeText('');
          } catch {
            // ignore: clipboard may be unavailable or hold non-text content
          }
        })();
      }, clearSeconds * 1000);
    } catch (err) {
      toastError(err);
    }
  }

  // ---- bulk actions ----
  async function bulkFavorite() {
    const ids = [...deps.selectedIds()];
    if (ids.length === 0) return;
    try {
      // Favorite every selected item that isn't already a favorite.
      const byId = new Map(deps.items().map((it) => [it.id, it]));
      await Promise.all(
        ids.map((id) => {
          const it = byId.get(id);
          return it ? ipc.setFavorite(it.accountEmail, id, !it.favorite) : Promise.resolve();
        }),
      );
      await reloadAfterMutation();
      pushToast('success', `Updated ${ids.length} item${ids.length === 1 ? '' : 's'}.`);
    } catch (err) {
      toastError(err);
    }
  }

  async function bulkMove(folderId: string | null) {
    const ids = [...deps.selectedIds()];
    if (ids.length === 0) return;
    deps.setMoveMenuOpen(false);
    try {
      if (folderId === null) {
        for (const [acct, gids] of deps.groupByAccount(ids)) {
          await ipc.moveItems(acct, gids, null);
        }
      } else {
        // A folder belongs to one account; only move that account's selected items.
        const acct = deps.folders().find((f) => f.id === folderId)?.accountEmail ?? '';
        const own = ids.filter((id) => deps.accountFor(id) === acct);
        if (own.length === 0) {
          pushToast('error', 'Pick a folder in the same account as the items.');
          return;
        }
        await ipc.moveItems(acct, own, folderId);
      }
      await reloadAfterMutation();
      pushToast('success', `Moved ${ids.length} item${ids.length === 1 ? '' : 's'}.`);
    } catch (err) {
      toastError(err);
    }
  }

  async function bulkDelete(permanent: boolean) {
    const ids = [...deps.selectedIds()];
    if (ids.length === 0) return;
    try {
      for (const [acct, gids] of deps.groupByAccount(ids)) {
        await ipc.deleteItems(acct, gids, permanent);
      }
      if (ids.includes(deps.selectedId() ?? '')) deps.setSelectedId(null);
      await reloadAfterMutation();
      pushToast('success', permanent ? `Deleted ${ids.length} permanently.` : `Trashed ${ids.length}.`);
    } catch (err) {
      toastError(err);
    }
  }

  async function bulkRestore() {
    const ids = [...deps.selectedIds()];
    if (ids.length === 0) return;
    try {
      for (const [acct, gids] of deps.groupByAccount(ids)) {
        await ipc.restoreItems(acct, gids);
      }
      await reloadAfterMutation();
      pushToast('success', `Restored ${ids.length} item${ids.length === 1 ? '' : 's'}.`);
    } catch (err) {
      toastError(err);
    }
  }

  // ---- single-item detail actions ----
  async function detailClone(id: string) {
    try {
      await ipc.cloneItem(deps.accountFor(id), id);
      await reloadAfterMutation();
      pushToast('success', 'Item cloned.');
    } catch (err) {
      toastError(err);
    }
  }

  async function detailFavorite(d: ItemDetail) {
    try {
      await ipc.setFavorite(d.accountEmail, d.id, !d.favorite);
      await reloadAfterMutation();
      // Refresh the open detail so the toggle reflects the new state.
      deps.setDetail(await ipc.itemDetail(d.accountEmail, d.id));
    } catch (err) {
      toastError(err);
    }
  }

  async function detailDelete(id: string, permanent: boolean) {
    try {
      await ipc.deleteItems(deps.accountFor(id), [id], permanent);
      deps.setSelectedId(null);
      await reloadAfterMutation();
      pushToast('success', permanent ? 'Item permanently deleted.' : 'Moved to trash.');
    } catch (err) {
      toastError(err);
    }
  }

  async function detailRestore(id: string) {
    try {
      const acct = deps.accountFor(id);
      await ipc.restoreItems(acct, [id]);
      await reloadAfterMutation();
      deps.setDetail(await ipc.itemDetail(acct, id));
      pushToast('success', 'Item restored.');
    } catch (err) {
      toastError(err);
    }
  }

  function openEdit(d: ItemDetail) {
    // No need to un-collapse the preview: the detail-pane <Show> already stays
    // visible whenever the editor is open (`editor().mode !== 'closed'`), so the
    // user's "hide details" preference is preserved and restored on close.
    deps.setEditor({ mode: 'edit', item: d });
  }

  // The editor renders inline in the vault detail pane, so creating from another
  // view (generator/security/…) must return to the vault view first.
  function openCreate(createType: ItemType) {
    deps.showVaultView();
    deps.setEditor({ mode: 'create', createType });
  }

  // ---- row context-menu actions (operate on a single right-clicked item) ----
  // The list row only carries username/type; secrets live in the full detail, so
  // copy-password/-totp/-uri fetch the detail (or live code) on demand.
  async function rowFavorite(item: VaultItem) {
    try {
      await ipc.setFavorite(item.accountEmail, item.id, !item.favorite);
      await reloadAfterMutation();
      if (deps.selectedId() === item.id) {
        deps.setDetail(await ipc.itemDetail(item.accountEmail, item.id));
      }
    } catch (err) {
      toastError(err);
    }
  }

  async function rowEdit(item: VaultItem) {
    try {
      openEdit(await ipc.itemDetail(item.accountEmail, item.id));
    } catch (err) {
      toastError(err);
    }
  }

  async function copyPasswordFor(item: VaultItem) {
    try {
      const d = await ipc.itemDetail(item.accountEmail, item.id);
      if (!d.login?.password) {
        pushToast('error', 'No password on this item.');
        return;
      }
      await copy('Password', d.login.password);
    } catch (err) {
      toastError(err);
    }
  }

  async function copyTotpFor(item: VaultItem) {
    try {
      const code = await ipc.itemTotp(item.accountEmail, item.id);
      await copy('Code', code.code);
    } catch (err) {
      toastError(err);
    }
  }

  // First populated URI on the item, shared by "copy website" and "open website".
  async function firstUri(item: VaultItem): Promise<string | null> {
    const d = await ipc.itemDetail(item.accountEmail, item.id);
    return d.login?.uris.find((u) => u.uri)?.uri ?? null;
  }

  async function copyUriFor(item: VaultItem) {
    try {
      const uri = await firstUri(item);
      if (!uri) {
        pushToast('error', 'No website on this item.');
        return;
      }
      await copy('URL', uri);
    } catch (err) {
      toastError(err);
    }
  }

  async function openSiteFor(item: VaultItem) {
    try {
      const uri = await firstUri(item);
      if (!uri) {
        pushToast('error', 'No website on this item.');
        return;
      }
      await openUrl(uri);
    } catch (err) {
      toastError(err);
    }
  }

  // After the editor saves, close it and refresh.
  async function onEditorSaved() {
    const state = deps.editor();
    const wasEditing = state.mode === 'edit' ? state.item : null;
    deps.setEditor({ mode: 'closed' });
    await reloadAfterMutation();
    if (wasEditing && deps.selectedId() === wasEditing.id) {
      try {
        deps.setDetail(await ipc.itemDetail(wasEditing.accountEmail, wasEditing.id));
      } catch (err) {
        toastError(err);
      }
    }
    pushToast('success', 'Item saved.');
  }

  // ---- folder management (the rail tree owns validation; these run the IPC) ----
  async function folderCreate(account: string, fullName: string) {
    try {
      await ipc.createFolder(account, fullName);
      await reloadAfterMutation();
      pushToast('success', 'Folder created.');
    } catch (err) {
      toastError(err);
    }
  }

  // Apply a batch of folder renames sequentially. A rename/re-parent cascades to
  // descendants; issuing them in series avoids racing the SDK's folder repository.
  async function folderApplyRenames(
    account: string,
    renames: { id: string; newName: string }[],
    done: string,
  ) {
    try {
      for (const r of renames) await ipc.renameFolder(account, r.id, r.newName);
      await reloadAfterMutation();
      pushToast('success', done);
    } catch (err) {
      toastError(err);
    }
  }

  // Delete a folder subtree: move its items to "No folder" first (so they survive
  // even if a later folder delete fails), then delete each folder. Reset the active
  // filter if it pointed into the now-deleted subtree.
  async function folderDelete(account: string, folderIds: string[], itemIds: string[]) {
    try {
      if (itemIds.length) await ipc.moveItems(account, itemIds, null);
      for (const id of folderIds) await ipc.deleteFolder(account, id);
      const f = deps.filter();
      if (f.kind === 'folder' && f.folderId !== null && folderIds.includes(f.folderId)) {
        deps.setFilter({ kind: 'all' });
      }
      await reloadAfterMutation();
      pushToast('success', folderIds.length > 1 ? 'Folders deleted.' : 'Folder deleted.');
    } catch (err) {
      toastError(err);
    }
  }

  return {
    cacheToken,
    reloadAfterMutation,
    copy,
    bulkFavorite,
    bulkMove,
    bulkDelete,
    bulkRestore,
    detailClone,
    detailFavorite,
    detailDelete,
    detailRestore,
    openEdit,
    openCreate,
    rowFavorite,
    rowEdit,
    copyPasswordFor,
    copyTotpFor,
    copyUriFor,
    openSiteFor,
    onEditorSaved,
    folderCreate,
    folderApplyRenames,
    folderDelete,
  };
}

export type BulkActions = ReturnType<typeof useBulkActions>;
