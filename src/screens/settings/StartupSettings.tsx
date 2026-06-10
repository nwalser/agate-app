// Settings › Appearance — "Startup" section: launch Agate at login, and
// close-to-tray (closing the main window hides to the tray instead of
// quitting). Autostart lives in the OS (tauri-plugin-autostart); close-to-tray
// is persisted app config read by the close handler in lib.rs.

import { createSignal, onMount } from 'solid-js';
import { Power } from 'lucide-solid';
import { ipc } from '../../lib/ipc.ts';
import { t } from '../../lib/i18n.ts';
import { toastError } from '../../state/toast.ts';
import { ToggleRow } from '../../components/settings/SettingsControls.tsx';

export default function StartupSettings() {
  const [autostart, setAutostart] = createSignal(false);
  const [closeToTray, setCloseToTray] = createSignal(false);
  const [busy, setBusy] = createSignal(false);

  onMount(() => {
    void (async () => {
      try {
        const [auto, tray] = await Promise.all([ipc.getAutostart(), ipc.getCloseToTray()]);
        setAutostart(auto);
        setCloseToTray(tray);
      } catch (err) {
        toastError(err);
      }
    })();
  });

  // Shared toggle shape: persist first, reflect only on success — a failed
  // write must not leave the switch lying about the stored state.
  async function toggle(current: () => boolean, persist: (v: boolean) => Promise<void>, reflect: (v: boolean) => void) {
    setBusy(true);
    const next = !current();
    try {
      await persist(next);
      reflect(next);
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
      <ToggleRow
        label={t('startup.launch')}
        checked={autostart()}
        disabled={busy()}
        onChange={() => void toggle(autostart, ipc.setAutostart, setAutostart)}
      />
      <ToggleRow
        label={t('startup.closeToTray')}
        desc={t('startup.closeToTrayDesc')}
        checked={closeToTray()}
        disabled={busy()}
        onChange={() => void toggle(closeToTray, ipc.setCloseToTray, setCloseToTray)}
      />
    </section>
  );
}
