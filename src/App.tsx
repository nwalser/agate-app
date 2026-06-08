import { createMemo, createSignal, Match, onMount, Show, Switch } from 'solid-js';
import ToastHost from './components/Toast.tsx';
import Onboarding from './screens/Onboarding.tsx';
import Unlock from './screens/Unlock.tsx';
import Vault from './screens/Vault.tsx';
import Settings from './screens/Settings.tsx';
import { ipc } from './lib/ipc.ts';
import { ready, refreshSession, screenForStatus, status } from './state/session.ts';
import { toastError } from './state/toast.ts';
import './App.css';

export default function App() {
  // Manual navigation overrides layered on top of the session-derived screen.
  const [forceMaster, setForceMaster] = createSignal(false);
  const [showSettings, setShowSettings] = createSignal(false);

  onMount(() => {
    void refreshSession().catch(toastError);
  });

  const base = createMemo(() => screenForStatus(status()));

  async function lock() {
    try {
      await ipc.lock();
      setShowSettings(false);
      await refreshSession();
    } catch (err) {
      toastError(err);
    }
  }

  return (
    <>
      <Show when={ready()} fallback={<div class="app-loading muted">Loading…</div>}>
        <Switch>
          <Match when={base() === 'vault'}>
            <Show when={!showSettings()} fallback={<Settings onBack={() => setShowSettings(false)} />}>
              <Vault onLock={() => void lock()} onOpenSettings={() => setShowSettings(true)} />
            </Show>
          </Match>

          <Match when={base() === 'unlock' && !forceMaster()}>
            <Unlock onUseMasterPassword={() => setForceMaster(true)} />
          </Match>

          <Match when={base() === 'unlock' && forceMaster()}>
            <Onboarding initialEmail={status().email} />
          </Match>

          <Match when={base() === 'onboarding'}>
            <Onboarding initialEmail={status().email} />
          </Match>
        </Switch>
      </Show>
      <ToastHost />
    </>
  );
}
