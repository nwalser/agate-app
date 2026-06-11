// Settings → Security: export every unlocked vault to a file. The export is
// CLEARTEXT (all passwords in plain text), so the copy warns loudly and the
// backend only runs on this explicit button press. The written path is surfaced
// in a toast so the user knows exactly where the sensitive file landed.

import { createSignal } from 'solid-js';
import { Download, Upload } from 'lucide-solid';
import { ipc } from '../lib/ipc.ts';
import { t } from '../lib/i18n.ts';
import type { ExportFormat } from '../lib/types.ts';
import { activeVault } from '../state/ui.ts';
import { pushToast, toastError } from '../state/toast.ts';
import { Select } from './settings/SettingsControls.tsx';

const FORMATS: { value: ExportFormat; label: string }[] = [
  { value: 'json', label: 'JSON' },
  { value: 'csv', label: 'CSV' },
];

export default function ExportSettings() {
  const [format, setFormat] = createSignal<ExportFormat>('json');
  const [busy, setBusy] = createSignal(false);
  const [importing, setImporting] = createSignal(false);

  async function exportNow() {
    setBusy(true);
    try {
      const path = await ipc.exportVault(format());
      pushToast('success', t('export.exportedTo', { path }));
    } catch (err) {
      toastError(err);
    } finally {
      setBusy(false);
    }
  }

  async function importNow() {
    setImporting(true);
    try {
      const count = await ipc.importVault(activeVault());
      if (count > 0) {
        pushToast(
          'success',
          count === 1 ? t('export.importedOne', { count }) : t('export.importedMany', { count }),
        );
      } else {
        pushToast('info', t('export.noItemsImported'));
      }
    } catch (err) {
      toastError(err);
    } finally {
      setImporting(false);
    }
  }

  return (
    <section class="settings-section">
      <h3>
        <Download size={14} strokeWidth={1.75} /> {t('export.exportTitle')}
      </h3>
      <p class="muted settings-help">
        {t('export.exportHelpBefore')}{' '}
        <strong>{t('export.exportHelpEmphasis')}</strong>{' '}
        {t('export.exportHelpAfter')}
      </p>
      <Select ariaLabel={t('export.formatAriaLabel')} value={format()} options={FORMATS} onChange={(v) => setFormat(v)} />
      <div class="settings-actions">
        <button class="primary" disabled={busy()} onClick={() => void exportNow()}>
          {busy() ? t('export.exporting') : t('export.exportVault')}
        </button>
      </div>

      <h3 class="sec-subhead">
        <Upload size={14} strokeWidth={1.75} /> {t('export.importTitle')}
      </h3>
      <p class="muted settings-help">
        {t('export.importHelpBefore')} <strong>CSV</strong>{' '}
        {activeVault() ? t('export.importTargetSelected') : t('export.importTargetFirst')}{' '}
        {t('export.importHelpAfter')}
      </p>
      <div class="settings-actions">
        <button disabled={importing()} onClick={() => void importNow()}>
          {importing() ? t('export.importing') : t('export.chooseCsvFile')}
        </button>
      </div>
    </section>
  );
}
