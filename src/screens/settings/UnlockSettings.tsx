// Settings › Unlock — the app-unlock methods, structured one after the other in
// the order they apply:
//   1. App password (always on) — change it.
//   2. This device (machine binding) — always on: a device key is mixed into the
//      unlock so the stored data can't be opened on another machine.
//   3. Windows Hello / Touch ID — biometric/PIN unlock.
//   4. Connections — what one app unlock opens (per-connection status; the
//      unlock/2FA flow itself lives on the Connections page).

import { createSignal, For, onMount, Show } from 'solid-js';
import { Check, Fingerprint, KeyRound, Laptop, Minus, Users } from 'lucide-solid';
import { ipc } from '../../lib/ipc.ts';
import type { ConnectionSummary } from '../../lib/types.ts';
import { refreshSession, status } from '../../state/session.ts';
import { pushToast, toastError } from '../../state/toast.ts';
import { SettingRow, ToggleRow } from '../../components/settings/SettingsControls.tsx';
import type { Page } from '../Settings.tsx';

// Platform-appropriate name for the biometric unlock method (Windows Hello /
// Touch ID / generic). The backend picks the matching consent gate per OS.
const UA = typeof navigator !== 'undefined' ? navigator.userAgent : '';
const BIOMETRIC_NAME = /Mac/.test(UA)
  ? 'Touch ID'
  : /Windows/.test(UA)
    ? 'Windows Hello'
    : 'Biometric unlock';

export default function UnlockSettings(props: { goto?: (p: Page) => void }) {
  const [newPw, setNewPw] = createSignal('');
  const [confirmPw, setConfirmPw] = createSignal('');
  const [busy, setBusy] = createSignal(false);

  const [helloAvailable, setHelloAvailable] = createSignal(false);
  const [helloBusy, setHelloBusy] = createSignal(false);
  const [connections, setConnections] = createSignal<ConnectionSummary[]>([]);

  onMount(() => {
    void (async () => {
      try {
        setHelloAvailable(await ipc.helloAvailable());
      } catch (err) {
        toastError(err);
      }
    })();
    void (async () => {
      try {
        setConnections(await ipc.listConnections());
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
      <p class="muted settings-help">
        How Agate is unlocked on this device. One app secret opens every connection. Each method is
        listed below in order.
      </p>

      {/* 1 — App password (always required) */}
      <section class="settings-section">
        <h3>
          <KeyRound size={14} strokeWidth={1.75} /> App password
          <MethodState on />
        </h3>
        <p class="muted settings-help">
          Change the single app password. Enter the new password twice to apply — stored master
          passwords are re-protected automatically and stay bound to this machine.
        </p>
        <div class="field">
          <label>New app password</label>
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
        <div class="settings-actions">
          <button class="primary" disabled={busy()} onClick={() => void changeAppPw()}>
            Update app unlock
          </button>
        </div>
      </section>

      {/* 2 — This device (machine binding, always on) */}
      <section class="settings-section">
        <h3>
          <Laptop size={14} strokeWidth={1.75} /> This device
          <MethodState on />
        </h3>
        <p class="muted settings-help">
          A device key is always mixed into the unlock, so the stored data can't be opened on
          another machine. This can't be turned off.
        </p>
      </section>

      {/* 3 — Biometric unlock (Windows Hello / Touch ID) */}
      <section class="settings-section">
        <h3>
          <Fingerprint size={14} strokeWidth={1.75} /> {BIOMETRIC_NAME}
          <MethodState on={status().helloConfigured} unavailable={!helloAvailable()} />
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
          <ToggleRow
            label={`Use ${BIOMETRIC_NAME}`}
            checked={status().helloConfigured}
            disabled={helloBusy()}
            onChange={() => void toggleHello()}
          />
        </Show>
      </section>

      {/* 4 — Connections: what one app unlock opens. */}
      <section class="settings-section">
        <h3>
          <Users size={14} strokeWidth={1.75} /> Connections
        </h3>
        <p class="muted settings-help">
          One app unlock opens every connection below. Locked ones (and 2FA re-prompts) are
          completed on the Connections page.
        </p>
        <Show
          when={connections().length > 0}
          fallback={<p class="muted settings-help">No connections yet.</p>}
        >
          <For each={connections()}>
            {(c) => (
              <SettingRow
                label={c.email}
                desc={c.storeCredentials ? 'Auto-unlocks with the app' : 'Manual unlock only'}
                control={
                  <span class="settings-conn-state">
                    <MethodState on={c.unlocked} />
                    <Show when={!c.unlocked && props.goto}>
                      <button class="ghost" onClick={() => props.goto?.('connections')}>
                        Unlock…
                      </button>
                    </Show>
                  </span>
                }
              />
            )}
          </For>
        </Show>
      </section>
    </div>
  );
}

// Inline on/off/unavailable status pill shown in an unlock-method section header.
function MethodState(props: { on?: boolean; unavailable?: boolean }) {
  return (
    <Show
      when={!props.unavailable}
      fallback={<span class="muted settings-method-state settings-h3-state">Unavailable</span>}
    >
      <span class="settings-method-state settings-h3-state" classList={{ on: props.on }}>
        <Show when={props.on} fallback={<Minus size={13} strokeWidth={2} />}>
          <Check size={13} strokeWidth={2.5} />
        </Show>
        {props.on ? 'On' : 'Off'}
      </span>
    </Show>
  );
}
