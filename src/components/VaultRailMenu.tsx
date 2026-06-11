// Left navigation rail for the vault screen: collapse toggle and a
// user-customizable list of entries — the All/Favorites/Trash + per-type
// filters, the scoped folder tree, the Generator / Security / Sync entries, and
// any saved custom queries. Order and visibility come from the sidebar store
// (state/sidebar.ts); Settings stays pinned at the bottom. (The connection
// switcher now lives in the titlebar.) It only renders + raises intent (which
// filter, which view, which saved query, folder edits); the screen owns the
// actual state and IPC. The Security entry carries an at-risk badge read off the
// offline health audit.

import { For, type JSX, Show, createSignal } from 'solid-js';
import {
  ArrowDown,
  ArrowUp,
  Check,
  CopyPlus,
  EyeOff,
  Minus,
  PanelLeftClose,
  PanelLeftOpen,
  Pencil,
  Play,
  Save,
  Settings as SettingsIcon,
  Trash2,
} from 'lucide-solid';
import type { IconComponent } from '../lib/icon.ts';
import type { Folder, HealthBand, VaultHealthReport, VaultItem } from '../lib/types.ts';
import type { VaultFilter } from '../lib/search.ts';
import { type VaultView, filterEq } from '../lib/vaultConfig.ts';
import {
  builtinFilter,
  entryMeta,
  isDividerId,
  isQueryId,
  type CustomQuery,
  type SidebarBuiltinId,
  type SidebarEntry,
} from '../lib/sidebarConfig.ts';
import { viewIcon } from '../lib/viewIcons.ts';
import {
  addDivider,
  duplicateQuery,
  moveEntry,
  queryById,
  removeEntry,
  reorderEntryByIds,
  sidebar,
  toggleHidden,
  visibleEntries,
} from '../state/sidebar.ts';
import { useDragReorder } from '../hooks/useDragReorder.ts';
import { t } from '../lib/i18n.ts';
import FolderTree from './FolderTree.tsx';
import { ContextMenu, CtxItem, CtxSep } from './ContextMenu.tsx';
import { SyncIcon, type SyncState } from './SyncStatus.tsx';

