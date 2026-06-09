// Left navigation rail for the vault screen: collapse toggle, the vault switcher
// (when more than one connection), the All/Favorites/Trash + per-type filters,
// the scoped folder tree, and the Generator / Security / Sync / Settings entries.
// It only renders + raises intent (which filter, which view, folder edits); the
// screen owns the actual state and IPC. The Security entry carries an at-risk
// badge read off the offline health audit.

import { For, type JSX, Show } from 'solid-js';
import {
  Dices,
  File,
  PanelLeftClose,
  PanelLeftOpen,
  Settings as SettingsIcon,
  Shield,
  Star,
  Trash2,
  Check,
} from 'lucide-solid';
import type { IconComponent } from '../lib/icon.ts';
import type { ConnectionSummary, Folder, HealthBand, VaultHealthReport, VaultItem } from '../lib/types.ts';
import type { VaultFilter } from '../lib/search.ts';
import { typeIcon } from '../lib/vaultIcons.ts';
import { TYPE_FILTERS, type VaultView, filterEq } from '../lib/vaultConfig.ts';
import FolderTree from './FolderTree.tsx';
import VaultSwitcher from './VaultSwitcher.tsx';
import { SyncIcon, type SyncState } from './SyncStatus.tsx';

export default function VaultRailMenu(props: {
  view: VaultView;
  filter: VaultFilter;
  sidebarCollapsed: boolean;
  toggleSidebar: () => void;
  connections: ConnectionSummary[];
  activeVault: string | null;
  switchVault: (email: string | null) => void;
  selectFilter: (f: VaultFilter) => void;
  scopedFolders: Folder[];
  items: VaultItem[];
  folderCreate: (account: string, fullName: string) => void;
  folderApplyRenames: (account: string, renames: { id: string; newName: string }[], done: string) => void;
  folderDelete: (account: string, folderIds: string[], itemIds: string[]) => void;
  defaultAccount: string;
  health: VaultHealthReport | null;
  setView: (v: VaultView) => void;
  syncState: SyncState;
  lastSync: number | null;
  syncTooltip: string;
  onOpenSettings: () => void;
}) {
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

      <Show when={props.connections.length > 1}>
        <VaultSwitcher
          connections={props.connections}
          active={props.activeVault}
          collapsed={props.sidebarCollapsed}
          onSelect={props.switchVault}
        />
      </Show>

      <FilterButton
        label="All items"
        icon={File}
        active={props.view === 'vault' && filterEq(props.filter, { kind: 'all' })}
        onClick={() => props.selectFilter({ kind: 'all' })}
      />
      <FilterButton
        label="Favorites"
        icon={Star}
        active={props.view === 'vault' && filterEq(props.filter, { kind: 'favorites' })}
        onClick={() => props.selectFilter({ kind: 'favorites' })}
      />
      <FilterButton
        label="Trash"
        icon={Trash2}
        active={props.view === 'vault' && filterEq(props.filter, { kind: 'trash' })}
        onClick={() => props.selectFilter({ kind: 'trash' })}
      />
      <div class="vault-rail-sep" />
      <For each={TYPE_FILTERS}>
        {(tf) => (
          <FilterButton
            label={tf.label}
            icon={typeIcon(tf.type)}
            active={props.view === 'vault' && filterEq(props.filter, { kind: 'type', itemType: tf.type })}
            onClick={() => props.selectFilter({ kind: 'type', itemType: tf.type })}
          />
        )}
      </For>
      {/* Folders need their labels to be useful — hide the tree when collapsed. */}
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
          defaultAccount={props.defaultAccount}
        />
      </Show>
      <div class="vault-rail-sep" />
      <FilterButton
        label="Generator"
        icon={Dices}
        active={props.view === 'generator'}
        onClick={() => props.setView('generator')}
      />
      <FilterButton
        label="Security"
        icon={Shield}
        active={props.view === 'security'}
        onClick={() => props.setView('security')}
        badge={<SecurityRailBadge report={props.health} />}
      />
      <button
        class="vault-rail-btn"
        classList={{ active: props.view === 'sync' }}
        title={props.sidebarCollapsed ? 'Sync' : props.syncTooltip}
        onClick={() => props.setView('sync')}
      >
        <SyncIcon state={props.syncState} lastSync={props.lastSync} />
        <span>Sync</span>
      </button>

      {/* Push Settings to the bottom of the rail. */}
      <div class="vault-rail-spacer" />
      <div class="vault-rail-sep" />
      <FilterButton label="Settings" icon={SettingsIcon} active={false} onClick={() => props.onOpenSettings()} />
    </nav>
  );
}

function FilterButton(props: {
  label: string;
  icon: IconComponent;
  active: boolean;
  onClick: () => void;
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
    >
      <Icon size={15} strokeWidth={1.6} />
      <span>{props.label}</span>
      {props.badge}
    </button>
  );
}

// Rail-band → token colour, so the rail badge is tinted by the same health band
// the backend audit reports.
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
