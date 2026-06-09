// Vault screen — the thin orchestrator. It owns only the transient UI state that
// no hook needs to share (which main view is up, the inline-editor open-state, the
// add/move/palette/context menus, the open-item selection) and wires together the
// data, selection, filtering, detail, mutation, and command hooks. The heavy
// lifting lives in src/hooks/* and the VaultRailMenu / VaultDetailPane /
// VaultContextMenu subcomponents; this file switches views and threads props.

import { For, createEffect, createMemo, createSignal, onCleanup, onMount, Match, Show, Switch } from 'solid-js';
import { Plus, PanelRightClose, PanelRightOpen, RotateCcw, Star, Trash2, X, FolderInput } from 'lucide-solid';
import type { VaultItem } from '../lib/types.ts';
import { applyColumnConfig, columns, type ColumnSpec } from '../state/columns.ts';
import { filters, setAllColumnFilters, showColumnFilters } from '../state/columnFilters.ts';
import type { VaultFilter } from '../lib/search.ts';
import type { CustomQuery, SavedFilter, ViewConfig } from '../lib/sidebarConfig.ts';
import { queryById, updateQuery } from '../state/sidebar.ts';
import { sameViewConfig } from '../lib/viewConfig.ts';
import { query, setQuery } from '../state/search.ts';
import { clearConnectionNav, setConnectionNav } from '../state/connections.ts';
import { recordRecent } from '../state/recentItems.ts';
import { lastSync, syncState } from '../state/sync.ts';
import {
  activeVault,
  previewCollapsed,
  resetListWidth,
  resetSidebarWidth,
  rowDensity,
  setActiveVault,
  setListWidth,
  setSidebarWidth,
  sidebarCollapsed,
  toggleSidebar,
  togglePreview,
} from '../state/ui.ts';
import {
  AUTO_SYNC_MS,
  CREATE_TYPES,
  type EditorState,
  type VaultView,
  createLabel,
} from '../lib/vaultConfig.ts';
import { useVaultData } from '../hooks/useVaultData.ts';
import { useVaultFiltering } from '../hooks/useVaultFiltering.ts';
import { useVaultSelection } from '../hooks/useVaultSelection.ts';
import { useNavigationHistory } from '../hooks/useNavigationHistory.ts';
import type { NavLocation } from '../lib/navHistory.ts';
import { useItemDetail } from '../hooks/useItemDetail.ts';
import { useBulkActions } from '../hooks/useBulkActions.ts';
import { useVaultCommands } from '../hooks/useVaultCommands.ts';
import ItemEditor from '../components/ItemEditor.tsx';
import SecurityCenter from '../components/SecurityCenter.tsx';
import SyncStatus from '../components/SyncStatus.tsx';
import CommandPalette from '../components/CommandPalette.tsx';
import VaultList from '../components/VaultList.tsx';
import GeneratorPage from '../components/GeneratorPage.tsx';
import VaultRailMenu from '../components/VaultRailMenu.tsx';
import Resizer from '../components/Resizer.tsx';
import VaultDetailPane from '../components/VaultDetailPane.tsx';
import VaultContextMenu, { type CtxMenuTarget } from '../components/VaultContextMenu.tsx';
import { typeIcon } from '../lib/vaultIcons.ts';
import { ipc } from '../lib/ipc.ts';
import './Vault.css';