export default function VaultRailMenu(props: {
  view: VaultView;
  filter: VaultFilter;
  sidebarCollapsed: boolean;
  toggleSidebar: () => void;
  selectFilter: (f: VaultFilter) => void;
  onRunQuery: (q: CustomQuery) => void;
  /** Id of the saved view currently being shown (drives the active highlight). */
  activeViewId: string | null;
  /** Whether the live list has diverged from the active view's saved snapshot —
   *  gates the "Update to current list" context action. */
  viewDirty: boolean;
  /** Overwrite the active view with the current list state (filter/search/columns/
   *  sort). Only meaningful for the view whose id equals `activeViewId`. */
  onSaveView: () => void;
  scopedFolders: Folder[];
  items: VaultItem[];
  folderCreate: (account: string, fullName: string) => void;
  folderApplyRenames: (account: string, renames: { id: string; newName: string }[], done: string) => void;
  folderDelete: (account: string, folderIds: string[], itemIds: string[]) => void;
  folderDropItems: (account: string, folderId: string, ids: string[]) => void;
  defaultAccount: string;
  health: VaultHealthReport | null;
  setView: (v: VaultView) => void;
  syncState: SyncState;
  lastSync: number | null;
  syncTooltip: string;
  onOpenSettings: () => void;
}) {
  // The folder-tree block (its own entry in the ordered rail). Folders need their
  // labels to be useful — hide the tree when the rail is collapsed.
  const folders = () => (
    <Show when={!props.sidebarCollapsed}>
      <FolderTree
        folders={props.scopedFolders}
        items={props.items}
        active={props.view === 'vault' ? props.filter : { kind: 'all' }}
        onSelect={(f) => props.selectFilter(f)}
        onCreate={(account, fullName) => props.folderCreate(account, fullName)}
        onRename={(account, renames) => props.folderApplyRenames(account, renames, t('menu.folderRenamed'))}
        onMove={(account, renames) => props.folderApplyRenames(account, renames, t('menu.folderMoved'))}
        onDelete={(account, folderIds, itemIds) => props.folderDelete(account, folderIds, itemIds)}
        onDropItems={(account, folderId, ids) => props.folderDropItems(account, folderId, ids)}
        defaultAccount={props.defaultAccount}
      />
    </Show>
  );

  // Right-click menu for a rail entry (operates on its position in the full order).
  const [entryMenu, setEntryMenu] = createSignal<{ id: string; x: number; y: number } | null>(null);
  function openEntryMenu(e: MouseEvent, id: string) {
    e.preventDefault();
    e.stopPropagation();
    setEntryMenu({ id, x: e.clientX, y: e.clientY });
  }

  // Drag-to-reorder rail entries via the shared gap-model hook: the painted
  // insert line IS the landing spot (the old drop-on-row model disagreed with
  // its indicator half the time). The hook ignores foreign drags (item→folder).
  // Indices run over the DRAGGABLE subset of visible entries — the folder-tree
  // block opts out (it owns its own DnD) — and the drop resolves to ids, so
  // hidden entries between visible neighbours can't skew where the entry lands.
  const entryId = (e: SidebarEntry) => (e.kind === 'query' ? e.query.id : e.id);
  const draggableEntries = () =>
    visibleEntries().filter((e) => !(e.kind === 'builtin' && e.id === 'folders'));
  const reorder = useDragReorder({
    onReorder: (from, to) => {
      const ids = draggableEntries().map(entryId);
      const fromId = ids[from];
      if (fromId === undefined) return;
      ids.splice(from, 1);
      reorderEntryByIds(fromId, ids[to] ?? null);
    },
  });

  const builtin = (id: SidebarBuiltinId, onCtx: (e: MouseEvent) => void): JSX.Element => {
    if (id === 'folders') return folders();
    if (id === 'sync') {
      return (
        <button
          class="vault-rail-btn"
          classList={{ active: props.view === 'sync' }}
          title={props.sidebarCollapsed ? t('menu.sync') : props.syncTooltip}
          onClick={() => props.setView('sync')}
          onContextMenu={onCtx}
        >
          <SyncIcon state={props.syncState} lastSync={props.lastSync} />
          <span>{t('menu.sync')}</span>
        </button>
      );
    }
    const meta = entryMeta(id);
    if (id === 'security') {
      return (
        <FilterButton
          label={meta.label}
          icon={meta.icon}
          active={props.view === 'security'}
          onClick={() => props.setView('security')}
          onContextMenu={onCtx}
          badge={<SecurityRailBadge report={props.health} />}
        />
      );
    }
    if (id === 'generator') {
      return (
        <FilterButton
          label={meta.label}
          icon={meta.icon}
          active={props.view === 'generator'}
          onClick={() => props.setView('generator')}
          onContextMenu={onCtx}
        />
      );
    }
    if (id === 'sends') {
      return (
        <FilterButton
          label={meta.label}
          icon={meta.icon}
          active={props.view === 'sends'}
          onClick={() => props.setView('sends')}
          onContextMenu={onCtx}
        />
      );
    }
    if (id === 'atRisk') {
      // A filter view (not the Security center), carrying the same at-risk badge.
      const f = builtinFilter(id);
      return (
        <FilterButton
          label={meta.label}
          icon={meta.icon}
          active={props.view === 'vault' && f !== null && filterEq(props.filter, f)}
          onClick={() => f && props.selectFilter(f)}
          onContextMenu={onCtx}
          badge={<SecurityRailBadge report={props.health} />}
        />
      );
    }
    // Filter builtins: All / Favorites / Trash / per-type.
    const f = builtinFilter(id);
    return (
      <FilterButton
        label={meta.label}
        icon={meta.icon}
        active={props.view === 'vault' && f !== null && filterEq(props.filter, f)}
        onClick={() => f && props.selectFilter(f)}
        onContextMenu={onCtx}
      />
    );
  };

  return (
    <nav class="vault-rail" classList={{ collapsed: props.sidebarCollapsed }}>
      <button
        class="vault-rail-collapse"
        title={props.sidebarCollapsed ? t('menu.expandSidebar') : t('menu.collapseSidebar')}
        onClick={() => props.toggleSidebar()}
      >
        <Show when={props.sidebarCollapsed} fallback={<PanelLeftClose size={16} strokeWidth={1.6} />}>
          <PanelLeftOpen size={16} strokeWidth={1.6} />
        </Show>
      </button>

      <For each={visibleEntries()}>
        {(entry) => {
          const inner =
            entry.kind === 'divider' ? (
              // A labeled divider renders as a section header; unlabeled (or when the
              // rail is collapsed, where text is useless) it's a plain rule.
              <Show
                when={entry.label && !props.sidebarCollapsed}
                fallback={<div class="vault-rail-sep" onContextMenu={(e) => openEntryMenu(e, entry.id)} />}
              >
                <div class="vault-rail-divider-label" onContextMenu={(e) => openEntryMenu(e, entry.id)}>
                  {entry.label}
                </div>
              </Show>
            ) : entry.kind === 'query' ? (
              <FilterButton
                label={entry.query.name}
                icon={viewIcon(entry.query.icon)}
                active={props.view === 'vault' && props.activeViewId === entry.query.id}
                onClick={() => props.onRunQuery(entry.query)}
                onContextMenu={(e) => openEntryMenu(e, entry.query.id)}
              />
            ) : (
              builtin(entry.id, (e) => openEntryMenu(e, entry.id))
            );
          // The folder-tree block owns its own drag-and-drop (folder reparenting +
          // item drops), so it opts out of rail-entry reordering — move it with the
          // arrows / context menu instead.
          if (entry.kind === 'builtin' && entry.id === 'folders') return inner;
          const id = entry.kind === 'query' ? entry.query.id : entry.id;
          // Index within the draggable subset, read at event time (stays correct
          // after the list reorders, like reading <For>'s own index accessor).
          const dIdx = () => draggableEntries().findIndex((x) => entryId(x) === id);
          return (
            <div
              class="vault-rail-entry"
              classList={{
                'rail-dragging': reorder.dragIndex() === dIdx(),
                'rail-drop-above': reorder.dragIndex() !== null && reorder.gap() === dIdx(),
                'rail-drop-below':
                  reorder.dragIndex() !== null &&
                  dIdx() === draggableEntries().length - 1 &&
                  reorder.gap() === draggableEntries().length,
              }}
              {...reorder.handleProps(dIdx)}
              {...reorder.rowProps(dIdx)}
            >
              {inner}
            </div>
          );
        }}
      </For>

      {/* Push Settings to the bottom of the rail. */}
      <div class="vault-rail-spacer" />
      <div class="vault-rail-sep" />
      <FilterButton label={t('menu.settings')} icon={SettingsIcon} active={false} onClick={() => props.onOpenSettings()} />

      <Show when={entryMenu()}>
        {(m) => {
          const id = () => m().id;
          const idx = () => sidebar().order.indexOf(id());
          const close = () => setEntryMenu(null);
          const act = (fn: () => void) => () => {
            fn();
            close();
          };
          return (
            <ContextMenu x={m().x} y={m().y} onClose={close}>
              <CtxItem disabled={idx() <= 0} onClick={act(() => moveEntry(idx(), -1))}>
                <ArrowUp size={14} /> {t('menu.moveUp')}
              </CtxItem>
              <CtxItem
                disabled={idx() < 0 || idx() >= sidebar().order.length - 1}
                onClick={act(() => moveEntry(idx(), 1))}
              >
                <ArrowDown size={14} /> {t('menu.moveDown')}
              </CtxItem>
              <Show when={!isDividerId(id())}>
                <CtxItem onClick={act(() => toggleHidden(id()))}>
                  <EyeOff size={14} /> {t('menu.hide')}
                </CtxItem>
              </Show>
              <CtxItem onClick={act(() => addDivider(idx() + 1))}>
                <Minus size={14} /> {t('menu.addDividerBelow')}
              </CtxItem>
              <Show when={isQueryId(id())}>
                <CtxSep />
                <CtxItem
                  onClick={act(() => {
                    const q = queryById(id());
                    if (q) props.onRunQuery(q);
                  })}
                >
                  <Play size={14} /> {t('menu.openView')}
                </CtxItem>
                <Show when={props.activeViewId === id()}>
                  <CtxItem disabled={!props.viewDirty} onClick={act(() => props.onSaveView())}>
                    <Save size={14} /> {t('menu.updateToCurrentList')}
                  </CtxItem>
                </Show>
                <CtxItem onClick={act(() => duplicateQuery(id()))}>
                  <CopyPlus size={14} /> {t('menu.duplicateView')}
                </CtxItem>
                <CtxItem onClick={act(() => props.onOpenSettings())}>
                  <Pencil size={14} /> {t('menu.editView')}
                </CtxItem>
                <CtxItem danger onClick={act(() => removeEntry(id()))}>
                  <Trash2 size={14} /> {t('menu.deleteView')}
                </CtxItem>
              </Show>
              <Show when={isDividerId(id())}>
                <CtxItem danger onClick={act(() => removeEntry(id()))}>
                  <Trash2 size={14} /> {t('menu.removeDivider')}
                </CtxItem>
              </Show>
              <CtxSep />
              <CtxItem onClick={act(() => props.onOpenSettings())}>
                <SettingsIcon size={14} /> {t('menu.sidebarSettings')}
              </CtxItem>
            </ContextMenu>
          );
        }}
      </Show>
    </nav>
  );
}

