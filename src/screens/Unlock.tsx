import { createEffect, createSignal, For, onCleanup, onMount, Show } from 'solid-js';
import { listen } from '@tauri-apps/api/event';
import { Fingerprint, KeyRound, Lock, LockOpen } from 'lucide-solid';
import { ipc } from '../lib/ipc.ts';
import { t } from '../lib/i18n.ts';
import type { TwoFactorKind, UnlockOutcome } from '../lib/types.ts';
import { refreshSession, status } from '../state/session.ts';
import { UNLOCK_BEAT_MS, UNLOCK_BEAT_REDUCED_MS } from '../lib/unlockBeat.ts';
import { pushToast, toastError } from '../state/toast.ts';
import './Unlock.css';

/** Rotating status lines shown on the unlocking screen. Ordered to roughly track
 *  what `unlock_all` actually does — derive the AUK (Argon2id), unwrap the VMK,
 *  re-login every connection — without claiming a precise step it can't observe.
 *  A function (not a module constant) so the strings re-translate on a language flip. */
const workingMessages = () => [
  t('unlock.workingDerivingKey'),
  t('unlock.workingUnwrappingVaultKey'),
  t('unlock.workingReconnectingAccounts'),
  t('unlock.workingAlmostThere'),
];

const TEXT_ROTATE_MS = 1400;

/** Whether to START showing the unlocking animation for an unlock running
 *  OUTSIDE this screen (the tray popup): only when fully idle — its own unlock
 *  flow and any pending per-connection 2FA prompts always win. Pure, unit-tested. */
export function shouldShowExternalUnlock(args: {
  busy: boolean;
  phase: 'idle' | 'working' | 'unlocked';
  pendingCount: number;
}): boolean {
  return !args.busy && args.phase === 'idle' && args.pendingCount === 0;
}

/** How the screen reacts to a `session-changed` broadcast for an unlock that ran
 *  OUTSIDE it (tray popup). `adopt` → play the success beat and open the vault;
 *  `cancel` → the external unlock ended still locked (wrong password / all-2FA /
 *  failed), so drop the borrowed animation; `ignore` → the screen's own flow owns
 *  the UI, leave it alone. Pure, unit-tested. */
