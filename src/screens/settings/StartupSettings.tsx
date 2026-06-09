// Settings › Appearance — "Startup" section: launch Agate at login. Reads the
// current state from the OS on mount (get_autostart) and toggles it via
// set_autostart. Both are thin Rust commands over tauri-plugin-autostart.

import { createSignal, onMount } from 'solid-js';
import { Power } from 'lucide-solid';
import { ipc } from '../../lib/ipc.ts';
import { t } from '../../lib/i18n.ts';
import { toastError } from '../../state/toast.ts';

export default function StartupSettings() {
  const [enabled, setEnabled] = createSignal(false);
  const [busy, setBusy] = createSignal(false);

  onMount(() => {
    void (async () => {
      try {
        setEnabled(await ipc.getAutostart());
      } catch (err) {
        toastError(err);
      }
    })();
  });

  async function toggle() {
    setBusy(true);
    const next = !enabled();
    try {
      await ipc.setAutostart(next);
      setEnabled(next);
    } catch (err) {
      toastError(err);
    } finally {
      setBusy(false);
    }
  }

  return (
    <section class="settings-section">
      <h3>
        <Power size={14} strokeWidth={1.75} /> {t('startup.title')}
      </h3>
      <p class="muted settings-help">{t('startup.help')}</p>
      <div class="settings-row">
        <span>{t('startup.launch')}</span>
        <button
          classList={{ primary: !enabled(), danger: enabled() }}
          disabled={busy()}
          onClick={() => void toggle()}
        >
          {enabled() ? t('common.disable') : t('common.enable')}
        </button>
      </div>
    </section>
  );
}
