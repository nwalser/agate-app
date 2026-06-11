// Master-password reprompt gate. Shown before revealing/copying a reprompt-
// protected item's secrets: the user re-enters the app password, which is checked
// by the backend (verify_app_password) without unlocking or changing any state.
// On success the caller marks the item verified for the session (state/reprompt).

import { createSignal, onMount, Show } from 'solid-js';
import { Lock } from 'lucide-solid';
import { ipc } from '../lib/ipc.ts';
import { t } from '../lib/i18n.ts';
import { toastError } from '../state/toast.ts';
import './RepromptGate.css';

export default function RepromptGate(props: {
  itemName: string;
  onVerified: () => void;
  onClose: () => void;
}) {
  const [pw, setPw] = createSignal('');
  const [busy, setBusy] = createSignal(false);
  const [error, setError] = createSignal(false);
  let input: HTMLInputElement | undefined;

  onMount(() => input?.focus());

  async function submit(e: Event) {
    e.preventDefault();
    if (!pw() || busy()) return;
    setBusy(true);
    setError(false);
    try {
      const ok = await ipc.verifyAppPassword(pw());
      if (ok) {
        props.onVerified();
      } else {
        setError(true);
        setPw('');
        input?.focus();
      }
    } catch (err) {
      toastError(err);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div class="reprompt-backdrop" onClick={() => props.onClose()}>
      <form
        class="reprompt-card"
        onClick={(e) => e.stopPropagation()}
        onSubmit={(e) => void submit(e)}
      >
        <div class="reprompt-title">
          <Lock size={15} strokeWidth={1.75} /> {t('reprompt.title')}
        </div>
        <p class="muted reprompt-desc">{t('reprompt.desc', { name: props.itemName })}</p>
        <input
          ref={(el) => (input = el)}
          type="password"
          autocomplete="off"
          placeholder={t('reprompt.placeholder')}
          value={pw()}
          onInput={(e) => setPw(e.currentTarget.value)}
        />
        <Show when={error()}>
          <p class="error-text">{t('reprompt.incorrect')}</p>
        </Show>
        <div class="reprompt-actions">
          <button type="button" class="ghost" onClick={() => props.onClose()}>
            {t('common.cancel')}
          </button>
          <button type="submit" class="primary" disabled={busy() || !pw()}>
            {busy() ? t('reprompt.checking') : t('reprompt.unlock')}
          </button>
        </div>
      </form>
    </div>
  );
}