export type ExternalUnlockAction = 'adopt' | 'cancel' | 'ignore';
export function externalUnlockAction(args: {
  busy: boolean;
  phase: 'idle' | 'working' | 'unlocked';
  pendingCount: number;
  unlocked: boolean;
  externalUnlock: boolean;
}): ExternalUnlockAction {
  // Own active flow (password / Hello / per-connection 2FA) always wins.
  if (args.busy || args.pendingCount > 0 || args.phase === 'unlocked') return 'ignore';
  // A 'working' phase we did NOT borrow for an external unlock is our own flow.
  if (args.phase === 'working' && !args.externalUnlock) return 'ignore';
  if (args.unlocked) return 'adopt';
  return args.externalUnlock ? 'cancel' : 'ignore';
}

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
  // True while the 'working' animation was borrowed for an unlock running in
  // ANOTHER window (the tray popup). Lets the session-changed handler tell our
  // own working flow apart from a mirrored one, and revert if it ends locked.
  const [externalUnlock, setExternalUnlock] = createSignal(false);

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
      () => setMsgIndex((i) => Math.min(i + 1, workingMessages().length - 1)),
      TEXT_ROTATE_MS,
    );
    onCleanup(() => clearInterval(id));
  });

  const statusLine = () =>
    phase() === 'unlocked' ? t('unlock.vaultUnlocked') : workingMessages()[msgIndex()];

  const connectionLabel = () => {
    const n = status().connectionCount;
    return n === 1
      ? t('unlock.connectionCountOne', { count: n })
      : t('unlock.connectionCountOther', { count: n });
  };

  /** Play the unlock beat, then hand off to the vault. Duration shared with
   *  the tray popup's flash so both windows finish together. */
  async function finishUnlocked() {
    setPhase('unlocked');
    await delay(prefersReducedMotion() ? UNLOCK_BEAT_REDUCED_MS : UNLOCK_BEAT_MS);
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

  // The vault can be unlocked from OUTSIDE this screen — the tray popup's unlock
  // form / Hello button. The backend fires `unlock-started` the instant such an
  // unlock begins: mirror the same decrypt animation here so BOTH windows read as
  // one surface while it runs (login + sync). Only when fully idle — our own flow
  // and any pending 2FA always win.
  onMount(() => {
    const unlisten = listen('agate://unlock-started', () => {
      if (
        shouldShowExternalUnlock({ busy: busy(), phase: phase(), pendingCount: pending().length })
      ) {
        setExternalUnlock(true);
        setPhase('working');
      }
    });
    onCleanup(() => void unlisten.then((un) => un()));
  });

  // The matching completion: the backend broadcasts every session change. When one
  // arrives, adopt the now-unlocked vault (own success beat + hand off), or — if we
  // were mirroring an external unlock that ended still locked — drop the animation.
  // The guard keeps an in-progress local flow (password, Hello, 2FA) untouched.
  onMount(() => {
    const unlisten = listen('agate://session-changed', () => {
      void (async () => {
        if (busy() || pending().length > 0) return;
        const s = await ipc.getSessionStatus();
        const action = externalUnlockAction({
          busy: busy(),
          phase: phase(),
          pendingCount: pending().length,
          unlocked: s.unlocked,
          externalUnlock: externalUnlock(),
        });
        if (action === 'adopt') {
          setExternalUnlock(false);
          await finishUnlocked();
        } else if (action === 'cancel') {
          setExternalUnlock(false);
          setPhase('idle');
        }
      })().catch(toastError);
    });
    onCleanup(() => void unlisten.then((un) => un()));
  });

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
      pushToast('success', t('unlock.codeSent'));
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
          // progress bar, and rotating status text. A faint multi-color aurora
          // weaves behind it across the whole background.
          <>
          <div
            class="unlocking-aurora"
            classList={{ done: phase() === 'unlocked' }}
            aria-hidden="true"
          />
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
              {phase() === 'unlocked' ? t('unlock.welcomeBack') : t('unlock.unlockingAgate')}
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
              aria-label={t('unlock.unlocking')}
            >
              <div class="unlock-progress-bar" />
            </div>

            <p class="unlocking-sub">
              {phase() === 'unlocked'
                ? t('unlock.openingVault')
                : t('unlock.unlockingConnections', { label: connectionLabel() })}
            </p>
          </div>
          </>
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
                <h2 class="unlock-title">{t('unlock.twoFactorNeeded')}</h2>
                <p class="muted unlock-email">{current()?.email}</p>
                <div class="field unlock-field">
                  <label>{t('unlock.provider')}</label>
                  <select value={tfProvider()} onChange={(e) => setTfProvider(e.currentTarget.value as TwoFactorKind)}>
                    <For each={providersFor(current())}>
                      {(p) => <option value={p}>{p === 'authenticator' ? t('unlock.authenticatorApp') : t('unlock.email')}</option>}
                    </For>
                  </select>
                </div>
                <Show when={tfProvider() === 'email'}>
                  <button class="ghost send-code" disabled={busy()} onClick={() => void sendCode()}>
                    {t('unlock.sendCodeToEmail')}
                  </button>
                </Show>
                <div class="field unlock-field">
                  <label>{t('unlock.verificationCode')}</label>
                  <input
                    value={tfToken()}
                    inputmode="numeric"
                    autocomplete="one-time-code"
                    onInput={(e) => setTfToken(e.currentTarget.value)}
                    onKeyDown={(e) => e.key === 'Enter' && void submit2fa()}
                  />
                </div>
                <button class="primary full" disabled={busy()} onClick={() => void submit2fa()}>
                  {busy() ? t('unlock.verifying') : t('unlock.verifyLeft', { count: pending().length })}
                </button>
              </>
            }
          >
            <h2 class="unlock-title">{t('unlock.unlockAgate')}</h2>
            <p class="muted unlock-email">
              {status().connectionCount === 1
                ? t('unlock.connectionCountOne', { count: status().connectionCount })
                : t('unlock.connectionCountOther', { count: status().connectionCount })}
            </p>

            <div class="unlock-methods">
              <span class="unlock-methods-head muted">{t('unlock.signInOptions')}</span>

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
                          ? t('unlock.helloNotSetUp')
                          : t('unlock.helloNotAvailable')}
                      </span>
                    </span>
                    <span class="unlock-method-badge">
                      {helloAvailable() ? t('unlock.notSetUp') : t('unlock.unavailable')}
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
                    <span class="unlock-method-note muted">{t('unlock.helloMethods')}</span>
                  </span>
                  <span class="unlock-method-badge is-ready">{t('unlock.unlockBadge')}</span>
                </button>
              </Show>

              {/* App password — the always-available method; its input is below. */}
              <div class="unlock-method-row is-on">
                <KeyRound size={16} strokeWidth={1.75} class="unlock-method-ico" />
                <span class="unlock-method-info">
                  <span class="unlock-method-name">{t('unlock.appPassword')}</span>
                  <span class="unlock-method-note muted">{t('unlock.alwaysAvailable')}</span>
                </span>
                <span class="unlock-method-badge is-ready">{t('unlock.ready')}</span>
              </div>
            </div>

            <div class="field unlock-field">
              <input
                type="password"
                aria-label={t('unlock.appPassword')}
                placeholder={t('unlock.appPasswordPlaceholder')}
                autocomplete="current-password"
                value={appPassword()}
                onInput={(e) => setAppPassword(e.currentTarget.value)}
                onKeyDown={(e) => e.key === 'Enter' && void unlock()}
              />
            </div>
            <button class="primary full" disabled={busy()} onClick={() => void unlock()}>
              {t('unlock.unlockAll')}
            </button>
          </Show>

          <button class="ghost full unlock-logout" onClick={() => void logout()}>
            {t('unlock.logOutEverything')}
          </button>
        </div>
      </Show>
    </div>
  );
}
