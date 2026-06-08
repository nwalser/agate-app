import {
  createEffect,
  createMemo,
  createSignal,
  For,
  on,
  onCleanup,
  onMount,
  Show,
} from 'solid-js';
import {
  Cloud,
  CloudOff,
  Copy,
  CreditCard,
  ExternalLink,
  Eye,
  EyeOff,
  File,
  FolderInput,
  KeyRound,
  Lock,
  Pencil,
  Plus,
  RefreshCw,
  RotateCcw,
  Search,
  Settings as SettingsIcon,
  Shield,
  Star,
  StickyNote,
  Terminal,
  Timer,
  Trash2,
  UserRound,
} from 'lucide-solid';
import { readText, writeText } from '@tauri-apps/plugin-clipboard-manager';
import { openUrl } from '@tauri-apps/plugin-opener';
import { ipc } from '../lib/ipc.ts';
import { filterItems, type VaultFilter } from '../lib/search.ts';
import type { Folder, ItemDetail, ItemType, TotpCode, VaultItem } from '../lib/types.ts';
import { pushToast, toastError } from '../state/toast.ts';
import ItemEditor from '../components/ItemEditor.tsx';
import AuditReport from '../components/AuditReport.tsx';
import CommandPalette, { type Command } from '../components/CommandPalette.tsx';
import './Vault.css';

function typeIcon(t: ItemType) {
  switch (t) {
    case 'login':
      return KeyRound;
    case 'secureNote':
      return StickyNote;
    case 'card':
      return CreditCard;
    case 'identity':
      return UserRound;
    case 'sshKey':
      return Terminal;
    default:
      return File;
  }
}

// Item types offered in the "Add" menu and command palette (excludes 'unknown').
const CREATE_TYPES: { type: ItemType; label: string }[] = [
  { type: 'login', label: 'Login' },
  { type: 'card', label: 'Card' },
  { type: 'identity', label: 'Identity' },
  { type: 'secureNote', label: 'Secure note' },
  { type: 'sshKey', label: 'SSH key' },
];

// Left-rail filters. `unknown` items only appear under "All items".
const TYPE_FILTERS: { type: ItemType; label: string }[] = [
  { type: 'login', label: 'Logins' },
  { type: 'card', label: 'Cards' },
  { type: 'identity', label: 'Identities' },
  { type: 'secureNote', label: 'Secure notes' },
  { type: 'sshKey', label: 'SSH keys' },
];

function filterEq(a: VaultFilter, b: VaultFilter): boolean {
  if (a.kind !== b.kind) return false;
  if (a.kind === 'type' && b.kind === 'type') return a.itemType === b.itemType;
  return true;
}

// Editor open-state: closed, creating a fresh item, or editing an existing one.
type EditorState =
  | { mode: 'closed' }
  | { mode: 'create'; createType: ItemType }
  | { mode: 'edit'; item: ItemDetail };

// Background-sync status, surfaced by the header cloud icon.
type SyncState = 'idle' | 'syncing' | 'error';