export default function Vault(props: { onLock: () => void; onOpenSettings: () => void }) {
  // The open item (detail pane). Lives here because selection, detail, and the
  // mutation hooks all read/write it.
  const [selectedId, setSelectedId] = createSignal<string | null>(null);

  // Which main view occupies the body: the vault list/detail, the security center,
  // sync status, or the generator. The rail stays visible in every view.
  const [view, setView] = createSignal<VaultView>('vault');

  // Editor (rendered inline in the detail pane) + menus.
  const [editor, setEditor] = createSignal<EditorState>({ mode: 'closed' });
  const [addMenuOpen, setAddMenuOpen] = createSignal(false);
  const [moveMenuOpen, setMoveMenuOpen] = createSignal(false);
  const [paletteOpen, setPaletteOpen] = createSignal(false);

  // Right-click context menu: the target item plus the cursor anchor, or null.
  const [ctxMenu, setCtxMenu] = createSignal<CtxMenuTarget | null>(null);

  // ---- hooks: data → filtering → selection → detail → mutations → commands ----
  const data = useVaultData();
  const filtering = useVaultFiltering({ items: data.items, folders: data.folders, health: data.health });
  const selection = useVaultSelection({
    displayed: filtering.displayed,
    setSelectedId,
    closeMoveMenu: () => setMoveMenuOpen(false),
  });
  const detailState = useItemDetail({
    selectedId,
    accountFor: data.accountFor,
    health: data.health,
    inTrash: filtering.inTrash,
  });
  const actions = useBulkActions({
    items: data.items,
    folders: data.folders,
    accountFor: data.accountFor,
    groupByAccount: data.groupByAccount,
    runSync: data.runSync,
    selectedIds: selection.selectedIds,
    clearSelection: selection.clearSelection,
    setMoveMenuOpen,
    selectedId,
    setSelectedId,
    setDetail: detailState.setDetail,
    filter: filtering.filter,
    setFilter: filtering.setFilter,
    editor,
    setEditor,
    showVaultView: () => setView('vault'),
  });

  // ---- saved views (full-snapshot, edited while viewing) ----
  // Which saved view (if any) the list is currently showing. Set when a view is
  // run; cleared when the user navigates to a plain rail page or switches vault.
  const [activeViewId, setActiveViewId] = createSignal<string | null>(null);
  const activeView = createMemo(() => {
    const id = activeViewId();
    return id ? queryById(id) : null;
  });

  // A view stores a portable SavedFilter; the live filter may be a folder filter
  // (account-scoped), which a view can't represent → capture it as "all".
  function toSavedFilter(f: VaultFilter): SavedFilter {
    if (f.kind === 'type') return { kind: 'type', itemType: f.itemType };
    if (f.kind === 'favorites' || f.kind === 'trash') return { kind: f.kind };
    return { kind: 'all' };
  }

  // Snapshot the whole list configuration into a ViewConfig.
  function captureView(): ViewConfig {
    return {
      filter: toSavedFilter(filtering.filter()),
      query: query(),
      columnFilters: { ...filters() },
      columns: columns(),
      sort: { key: filtering.sortKey(), dir: filtering.sortDir() },
    };
  }

  // Restore a ViewConfig onto the live list (only the parts it carries).
  function applyView(cfg: ViewConfig) {
    filtering.setFilter(cfg.filter);
    setQuery(cfg.query);
    setAllColumnFilters(cfg.columnFilters);
    if (Object.keys(cfg.columnFilters).length > 0) showColumnFilters(true);
    if (cfg.columns) applyColumnConfig(cfg.columns);
    if (cfg.sort) filtering.setSort(cfg.sort.key, cfg.sort.dir);
  }

  // True when the live list has diverged from the active view's saved snapshot.
  const viewDirty = createMemo(() => {
    const v = activeView();
    return v ? !sameViewConfig(captureView(), v.config) : false;
  });

  function saveActiveView() {
    const v = activeView();
    if (v) updateQuery(v.id, { config: captureView() });
  }
  function discardViewChanges() {
    const v = activeView();
    if (v) applyView(v.config);
  }

  // Switch a rail filter and return to the vault view in one step (leaves any view).
  function selectFilter(f: VaultFilter) {
    setView('vault');
    setActiveViewId(null);
    filtering.setFilter(f);
  }

  // Copy a single list cell's value. Secret columns (password/TOTP) and custom
  // fields pull the freshly-decrypted detail; plain columns copy the row value.
  function copyCell(item: VaultItem, col: ColumnSpec) {
    if (col.kind === 'custom') {
      void actions.copyFieldFor(item, col.field);
      return;
    }
    switch (col.id) {
      case 'username':
        void actions.copy('Username', item.username);
        break;
      case 'website':
        void actions.copy('Website', item.uri);
        break;
      case 'folder':
        void actions.copy('Folder', filtering.folderNameOf(item.folderId));
        break;
      case 'password':
        void actions.copyPasswordFor(item);
        break;
      case 'totp':
        void actions.copyTotpFor(item);
        break;
      default:
        break; // type / security / passkey aren't copyable values
    }
  }

  // Open a saved view: apply its full snapshot and mark it active (so edits to the
  // list surface the "unsaved changes" bar against this view).
  function runQuery(q: CustomQuery) {
    setView('vault');
    applyView(q.config);
    setActiveViewId(q.id);
  }

  // Switch which connection the list is scoped to (null = all vaults merged).
  // Records the choice, returns to the vault view, and (for a specific, unlocked
  // connection) makes it the backend's default target for new items.
  function switchVault(email: string | null) {
    setActiveVault(email);
    setView('vault');
    setActiveViewId(null);
    // A folder filter belongs to one account, so switching vaults invalidates it.
    if (filtering.filter().kind === 'folder') filtering.setFilter({ kind: 'all' });
    selection.clearSelection();
    setSelectedId(null);
    if (email)
      void ipc.setActiveConnection(email).catch(() => {
        // ignore: a locked connection can't be the active target; filter still applies
      });
  }

  // Publish the connection list + switch handler so the titlebar's connection
  // dropdown (outside this tree, in App.tsx) can switch vaults. Re-runs as the
  // connection list changes; cleared when the Vault unmounts (lock / logout).
  createEffect(() => {
    setConnectionNav({ connections: data.connections(), switchVault });
  });
  onCleanup(clearConnectionNav);

  // Reveal a single item: switch to the all-items vault view and select it.
  // Shared by the command palette, the titlebar search, and the security center.
  function openItem(id: string) {
    selectFilter({ kind: 'all' });
    selection.clearSelection();
    setSelectedId(id);
    recordRecent(id);
  }

  // ---- back/forward navigation history ----
  // The user's current spot, tracked so each distinct (view, filter, vault, item)
  // is recorded and can be restored by the mouse side buttons or Alt+Arrow.
  const navLocation = (): NavLocation => ({
    view: view(),
    filter: filtering.filter(),
    activeVault: activeVault(),
    selectedId: selectedId(),
  });

  // Restore a recorded spot. Mirrors switchVault's active-connection side effect
  // so a restored vault scope is again the backend's target for new items.
  function applyNavLocation(loc: NavLocation) {
    setView(loc.view);
    filtering.setFilter(loc.filter);
    if (loc.activeVault !== activeVault()) {
      setActiveVault(loc.activeVault);
      if (loc.activeVault)
        void ipc.setActiveConnection(loc.activeVault).catch(() => {
          // ignore: a locked connection can't be the active target; filter still applies
        });
    }
    selection.clearSelection();
    setSelectedId(loc.selectedId);
  }

  const nav = useNavigationHistory({ current: navLocation, apply: applyNavLocation });

  // Move the open-item selection through the list by keyboard. Clears any
  // multi-selection (arrowing is single-item browsing) and scrolls the row in.
  function moveSelection(key: 'ArrowDown' | 'ArrowUp' | 'Home' | 'End') {
    const list = filtering.displayed();
    if (list.length === 0) return;
    const cur = selectedId();
    const idx = cur ? list.findIndex((it) => it.id === cur) : -1;
    let next: number;
    if (key === 'Home') next = 0;
    else if (key === 'End') next = list.length - 1;
    else if (idx === -1) next = key === 'ArrowDown' ? 0 : list.length - 1;
    else if (key === 'ArrowDown') next = Math.min(list.length - 1, idx + 1);
    else next = Math.max(0, idx - 1);
    selection.clearSelection();
    setSelectedId(list[next].id);
    requestAnimationFrame(() => {
      document.querySelector('.vault-list .vault-row.active')?.scrollIntoView({ block: 'nearest' });
    });
  }

  const commands = useVaultCommands({
    items: data.items,
    openCreate: actions.openCreate,
    setView,
    sync: data.sync,
    openItem,
    onLock: props.onLock,
    onOpenSettings: props.onOpenSettings,
  });

  // Resolved props for the inline editor, or null when closed. A fresh object on
  // every open/switch makes the keyed <Show> remount the form so its field
  // signals re-init (e.g. editing item A then item B).
  const editorView = createMemo(() => {
    const s = editor();
    if (s.mode === 'closed') return null;
    return {
      item: s.mode === 'edit' ? s.item : null,
      createType: s.mode === 'create' ? s.createType : undefined,
      accountEmail: s.mode === 'edit' ? s.item.accountEmail : data.createAccount(),
    };
  });

  // The current list page's type, if it's a type page (Logins/Cards/…). Drives
  // the per-page Add button: a type page adds that type directly; All / Favorites
  // / folders fall back to the type-picker menu.
  const addType = filtering.addType;

  // Hover text for the header cloud icon — state plus last-success clock time.
  const syncTooltip = createMemo(() => {
    if (syncState() === 'syncing') return 'Syncing…';
    const ts = lastSync();
    const when = ts === null ? '' : ` (synced ${new Date(ts).toLocaleTimeString()})`;
    if (syncState() === 'error') return `Sync failed — click to retry${when}`;
    if (ts === null) return 'Not synced yet — click to sync';
    return `Live — click to sync now${when}`;
  });

  // ---- row context-menu open/close (positioning owned here) ----
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

  // True while the user is typing in a field — then arrows/Alt+Arrow belong to
  // that field (search, editor), not to list or history navigation.
  function isTypingTarget(e: Event): boolean {
    const t = e.target as HTMLElement | null;
    if (!t) return false;
    return (
      t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.tagName === 'SELECT' || t.isContentEditable
    );
  }

  // Ctrl/Cmd-K toggles the command palette; Alt+Arrow walks history; arrows +
  // Home/End move the open item in the vault list.
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
      return;
    }
    // Back/forward through navigation history (standard Alt+Arrow), unless a
    // field owns the keys.
    if (e.altKey && !isTypingTarget(e) && (e.key === 'ArrowLeft' || e.key === 'ArrowRight')) {
      e.preventDefault();
      if (e.key === 'ArrowLeft') nav.back();
      else nav.forward();
      return;
    }
    // List navigation: only in the vault list, and not while typing or an
    // overlay (palette / context or add/move menus / editor) is up.
    if (
      view() === 'vault' &&
      editor().mode === 'closed' &&
      !paletteOpen() &&
      !ctxMenu() &&
      !addMenuOpen() &&
      !moveMenuOpen() &&
      !isTypingTarget(e) &&
      (e.key === 'ArrowDown' || e.key === 'ArrowUp' || e.key === 'Home' || e.key === 'End')
    ) {
      e.preventDefault();
      moveSelection(e.key);
    }
  }

  // Mouse side buttons: button 3 = back, button 4 = forward (the X1/X2 buttons).
  function onGlobalMouseDown(e: MouseEvent) {
    if (e.button === 3) {
      e.preventDefault();
      nav.back();
    } else if (e.button === 4) {
      e.preventDefault();
      nav.forward();
    }
  }

  onMount(() => {
    document.addEventListener('keydown', onGlobalKeyDown);
    document.addEventListener('mousedown', onGlobalMouseDown);
  });
  onCleanup(() => {
    document.removeEventListener('keydown', onGlobalKeyDown);
    document.removeEventListener('mousedown', onGlobalMouseDown);
  });

  return (
    <div class="vault">
      <div class="vault-body">
        <VaultRailMenu
          view={view()}
          filter={filtering.filter()}
          sidebarCollapsed={sidebarCollapsed()}
          toggleSidebar={() => toggleSidebar()}
          selectFilter={selectFilter}
          onRunQuery={runQuery}
          activeViewId={activeViewId()}
          scopedFolders={filtering.scopedFolders()}
          items={data.items()}
          folderCreate={(account, fullName) => void actions.folderCreate(account, fullName)}
          folderApplyRenames={(account, renames, done) => void actions.folderApplyRenames(account, renames, done)}
          folderDelete={(account, folderIds, itemIds) => void actions.folderDelete(account, folderIds, itemIds)}
          folderDropItems={(account, folderId, ids) => void actions.moveIdsToFolder(account, folderId, ids)}
          defaultAccount={data.createAccount()}
          health={data.health()}
          setView={setView}
          syncState={syncState()}
          lastSync={lastSync()}
          syncTooltip={syncTooltip()}
          onOpenSettings={() => props.onOpenSettings()}
        />

        {/* Drag handle at the rail's right edge. Hidden when the rail is collapsed
            (it has its own fixed width then). */}
        <Show when={!sidebarCollapsed()}>
          <Resizer
            variant="sidebar-resizer"
            label="Resize sidebar"
            onResize={setSidebarWidth}
            onReset={resetSidebarWidth}
          />
        </Show>

        <Switch>
          <Match when={view() === 'security'}>
            <SecurityCenter onOpenItem={openItem} />
          </Match>
          <Match when={view() === 'sync'}>
            <SyncStatus
              state={syncState()}
              lastSync={lastSync()}
              autoSyncMs={AUTO_SYNC_MS}
              onSync={() => void data.sync()}
            />
          </Match>
          <Match when={view() === 'generator'}>
            <GeneratorPage />
          </Match>
          <Match when={view() === 'vault'}>
            <>
              <aside
                class="vault-list"
                classList={{ 'has-selection': selection.selectedCount() > 0, 'list-full': previewCollapsed() }}
                data-density={rowDensity()}
              >
                <Show when={viewDirty() && activeView()}>
                  {(v) => (
                    <div class="vault-view-bar">
                      <span class="vault-view-bar-text">
                        Unsaved changes to <strong>{v().name}</strong>
                      </span>
                      <span class="spacer" />
                      <button class="ghost vault-view-bar-btn" onClick={() => discardViewChanges()}>
                        Discard
                      </button>
                      <button class="vault-view-bar-btn primary" onClick={() => saveActiveView()}>
                        Save changes
                      </button>
                    </div>
                  )}
                </Show>
                <div class="vault-list-head">
                  <span class="vault-list-count">
                    {filtering.displayed().length} {filtering.displayed().length === 1 ? 'item' : 'items'}
                  </span>
                  <div class="vault-list-actions">
                    <button
                      class="ghost icon-btn"
                      aria-expanded={!previewCollapsed()}
                      title={previewCollapsed() ? 'Show details' : 'Hide details'}
                      onClick={() => togglePreview()}
                    >
                      <Show when={previewCollapsed()} fallback={<PanelRightClose size={16} strokeWidth={1.6} />}>
                        <PanelRightOpen size={16} strokeWidth={1.6} />
                      </Show>
                    </button>
                    <Show when={!filtering.inTrash()}>
                      <Show
                        when={addType()}
                        fallback={
                          <div class="vault-add-anchor">
                            <button class="vault-add" title="Add item" onClick={() => setAddMenuOpen((v) => !v)}>
                              <Plus size={15} strokeWidth={1.75} /> Add
                            </button>
                            <Show when={addMenuOpen()}>
                              <>
                                <div class="vault-menu-backdrop" onClick={() => setAddMenuOpen(false)} />
                                <div class="vault-menu align-right" role="menu">
                                  <For each={CREATE_TYPES}>
                                    {(ct) => {
                                      const Icon = typeIcon(ct.type);
                                      return (
                                        <button
                                          class="vault-menu-item"
                                          role="menuitem"
                                          onClick={() => {
                                            setAddMenuOpen(false);
                                            actions.openCreate(ct.type);
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
                        }
                      >
                        {(t) => (
                          <button
                            class="vault-add"
                            title={`Add ${createLabel(t()).toLowerCase()}`}
                            onClick={() => actions.openCreate(t())}
                          >
                            <Plus size={15} strokeWidth={1.75} /> Add {createLabel(t()).toLowerCase()}
                          </button>
                        )}
                      </Show>
                    </Show>
                  </div>
                </div>

                <VaultList
                  items={filtering.displayed()}
                  folders={data.folders()}
                  sortKey={filtering.sortKey()}
                  sortDir={filtering.sortDir()}
                  onSort={filtering.toggleSort}
                  selectedId={selectedId()}
                  selectedCount={selection.selectedCount()}
                  isSelected={selection.isSelected}
                  cursorId={selection.cursorId()}
                  onRowClick={selection.onRowClick}
                  onRowContextMenu={openCtxMenu}
                  onCheckboxToggle={selection.onCheckboxToggle}
                  onCopyCell={copyCell}
                  onListKeyDown={selection.handleListKeyDown}
                  onMarqueeSelect={selection.marqueeSelect}
                  enableItemDrag={filtering.filter().kind !== 'trash'}
                  onCreateItem={(type) => actions.openCreate(type)}
                  onSelectAll={selection.selectAll}
                  emptyMessage={data.items().length === 0 ? 'Vault is empty or not synced.' : 'No matches.'}
                  cacheToken={actions.cacheToken()}
                  security={data.health()}
                />

                {/* Floating multi-select action bar. Stays mounted; .is-hidden slides it
                    away so toggling selection never reflows the list (no layout shift). */}
                <div
                  class="vault-bulk"
                  classList={{ 'is-hidden': selection.selectedCount() === 0 }}
                  role="toolbar"
                  aria-label="Selection actions"
                >
                  <button
                    class="ghost icon-btn vault-bulk-clear"
                    title="Clear selection"
                    onClick={() => selection.clearSelection()}
                  >
                    <X size={15} strokeWidth={1.75} />
                  </button>
                  <span class="vault-bulk-count">{selection.selectedCount()} selected</span>
                  <span class="vault-bulk-sep" />
                  <Show
                    when={!filtering.inTrash()}
                    fallback={
                      <>
                        <button class="ghost vault-bulk-btn" title="Restore" onClick={() => void actions.bulkRestore()}>
                          <RotateCcw size={14} strokeWidth={1.6} /> Restore
                        </button>
                        <button
                          class="danger vault-bulk-btn"
                          title="Delete permanently"
                          onClick={() => void actions.bulkDelete(true)}
                        >
                          <Trash2 size={14} strokeWidth={1.6} /> Delete
                        </button>
                      </>
                    }
                  >
                    <button class="ghost vault-bulk-btn" title="Favorite" onClick={() => void actions.bulkFavorite()}>
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
                          <div class="vault-menu vault-menu-up" role="menu">
                            <button class="vault-menu-item" onClick={() => void actions.bulkMove(null)}>
                              No folder
                            </button>
                            <For each={filtering.realFolders()}>
                              {(f) => (
                                <button class="vault-menu-item" onClick={() => void actions.bulkMove(f.id)}>
                                  {f.name}
                                </button>
                              )}
                            </For>
                          </div>
                        </>
                      </Show>
                    </div>
                    <button
                      class="danger vault-bulk-btn"
                      title="Move to trash"
                      onClick={() => void actions.bulkDelete(false)}
                    >
                      <Trash2 size={14} strokeWidth={1.6} /> Delete
                    </button>
                  </Show>
                </div>

                {/* Drag handle at the list's right edge to resize the list ↔ detail
                    split. Only meaningful while the detail pane is shown; when it's
                    hidden the list spans the full width (no seam). */}
                <Show when={!previewCollapsed()}>
                  <Resizer
                    variant="list-resizer"
                    label="Resize item list"
                    onResize={setListWidth}
                    onReset={resetListWidth}
                  />
                </Show>
              </aside>

              {/* Detail (preview) pane. Hidden when the preview toggle is off, but always
                  shown while the inline editor is open so an edit is never stranded. */}
              <Show when={!previewCollapsed() || editor().mode !== 'closed'}>
                <section class="vault-detail" classList={{ 'vault-detail-editing': editor().mode !== 'closed' }}>
                  <Show when={editorView()} keyed>
                    {(v) => (
                      <ItemEditor
                        item={v.item}
                        createType={v.createType}
                        accountEmail={v.accountEmail}
                        folders={data.folders()}
                        onSaved={() => void actions.onEditorSaved()}
                        onClose={() => setEditor({ mode: 'closed' })}
                      />
                    )}
                  </Show>
                  <Show
                    when={editor().mode === 'closed' && detailState.detail()}
                    fallback={
                      editor().mode === 'closed' ? (
                        <div class="vault-detail-empty muted">Select an item to view its details.</div>
                      ) : null
                    }
                  >
                    {(d) => (
                      <VaultDetailPane
                        detail={d()}
                        inTrash={filtering.inTrash()}
                        revealed={detailState.revealed()}
                        setRevealed={detailState.setRevealed}
                        totp={detailState.totp()}
                        selectedSecurity={detailState.selectedSecurity()}
                        selectedBreaches={detailState.selectedBreaches()}
                        copy={(label, value) => void actions.copy(label, value)}
                        onFavorite={(item) => void actions.detailFavorite(item)}
                        onEdit={(item) => actions.openEdit(item)}
                        onClone={(id) => void actions.detailClone(id)}
                        onDelete={(id, permanent) => void actions.detailDelete(id, permanent)}
                        onRestore={(id) => void actions.detailRestore(id)}
                      />
                    )}
                  </Show>
                </section>
              </Show>
            </>
          </Match>
        </Switch>
      </div>

      <Show when={ctxMenu()}>
        {(menu) => (
          <VaultContextMenu
            menu={menu()}
            inTrash={filtering.inTrash()}
            onClose={closeCtxMenu}
            copyUsername={(item) => void actions.copy('Username', item.username)}
            copyPasswordFor={(item) => void actions.copyPasswordFor(item)}
            copyTotpFor={(item) => void actions.copyTotpFor(item)}
            copyUriFor={(item) => void actions.copyUriFor(item)}
            openSiteFor={(item) => void actions.openSiteFor(item)}
            rowFavorite={(item) => void actions.rowFavorite(item)}
            rowEdit={(item) => void actions.rowEdit(item)}
            detailClone={(id) => void actions.detailClone(id)}
            detailDelete={(id, permanent) => void actions.detailDelete(id, permanent)}
            detailRestore={(id) => void actions.detailRestore(id)}
          />
        )}
      </Show>

      <CommandPalette open={paletteOpen()} onClose={() => setPaletteOpen(false)} commands={commands.commands()} />
    </div>
  );
}
