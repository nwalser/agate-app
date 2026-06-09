// Slim banner shown when the last sync failed: the vault is showing cached data
// and edits may not reach the server. Reads the shared sync state (state/sync.ts)
// and offers a one-click retry through the same request bus the titlebar uses.
// Rendered globally under the titlebar (App.tsx) on the vault screen; it gates
// itself on the error state, so it's invisible while sync is healthy.

import { Show } from 'solid-js';
import { CloudOff, RefreshCw } from 'lucide-solid';
import { requestSync, syncState } from '../state/sync.ts';
import './OfflineBanner.css';

export default function OfflineBanner() {
  return (
    <Show when={syncState() === 'error'}>
      <div class="offline-banner" role="status">
        <CloudOff size={14} strokeWidth={1.75} />
        <span class="offline-banner-text">
          Offline — showing your last synced vault. Changes you make may not reach the server yet.
        </span>
        <button class="offline-banner-retry" onClick={() => requestSync()}>
          <RefreshCw size={13} strokeWidth={1.75} /> Retry
        </button>
      </div>
    </Show>
  );
}
