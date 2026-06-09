// Vault data layer: owns the decrypted item list, folders, connections, and the
// offline health audit, plus the single sync path (manual + background interval +
// post-mutation reload). All IPC loads funnel through here so the screen and the
// other hooks read one consistent snapshot. Also exposes the per-account routing
// helpers (createAccount / accountFor / groupByAccount) the bulk + folder actions
// need, since they depend on the live item list and the active-vault scope.

import { createEffect, createSignal, on, onCleanup, onMount } from 'solid-js';
import { ipc } from '../lib/ipc.ts';
import type { ConnectionSummary, Folder, VaultHealthReport, VaultItem } from '../lib/types.ts';
import { pushToast, toastError } from '../state/toast.ts';
import { setQuery } from '../state/search.ts';
import { setLastSync, setSyncState, syncRequest, syncState } from '../state/sync.ts';
import { activeVault, setActiveVault } from '../state/ui.ts';
import { AUTO_SYNC_MS } from '../lib/vaultConfig.ts';

export function useVaultData() {
  const [items, setItems] = createSignal<VaultItem[]>([]);
  const [folders, setFolders] = createSignal<Folder[]>([]);
  const [connections, setConnections] = createSignal<ConnectionSummary[]>([]);
  // Offline vault-health audit, summarised as a badge on the Security rail item.
  // Best-effort: recomputed after every sync; null until the first run.
  const [health, setHealth] = createSignal<VaultHealthReport | null>(null);

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

  // Refresh the offline health audit behind the Security rail badge. Best-effort:
  // the Security center surfaces real errors, so a failure here just leaves the
  // last badge in place rather than toasting on every background sync.
  async function loadHealth() {
    try {
      setHealth(await ipc.auditOffline());
    } catch {
      // ignore: rail badge is advisory; Security center reports audit failures
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
      // Recompute the security badge off the freshly synced vault (offline, cheap).
      void loadHealth();
      if (manual) pushToast('success', 'Vault synced.');
    } catch (err) {
      setSyncState('error');
      if (manual) toastError(err);
    }
  }

  const sync = () => runSync(true);

  // The titlebar's sync button can't reach runSync (it holds the reload logic),
  // so it bumps syncRequest and we run a manual sync here. Deferred so the
  // initial mount value doesn't trigger a sync.
  createEffect(on(syncRequest, () => void runSync(true), { defer: true }));

  // Automatic background sync: once on open, then on a fixed interval. The cloud
  // icon in the header is the visible status.
  let autoSyncTimer: ReturnType<typeof setInterval> | undefined;
  onMount(() => {
    // Start each vault session with a clean search so a stale query (the field
    // now lives in the persistent titlebar) can't hide items on entry.
    setQuery('');
    // Show cached items immediately (instant on re-mounts / after a prior sync),
    // then refresh in the background — avoids a blank-then-populate flicker.
    void (async () => {
      await Promise.all([loadItems(), loadFolders(), loadConnections()]);
      // Seed the security badge off the cached vault so it shows even if the
      // first background sync fails; runSync refreshes it once sync completes.
      void loadHealth();
      await runSync(false);
    })();
    autoSyncTimer = setInterval(() => void runSync(false), AUTO_SYNC_MS);
  });
  onCleanup(() => {
    if (autoSyncTimer) clearInterval(autoSyncTimer);
    autoSyncTimer = undefined;
  });

  // If the scoped vault was removed (e.g. in Settings), fall back to all vaults so
  // the list can't silently show nothing with no way to recover.
  createEffect(() => {
    const av = activeVault();
    if (av && connections().length > 0 && !connections().some((c) => c.email === av)) {
      setActiveVault(null);
    }
  });

  return {
    items,
    folders,
    connections,
    health,
    loadHealth,
    runSync,
    sync,
    createAccount,
    accountFor,
    groupByAccount,
  };
}

export type VaultData = ReturnType<typeof useVaultData>;
