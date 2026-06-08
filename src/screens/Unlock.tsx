import { createSignal, Show } from 'solid-js';
import { Fingerprint, Lock } from 'lucide-solid';
import { ipc } from '../lib/ipc.ts';
import { refreshSession, status } from '../state/session.ts';
import { toastError } from '../state/toast.ts';
import './Unlock.css';

export default function Unlock(props: { onUseMasterPassword: () => void }) {
  const [localPassword, setLocalPassword] = createSignal('');
  const [busy, setBusy] = createSignal(false);

  const hasLocal = () => status().localUnlockConfigured;
  const hasHello = () => status().helloConfigured;

  async function unlock() {
    if (!localPassword()) return;
    setBusy(true);
    try {
      await ipc.unlockLocal(localPassword());
      await refreshSession();
    } catch (err) {
      toastError(err);
    } finally {
      setBusy(false);
    }
  }

  async function unlockHello() {
    setBusy(true);
    try {
      await ipc.helloUnlock();
      await refreshSession();
    } catch (err) {
      toastError(err);
    } finally {
      setBusy(false);
    }
  }

  async function logout() {
    try {
      await ipc.logout();
      await refreshSession();
    } catch (err) {
      toastError(err);
    }
  }

  return (
    <div class="unlock">
      <div class="unlock-card">
        <div class="unlock-icon">
          <Lock size={20} strokeWidth={1.75} />
        </div>
        <h2 class="unlock-title">Vault locked</h2>
        <Show when={status().email}>
          {(email) => <p class="muted unlock-email">{email()}</p>}
        </Show>

        <Show when={hasHello()}>
          <button class="primary full unlock-hello" disabled={busy()} onClick={() => void unlockHello()}>
            <Fingerprint size={16} strokeWidth={1.75} /> Unlock with Windows Hello
          </button>
          <div class="unlock-or muted">or</div>
        </Show>

        <Show
          when={hasLocal()}
          fallback={
            <>
              <p class="muted unlock-hint">Unlock with your master password to continue.</p>
              <button class="primary full" onClick={() => props.onUseMasterPassword()}>
                Enter master password
              </button>
            </>
          }
        >
          <div class="field unlock-field">
            <label>Local password</label>
            <input
              type="password"
              autocomplete="off"
              value={localPassword()}
              onInput={(e) => setLocalPassword(e.currentTarget.value)}
              onKeyDown={(e) => e.key === 'Enter' && void unlock()}
            />
          </div>
          <button class="primary full" disabled={busy()} onClick={() => void unlock()}>
            {busy() ? 'Unlocking…' : 'Unlock'}
          </button>
          <button class="ghost full" disabled={busy()} onClick={() => props.onUseMasterPassword()}>
            Use master password instead
          </button>
        </Show>

        <button class="ghost full unlock-logout" onClick={() => void logout()}>
          Log out
        </button>
      </div>
    </div>
  );
}
