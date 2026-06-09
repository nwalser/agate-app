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
  EyeOff,
  Minus,
  PanelLeftClose,
  PanelLeftOpen,
  Pencil,
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
} from '../lib/sidebarConfig.ts';
import { viewIcon } from '../lib/viewIcons.ts';
import {
  addDivider,
  moveEntry,
  removeEntry,
  reorderEntry,
  sidebar,
  toggleHidden,
  visibleEntries,
} from '../state/sidebar.ts';
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
        onRename={(account, renames) => props.folderApplyRenames(account, renames, 'Folder renamed.')}
        onMove={(account, renames) => props.folderApplyRenames(account, renames, 'Folder moved.')}
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

  // Drag-to-reorder rail entries. Handlers guard on `dragId` so they only act
  // during a rail-entry drag — a vault-item drag (folder drops) is left alone.
  const [dragId, setDragId] = createSignal<string | null>(null);
  const [overId, setOverId] = createSignal<string | null>(null);
  function dropOn(targetId: string) {
    const from = dragId();
    if (from && from !== targetId) {
      const order = sidebar().order;
      const fi = order.indexOf(from);
      const ti = order.indexOf(targetId);
      if (fi >= 0 && ti >= 0) reorderEntry(fi, ti);
    }
    setDragId(null);
    setOverId(null);
  }

  const builtin = (id: SidebarBuiltinId, onCtx: (e: MouseEvent) => void): JSX.Element => {
    if (id === 'folders') return folders();
    if (id === 'sync') {
      return (
        <button
          class="vault-rail-btn"
          classList={{ active: props.view === 'sync' }}
          title={props.sidebarCollapsed ? 'Sync' : props.syncTooltip}
          onClick={() => props.setView('sync')}
          onContextMenu={onCtx}
        >
          <SyncIcon state={props.syncState} lastSync={props.lastSync} />
          <span>Sync</span>
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
        title={props.sidebarCollapsed ? 'Expand sidebar' : 'Collapse sidebar'}
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
          return (
            <div
              class="vault-rail-entry"
              classList={{
                'rail-dragging': dragId() === id,
                'rail-dropover': overId() === id && dragId() !== null && dragId() !== id,
              }}
              draggable={true}
              onDragStart={(e) => {
                setDragId(id);
                if (e.dataTransfer) {
                  e.dataTransfer.effectAllowed = 'move';
                  e.dataTransfer.setData('text/plain', id);
                }
              }}
              onDragOver={(e) => {
                if (dragId() === null) return; // not a rail-entry drag — ignore
                e.preventDefault();
                setOverId(id);
                if (e.dataTransfer) e.dataTransfer.dropEffect = 'move';
              }}
              onDrop={(e) => {
                if (dragId() === null) return;
                e.preventDefault();
                dropOn(id);
              }}
              onDragEnd={() => {
                setDragId(null);
                setOverId(null);
              }}
            >
              {inner}
            </div>
          );
        }}
      </For>

      {/* Push Settings to the bottom of the rail. */}
      <div class="vault-rail-spacer" />
      <div class="vault-rail-sep" />
      <FilterButton label="Settings" icon={SettingsIcon} active={false} onClick={() => props.onOpenSettings()} />

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
                <ArrowUp size={14} /> Move up
              </CtxItem>
              <CtxItem
                disabled={idx() < 0 || idx() >= sidebar().order.length - 1}
                onClick={act(() => moveEntry(idx(), 1))}
              >
                <ArrowDown size={14} /> Move down
              </CtxItem>
              <Show when={!isDividerId(id())}>
                <CtxItem onClick={act(() => toggleHidden(id()))}>
                  <EyeOff size={14} /> Hide
                </CtxItem>
              </Show>
              <CtxItem onClick={act(() => addDivider(idx() + 1))}>
                <Minus size={14} /> Add divider below
              </CtxItem>
              <Show when={isQueryId(id())}>
                <CtxSep />
                <CtxItem onClick={act(() => props.onOpenSettings())}>
                  <Pencil size={14} /> Edit view
                </CtxItem>
                <CtxItem danger onClick={act(() => removeEntry(id()))}>
                  <Trash2 size={14} /> Delete view
                </CtxItem>
              </Show>
              <Show when={isDividerId(id())}>
                <CtxItem danger onClick={act(() => removeEntry(id()))}>
                  <Trash2 size={14} /> Remove divider
                </CtxItem>
              </Show>
              <CtxSep />
              <CtxItem onClick={act(() => props.onOpenSettings())}>
                <SettingsIcon size={14} /> Sidebar settings…
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
          `Security score ${r().score}/100 · ${count()} at-risk item${count() === 1 ? '' : 's'}`;
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