export default function Vault(props: { onLock: () => void; onOpenSettings: () => void }) {
  const [items, setItems] = createSignal<VaultItem[]>([]);
  const [folders, setFolders] = createSignal<Folder[]>([]);
  const [query, setQuery] = createSignal('');
  const [filter, setFilter] = createSignal<VaultFilter>({ kind: 'all' });
  const [selectedId, setSelectedId] = createSignal<string | null>(null);
  const [detail, setDetail] = createSignal<ItemDetail | null>(null);
  const [revealed, setRevealed] = createSignal(false);
  const [totp, setTotp] = createSignal<TotpCode | null>(null);
  // Sync status drives the cloud icon in the header. 'syncing' = in flight,
  // 'error' = last attempt failed, 'idle' = up to date. `lastSync` is the epoch
  // ms of the last successful sync (null until the first one completes).
  const [syncState, setSyncState] = createSignal<SyncState>('idle');
  const [lastSync, setLastSync] = createSignal<number | null>(null);

  // Multi-select state. `anchor` is the last clicked row for shift-range select.
  const [selectedIds, setSelectedIds] = createSignal<Set<string>>(new Set());
  const [anchorId, setAnchorId] = createSignal<string | null>(null);

  // Overlays / menus.
  const [editor, setEditor] = createSignal<EditorState>({ mode: 'closed' });
  const [showAudit, setShowAudit] = createSignal(false);
  const [addMenuOpen, setAddMenuOpen] = createSignal(false);
  const [moveMenuOpen, setMoveMenuOpen] = createSignal(false);
  const [paletteOpen, setPaletteOpen] = createSignal(false);

  const inTrash = createMemo(() => filter().kind === 'trash');
  const filtered = createMemo(() => filterItems(items(), query(), filter()));
  const selectedCount = createMemo(() => selectedIds().size);

  // Hover text for the header cloud icon — state plus last-success clock time.
  const syncTooltip = createMemo(() => {
    if (syncState() === 'syncing') return 'Syncing…';
    const ts = lastSync();
    const when = ts === null ? '' : ` (last synced ${new Date(ts).toLocaleTimeString()})`;
    if (syncState() === 'error') return `Sync failed — click to retry${when}`;
    return `Synced — click to sync now${when}`;
  });

  async function loadItems() {
    try {
      setItems(await ipc.listItems());
    } catch (err) {
      toastError(err);
    }
  }

  async function loadFolders() {
    try {
      setFolders(await ipc.listFolders());
    } catch (err) {
      toastError(err);
    }
  }

  function clearSelection() {
    setSelectedIds(new Set<string>());
    setAnchorId(null);
  }

  // Single sync path. `manual` syncs (button / palette) toast on success and
  // surface errors loudly; background syncs (mount, interval, post-mutation)
  // stay quiet — the cloud status icon already reflects success/failure, so the
  // interval can't spam toasts. Overlapping runs are skipped.
  async function runSync(manual: boolean) {
    if (syncState() === 'syncing') return;
    setSyncState('syncing');
    try {
      await ipc.syncVault(false);
      await Promise.all([loadItems(), loadFolders()]);
      setLastSync(Date.now());
      setSyncState('idle');
      if (manual) pushToast('success', 'Vault synced.');
    } catch (err) {
      setSyncState('error');
      if (manual) toastError(err);
    }
  }

  const sync = () => runSync(true);

  // Re-sync + reload after any vault mutation, then clear selection.
  async function reloadAfterMutation() {
    await runSync(false);
    clearSelection();
  }

  // Automatic background sync: once on open, then on a fixed interval. The cloud
  // icon in the header is the visible status.
  const AUTO_SYNC_MS = 5 * 60 * 1000;
  let autoSyncTimer: ReturnType<typeof setInterval> | undefined;
  onMount(() => {
    void runSync(false);
    autoSyncTimer = setInterval(() => void runSync(false), AUTO_SYNC_MS);
  });
  onCleanup(() => {
    if (autoSyncTimer) clearInterval(autoSyncTimer);
    autoSyncTimer = undefined;
  });

  // Ctrl/Cmd-K toggles the command palette.
  function onGlobalKeyDown(e: KeyboardEvent) {
    if ((e.ctrlKey || e.metaKey) && (e.key === 'k' || e.key === 'K')) {
      // Don't open the palette over an open editor/audit modal — palette
      // commands could switch the editor state without it remounting, leaving
      // stale field values.
      if (editor().mode !== 'closed' || showAudit()) return;
      e.preventDefault();
      setPaletteOpen((v) => !v);
    }
  }
  onMount(() => document.addEventListener('keydown', onGlobalKeyDown));
  onCleanup(() => document.removeEventListener('keydown', onGlobalKeyDown));

  // Seconds before a copied secret is wiped from the clipboard.
  const CLIPBOARD_CLEAR_SECONDS = 15;

  async function copy(label: string, value: string | null | undefined) {
    if (!value) return;
    try {
      await writeText(value);
      pushToast('success', `${label} copied — clears in ${CLIPBOARD_CLEAR_SECONDS}s.`);
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
      }, CLIPBOARD_CLEAR_SECONDS * 1000);
    } catch (err) {
      toastError(err);
    }
  }

  // ---- selection handling (single-click selects; modifiers multi-select) ----
  function onRowClick(item: VaultItem, e: MouseEvent) {
    const visible = filtered();
    if (e.shiftKey && anchorId()) {
      const anchorIdx = visible.findIndex((it) => it.id === anchorId());
      const clickIdx = visible.findIndex((it) => it.id === item.id);
      if (anchorIdx !== -1 && clickIdx !== -1) {
        const [lo, hi] = anchorIdx < clickIdx ? [anchorIdx, clickIdx] : [clickIdx, anchorIdx];
        const next = new Set(selectedIds());
        for (let i = lo; i <= hi; i++) next.add(visible[i].id);
        setSelectedIds(next);
        return;
      }
    }
    if (e.ctrlKey || e.metaKey) {
      const next = new Set(selectedIds());
      if (next.has(item.id)) next.delete(item.id);
      else next.add(item.id);
      setSelectedIds(next);
      setAnchorId(item.id);
      return;
    }
    // Plain click: open the item and reset any multi-selection.
    clearSelection();
    setSelectedId(item.id);
  }

  function onCheckboxToggle(item: VaultItem, checked: boolean) {
    const next = new Set(selectedIds());
    if (checked) next.add(item.id);
    else next.delete(item.id);
    setSelectedIds(next);
    setAnchorId(item.id);
  }

  // ---- bulk actions ----
  async function bulkFavorite() {
    const ids = [...selectedIds()];
    if (ids.length === 0) return;
    try {
      // Favorite every selected item that isn't already a favorite.
      const byId = new Map(items().map((it) => [it.id, it]));
      await Promise.all(
        ids.map((id) => ipc.setFavorite(id, !(byId.get(id)?.favorite ?? false))),
      );
      await reloadAfterMutation();
      pushToast('success', `Updated ${ids.length} item${ids.length === 1 ? '' : 's'}.`);
    } catch (err) {
      toastError(err);
    }
  }

  async function bulkMove(folderId: string | null) {
    const ids = [...selectedIds()];
    if (ids.length === 0) return;
    setMoveMenuOpen(false);
    try {
      await ipc.moveItems(ids, folderId);
      await reloadAfterMutation();
      pushToast('success', `Moved ${ids.length} item${ids.length === 1 ? '' : 's'}.`);
    } catch (err) {
      toastError(err);
    }
  }

  async function bulkDelete(permanent: boolean) {
    const ids = [...selectedIds()];
    if (ids.length === 0) return;
    try {
      await ipc.deleteItems(ids, permanent);
      if (ids.includes(selectedId() ?? '')) setSelectedId(null);
      await reloadAfterMutation();
      pushToast('success', permanent ? `Deleted ${ids.length} permanently.` : `Trashed ${ids.length}.`);
    } catch (err) {
      toastError(err);
    }
  }

  async function bulkRestore() {
    const ids = [...selectedIds()];
    if (ids.length === 0) return;
    try {
      await ipc.restoreItems(ids);
      await reloadAfterMutation();
      pushToast('success', `Restored ${ids.length} item${ids.length === 1 ? '' : 's'}.`);
    } catch (err) {
      toastError(err);
    }
  }

  // ---- single-item detail actions ----
  async function detailClone(id: string) {
    try {
      await ipc.cloneItem(id);
      await reloadAfterMutation();
      pushToast('success', 'Item cloned.');
    } catch (err) {
      toastError(err);
    }
  }

  async function detailFavorite(d: ItemDetail) {
    try {
      await ipc.setFavorite(d.id, !d.favorite);
      await reloadAfterMutation();
      // Refresh the open detail so the toggle reflects the new state.
      setDetail(await ipc.itemDetail(d.id));
    } catch (err) {
      toastError(err);
    }
  }

  async function detailDelete(id: string, permanent: boolean) {
    try {
      await ipc.deleteItems([id], permanent);
      setSelectedId(null);
      await reloadAfterMutation();
      pushToast('success', permanent ? 'Item permanently deleted.' : 'Moved to trash.');
    } catch (err) {
      toastError(err);
    }
  }

  async function detailRestore(id: string) {
    try {
      await ipc.restoreItems([id]);
      await reloadAfterMutation();
      setDetail(await ipc.itemDetail(id));
      pushToast('success', 'Item restored.');
    } catch (err) {
      toastError(err);
    }
  }

  function openEdit(d: ItemDetail) {
    setEditor({ mode: 'edit', item: d });
  }

  // After the editor saves, close it and refresh.
  async function onEditorSaved() {
    const state = editor();
    const wasEditingId = state.mode === 'edit' ? state.item.id : null;
    setEditor({ mode: 'closed' });
    await reloadAfterMutation();
    if (wasEditingId && selectedId() === wasEditingId) {
      try {
        setDetail(await ipc.itemDetail(wasEditingId));
      } catch (err) {
        toastError(err);
      }
    }
    pushToast('success', 'Item saved.');
  }

  // Load detail + TOTP whenever selection changes.
  let totpTimer: ReturnType<typeof setInterval> | undefined;
  function stopTotp() {
    if (totpTimer) clearInterval(totpTimer);
    totpTimer = undefined;
    setTotp(null);
  }
  onCleanup(stopTotp);

  async function refreshTotp(id: string) {
    try {
      setTotp(await ipc.itemTotp(id));
    } catch (err) {
      toastError(err);
    }
  }

  createEffect(
    on(selectedId, async (id) => {
      stopTotp();
      setRevealed(false);
      setDetail(null);
      if (!id) return;
      try {
        const d = await ipc.itemDetail(id);
        setDetail(d);
        if (d.login?.hasTotp) {
          await refreshTotp(id);
          totpTimer = setInterval(() => {
            const current = totp();
            if (!current) return;
            if (current.remaining <= 1) {
              void refreshTotp(id);
            } else {
              setTotp({ ...current, remaining: current.remaining - 1 });
            }
          }, 1000);
        }
      } catch (err) {
        toastError(err);
      }
    }),
  );

  // ---- command palette commands ----
  const commands = createMemo<Command[]>(() => {
    const list: Command[] = [];
    for (const ct of CREATE_TYPES) {
      list.push({
        id: `new-${ct.type}`,
        label: `New ${ct.label.toLowerCase()}`,
        hint: 'Create',
        icon: Plus,
        run: () => setEditor({ mode: 'create', createType: ct.type }),
      });
    }
    list.push({
      id: 'security',
      label: 'Open Security report',
      icon: Shield,
      run: () => setShowAudit(true),
    });
    list.push({
      id: 'sync',
      label: 'Sync now',
      icon: RefreshCw,
      run: () => void sync(),
    });
    list.push({
      id: 'lock',
      label: 'Lock vault',
      icon: Lock,
      run: () => props.onLock(),
    });
    list.push({
      id: 'settings',
      label: 'Open Settings',
      icon: SettingsIcon,
      run: () => props.onOpenSettings(),
    });
    for (const it of items()) {
      if (it.deleted) continue;
      list.push({
        id: `goto-${it.id}`,
        label: `Go to ${it.name}`,
        hint: it.username ?? undefined,
        icon: typeIcon(it.itemType),
        run: () => {
          setFilter({ kind: 'all' });
          clearSelection();
          setSelectedId(it.id);
        },
      });
    }
    return list;
  });

  const realFolders = createMemo(() => folders().filter((f) => f.id !== null));

  return (
    <div class="vault">
      <header class="vault-header">
        <div class="vault-add-anchor">
          <button class="vault-add" onClick={() => setAddMenuOpen((v) => !v)} title="Add item">
            <Plus size={15} strokeWidth={1.75} /> Add
          </button>
          <Show when={addMenuOpen()}>
            <>
              <div class="vault-menu-backdrop" onClick={() => setAddMenuOpen(false)} />
              <div class="vault-menu" role="menu">
                <For each={CREATE_TYPES}>
                  {(ct) => {
                    const Icon = typeIcon(ct.type);
                    return (
                      <button
                        class="vault-menu-item"
                        role="menuitem"
                        onClick={() => {
                          setAddMenuOpen(false);
                          setEditor({ mode: 'create', createType: ct.type });
                        }}
                      >
                        <Icon size={14} strokeWidth={1.6} />
                        {ct.label}
                      </button>
                    );
                  }}
                </For>
              </div>
            </>
          </Show>
        </div>

        <div class="vault-search">
          <Search size={14} strokeWidth={1.75} />
          <input
            placeholder="Search vault…"
            value={query()}
            onInput={(e) => setQuery(e.currentTarget.value)}
          />
        </div>
        <button
          class="ghost icon-btn"
          title="Security report"
          onClick={() => setShowAudit(true)}
        >
          <Shield size={15} strokeWidth={1.75} />
        </button>
        <button
          class="ghost icon-btn"
          title={syncTooltip()}
          disabled={syncState() === 'syncing'}
          onClick={() => void sync()}
        >
          <Show
            when={syncState() === 'error'}
            fallback={
              <Cloud
                size={15}
                strokeWidth={1.75}
                class={syncState() === 'syncing' ? 'pulse' : ''}
              />
            }
          >
            <CloudOff size={15} strokeWidth={1.75} class="sync-error" />
          </Show>
        </button>
        <button class="ghost icon-btn" title="Settings" onClick={() => props.onOpenSettings()}>
          <SettingsIcon size={15} strokeWidth={1.75} />
        </button>
        <button class="ghost icon-btn" title="Lock" onClick={() => props.onLock()}>
          <Lock size={15} strokeWidth={1.75} />
        </button>
      </header>

      <div class="vault-body">
        <nav class="vault-rail">
          <FilterButton
            label="All items"
            icon={File}
            active={filterEq(filter(), { kind: 'all' })}
            onClick={() => setFilter({ kind: 'all' })}
          />
          <FilterButton
            label="Favorites"
            icon={Star}
            active={filterEq(filter(), { kind: 'favorites' })}
            onClick={() => setFilter({ kind: 'favorites' })}
          />
          <FilterButton
            label="Trash"
            icon={Trash2}
            active={filterEq(filter(), { kind: 'trash' })}
            onClick={() => setFilter({ kind: 'trash' })}
          />
          <div class="vault-rail-sep" />
          <For each={TYPE_FILTERS}>
            {(tf) => (
              <FilterButton
                label={tf.label}
                icon={typeIcon(tf.type)}
                active={filterEq(filter(), { kind: 'type', itemType: tf.type })}
                onClick={() => setFilter({ kind: 'type', itemType: tf.type })}
              />
            )}
          </For>
        </nav>

        <aside class="vault-list">
          <Show when={selectedCount() > 0}>
            <div class="vault-bulk">
              <span class="vault-bulk-count">{selectedCount()} selected</span>
              <span class="spacer" />
              <Show
                when={!inTrash()}
                fallback={
                  <>
                    <button class="ghost vault-bulk-btn" title="Restore" onClick={() => void bulkRestore()}>
                      <RotateCcw size={14} strokeWidth={1.6} /> Restore
                    </button>
                    <button
                      class="danger vault-bulk-btn"
                      title="Delete permanently"
                      onClick={() => void bulkDelete(true)}
                    >
                      <Trash2 size={14} strokeWidth={1.6} /> Delete
                    </button>
                  </>
                }
              >
                <button class="ghost vault-bulk-btn" title="Favorite" onClick={() => void bulkFavorite()}>
                  <Star size={14} strokeWidth={1.6} /> Favorite
                </button>
                <div class="vault-add-anchor">
                  <button
                    class="ghost vault-bulk-btn"
                    title="Move to folder"
                    onClick={() => setMoveMenuOpen((v) => !v)}
                  >
                    <FolderInput size={14} strokeWidth={1.6} /> Move
                  </button>
                  <Show when={moveMenuOpen()}>
                    <>
                      <div class="vault-menu-backdrop" onClick={() => setMoveMenuOpen(false)} />
                      <div class="vault-menu" role="menu">
                        <button class="vault-menu-item" onClick={() => void bulkMove(null)}>
                          No folder
                        </button>
                        <For each={realFolders()}>
                          {(f) => (
                            <button class="vault-menu-item" onClick={() => void bulkMove(f.id)}>
                              {f.name}
                            </button>
                          )}
                        </For>
                      </div>
                    </>
                  </Show>
                </div>
                <button class="danger vault-bulk-btn" title="Move to trash" onClick={() => void bulkDelete(false)}>
                  <Trash2 size={14} strokeWidth={1.6} /> Delete
                </button>
              </Show>
            </div>
          </Show>

          <Show
            when={filtered().length > 0}
            fallback={
              <div class="vault-empty muted">
                {items().length === 0 ? 'Vault is empty or not synced.' : 'No matches.'}
              </div>
            }
          >
            <For each={filtered()}>
              {(item) => {
                const Icon = typeIcon(item.itemType);
                const isChecked = () => selectedIds().has(item.id);
                return (
                  <div
                    class="vault-row"
                    classList={{
                      active: selectedId() === item.id && selectedCount() === 0,
                      'multi-selected': isChecked(),
                    }}
                    onClick={(e) => onRowClick(item, e)}
                  >
                    <label class="vault-row-check" onClick={(e) => e.stopPropagation()}>
                      <input
                        type="checkbox"
                        checked={isChecked()}
                        onChange={(e) => onCheckboxToggle(item, e.currentTarget.checked)}
                      />
                    </label>
                    <Icon size={16} strokeWidth={1.6} class="vault-row-icon" />
                    <span class="vault-row-text">
                      <span class="vault-row-name">{item.name}</span>
                      <Show when={item.username}>
                        <span class="vault-row-sub">{item.username}</span>
                      </Show>
                    </span>
                    <Show when={item.favorite}>
                      <Star size={13} strokeWidth={1.75} class="vault-row-fav" />
                    </Show>
                  </div>
                );
              }}
            </For>
          </Show>
        </aside>

        <section class="vault-detail">
          <Show
            when={detail()}
            fallback={<div class="vault-detail-empty muted">Select an item to view its details.</div>}
          >
            {(d) => (
              <div class="detail">
                <div class="detail-head">
                  <h2 class="detail-name">{d().name}</h2>
                  <span class="spacer" />
                  <div class="detail-actions">
                    <Show
                      when={!inTrash()}
                      fallback={
                        <>
                          <button
                            class="ghost icon-btn"
                            title="Restore"
                            onClick={() => void detailRestore(d().id)}
                          >
                            <RotateCcw size={15} strokeWidth={1.6} />
                          </button>
                          <button
                            class="ghost icon-btn detail-del"
                            title="Delete permanently"
                            onClick={() => void detailDelete(d().id, true)}
                          >
                            <Trash2 size={15} strokeWidth={1.6} />
                          </button>
                        </>
                      }
                    >
                      <button
                        class="ghost icon-btn"
                        title={d().favorite ? 'Unfavorite' : 'Favorite'}
                        onClick={() => void detailFavorite(d())}
                      >
                        <Star
                          size={15}
                          strokeWidth={1.6}
                          class={d().favorite ? 'vault-row-fav' : ''}
                        />
                      </button>
                      <button class="ghost icon-btn" title="Edit" onClick={() => openEdit(d())}>
                        <Pencil size={15} strokeWidth={1.6} />
                      </button>
                      <button
                        class="ghost icon-btn"
                        title="Clone"
                        onClick={() => void detailClone(d().id)}
                      >
                        <Copy size={15} strokeWidth={1.6} />
                      </button>
                      <button
                        class="ghost icon-btn detail-del"
                        title="Move to trash"
                        onClick={() => void detailDelete(d().id, false)}
                      >
                        <Trash2 size={15} strokeWidth={1.6} />
                      </button>
                    </Show>
                  </div>
                </div>

                <Show when={d().login}>
                  {(login) => (
                    <>
                      <Show when={login().username}>
                        <Field
                          label="Username"
                          value={login().username}
                          onCopy={() => void copy('Username', login().username)}
                        />
                      </Show>
                      <Show when={login().password}>
                        <div class="detail-field">
                          <label>Password</label>
                          <div class="detail-value-row">
                            <code class="detail-value mono">
                              {revealed() ? login().password : '••••••••••••'}
                            </code>
                            <button
                              class="ghost icon-btn"
                              title={revealed() ? 'Hide' : 'Reveal'}
                              onClick={() => setRevealed(!revealed())}
                            >
                              {revealed() ? <EyeOff size={14} /> : <Eye size={14} />}
                            </button>
                            <button
                              class="ghost icon-btn"
                              title="Copy"
                              onClick={() => void copy('Password', login().password)}
                            >
                              <Copy size={14} />
                            </button>
                          </div>
                        </div>
                      </Show>

                      <Show when={totp()}>
                        {(code) => (
                          <div class="detail-field">
                            <label>
                              <Timer size={11} strokeWidth={2} /> One-time code
                            </label>
                            <div class="detail-value-row">
                              <code class="detail-value mono totp-code">{code().code}</code>
                              <span class="totp-remaining">{code().remaining}s</span>
                              <button
                                class="ghost icon-btn"
                                title="Copy"
                                onClick={() => void copy('Code', code().code)}
                              >
                                <Copy size={14} />
                              </button>
                            </div>
                          </div>
                        )}
                      </Show>

                      <For each={login().uris}>
                        {(u) => (
                          <Show when={u.uri}>
                            <div class="detail-field">
                              <label>Website</label>
                              <div class="detail-value-row">
                                <span class="detail-value truncate">{u.uri}</span>
                                <button
                                  class="ghost icon-btn"
                                  title="Open"
                                  onClick={() => u.uri && void openUrl(u.uri)}
                                >
                                  <ExternalLink size={14} />
                                </button>
                                <button
                                  class="ghost icon-btn"
                                  title="Copy"
                                  onClick={() => void copy('URL', u.uri)}
                                >
                                  <Copy size={14} />
                                </button>
                              </div>
                            </div>
                          </Show>
                        )}
                      </For>
                    </>
                  )}
                </Show>

                <For each={d().fields}>
                  {(f) => (
                    <Show when={f.name || f.value}>
                      <Field
                        label={f.name ?? 'Field'}
                        value={f.value}
                        onCopy={() => void copy(f.name ?? 'Field', f.value)}
                      />
                    </Show>
                  )}
                </For>

                <Show when={d().notes}>
                  <div class="detail-field">
                    <label>Notes</label>
                    <pre class="detail-notes">{d().notes}</pre>
                  </div>
                </Show>
              </div>
            )}
          </Show>
        </section>
      </div>

      <Show when={editor().mode !== 'closed'}>
        {(() => {
          const state = editor();
          if (state.mode === 'closed') return null;
          return (
            <ItemEditor
              item={state.mode === 'edit' ? state.item : null}
              createType={state.mode === 'create' ? state.createType : undefined}
              folders={folders()}
              onSaved={() => void onEditorSaved()}
              onClose={() => setEditor({ mode: 'closed' })}
            />
          );
        })()}
      </Show>

      <Show when={showAudit()}>
        <div class="vault-audit-overlay" onClick={() => setShowAudit(false)}>
          <div class="vault-audit-panel" onClick={(e) => e.stopPropagation()}>
            <AuditReport
              onClose={() => setShowAudit(false)}
              onOpenItem={(id) => {
                setShowAudit(false);
                setFilter({ kind: 'all' });
                clearSelection();
                setSelectedId(id);
              }}
            />
          </div>
        </div>
      </Show>

      <CommandPalette
        open={paletteOpen()}
        onClose={() => setPaletteOpen(false)}
        commands={commands()}
      />
    </div>
  );
}

function FilterButton(props: {
  label: string;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  icon: any;
  active: boolean;
  onClick: () => void;
}) {
  const Icon = props.icon;
  return (
    <button class="vault-rail-btn" classList={{ active: props.active }} onClick={() => props.onClick()}>
      <Icon size={15} strokeWidth={1.6} />
      <span>{props.label}</span>
    </button>
  );
}

function Field(props: { label: string; value: string | null; onCopy: () => void }) {
  return (
    <div class="detail-field">
      <label>{props.label}</label>
      <div class="detail-value-row">
        <span class="detail-value truncate">{props.value}</span>
        <button class="ghost icon-btn" title="Copy" onClick={() => props.onCopy()}>
          <Copy size={14} />
        </button>
      </div>
    </div>
  );
}
