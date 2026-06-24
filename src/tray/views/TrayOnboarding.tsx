// First-run onboarding inside the tray popup: create the single app password
// (the unified app unlock) before any vault connection exists. Popup-scale
// port of the main window's AppUnlockSetup flow — same ipc.configureAppUnlock
// call, same rules (min 8 chars, confirm must match), but validation shows
// inline (the popup is too small for toast-only feedback); IPC failures still
// surface through the toast pipeline. On success the caller navigates to the
// add-vault view via `onDone`.

import { createMemo, createSignal, Show } from 'solid-js';
import type { JSX } from 'solid-js';
import { LoaderCircle } from 'lucide-solid';
import { AgateLogo } from '../../components/AgateLogo.tsx';
import { ipc } from '../../lib/ipc.ts';
import { t } from '../../lib/i18n.ts';
import { toastError } from '../../state/toast.ts';
import './TrayOnboarding.css';

const MIN_PASSWORD_LENGTH = 8;

export default function TrayOnboarding(props: { onDone: () => void }): JSX.Element {
  const [pw, setPw] = createSignal('');
  const [confirm, setConfirm] = createSignal('');
  const [busy, setBusy] = createSignal(false);
  // Inline validation only appears after the first submit attempt, then
  // tracks every keystroke so the message clears the moment the input is fixed.
  const [attempted, setAttempted] = createSignal(false);

  const validationError = createMemo<string | null>(() => {
    if (!attempted()) return null;
    if (pw().length < MIN_PASSWORD_LENGTH) return t('unlockSettings.pwMinLength');
    if (pw() !== confirm()) return t('unlockSettings.pwMismatch');
    return null;
  });

  async function create(): Promise<void> {
    setAttempted(true);
    if (pw().length < MIN_PASSWORD_LENGTH || pw() !== confirm()) return;
    setBusy(true);
    try {
      await ipc.configureAppUnlock(pw());
      setPw('');
      setConfirm('');
      props.onDone();
    } catch (err) {
      toastError(err);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div class="tray-onboard">
      <div class="tray-onboard-brand">
        <AgateLogo size={26} />
        <span>Agate</span>
      </div>
      <p class="tray-onboard-intro">{t('trayOnboard.intro')}</p>

      <form
        class="tray-onboard-form"
        onSubmit={(e) => {
          e.preventDefault();
          void create();
        }}
      >
        <label class="tray-onboard-label" for="tray-onboard-pw">
          {t('trayOnboard.appPassword')}
        </label>
        <input
          id="tray-onboard-pw"
          type="password"
          autocomplete="new-password"
          value={pw()}
          onInput={(e) => setPw(e.currentTarget.value)}
        />

        <label class="tray-onboard-label" for="tray-onboard-confirm">
          {t('trayOnboard.confirmPassword')}
        </label>
        <input
          id="tray-onboard-confirm"
          type="password"
          autocomplete="new-password"
          value={confirm()}
          onInput={(e) => setConfirm(e.currentTarget.value)}
        />

        <Show when={validationError()}>
          {(msg) => (
            <p class="tray-onboard-error" role="alert">
              {msg()}
            </p>
          )}
        </Show>

        <button class="tray-onboard-submit" type="submit" disabled={busy()}>
          <Show when={busy()}>
            <LoaderCircle size={15} strokeWidth={2} class="tray-onboard-spin" />
          </Show>
          {busy() ? t('trayOnboard.creating') : t('trayOnboard.create')}
        </button>
      </form>

      <p class="tray-onboard-hint">{t('trayOnboard.hint')}</p>
    </div>
  );
}
