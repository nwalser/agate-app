import {
  createEffect,
  createMemo,
  createSignal,
  For,
  Match,
  on,
  onCleanup,
  onMount,
  Show,
  Switch,
} from 'solid-js';
import {
  Cloud,
  Copy,
  CreditCard,
  Dices,
  ExternalLink,
  Eye,
  EyeOff,
  File,
  FolderInput,
  KeyRound,
  Lock,
  Monitor,
  Moon,
  PanelLeftClose,
  PanelLeftOpen,
  Pencil,
  Plus,
  RefreshCw,
  RotateCcw,
  Settings as SettingsIcon,
  Shield,
  Star,
  StickyNote,
  Sun,
  Terminal,
  Timer,
  Trash2,
  UserRound,
} from 'lucide-solid';
import { readText, writeText } from '@tauri-apps/plugin-clipboard-manager';
import { openUrl } from '@tauri-apps/plugin-opener';
import { ipc } from '../lib/ipc.ts';
import { filterItems, type VaultFilter } from '../lib/search.ts';
import type { ConnectionSummary, Folder, ItemDetail, ItemType, TotpCode, VaultItem } from '../lib/types.ts';
import { query, setQuery } from '../state/search.ts';
import { pushToast, toastError } from '../state/toast.ts';
import { setTheme, theme, type ThemePref } from '../state/theme.ts';
import ItemEditor from '../components/ItemEditor.tsx';
import SecurityCenter from '../components/SecurityCenter.tsx';
import SyncStatus, { SyncIcon, type SyncState } from '../components/SyncStatus.tsx';
import CommandPalette, { type Command } from '../components/CommandPalette.tsx';
import VaultList from '../components/VaultList.tsx';
import FolderTree from '../components/FolderTree.tsx';
import VaultSwitcher from '../components/VaultSwitcher.tsx';
import GeneratorPage from '../components/GeneratorPage.tsx';
import { columnKey, columns, isFilterable, TYPE_LABELS, type SortDir, type SortKey } from '../state/columns.ts';
import { filters, NAME_FILTER_KEY } from '../state/columnFilters.ts';
import { activeVault, setActiveVault, sidebarCollapsed, toggleSidebar } from '../state/ui.ts';
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
  if (a.kind === 'folder' && b.kind === 'folder') return a.folderId === b.folderId;
  return true;
}

// Editor open-state: closed, creating a fresh item, or editing an existing one.
type EditorState =
  | { mode: 'closed' }
  | { mode: 'create'; createType: ItemType }
  | { mode: 'edit'; item: ItemDetail };

// Header theme button cycles through these in order.
const THEME_CYCLE: ThemePref[] = ['system', 'light', 'dark'];
const THEME_META: Record<ThemePref, { icon: typeof Sun; label: string }> = {
  system: { icon: Monitor, label: 'System theme' },
  light: { icon: Sun, label: 'Light theme' },
  dark: { icon: Moon, label: 'Dark theme' },
};

