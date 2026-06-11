import { Cloud, CloudOff, RefreshCw } from 'lucide-solid';
import { Match, Switch } from 'solid-js';
import { t } from '../lib/i18n.ts';
import './SyncStatus.css';

// Background-sync status, shared by the header icon, the rail entry, and this page.
export type SyncState = 'idle' | 'syncing' | 'error';

// Cloud glyph + color for the current sync state. Reused in the header and rail
// so all three surfaces stay in lock-step. `idle` splits into "live" (a sync has
// succeeded this session) vs neutral "not synced yet" by `lastSync`.
export function SyncIcon(props: { state: SyncState; lastSync: number | null; size?: number }) {
  const size = () => props.size ?? 15;
  return (
    <Switch fallback={<Cloud size={size()} strokeWidth={1.75} class="sync-live" />}>
      <Match when={props.state === 'syncing'}>
        <Cloud size={size()} strokeWidth={1.75} class="sync-active pulse" />
      </Match>
      <Match when={props.state === 'error'}>
        <CloudOff size={size()} strokeWidth={1.75} class="sync-error" />
      </Match>
      <Match when={props.lastSync === null}>
        <Cloud size={size()} strokeWidth={1.75} class="sync-idle" />
      </Match>
    </Switch>
  );
}

// Full-page sync status, opened from the left rail. Shows the live state, the
// last successful sync time, the auto-sync cadence, and a manual "Sync now".
export default function SyncStatus(props: {
  state: SyncState;
  lastSync: number | null;
  autoSyncMs: number;
  onSync: () => void;
}) {
  const heading = () => {
    if (props.state === 'syncing') return t('sync.syncing');
    if (props.state === 'error') return t('sync.failed');
    return props.lastSync === null ? t('sync.notSyncedYet') : t('sync.live');
  };
  const detail = () => {
    if (props.state === 'syncing') return t('sync.detailSyncing');
    if (props.state === 'error') {
      return t('sync.detailError');
    }
    if (props.lastSync === null) return t('sync.detailNotSynced');
    return t('sync.detailLastSynced', { time: new Date(props.lastSync).toLocaleTimeString() });
  };
  const everyMinutes = () => Math.max(1, Math.round(props.autoSyncMs / 60_000));

  return (
    <section class="sync-page">
      <div class="sync-page-card">
        <SyncIcon state={props.state} lastSync={props.lastSync} size={48} />
        <h2 class="sync-page-title">{heading()}</h2>
        <p class="sync-page-detail muted">{detail()}</p>
        <p class="sync-page-auto muted">
          {everyMinutes() === 1
            ? t('sync.autoEveryOne', { count: everyMinutes() })
            : t('sync.autoEveryOther', { count: everyMinutes() })}
        </p>
        <button
          class="sync-page-btn"
          disabled={props.state === 'syncing'}
          onClick={() => props.onSync()}
        >
          <RefreshCw
            size={15}
            strokeWidth={1.75}
            class={props.state === 'syncing' ? 'spin' : ''}
          />
          {props.state === 'syncing' ? t('sync.syncing') : t('sync.syncNow')}
        </button>
      </div>
    </section>
  );
}