function FilterButton(props: {
  label: string;
  icon: IconComponent;
  active: boolean;
  onClick: () => void;
  onContextMenu?: (e: MouseEvent) => void;
  // Optional trailing element (e.g. the security audit badge).
  badge?: JSX.Element;
}) {
  const Icon = props.icon;
  return (
    <button
      class="vault-rail-btn"
      classList={{ active: props.active }}
      title={props.label}
      onClick={() => props.onClick()}
      onContextMenu={(e) => props.onContextMenu?.(e)}
    >
      <Icon size={15} strokeWidth={1.6} />
      <span>{props.label}</span>
      {props.badge}
    </button>
  );
}

// Rail-band → token colour. Mirrors SecurityCenter's bandColor so the badge and
// the Security center's score read the same severity.
function railBandColor(band: HealthBand): string {
  switch (band) {
    case 'critical':
    case 'poor':
      return 'var(--destructive)';
    case 'fair':
      return 'var(--warning)';
    case 'good':
      return 'var(--primary)';
    case 'excellent':
      return 'var(--success)';
  }
}

// Compact overview of the offline vault-health audit, shown on the Security rail
// item: the count of at-risk items (a check when clean), tinted by health band.
// Hidden until the first audit completes. Collapses to a coloured dot when the
// rail is collapsed (styled in Vault.css).
function SecurityRailBadge(props: { report: VaultHealthReport | null }) {
  return (
    <Show when={props.report}>
      {(r) => {
        const count = () => r().atRisk.length;
        const color = () => railBandColor(r().band);
        const title = () =>
          count() === 1
            ? t('menu.securityBadgeTitleOne', { score: r().score, count: count() })
            : t('menu.securityBadgeTitleOther', { score: r().score, count: count() });
        return (
          <span
            class="vault-rail-badge"
            classList={{ clean: count() === 0 }}
            style={{ color: color(), 'border-color': color() }}
            title={title()}
          >
            <Show when={count() > 0} fallback={<Check size={11} strokeWidth={3} />}>
              {count()}
            </Show>
          </span>
        );
      }}
    </Show>
  );
}
