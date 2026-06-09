import { createSignal } from 'solid-js';
import type { SyncState } from '../components/SyncStatus.tsx';

// Sync status is shared between the vault screen — which owns the real sync logic
// (it reloads items / folders / health) — and the titlebar, which shows the icon
// and can trigger a manual sync. Lifting the state here avoids prop-drilling
// through App into a sibling component.
export const [syncState, setSyncState] = createSignal<SyncState>('idle');

// Epoch ms of the last successful sync (null until the first one completes).
export const [lastSync, setLastSync] = createSignal<number | null>(null);

// Manual-sync request bus: the titlebar bumps the nonce, the vault screen runs
// the actual sync via an effect (it holds the reload logic the titlebar can't
// reach). A monotonic counter so repeated requests always re-trigger.
const [syncRequest, setSyncRequest] = createSignal(0);
export { syncRequest };
export function requestSync(): void {
  setSyncRequest((n) => n + 1);
}
