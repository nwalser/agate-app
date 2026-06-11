import { createSignal } from 'solid-js';
import { Check, Laptop, ShieldCheck } from 'lucide-solid';
import { ipc } from '../lib/ipc.ts';
import { t } from '../lib/i18n.ts';
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
      pushToast('error', t('setup.passwordTooShort'));
      return;
    }
    if (pw() !== confirm()) {
      pushToast('error', t('setup.passwordsDoNotMatch'));
      return;
    }
    setBusy(true);
    try {
      await ipc.configureAppUnlock(pw());
      setPw('');
      setConfirm('');
      await refreshSession();
      pushToast('success', t('setup.appUnlockSet'));
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
            {t('setup.intro')}
          </p>
          <div class="field">
            <label>{t('setup.appPassword')}</label>
            <input
              type="password"
              autocomplete="new-password"
              value={pw()}
              onInput={(e) => setPw(e.currentTarget.value)}
            />
          </div>
          <div class="field">
            <label>{t('setup.confirmAppPassword')}</label>
            <input
              type="password"
              autocomplete="new-password"
              value={confirm()}
              onInput={(e) => setConfirm(e.currentTarget.value)}
              onKeyDown={(e) => e.key === 'Enter' && void create()}
            />
          </div>

          <div class="unlock-method active">
            <Laptop size={18} strokeWidth={1.6} />
            <span class="unlock-method-text">
              <span class="unlock-method-title">{t('setup.boundToComputerTitle')}</span>
              <span class="muted unlock-method-sub">
                {t('setup.boundToComputerSub')}
              </span>
            </span>
            <Check size={18} strokeWidth={2} />
          </div>

          <button class="primary full" disabled={busy()} onClick={() => void create()}>
            {busy() ? t('setup.settingUp') : t('setup.setAppPassword')}
          </button>
        </div>
        <p class="onboarding-disclaimer muted">
          {t('setup.disclaimer')}
        </p>
      </div>
    </div>
  );
}
