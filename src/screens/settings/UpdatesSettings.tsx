// Settings › Updates — check for and install a newer Agate release.

import { createSignal, Show } from 'solid-js';
import { DownloadCloud, RefreshCw } from 'lucide-solid';
import { ipc } from '../../lib/ipc.ts';
import { pushToast, toastError } from '../../state/toast.ts';

export default function UpdatesSettings() {
  const [updateBusy, setUpdateBusy] = createSignal(false);
  const [installing, setInstalling] = createSignal(false);
  // null = not checked; '' = up to date; otherwise the available version.
  const [availableVersion, setAvailableVersion] = createSignal<string | null>(null);

  async function checkUpdate() {
    setUpdateBusy(true);
    try {
      const version = await ipc.checkUpdate();
      if (version) {
        setAvailableVersion(version);
      } else {
        setAvailableVersion('');
        pushToast('success', "You're on the latest version.");
      }
    } catch (err) {
      toastError(err);
    } finally {
      setUpdateBusy(false);
    }
  }

  async function installUpdate() {
    setInstalling(true);
    try {
      await ipc.runUpdate();
    } catch (err) {
      toastError(err);
      setInstalling(false);
    }
  }

  return (
    <div class="settings-page">
      <section class="settings-section">
        <h3>
          <DownloadCloud size={14} strokeWidth={1.75} /> Updates
        </h3>
        <Show
          when={availableVersion()}
          fallback={
            <>
              <p class="muted settings-help">Check whether a newer version of Agate is available.</p>
              <button class="primary gen-btn" disabled={updateBusy()} onClick={() => void checkUpdate()}>
                <RefreshCw size={14} strokeWidth={1.75} class={updateBusy() ? 'spin' : ''} />
                {updateBusy() ? 'Checking…' : 'Check for updates'}
              </button>
            </>
          }
        >
          {(version) => (
            <>
              <p class="settings-update-available">Version {version()} is available.</p>
              <button class="primary gen-btn" disabled={installing()} onClick={() => void installUpdate()}>
                <DownloadCloud size={14} strokeWidth={1.75} />
                {installing() ? 'Installing…' : 'Install & restart'}
              </button>
            </>
          )}
        </Show>
      </section>
    </div>
  );
}
