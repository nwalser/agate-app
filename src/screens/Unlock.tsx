import { createSignal, For, Show } from 'solid-js';
import { Fingerprint, Lock } from 'lucide-solid';
import { ipc } from '../lib/ipc.ts';
import type { TwoFactorKind, UnlockOutcome } from '../lib/types.ts';
import { refreshSession, status } from '../state/session.ts';
import { pushToast, toastError } from '../state/toast.ts';
import './Unlock.css';

/** Returning, locked: one app secret (or Windows Hello) re-logs-in every
 *  connection. Connections that still enforce 2FA are completed one by one. */
export default function Unlock() {
  const [appPassword, setAppPassword] = createSignal('');
  const [busy, setBusy] = createSignal(false);

  // Connections that reported `twoFactorRequired` and still need a code.
  const [pending, setPending] = createSignal<UnlockOutcome[]>([]);
  const [tfToken, setTfToken] = createSignal('');
  const [tfProvider, setTfProvider] = createSignal<TwoFactorKind>('authenticator');

  const hasHello = () => status().helloConfigured;
  const current = () => pending()[0];
  const providersFor = (o: UnlockOutcome | undefined): TwoFactorKind[] =>
    o && o.status === 'twoFactorRequired' ? o.providers : [];

  function handleOutcomes(outcomes: UnlockOutcome[]) {
    for (const o of outcomes) {
      if (o.status === 'failed') pushToast('error', `${o.email}: ${o.message}`);
    }
    const need = outcomes.filter((o) => o.status === 'twoFactorRequired');
    setPending(need);
    if (need.length === 0) {
      void refreshSession();
    } else {
      setTfProvider(providersFor(need[0])[0] ?? 'authenticator');
    }
  }

  async function unlock() {
    if (!appPassword()) return;
    setBusy(true);
    try {
      const outcomes = await ipc.unlockAll(appPassword());
      setAppPassword('');
      handleOutcomes(outcomes);
    } catch (err) {
      toastError(err);
    } finally {
      setBusy(false);
    }
  }

  async function unlockHello() {
    setBusy(true);
    try {
      handleOutcomes(await ipc.helloUnlock());
    } catch (err) {
      toastError(err);
    } finally {
      setBusy(false);
    }
  }

  async function submit2fa() {
    const c = current();
    if (!c) return;
    setBusy(true);
    try {
      await ipc.unlockConnection2fa(c.email, {
        provider: tfProvider(),
        token: tfToken().trim(),
        remember: false,
      });
      setTfToken('');
      const rest = pending().slice(1);
      setPending(rest);
      if (rest.length === 0) {
        await refreshSession();
      } else {
        setTfProvider(providersFor(rest[0])[0] ?? 'authenticator');
      }
    } catch (err) {
      toastError(err);
    } finally {
      setBusy(false);
    }
  }

  async function sendCode() {
    const c = current();
    if (!c) return;
    setBusy(true);
    try {
      await ipc.sendConnectionEmailCode(c.email);
      pushToast('success', 'Code sent to your email.');
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

        <Show
          when={!current()}
          fallback={
            <>
              <h2 class="unlock-title">Two-factor needed</h2>
              <p class="muted unlock-email">{current()?.email}</p>
              <div class="field unlock-field">
                <label>Provider</label>
                <select value={tfProvider()} onChange={(e) => setTfProvider(e.currentTarget.value as TwoFactorKind)}>
                  <For each={providersFor(current())}>
                    {(p) => <option value={p}>{p === 'authenticator' ? 'Authenticator app' : 'Email'}</option>}
                  </For>
                </select>
              </div>
              <Show when={tfProvider() === 'email'}>
                <button class="ghost send-code" disabled={busy()} onClick={() => void sendCode()}>
                  Send code to email
                </button>
              </Show>
              <div class="field unlock-field">
                <label>Verification code</label>
                <input
                  value={tfToken()}
                  inputmode="numeric"
                  autocomplete="one-time-code"
                  onInput={(e) => setTfToken(e.currentTarget.value)}
                  onKeyDown={(e) => e.key === 'Enter' && void submit2fa()}
                />
              </div>
              <button class="primary full" disabled={busy()} onClick={() => void submit2fa()}>
                {busy() ? 'Verifying…' : `Verify (${pending().length} left)`}
              </button>
            </>
          }
        >
          <h2 class="unlock-title">Unlock Agate</h2>
          <p class="muted unlock-email">
            {status().connectionCount} connection{status().connectionCount === 1 ? '' : 's'}
          </p>

          <Show when={hasHello()}>
            <button class="primary full unlock-hello" disabled={busy()} onClick={() => void unlockHello()}>
              <Fingerprint size={16} strokeWidth={1.75} /> Unlock with Windows Hello
            </button>
            <div class="unlock-or muted">or</div>
          </Show>

          <div class="field unlock-field">
            <label>App password</label>
            <input
              type="password"
              autocomplete="current-password"
              value={appPassword()}
              onInput={(e) => setAppPassword(e.currentTarget.value)}
              onKeyDown={(e) => e.key === 'Enter' && void unlock()}
            />
          </div>
          <button class="primary full" disabled={busy()} onClick={() => void unlock()}>
            {busy() ? 'Unlocking…' : 'Unlock all'}
          </button>
        </Show>

        <button class="ghost full unlock-logout" onClick={() => void logout()}>
          Log out of everything
        </button>
      </div>
    </div>
  );
}
