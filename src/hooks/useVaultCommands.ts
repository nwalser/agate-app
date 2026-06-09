// Builds the command-palette command lists and publishes the palette source the
// titlebar search reads. `actionCommands` are the verb commands (new item, open
// security/sync, sync now, lock, settings) shown in the titlebar's `/` mode;
// `commands` is the Ctrl-K palette's full list — those actions plus a "Go to <x>"
// entry per live item. The publish effect mirrors the actions + live items into
// state/palette.ts so the out-of-tree titlebar can preview/run them; it's cleared
// when the Vault unmounts.

import { type Accessor, createEffect, createMemo, onCleanup } from 'solid-js';
import { Cloud, Lock, Plus, RefreshCw, Settings as SettingsIcon, Shield } from 'lucide-solid';
import type { Command } from '../components/CommandPalette.tsx';
import type { ItemType, VaultItem } from '../lib/types.ts';
import type { VaultView } from '../lib/vaultConfig.ts';
import { CREATE_TYPES } from '../lib/vaultConfig.ts';
import { typeIcon } from '../lib/vaultIcons.ts';
import { clearPaletteSource, setPaletteSource } from '../state/palette.ts';

export function useVaultCommands(deps: {
  items: Accessor<VaultItem[]>;
  openCreate: (createType: ItemType) => void;
  setView: (v: VaultView) => void;
  sync: () => void;
  openItem: (id: string) => void;
  onLock: () => void;
  onOpenSettings: () => void;
}) {
  // ---- command palette commands ----
  // Action commands only (no go-to-item entries). These are what the titlebar
  // search shows in `/` command mode; the Ctrl-K palette appends go-to-item
  // entries below (items are reachable by plain text there).
  const actionCommands = createMemo<Command[]>(() => {
    const list: Command[] = [];
    for (const ct of CREATE_TYPES) {
      list.push({
        id: `new-${ct.type}`,
        label: `New ${ct.label.toLowerCase()}`,
        hint: 'Create',
        icon: Plus,
        run: () => deps.openCreate(ct.type),
      });
    }
    list.push({
      id: 'security',
      label: 'Open Security center',
      icon: Shield,
      run: () => deps.setView('security'),
    });
    list.push({
      id: 'sync',
      label: 'Sync now',
      icon: RefreshCw,
      run: () => deps.sync(),
    });
    list.push({
      id: 'sync-status',
      label: 'Open Sync status',
      icon: Cloud,
      run: () => deps.setView('sync'),
    });
    list.push({
      id: 'lock',
      label: 'Lock vault',
      icon: Lock,
      run: () => deps.onLock(),
    });
    list.push({
      id: 'settings',
      label: 'Open Settings',
      icon: SettingsIcon,
      run: () => deps.onOpenSettings(),
    });
    return list;
  });

  // The Ctrl-K palette's full list: actions plus a go-to entry per live item.
  const commands = createMemo<Command[]>(() => {
    const list = [...actionCommands()];
    for (const it of deps.items()) {
      if (it.deleted) continue;
      list.push({
        id: `goto-${it.id}`,
        label: `Go to ${it.name}`,
        hint: it.username ?? undefined,
        icon: typeIcon(it.itemType),
        run: () => deps.openItem(it.id),
      });
    }
    return list;
  });

  // Publish commands + items so the titlebar search (outside this tree, in
  // App.tsx) can preview items and run commands. Cleared when the Vault unmounts.
  createEffect(() => {
    setPaletteSource({
      commands: actionCommands(),
      items: deps.items().filter((it) => !it.deleted),
      openItem: deps.openItem,
    });
  });
  onCleanup(clearPaletteSource);

  return { actionCommands, commands };
}
