import { createSignal } from 'solid-js';
import { ShieldCheck } from 'lucide-solid';
import { ipc } from '../lib/ipc.ts';
import { refreshSession } from '../state/session.ts';
import { pushToast, toastError } from '../state/toast.ts';
import './Onboarding.css';

/** First-run: create the single app password that unlocks every connection. */
export default function AppUnlockSetup() {
  const [pw, setPw] = createSignal('');
  const [confirm, setConfirm] = createSignal('');
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
      await ipc.configureAppUnlock(pw());
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
