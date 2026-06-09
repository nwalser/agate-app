// Settings › Unlock — manage the app-unlock methods:
//   * App password (always on) — change it.
//   * This device (machine binding) — always on: a device key is mixed into the
//     unlock so the stored data can't be opened on another machine.
//   * Windows Hello — biometric/PIN unlock (Windows only).

import { createSignal, onMount, Show } from 'solid-js';
import { Check, Fingerprint, KeyRound, Laptop, Minus } from 'lucide-solid';
import { ipc } from '../../lib/ipc.ts';
import { refreshSession, status } from '../../state/session.ts';
import { pushToast, toastError } from '../../state/toast.ts';

// Platform-appropriate name for the biometric unlock method (Windows Hello /
// Touch ID / generic). The backend picks the matching consent gate per OS.
const UA = typeof navigator !== 'undefined' ? navigator.userAgent : '';
const BIOMETRIC_NAME = /Mac/.test(UA)
  ? 'Touch ID'
  : /Windows/.test(UA)
    ? 'Windows Hello'
    : 'Biometric unlock';

export default function UnlockSettings() {
  const [newPw, setNewPw] = createSignal('');
  const [confirmPw, setConfirmPw] = createSignal('');
  const [busy, setBusy] = createSignal(false);

  const [helloAvailable, setHelloAvailable] = createSignal(false);
  const [helloBusy, setHelloBusy] = createSignal(false);

  onMount(() => {
    void (async () => {
      try {
        setHelloAvailable(await ipc.helloAvailable());
      } catch (err) {
        toastError(err);
      }
    })();
  });

  async function changeAppPw() {
    if (newPw().length < 8) {
      pushToast('error', 'App password must be at least 8 characters.');
      return;
    }
    if (newPw() !== confirmPw()) {
      pushToast('error', 'Passwords do not match.');
      return;
    }
    setBusy(true);
    try {
      await ipc.changeAppUnlock(newPw());
      setNewPw('');
      setConfirmPw('');
      await refreshSession();
      pushToast('success', 'App unlock updated.');
    } catch (err) {
      toastError(err);
    } finally {
      setBusy(false);
    }
  }

  async function toggleHello() {
    setHelloBusy(true);
    try {
      if (status().helloConfigured) {
        await ipc.helloDisable();
        await refreshSession();
        pushToast('success', `${BIOMETRIC_NAME} unlock disabled.`);
      } else {
        await ipc.helloEnable();
        await refreshSession();
        pushToast('success', `${BIOMETRIC_NAME} unlock enabled.`);
      }
    } catch (err) {
      toastError(err);
    } finally {
      setHelloBusy(false);
    }
  }

  return (
    <div class="settings-page">
      <section class="settings-section">
        <h3>Unlock methods</h3>
        <p class="muted settings-help">
          How Agate is unlocked on this device. One app secret opens every connection.
        </p>
        <MethodRow icon={KeyRound} label="App password" on subtitle="Always required" />
        <MethodRow icon={Laptop} label="This device" on
          subtitle="Always bound to this machine" />
        <MethodRow
          icon={Fingerprint}
          label={BIOMETRIC_NAME}
          on={status().helloConfigured}
          unavailable={!helloAvailable()}
          subtitle="Face, fingerprint, or PIN"
        />
      </section>

      <section class="settings-section">
        <h3>
          <KeyRound size={14} strokeWidth={1.75} /> App password
        </h3>
        <p class="muted settings-help">
          Change the single app password. Enter the new password twice to apply — stored master
          passwords are re-protected automatically and stay bound to this machine.
        </p>
        <div class="field">
          <label>App password</label>
          <input
            type="password"
            autocomplete="new-password"
            value={newPw()}
            onInput={(e) => setNewPw(e.currentTarget.value)}
          />
        </div>
        <div class="field">
          <label>Confirm password</label>
          <input
            type="password"
            autocomplete="new-password"
            value={confirmPw()}
            onInput={(e) => setConfirmPw(e.currentTarget.value)}
          />
        </div>
        <button class="primary" disabled={busy()} onClick={() => void changeAppPw()}>
          Update app unlock
        </button>
      </section>

      <section class="settings-section">
        <h3>
          <Fingerprint size={14} strokeWidth={1.75} /> {BIOMETRIC_NAME}
        </h3>
        <p class="muted settings-help">
          Unlock your vault with {BIOMETRIC_NAME} (face, fingerprint, or PIN) instead of typing a
          password.
        </p>
        <Show
          when={helloAvailable()}
          fallback={
            <div class="settings-row settings-row-disabled">
              <span class="muted">{BIOMETRIC_NAME} is not available on this device.</span>
            </div>
          }
        >
          <div class="settings-row">
            <span>{status().helloConfigured ? 'Enabled' : 'Disabled'}</span>
            <button
              classList={{ primary: !status().helloConfigured, danger: status().helloConfigured }}
              disabled={helloBusy()}
              onClick={() => void toggleHello()}
            >
              {status().helloConfigured ? 'Disable' : 'Enable'}
            </button>
          </div>
        </Show>
      </section>
    </div>
  );
}

// A read-only summary row showing whether one unlock method is active.
function MethodRow(props: {
  icon: typeof KeyRound;
  label: string;
  subtitle: string;
  on?: boolean;
  unavailable?: boolean;
}) {
  const Icon = props.icon;
  return (
    <div class="settings-method">
      <Icon size={16} strokeWidth={1.6} class="settings-method-icon" />
      <span class="settings-method-text">
        <span class="settings-method-label">{props.label}</span>
        <span class="muted settings-method-sub">{props.subtitle}</span>
      </span>
      <Show
        when={!props.unavailable}
        fallback={<span class="muted settings-method-state">Unavailable</span>}
      >
        <span class="settings-method-state" classList={{ on: props.on }}>
          <Show when={props.on} fallback={<Minus size={13} strokeWidth={2} />}>
            <Check size={13} strokeWidth={2.5} />
          </Show>
          {props.on ? 'On' : 'Off'}
        </span>
      </Show>
    </div>
  );
}
