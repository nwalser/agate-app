// Settings › Autofill — choose how Agate watches other apps' login fields:
// Off / on a hotkey / always-watch. Persisted app-wide (config.autofill_mode);
// the backend starts or stops the platform watcher on change. Windows-only for
// now — other platforms show the feature as unavailable.

import { createSignal, onMount, Show } from 'solid-js';
import { Wand2 } from 'lucide-solid';
import { ipc } from '../../lib/ipc.ts';
import { t } from '../../lib/i18n.ts';
import { toastError } from '../../state/toast.ts';
import { Select, SettingRow } from '../../components/settings/SettingsControls.tsx';
import type { AutofillMode } from '../../lib/types.ts';

export default function AutofillSettings() {
  const [mode, setMode] = createSignal<AutofillMode>('off');
  const [supported, setSupported] = createSignal(true);
  const [hotkey, setHotkey] = createSignal('');
  const [busy, setBusy] = createSignal(false);

  onMount(() => {
    void (async () => {
      try {
        const status = await ipc.autofillStatus();
        setMode(status.mode);
        setSupported(status.supported);
        setHotkey(status.hotkey);
      } catch (err) {
        toastError(err);
      }
    })();
  });

  // Persist first, reflect only on success — a failed write must not leave the
  // picker lying about the stored mode.
  async function change(next: AutofillMode) {
    if (next === mode()) return;
    setBusy(true);
    try {
      await ipc.autofillSetMode(next);
      setMode(next);
    } catch (err) {
      toastError(err);
    } finally {
      setBusy(false);
    }
  }

  const options = (): { value: AutofillMode; label: string }[] => [
    { value: 'off', label: t('autofill.mode.off') },
    { value: 'hotkey', label: t('autofill.mode.hotkey') },
    { value: 'watch', label: t('autofill.mode.watch') },
  ];

  const desc = () => {
    switch (mode()) {
      case 'hotkey':
        return t('autofill.hotkeyHint', { hotkey: hotkey() });
      case 'watch':
        return t('autofill.watchHint');
      default:
        return t('autofill.offHint');
    }
  };

  return (
    <section class="settings-section">
      <h3>
        <Wand2 size={14} strokeWidth={1.75} /> {t('autofill.title')}
      </h3>
      <p class="muted settings-help">{t('autofill.help')}</p>
      <Show
        when={supported()}
        fallback={<p class="muted settings-help">{t('autofill.unsupported')}</p>}
      >
        <SettingRow
          label={t('autofill.modeLabel')}
          desc={desc()}
          dim={busy()}
          control={
            <Select
              value={mode()}
              options={options()}
              onChange={(v) => void change(v)}
              ariaLabel={t('autofill.modeLabel')}
            />
          }
        />
        <p class="muted settings-help">{t('autofill.securityNote')}</p>
      </Show>
    </section>
  );
}