export default function Vault(props: { onLock: () => void; onOpenSettings: () => void }) {
  const [items, setItems] = createSignal<VaultItem[]>([]);
  const [folders, setFolders] = createSignal<Folder[]>([]);
  const [connections, setConnections] = createSignal<ConnectionSummary[]>([]);
  // `query` is the shared titlebar search signal (state/search.ts) — the search
  // field now lives in the custom window titlebar, not this header.
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

  // Which main view occupies the body: the vault list/detail, or the security
  // center (reached from the left rail). The rail stays visible in both.
  const [view, setView] = createSignal<'vault' | 'security' | 'sync' | 'generator'>('vault');

  // Switch a rail filter and return to the vault view in one step.
  function selectFilter(f: VaultFilter) {
    setView('vault');
    setFilter(f);
  }

  // Switch which connection the list is scoped to (null = all vaults merged).
  // Records the choice, returns to the vault view, and (for a specific, unlocked
  // connection) makes it the backend's default target for new items.
  function switchVault(email: string | null) {
    setActiveVault(email);
    setView('vault');
    // A folder filter belongs to one account, so switching vaults invalidates it.
    if (filter().kind === 'folder') setFilter({ kind: 'all' });
    clearSelection();
    setSelectedId(null);
    if (email) void ipc.setActiveConnection(email).catch(() => {
      // ignore: a locked connection can't be the active target; filter still applies
    });
  }

  // Overlays / menus.
  const [editor, setEditor] = createSignal<EditorState>({ mode: 'closed' });
  const [addMenuOpen, setAddMenuOpen] = createSignal(false);
  const [moveMenuOpen, setMoveMenuOpen] = createSignal(false);
  const [paletteOpen, setPaletteOpen] = createSignal(false);

  // Column sort. `displayed` is the filtered list in the sorted order the rows
  // actually render in — selection (shift-range) and the For both key off it so
  // visual order and logical order never diverge.
  const [sortKey, setSortKey] = createSignal<SortKey>('name');
  const [sortDir, setSortDir] = createSignal<SortDir>('asc');
  // Bumped after a vault mutation so the list drops stale cached row detail.
  const [cacheToken, setCacheToken] = createSignal(0);

  // Right-click context menu: the target item plus the cursor anchor, or null.
  const [ctxMenu, setCtxMenu] = createSignal<{ item: VaultItem; x: number; y: number } | null>(
    null,
  );

  const inTrash = createMemo(() => filter().kind === 'trash');
  const folderNameOf = (id: string | null): string =>
    id ? folders().find((f) => f.id === id)?.name ?? '' : '';
  const filtered = createMemo(() => {
    const av = activeVault();
    let base = filterItems(items(), query(), filter());
    // Scope to the selected vault (connection), if any. null = all merged.
    if (av) base = base.filter((it) => it.accountEmail === av);
    const active = filters();
    if (Object.keys(active).length === 0) return base;
    // Per-column filters. Build extractors only for the Name column and the
    // currently-visible filterable columns, so a stale filter on a hidden
    // column can't silently hide rows with no visible input to clear it.
    const extractors = new Map<string, (it: VaultItem) => string>();
    extractors.set(NAME_FILTER_KEY, (it) => it.name);
    for (const col of columns().columns) {
      if (col.kind !== 'builtin' || !isFilterable(col)) continue;
      const k = columnKey(col);
      if (col.id === 'username') extractors.set(k, (it) => it.username ?? '');
      else if (col.id === 'website') extractors.set(k, (it) => it.uri ?? '');
      else if (col.id === 'folder') extractors.set(k, (it) => folderNameOf(it.folderId));
      else if (col.id === 'type') extractors.set(k, (it) => TYPE_LABELS[it.itemType]);
    }
    const applicable = Object.keys(active)
      .filter((k) => extractors.has(k) && active[k])
      .map((k) => ({ needle: active[k].toLowerCase(), get: extractors.get(k)! }));
    if (applicable.length === 0) return base;
    return base.filter((it) => applicable.every((f) => f.get(it).toLowerCase().includes(f.needle)));
  });
  const displayed = createMemo(() => {
    const dir = sortDir() === 'asc' ? 1 : -1;
    const key = sortKey();
    const val = (it: VaultItem): string => {
      switch (key) {
        case 'name':
          return it.name;
        case 'username':
          return it.username ?? '';
        case 'folder':
          return folderNameOf(it.folderId);
        case 'type':
          return it.itemType;
      }
    };
    // Stable, case-insensitive, locale-aware; empty values sort last.
    return [...filtered()].sort((a, b) => {
      const av = val(a);
      const bv = val(b);
      if (!av && bv) return 1;
      if (av && !bv) return -1;
      return dir * av.localeCompare(bv, undefined, { sensitivity: 'base' });
    });
  });
  const selectedCount = createMemo(() => selectedIds().size);

  // Click a column header: toggle direction if already sorted by it, else switch
  // to it ascending.
  function toggleSort(key: SortKey) {
    if (sortKey() === key) {
      setSortDir((d) => (d === 'asc' ? 'desc' : 'asc'));
    } else {
      setSortKey(key);
      setSortDir('asc');
    }
  }

  // Hover text for the header cloud icon — state plus last-success clock time.
  const syncTooltip = createMemo(() => {
    if (syncState() === 'syncing') return 'Syncing…';
    const ts = lastSync();
    const when = ts === null ? '' : ` (synced ${new Date(ts).toLocaleTimeString()})`;
    if (syncState() === 'error') return `Sync failed — click to retry${when}`;
    if (ts === null) return 'Not synced yet — click to sync';
    return `Live — click to sync now${when}`;
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

  async function loadConnections() {
    try {
      setConnections(await ipc.listConnections());
    } catch (err) {
      toastError(err);
    }
  }

  // The connection a freshly created item goes into: the scoped vault when one is
  // active and unlocked, otherwise any unlocked connection.
  const createAccount = () => {
    const av = activeVault();
    if (av && connections().some((c) => c.email === av && c.unlocked)) return av;
    return connections().find((c) => c.unlocked)?.email ?? connections()[0]?.email ?? '';
  };

  // Map an item id to its owning connection (the unified list mixes accounts).
  function accountFor(id: string): string {
    return items().find((it) => it.id === id)?.accountEmail ?? '';
  }

  // Group selected ids by owning connection, so bulk ops route per account.
  function groupByAccount(ids: string[]): Map<string, string[]> {
    const byId = new Map(items().map((it) => [it.id, it] as const));
    const groups = new Map<string, string[]>();
    for (const id of ids) {
      const acct = byId.get(id)?.accountEmail;
      if (!acct) continue;
      const arr = groups.get(acct) ?? [];
      arr.push(id);
      groups.set(acct, arr);
    }
    return groups;
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
    setCacheToken((t) => t + 1);
  }

  // Automatic background sync: once on open, then on a fixed interval. The cloud
  // icon in the header is the visible status.
  const AUTO_SYNC_MS = 5 * 60 * 1000;
  let autoSyncTimer: ReturnType<typeof setInterval> | undefined;
  onMount(() => {
    // Start each vault session with a clean search so a stale query (the field
    // now lives in the persistent titlebar) can't hide items on entry.
    setQuery('');
    // Show cached items immediately (instant on re-mounts / after a prior sync),
    // then refresh in the background — avoids a blank-then-populate flicker.
    void (async () => {
      await Promise.all([loadItems(), loadFolders(), loadConnections()]);
      await runSync(false);
    })();
    autoSyncTimer = setInterval(() => void runSync(false), AUTO_SYNC_MS);
  });
  onCleanup(() => {
    if (autoSyncTimer) clearInterval(autoSyncTimer);
    autoSyncTimer = undefined;
  });

  // Ctrl/Cmd-K toggles the command palette.
  function onGlobalKeyDown(e: KeyboardEvent) {
    if (e.key === 'Escape' && ctxMenu()) {
      setCtxMenu(null);
      return;
    }
    if ((e.ctrlKey || e.metaKey) && (e.key === 'k' || e.key === 'K')) {
      // Don't open the palette over an open editor — palette commands could
      // switch the editor state without it remounting, leaving stale values.
      if (editor().mode !== 'closed') return;
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
    const visible = displayed();
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
    const ids = [...selectedIds()];
    if (ids.length === 0) return;
    setMoveMenuOpen(false);
    try {
      if (folderId === null) {
        for (const [acct, gids] of groupByAccount(ids)) {
          await ipc.moveItems(acct, gids, null);
        }
      } else {
        // A folder belongs to one account; only move that account's selected items.
        const acct = folders().find((f) => f.id === folderId)?.accountEmail ?? '';
        const own = ids.filter((id) => accountFor(id) === acct);
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
    const ids = [...selectedIds()];
    if (ids.length === 0) return;
    try {
      for (const [acct, gids] of groupByAccount(ids)) {
        await ipc.deleteItems(acct, gids, permanent);
      }
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
      for (const [acct, gids] of groupByAccount(ids)) {
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
      await ipc.cloneItem(accountFor(id), id);
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
      setDetail(await ipc.itemDetail(d.accountEmail, d.id));
    } catch (err) {
      toastError(err);
    }
  }

  async function detailDelete(id: string, permanent: boolean) {
    try {
      await ipc.deleteItems(accountFor(id), [id], permanent);
      setSelectedId(null);
      await reloadAfterMutation();
      pushToast('success', permanent ? 'Item permanently deleted.' : 'Moved to trash.');
    } catch (err) {
      toastError(err);
    }
  }

  async function detailRestore(id: string) {
    try {
      const acct = accountFor(id);
      await ipc.restoreItems(acct, [id]);
      await reloadAfterMutation();
      setDetail(await ipc.itemDetail(acct, id));
      pushToast('success', 'Item restored.');
    } catch (err) {
      toastError(err);
    }
  }

  function openEdit(d: ItemDetail) {
    setEditor({ mode: 'edit', item: d });
  }

  // Cycle the header theme button through system -> light -> dark.
  function cycleTheme() {
    const idx = THEME_CYCLE.indexOf(theme());
    setTheme(THEME_CYCLE[(idx + 1) % THEME_CYCLE.length]);
  }

  // ---- row context-menu actions (operate on a single right-clicked item) ----
  // The list row only carries username/type; secrets live in the full detail, so
  // copy-password/-totp/-uri fetch the detail (or live code) on demand.
  function openCtxMenu(item: VaultItem, e: MouseEvent) {
    e.preventDefault();
    e.stopPropagation();
    // Clamp to the viewport so the menu never opens off-screen near an edge.
    const MENU_W = 210;
    const MENU_H = 360;
    const x = Math.min(e.clientX, window.innerWidth - MENU_W);
    const y = Math.min(e.clientY, window.innerHeight - MENU_H);
    setCtxMenu({ item, x: Math.max(8, x), y: Math.max(8, y) });
  }

  const closeCtxMenu = () => setCtxMenu(null);

  async function rowFavorite(item: VaultItem) {
    closeCtxMenu();
    try {
      await ipc.setFavorite(item.accountEmail, item.id, !item.favorite);
      await reloadAfterMutation();
      if (selectedId() === item.id) setDetail(await ipc.itemDetail(item.accountEmail, item.id));
    } catch (err) {
      toastError(err);
    }
  }

  async function rowEdit(item: VaultItem) {
    closeCtxMenu();
    try {
      openEdit(await ipc.itemDetail(item.accountEmail, item.id));
    } catch (err) {
      toastError(err);
    }
  }

  async function copyPasswordFor(item: VaultItem) {
    closeCtxMenu();
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
    closeCtxMenu();
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
    closeCtxMenu();
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
    closeCtxMenu();
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
    const state = editor();
    const wasEditing = state.mode === 'edit' ? state.item : null;
    setEditor({ mode: 'closed' });
    await reloadAfterMutation();
    if (wasEditing && selectedId() === wasEditing.id) {
      try {
        setDetail(await ipc.itemDetail(wasEditing.accountEmail, wasEditing.id));
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
      setTotp(await ipc.itemTotp(accountFor(id), id));
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
        const d = await ipc.itemDetail(accountFor(id), id);
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
      label: 'Open Security center',
      icon: Shield,
      run: () => setView('security'),
    });
    list.push({
      id: 'sync',
      label: 'Sync now',
      icon: RefreshCw,
      run: () => void sync(),
    });
    list.push({
      id: 'sync-status',
      label: 'Open Sync status',
      icon: Cloud,
      run: () => setView('sync'),
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
          selectFilter({ kind: 'all' });
          clearSelection();
          setSelectedId(it.id);
        },
      });
    }
    return list;
  });

  // Folders scoped to the active vault (all folders when no vault is selected) —
  // drives the rail folder tree and the bulk "move to folder" targets.
  const scopedFolders = createMemo(() => {
    const av = activeVault();
    return av ? folders().filter((f) => f.accountEmail === av) : folders();
  });
  const realFolders = createMemo(() => scopedFolders().filter((f) => f.id !== null));

  // If the scoped vault was removed (e.g. in Settings), fall back to all vaults so
  // the list can't silently show nothing with no way to recover.
  createEffect(() => {
    const av = activeVault();
    if (av && connections().length > 0 && !connections().some((c) => c.email === av)) {
      setActiveVault(null);
    }
  });

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

        <span class="spacer" />
        <button
          class="ghost icon-btn"
          title={syncTooltip()}
          disabled={syncState() === 'syncing'}
          onClick={() => void sync()}
        >
          <SyncIcon state={syncState()} lastSync={lastSync()} />
        </button>
        <button class="ghost icon-btn" title={THEME_META[theme()].label} onClick={cycleTheme}>
          <Switch fallback={<Monitor size={15} strokeWidth={1.75} />}>
            <Match when={theme() === 'light'}>
              <Sun size={15} strokeWidth={1.75} />
            </Match>
            <Match when={theme() === 'dark'}>
              <Moon size={15} strokeWidth={1.75} />
            </Match>
          </Switch>
        </button>
        <button class="ghost icon-btn" title="Settings" onClick={() => props.onOpenSettings()}>
          <SettingsIcon size={15} strokeWidth={1.75} />
        </button>
        <button class="ghost icon-btn" title="Lock" onClick={() => props.onLock()}>
          <Lock size={15} strokeWidth={1.75} />
        </button>
      </header>

      <div class="vault-body">
        <nav class="vault-rail" classList={{ collapsed: sidebarCollapsed() }}>
          <button
            class="vault-rail-collapse"
            title={sidebarCollapsed() ? 'Expand sidebar' : 'Collapse sidebar'}
            onClick={() => toggleSidebar()}
          >
            <Show when={sidebarCollapsed()} fallback={<PanelLeftClose size={16} strokeWidth={1.6} />}>
              <PanelLeftOpen size={16} strokeWidth={1.6} />
            </Show>
          </button>

          <Show when={connections().length > 1}>
            <VaultSwitcher
              connections={connections()}
              active={activeVault()}
              collapsed={sidebarCollapsed()}
              onSelect={switchVault}
            />
          </Show>

          <FilterButton
            label="All items"
            icon={File}
            active={view() === 'vault' && filterEq(filter(), { kind: 'all' })}
            onClick={() => selectFilter({ kind: 'all' })}
          />
          <FilterButton
            label="Favorites"
            icon={Star}
            active={view() === 'vault' && filterEq(filter(), { kind: 'favorites' })}
            onClick={() => selectFilter({ kind: 'favorites' })}
          />
          <FilterButton
            label="Trash"
            icon={Trash2}
            active={view() === 'vault' && filterEq(filter(), { kind: 'trash' })}
            onClick={() => selectFilter({ kind: 'trash' })}
          />
          <div class="vault-rail-sep" />
          <For each={TYPE_FILTERS}>
            {(tf) => (
              <FilterButton
                label={tf.label}
                icon={typeIcon(tf.type)}
                active={view() === 'vault' && filterEq(filter(), { kind: 'type', itemType: tf.type })}
                onClick={() => selectFilter({ kind: 'type', itemType: tf.type })}
              />
            )}
          </For>
          {/* Folders need their labels to be useful — hide the tree when collapsed. */}
          <Show when={!sidebarCollapsed()}>
            <FolderTree
              folders={scopedFolders()}
              active={view() === 'vault' ? filter() : { kind: 'all' }}
              onSelect={(f) => selectFilter(f)}
            />
          </Show>
          <div class="vault-rail-sep" />
          <FilterButton
            label="Generator"
            icon={Dices}
            active={view() === 'generator'}
            onClick={() => setView('generator')}
          />
          <FilterButton
            label="Security"
            icon={Shield}
            active={view() === 'security'}
            onClick={() => setView('security')}
          />
          <button
            class="vault-rail-btn"
            classList={{ active: view() === 'sync' }}
            title={sidebarCollapsed() ? 'Sync' : syncTooltip()}
            onClick={() => setView('sync')}
          >
            <SyncIcon state={syncState()} lastSync={lastSync()} />
            <span>Sync</span>
          </button>
        </nav>

        <Switch>
          <Match when={view() === 'security'}>
            <SecurityCenter
              onOpenItem={(id) => {
                selectFilter({ kind: 'all' });
                clearSelection();
                setSelectedId(id);
              }}
            />
          </Match>
          <Match when={view() === 'sync'}>
            <SyncStatus
              state={syncState()}
              lastSync={lastSync()}
              autoSyncMs={AUTO_SYNC_MS}
              onSync={() => void sync()}
            />
          </Match>
          <Match when={view() === 'generator'}>
            <GeneratorPage />
          </Match>
          <Match when={view() === 'vault'}>
            <>
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

          <VaultList
            items={displayed()}
            folders={folders()}
            sortKey={sortKey()}
            sortDir={sortDir()}
            onSort={toggleSort}
            selectedId={selectedId()}
            selectedCount={selectedCount()}
            isSelected={(id) => selectedIds().has(id)}
            onRowClick={onRowClick}
            onRowContextMenu={openCtxMenu}
            onCheckboxToggle={onCheckboxToggle}
            emptyMessage={items().length === 0 ? 'Vault is empty or not synced.' : 'No matches.'}
            cacheToken={cacheToken()}
          />
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
            </>
          </Match>
        </Switch>
      </div>

      <Show when={editor().mode !== 'closed'}>
        {(() => {
          const state = editor();
          if (state.mode === 'closed') return null;
          return (
            <ItemEditor
              item={state.mode === 'edit' ? state.item : null}
              createType={state.mode === 'create' ? state.createType : undefined}
              accountEmail={state.mode === 'edit' ? state.item.accountEmail : createAccount()}
              folders={folders()}
              onSaved={() => void onEditorSaved()}
              onClose={() => setEditor({ mode: 'closed' })}
            />
          );
        })()}
      </Show>

      <Show when={ctxMenu()}>
        {(menu) => {
          const item = () => menu().item;
          const isLogin = () => item().itemType === 'login';
          return (
            <>
              <div
                class="vault-menu-backdrop"
                onClick={closeCtxMenu}
                onContextMenu={(e) => {
                  e.preventDefault();
                  closeCtxMenu();
                }}
              />
              <div
                class="vault-ctx"
                role="menu"
                style={{ left: menu().x + 'px', top: menu().y + 'px' }}
              >
                <div class="vault-ctx-title">{item().name}</div>
                <div class="vault-ctx-sep" />
                <Show when={item().username}>
                  <button
                    class="vault-ctx-item"
                    onClick={() => {
                      closeCtxMenu();
                      void copy('Username', item().username);
                    }}
                  >
                    <UserRound size={14} /> Copy username
                  </button>
                </Show>
                <Show when={isLogin()}>
                  <button class="vault-ctx-item" onClick={() => void copyPasswordFor(item())}>
                    <KeyRound size={14} /> Copy password
                  </button>
                </Show>
                <Show when={item().hasTotp}>
                  <button class="vault-ctx-item" onClick={() => void copyTotpFor(item())}>
                    <Timer size={14} /> Copy one-time code
                  </button>
                </Show>
                <Show when={isLogin()}>
                  <button class="vault-ctx-item" onClick={() => void copyUriFor(item())}>
                    <Copy size={14} /> Copy website
                  </button>
                  <button class="vault-ctx-item" onClick={() => void openSiteFor(item())}>
                    <ExternalLink size={14} /> Open website
                  </button>
                </Show>
                <div class="vault-ctx-sep" />
                <Show
                  when={!inTrash()}
                  fallback={
                    <>
                      <button
                        class="vault-ctx-item"
                        onClick={() => {
                          closeCtxMenu();
                          void detailRestore(item().id);
                        }}
                      >
                        <RotateCcw size={14} /> Restore
                      </button>
                      <button
                        class="vault-ctx-item danger"
                        onClick={() => {
                          closeCtxMenu();
                          void detailDelete(item().id, true);
                        }}
                      >
                        <Trash2 size={14} /> Delete permanently
                      </button>
                    </>
                  }
                >
                  <button class="vault-ctx-item" onClick={() => void rowFavorite(item())}>
                    <Star size={14} /> {item().favorite ? 'Unfavorite' : 'Favorite'}
                  </button>
                  <button class="vault-ctx-item" onClick={() => void rowEdit(item())}>
                    <Pencil size={14} /> Edit
                  </button>
                  <button
                    class="vault-ctx-item"
                    onClick={() => {
                      closeCtxMenu();
                      void detailClone(item().id);
                    }}
                  >
                    <Copy size={14} /> Clone
                  </button>
                  <div class="vault-ctx-sep" />
                  <button
                    class="vault-ctx-item danger"
                    onClick={() => {
                      closeCtxMenu();
                      void detailDelete(item().id, false);
                    }}
                  >
                    <Trash2 size={14} /> Move to trash
                  </button>
                </Show>
              </div>
            </>
          );
        }}
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
    <button
      class="vault-rail-btn"
      classList={{ active: props.active }}
      title={props.label}
      onClick={() => props.onClick()}
    >
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
