// Settings › Updates — current app/build information, a manual check + install,
// and the automatic-update preferences. The check/install actions and the auto
// prefs live in state/update.ts, so a startup auto-check (App.tsx) is reflected
// here live — one update path, not two.

import { createSignal, onMount, Show } from 'solid-js';
import { CheckCircle2, DownloadCloud, Info, RefreshCw, ShieldCheck } from 'lucide-solid';
import { getName, getTauriVersion, getVersion } from '@tauri-apps/api/app';
import {
  availableVersion,
  checkForUpdate,
  checking,
  installUpdate,
  installing,
  lastCheckedAt,
  setUpdateOption,
  updateConfig,
} from '../../state/update.ts';
import { toastError } from '../../state/toast.ts';
import { ToggleRow } from '../../components/settings/SettingsControls.tsx';
import './UpdatesSettings.css';

function formatChecked(ts: number | null): string {
  if (!ts) return 'Never';
  try {
    return new Date(ts).toLocaleString();
  } catch {
    // ignore: a bad timestamp is only cosmetic
    return 'Unknown';
  }
}

export default function UpdatesSettings() {
  const [appName, setAppName] = createSignal('Agate');
  const [version, setVersion] = createSignal('');
  const [tauriVersion, setTauriVersion] = createSignal('');

  onMount(() => {
    // Build info is informational — leave each blank if the host can't report it.
    void getName().then(setAppName).catch(() => {});
    void getVersion().then(setVersion).catch(() => {});
    void getTauriVersion().then(setTauriVersion).catch(() => {});
  });

  async function check() {
    try {
      await checkForUpdate();
    } catch (err) {
      toastError(err);
    }
  }

  async function install() {
    try {
      await installUpdate();
    } catch (err) {
      toastError(err);
    }
  }

  return (
    <div class="settings-page">
      {/* Current application information. */}
      <section class="settings-section">
        <h3>
          <Info size={14} strokeWidth={1.75} /> Application
        </h3>
        <dl class="update-info">
          <InfoRow label="Name" value={appName()} />
          <Show when={version()}>
            <InfoRow label="Version" value={version()} />
          </Show>
          <Show when={tauriVersion()}>
            <InfoRow label="Tauri" value={tauriVersion()} />
          </Show>
        </dl>
      </section>

      {/* Manual check + install. */}
      <section class="settings-section">
        <h3>
          <DownloadCloud size={14} strokeWidth={1.75} /> Updates
        </h3>
        <Show
          when={availableVersion()}
          fallback={
            <>
              <p class="muted settings-help">Check whether a newer version of Agate is available.</p>
              <button class="primary gen-btn" disabled={checking()} onClick={() => void check()}>
                <RefreshCw size={14} strokeWidth={1.75} class={checking() ? 'spin' : ''} />
                {checking() ? 'Checking…' : 'Check for updates'}
              </button>
              {/* '' means a check ran and found nothing newer (null = not checked yet). */}
              <Show when={availableVersion() === ''}>
                <p class="update-uptodate">
                  <CheckCircle2 size={13} strokeWidth={2} /> You're on the latest version.
                </p>
              </Show>
            </>
          }
        >
          {(v) => (
            <>
              <p class="settings-update-available">Version {v()} is available.</p>
              <button class="primary gen-btn" disabled={installing()} onClick={() => void install()}>
                <DownloadCloud size={14} strokeWidth={1.75} />
                {installing() ? 'Installing…' : 'Install & restart'}
              </button>
            </>
          )}
        </Show>
        <p class="muted update-last-checked">Last checked: {formatChecked(lastCheckedAt())}</p>
      </section>

      {/* Automatic-update preferences. */}
      <section class="settings-section">
        <h3>
          <RefreshCw size={14} strokeWidth={1.75} /> Automatic updates
        </h3>
        <ToggleRow
          label="Check for updates on launch"
          desc="Look for a newer release each time Agate starts."
          checked={updateConfig().autoCheck}
          onChange={(v) => setUpdateOption('autoCheck', v)}
        />
        <ToggleRow
          label="Download and install automatically"
          desc="When a launch check finds an update, install it and restart without asking."
          checked={updateConfig().autoInstall}
          disabled={!updateConfig().autoCheck}
          onChange={(v) => setUpdateOption('autoInstall', v)}
        />
      </section>

      {/* About — brand + the unofficial-client disclaimer. */}
      <section class="settings-section settings-about">
        <h3>
          <ShieldCheck size={14} strokeWidth={1.75} /> About
        </h3>
        <div class="settings-about-brand">
          <ShieldCheck size={22} strokeWidth={1.75} />
          <div>
            <div class="settings-about-name">Agate</div>
            <Show when={version()}>
              <div class="muted settings-about-version">Version {version()}</div>
            </Show>
          </div>
        </div>
        <p class="muted settings-help">
          An unofficial, open-source desktop client for Bitwarden, built on Bitwarden's official Rust
          SDK. Not affiliated with or endorsed by Bitwarden, Inc. "Bitwarden" is a trademark of
          Bitwarden, Inc.
        </p>
        <p class="muted settings-foot">Agate · unofficial Bitwarden client · GPL-3.0</p>
      </section>
    </div>
  );
}

function InfoRow(props: { label: string; value: string }) {
  return (
    <div class="update-info-row">
      <dt>{props.label}</dt>
      <dd>{props.value}</dd>
    </div>
  );
}
