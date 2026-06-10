// Settings → Security: export every unlocked vault to a file. The export is
// CLEARTEXT (all passwords in plain text), so the copy warns loudly and the
// backend only runs on this explicit button press. The written path is surfaced
// in a toast so the user knows exactly where the sensitive file landed.

import { createSignal } from 'solid-js';
import { Download, Upload } from 'lucide-solid';
import { ipc } from '../lib/ipc.ts';
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
      pushToast('success', `Vault exported to ${path}`);
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
        pushToast('success', `Imported ${count} item${count === 1 ? '' : 's'}. They appear after the next sync.`);
      } else {
        pushToast('info', 'No items imported.');
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
        <Download size={14} strokeWidth={1.75} /> Export vault
      </h3>
      <p class="muted settings-help">
        Save every unlocked vault to a file in your Downloads folder.{' '}
        <strong>The file is unencrypted</strong> — it contains all your passwords in plain text.
        Keep it somewhere safe and delete it when you're done. Trashed items are not included.
      </p>
      <Select ariaLabel="Export format" value={format()} options={FORMATS} onChange={(v) => setFormat(v)} />
      <div class="settings-actions">
        <button class="primary" disabled={busy()} onClick={() => void exportNow()}>
          {busy() ? 'Exporting…' : 'Export vault'}
        </button>
      </div>

      <h3 class="sec-subhead">
        <Upload size={14} strokeWidth={1.75} /> Import
      </h3>
      <p class="muted settings-help">
        Import logins and notes from a Bitwarden-compatible <strong>CSV</strong> file into
        {activeVault() ? ' the selected vault' : ' your first connection'}. Items appear after the
        next sync.
      </p>
      <div class="settings-actions">
        <button disabled={importing()} onClick={() => void importNow()}>
          {importing() ? 'Importing…' : 'Choose CSV file…'}
        </button>
      </div>
    </section>
  );
}
