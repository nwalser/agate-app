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
import { t } from '../../lib/i18n.ts';
import type { ConnectionSummary } from '../../lib/types.ts';
import { refreshSession, status } from '../../state/session.ts';
import { pushToast, toastError } from '../../state/toast.ts';
import { SettingRow, ToggleRow } from '../../components/settings/SettingsControls.tsx';
import type { Page } from '../Settings.tsx';

// Platform-appropriate name for the biometric unlock method (Windows Hello /
// Touch ID / generic). The backend picks the matching consent gate per OS.
// A function (not a constant) so the generic fallback re-localizes on a language
// flip; the platform names (Touch ID / Windows Hello) are brand tokens, kept literal.
const UA = typeof navigator !== 'undefined' ? navigator.userAgent : '';
const biometricName = (): string =>
  /Mac/.test(UA)
    ? 'Touch ID'
    : /Windows/.test(UA)
      ? 'Windows Hello'
      : t('unlockSettings.biometricGeneric');

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
      pushToast('error', t('unlockSettings.pwMinLength'));
      return;
    }
    if (newPw() !== confirmPw()) {
      pushToast('error', t('unlockSettings.pwMismatch'));
      return;
    }
    setBusy(true);
    try {
      await ipc.changeAppUnlock(newPw());
      setNewPw('');
      setConfirmPw('');
      await refreshSession();
      pushToast('success', t('unlockSettings.appUnlockUpdated'));
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
        pushToast('success', t('unlockSettings.biometricDisabled', { name: biometricName() }));
      } else {
        await ipc.helloEnable();
        await refreshSession();
        pushToast('success', t('unlockSettings.biometricEnabled', { name: biometricName() }));
      }
    } catch (err) {
      toastError(err);
    } finally {
      setHelloBusy(false);
    }
  }

  return (
    <div class="settings-page">
      <p class="muted settings-help">{t('unlockSettings.intro')}</p>

      {/* 1 — App password (always required) */}
      <section class="settings-section">
        <h3>
          <KeyRound size={14} strokeWidth={1.75} /> {t('unlockSettings.appPassword')}
          <MethodState on />
        </h3>
        <p class="muted settings-help">{t('unlockSettings.appPasswordHelp')}</p>
        <div class="field">
          <label>{t('unlockSettings.newAppPassword')}</label>
          <input
            type="password"
            autocomplete="new-password"
            value={newPw()}
            onInput={(e) => setNewPw(e.currentTarget.value)}
          />
        </div>
        <div class="field">
          <label>{t('unlockSettings.confirmPassword')}</label>
          <input
            type="password"
            autocomplete="new-password"
            value={confirmPw()}
            onInput={(e) => setConfirmPw(e.currentTarget.value)}
          />
        </div>
        <div class="settings-actions">
          <button class="primary" disabled={busy()} onClick={() => void changeAppPw()}>
            {t('unlockSettings.updateAppUnlock')}
          </button>
        </div>
      </section>

      {/* 2 — This device (machine binding, always on) */}
      <section class="settings-section">
        <h3>
          <Laptop size={14} strokeWidth={1.75} /> {t('unlockSettings.thisDevice')}
          <MethodState on />
        </h3>
        <p class="muted settings-help">{t('unlockSettings.thisDeviceHelp')}</p>
      </section>

      {/* 3 — Biometric unlock (Windows Hello / Touch ID) */}
      <section class="settings-section">
        <h3>
          <Fingerprint size={14} strokeWidth={1.75} /> {biometricName()}
          <MethodState on={status().helloConfigured} unavailable={!helloAvailable()} />
        </h3>
        <p class="muted settings-help">{t('unlockSettings.biometricHelp', { name: biometricName() })}</p>
        <Show
          when={helloAvailable()}
          fallback={
            <div class="settings-row settings-row-disabled">
              <span class="muted">{t('unlockSettings.biometricUnavailable', { name: biometricName() })}</span>
            </div>
          }
        >
          <ToggleRow
            label={t('unlockSettings.useBiometric', { name: biometricName() })}
            checked={status().helloConfigured}
            disabled={helloBusy()}
            onChange={() => void toggleHello()}
          />
        </Show>
      </section>

      {/* 4 — Connections: what one app unlock opens. */}
      <section class="settings-section">
        <h3>
          <Users size={14} strokeWidth={1.75} /> {t('unlockSettings.connections')}
        </h3>
        <p class="muted settings-help">{t('unlockSettings.connectionsHelp')}</p>
        <Show
          when={connections().length > 0}
          fallback={<p class="muted settings-help">{t('unlockSettings.noConnections')}</p>}
        >
          <For each={connections()}>
            {(c) => (
              <SettingRow
                label={c.email}
                desc={c.storeCredentials ? t('unlockSettings.autoUnlocks') : t('unlockSettings.manualOnly')}
                control={
                  <span class="settings-conn-state">
                    <MethodState on={c.unlocked} />
                    <Show when={!c.unlocked && props.goto}>
                      <button class="ghost" onClick={() => props.goto?.('connections')}>
                        {t('unlockSettings.unlockEllipsis')}
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
      fallback={<span class="muted settings-method-state settings-h3-state">{t('unlockSettings.unavailable')}</span>}
    >
      <span class="settings-method-state settings-h3-state" classList={{ on: props.on }}>
        <Show when={props.on} fallback={<Minus size={13} strokeWidth={2} />}>
          <Check size={13} strokeWidth={2.5} />
        </Show>
        {props.on ? t('unlockSettings.on') : t('unlockSettings.off')}
      </span>
    </Show>
  );
}
