import { createSignal } from 'solid-js';
import { Laptop, ShieldCheck } from 'lucide-solid';
import { ipc } from '../lib/ipc.ts';
import { refreshSession } from '../state/session.ts';
import { pushToast, toastError } from '../state/toast.ts';
import './Onboarding.css';

/** First-run: create the single app password that unlocks every connection. */
export default function AppUnlockSetup() {
  const [pw, setPw] = createSignal('');
  const [confirm, setConfirm] = createSignal('');
  // Bind the unlock to this machine by default — strictly stronger, and the blob
  // can't be opened if copied to another device.
  const [deviceBound, setDeviceBound] = createSignal(true);
  const [busy, setBusy] = createSignal(false);

  async function create() {
    if (pw().length < 8) {
      pushToast('error', 'App password must be at least 8 characters.');
      return;
    }
    if (pw() !== confirm()) {
      pushToast('error', 'Passwords do not match.');
      return;
    }
    setBusy(true);
    try {
      await ipc.configureAppUnlock(pw(), deviceBound());
      setPw('');
      setConfirm('');
      await refreshSession();
      pushToast('success', 'App unlock set — now add your first connection.');
    } catch (err) {
      toastError(err);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div class="onboarding">
      <div class="onboarding-card">
        <div class="onboarding-brand">
          <ShieldCheck size={22} strokeWidth={1.75} />
          <span>Agate</span>
        </div>
        <div class="onboarding-step">
          <p class="muted onboarding-sub">
            Create one app password. It unlocks every Bitwarden connection you add and is the only
            secret you'll type to open Agate. Choose something strong — it protects all of your
            vaults on this device.
          </p>
          <div class="field">
            <label>App password</label>
            <input
              type="password"
              autocomplete="new-password"
              value={pw()}
              onInput={(e) => setPw(e.currentTarget.value)}
            />
          </div>
          <div class="field">
            <label>Confirm app password</label>
            <input
              type="password"
              autocomplete="new-password"
              value={confirm()}
              onInput={(e) => setConfirm(e.currentTarget.value)}
              onKeyDown={(e) => e.key === 'Enter' && void create()}
            />
          </div>

          <button
            type="button"
            class="unlock-method"
            classList={{ active: deviceBound() }}
            onClick={() => setDeviceBound((v) => !v)}
          >
            <Laptop size={18} strokeWidth={1.6} />
            <span class="unlock-method-text">
              <span class="unlock-method-title">Bind to this computer</span>
              <span class="muted unlock-method-sub">
                Mix a device key into the unlock so your vault can only be opened on this machine —
                even with the password, the data is useless if copied elsewhere.
              </span>
            </span>
            <input type="checkbox" checked={deviceBound()} tabindex={-1} />
          </button>

          <button class="primary full" disabled={busy()} onClick={() => void create()}>
            {busy() ? 'Setting up…' : 'Set app password'}
          </button>
        </div>
        <p class="onboarding-disclaimer muted">
          Unofficial client — not affiliated with Bitwarden, Inc.
        </p>
      </div>
    </div>
  );
}
