import { createEffect, createSignal, For, onCleanup, onMount, Show } from 'solid-js';
import { Fingerprint, KeyRound, Lock, LockOpen } from 'lucide-solid';
import { ipc } from '../lib/ipc.ts';
import type { TwoFactorKind, UnlockOutcome } from '../lib/types.ts';
import { refreshSession, status } from '../state/session.ts';
import { pushToast, toastError } from '../state/toast.ts';
import './Unlock.css';

/** Rotating status lines shown on the unlocking screen. Ordered to roughly track
 *  what `unlock_all` actually does — derive the AUK (Argon2id), unwrap the VMK,
 *  re-login every connection — without claiming a precise step it can't observe. */
const WORKING_MESSAGES = [
  'Deriving your key…',
  'Unwrapping the vault key…',
  'Reconnecting your accounts…',
  'Almost there…',
] as const;

const TEXT_ROTATE_MS = 1400;

/** Returning, locked: one app secret (or Windows Hello) re-logs-in every
 *  connection. Connections that still enforce 2FA are completed one by one. */
export default function Unlock() {
  const [appPassword, setAppPassword] = createSignal('');
  const [busy, setBusy] = createSignal(false);
  // Whether Windows Hello is usable on this device at all (separate from whether
  // the user has enrolled it) — picks the "not set up" vs "not available" copy.
  const [helloAvailable, setHelloAvailable] = createSignal(false);

  onMount(() => {
    void (async () => {
      try {
        setHelloAvailable(await ipc.helloAvailable());
      } catch (err) {
        toastError(err);
      }
    })();
  });

  // Drives the dedicated unlocking screen, independent of `busy` (which only gates
  // inputs): 'working' while the key is unwrapped / connections re-login, 'unlocked'
  // for the brief success beat before the vault opens. While not 'idle' the whole
  // password/2FA form is hidden behind the animation.
  const [phase, setPhase] = createSignal<'idle' | 'working' | 'unlocked'>('idle');
  const [msgIndex, setMsgIndex] = createSignal(0);

  const prefersReducedMotion = () =>
    typeof window !== 'undefined' && !!window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;
  const delay = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

  // Advance the rotating status text while working; clamp at the last line so it
  // settles rather than looping (we can't know the real duration). The interval is
  // torn down whenever the phase leaves 'working'.
  createEffect(() => {
    if (phase() !== 'working') return;
    setMsgIndex(0);
    const id = setInterval(
      () => setMsgIndex((i) => Math.min(i + 1, WORKING_MESSAGES.length - 1)),
      TEXT_ROTATE_MS,
    );
    onCleanup(() => clearInterval(id));
  });

  const statusLine = () =>
    phase() === 'unlocked' ? 'Vault unlocked' : WORKING_MESSAGES[msgIndex()];

  const connectionLabel = () => {
    const n = status().connectionCount;
    return `${n} connection${n === 1 ? '' : 's'}`;
  };

  /** Play the unlock beat, then hand off to the vault. */
  async function finishUnlocked() {
    setPhase('unlocked');
    await delay(prefersReducedMotion() ? 120 : 720);
    await refreshSession();
  }

  // Connections that reported `twoFactorRequired` and still need a code.
  const [pending, setPending] = createSignal<UnlockOutcome[]>([]);
  const [tfToken, setTfToken] = createSignal('');
  const [tfProvider, setTfProvider] = createSignal<TwoFactorKind>('authenticator');

  const hasHello = () => status().helloConfigured;
  const current = () => pending()[0];
  const providersFor = (o: UnlockOutcome | undefined): TwoFactorKind[] =>
    o && o.status === 'twoFactorRequired' ? o.providers : [];

  async function handleOutcomes(outcomes: UnlockOutcome[]) {
    for (const o of outcomes) {
      if (o.status === 'failed') pushToast('error', `${o.email}: ${o.message}`);
    }
    const need = outcomes.filter((o) => o.status === 'twoFactorRequired');
    setPending(need);
    if (need.length === 0) {
      await finishUnlocked();
    } else {
      setPhase('idle'); // drop the animation; show the 2FA form
      setTfProvider(providersFor(need[0])[0] ?? 'authenticator');
    }
  }

  async function unlock() {
    if (!appPassword()) return;
    setBusy(true);
    setPhase('working');
    try {
      const outcomes = await ipc.unlockAll(appPassword());
      setAppPassword('');
      await handleOutcomes(outcomes);
    } catch (err) {
      setPhase('idle');
      toastError(err);
    } finally {
      setBusy(false);
    }
  }

  async function unlockHello() {
    setBusy(true);
    setPhase('working');
    try {
      await handleOutcomes(await ipc.helloUnlock());
    } catch (err) {
      setPhase('idle');
      toastError(err);
    } finally {
      setBusy(false);
    }
  }

  async function submit2fa() {
    const c = current();
    if (!c) return;
    setBusy(true);
    setPhase('working');
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
        await finishUnlocked();
      } else {
        setPhase('idle'); // more accounts to verify — back to the 2FA form
        setTfProvider(providersFor(rest[0])[0] ?? 'authenticator');
      }
    } catch (err) {
      setPhase('idle');
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
      <Show
        when={phase() === 'idle'}
        fallback={
          // Dedicated unlocking screen — no password field, just the animation,
          // progress bar, and rotating status text.
          <div class="unlocking">
            <div
              class="unlocking-icon"
              classList={{ working: phase() === 'working', unlocked: phase() === 'unlocked' }}
              aria-hidden="true"
            >
              <Show when={phase() === 'unlocked'} fallback={<Lock size={30} strokeWidth={1.5} />}>
                <LockOpen size={30} strokeWidth={1.5} />
              </Show>
            </div>

            <h2 class="unlocking-title">
              {phase() === 'unlocked' ? 'Welcome back' : 'Unlocking Agate'}
            </h2>

            {/* Keyed so each new line re-mounts and re-runs its fade-in. */}
            <Show when={statusLine()} keyed>
              {(line) => (
                <p class="unlocking-status muted" role="status" aria-live="polite">
                  {line}
                </p>
              )}
            </Show>

            <div
              class="unlock-progress"
              classList={{ done: phase() === 'unlocked' }}
              role="progressbar"
              aria-label="Unlocking"
            >
              <div class="unlock-progress-bar" />
            </div>

            <p class="unlocking-sub">
              {phase() === 'unlocked' ? 'Opening your vault' : `Unlocking ${connectionLabel()}`}
            </p>
          </div>
        }
      >
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

            <div class="unlock-methods">
              <span class="unlock-methods-head muted">Sign-in options</span>

              {/* Windows Hello — actionable when enrolled, otherwise shown disabled
                  with why it can't be used (not set up vs not available here). */}
              <Show
                when={hasHello()}
                fallback={
                  <div class="unlock-method-row is-off" aria-disabled="true">
                    <Fingerprint size={16} strokeWidth={1.75} class="unlock-method-ico" />
                    <span class="unlock-method-info">
                      <span class="unlock-method-name">Windows Hello</span>
                      <span class="unlock-method-note muted">
                        {helloAvailable()
                          ? 'This option is not set up — turn it on in Settings › Unlock.'
                          : 'This option is not available on this device.'}
                      </span>
                    </span>
                    <span class="unlock-method-badge">
                      {helloAvailable() ? 'Not set up' : 'Unavailable'}
                    </span>
                  </div>
                }
              >
                <button
                  type="button"
                  class="unlock-method-row is-action"
                  disabled={busy()}
                  onClick={() => void unlockHello()}
                >
                  <Fingerprint size={16} strokeWidth={1.75} class="unlock-method-ico" />
                  <span class="unlock-method-info">
                    <span class="unlock-method-name">Windows Hello</span>
                    <span class="unlock-method-note muted">Face, fingerprint, or PIN</span>
                  </span>
                  <span class="unlock-method-badge is-ready">Unlock</span>
                </button>
              </Show>

              {/* App password — the always-available method; its input is below. */}
              <div class="unlock-method-row is-on">
                <KeyRound size={16} strokeWidth={1.75} class="unlock-method-ico" />
                <span class="unlock-method-info">
                  <span class="unlock-method-name">App password</span>
                  <span class="unlock-method-note muted">Always available</span>
                </span>
                <span class="unlock-method-badge is-ready">Ready</span>
              </div>
            </div>

            <div class="field unlock-field">
              <input
                type="password"
                aria-label="App password"
                placeholder="Enter your app password"
                autocomplete="current-password"
                value={appPassword()}
                onInput={(e) => setAppPassword(e.currentTarget.value)}
                onKeyDown={(e) => e.key === 'Enter' && void unlock()}
              />
            </div>
            <button class="primary full" disabled={busy()} onClick={() => void unlock()}>
              Unlock all
            </button>
          </Show>

          <button class="ghost full unlock-logout" onClick={() => void logout()}>
            Log out of everything
          </button>
        </div>
      </Show>
    </div>
  );
}
