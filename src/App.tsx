import { createEffect, createMemo, createSignal, Match, onMount, Show, Switch } from 'solid-js';
import Titlebar from './components/Titlebar.tsx';
import ToastHost from './components/Toast.tsx';
import OfflineBanner from './components/OfflineBanner.tsx';
import ShortcutsOverlay from './components/ShortcutsOverlay.tsx';
import AppUnlockSetup from './screens/AppUnlockSetup.tsx';
import Onboarding from './screens/Onboarding.tsx';
import Unlock from './screens/Unlock.tsx';
import Vault from './screens/Vault.tsx';
import Settings from './screens/Settings.tsx';
import { ipc } from './lib/ipc.ts';
import {
  addingConnection,
  ready,
  refreshSession,
  screenForStatus,
  setAddingConnection,
  status,
} from './state/session.ts';
import { toastError } from './state/toast.ts';
import { runStartupUpdateCheck } from './state/update.ts';
import { useAutoLock } from './hooks/useAutoLock.ts';
import { clearGeneratorHistory } from './state/generatorHistory.ts';
import './App.css';

export default function App() {
  const [showSettings, setShowSettings] = createSignal(false);

  onMount(() => {
    void refreshSession().catch(toastError);
    // Independent of auth: silently check (and optionally install) a newer
    // release if the user has auto-updates on. Swallows its own errors.
    void runStartupUpdateCheck();
  });

  const base = createMemo(() => screenForStatus(status()));

  // Search lives in the titlebar but only belongs to the vault list — hide it on
  // setup / unlock / settings / add-connection.
  const showSearch = createMemo(() => base() === 'vault' && !showSettings() && !addingConnection());

  async function lock() {
    try {
      await ipc.lock();
      setShowSettings(false);
      // Generated-secret buffer is session-only; wipe it when the vault closes.
      clearGeneratorHistory();
      await refreshSession();
    } catch (err) {
      toastError(err);
    }
  }

  // Idle vault timeout: auto-lock after inactivity (and on minimize, if enabled)
  // while unlocked. Reads its config from state/autolock.ts (Settings → Security).
  useAutoLock({ unlocked: () => status().unlocked, lock: () => void lock() });

  return (
    <>
      <Titlebar showSearch={showSearch()} onLock={() => void lock()} />
      <Show when={ready() && base() === 'vault'}>
        <OfflineBanner />
      </Show>
      <Show when={ready()} fallback={<div class="app-loading muted">Loading…</div>}>
        <Switch>
          {/* First run: create the one app password that unlocks every connection. */}
          <Match when={base() === 'setup'}>
            <AppUnlockSetup />
          </Match>

          {/* Returning, locked: one secret unlocks all connections. */}
          <Match when={base() === 'unlock'}>
            <Unlock />
          </Match>

          <Match when={base() === 'vault'}>
            <Show
              when={addingConnection()}
              fallback={
                <Show when={!showSettings()} fallback={<Settings onBack={() => setShowSettings(false)} />}>
                  <Vault onLock={() => void lock()} onOpenSettings={() => setShowSettings(true)} />
                </Show>
              }
            >
              {/* Add another connection while the others stay unlocked. */}
              <Onboarding onDone={() => setAddingConnection(false)} />
            </Show>
          </Match>
        </Switch>
      </Show>
      <ToastHost />
      <ShortcutsOverlay />
    </>
  );
}
