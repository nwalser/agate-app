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
import { t } from '../../lib/i18n.ts';
import { ToggleRow } from '../../components/settings/SettingsControls.tsx';
import './UpdatesSettings.css';

function formatChecked(ts: number | null): string {
  if (!ts) return t('updates.never');
  try {
    return new Date(ts).toLocaleString();
  } catch {
    // ignore: a bad timestamp is only cosmetic
    return t('updates.unknown');
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
          <Info size={14} strokeWidth={1.75} /> {t('updates.application')}
        </h3>
        <dl class="update-info">
          <InfoRow label={t('common.name')} value={appName()} />
          <Show when={version()}>
            <InfoRow label={t('updates.version')} value={version()} />
          </Show>
          <Show when={tauriVersion()}>
            <InfoRow label="Tauri" value={tauriVersion()} />
          </Show>
        </dl>
      </section>

      {/* Manual check + install. */}
      <section class="settings-section">
        <h3>
          <DownloadCloud size={14} strokeWidth={1.75} /> {t('updates.title')}
        </h3>
        <Show
          when={availableVersion()}
          fallback={
            <>
              <p class="muted settings-help">{t('updates.checkHelp')}</p>
              {/* '' means a check ran and found nothing newer (null = not checked yet). */}
              <Show when={availableVersion() === ''}>
                <p class="update-uptodate">
                  <CheckCircle2 size={13} strokeWidth={2} /> {t('updates.upToDate')}
                </p>
              </Show>
              <div class="settings-actions">
                <button class="primary gen-btn" disabled={checking()} onClick={() => void check()}>
                  <RefreshCw size={14} strokeWidth={1.75} class={checking() ? 'spin' : ''} />
                  {checking() ? t('updates.checking') : t('updates.checkForUpdates')}
                </button>
              </div>
            </>
          }
        >
          {(v) => (
            <>
              <p class="settings-update-available">{t('updates.versionAvailable', { version: v() })}</p>
              <div class="settings-actions">
                <button class="primary gen-btn" disabled={installing()} onClick={() => void install()}>
                  <DownloadCloud size={14} strokeWidth={1.75} />
                  {installing() ? t('updates.installing') : t('updates.installAndRestart')}
                </button>
              </div>
            </>
          )}
        </Show>
        <p class="muted update-last-checked">{t('updates.lastChecked', { time: formatChecked(lastCheckedAt()) })}</p>
      </section>

      {/* Automatic-update preferences. */}
      <section class="settings-section">
        <h3>
          <RefreshCw size={14} strokeWidth={1.75} /> {t('updates.automaticUpdates')}
        </h3>
        <ToggleRow
          label={t('updates.checkOnLaunch')}
          desc={t('updates.checkOnLaunchDesc')}
          checked={updateConfig().autoCheck}
          onChange={(v) => setUpdateOption('autoCheck', v)}
        />
        <ToggleRow
          label={t('updates.autoInstall')}
          desc={t('updates.autoInstallDesc')}
          checked={updateConfig().autoInstall}
          disabled={!updateConfig().autoCheck}
          onChange={(v) => setUpdateOption('autoInstall', v)}
        />
      </section>

      {/* About — brand + the unofficial-client disclaimer. */}
      <section class="settings-section settings-about">
        <h3>
          <ShieldCheck size={14} strokeWidth={1.75} /> {t('updates.about')}
        </h3>
        <div class="settings-about-brand">
          <ShieldCheck size={22} strokeWidth={1.75} />
          <div>
            <div class="settings-about-name">Agate</div>
            <Show when={version()}>
              <div class="muted settings-about-version">{t('updates.versionLabel', { version: version() })}</div>
            </Show>
          </div>
        </div>
        <p class="muted settings-help">{t('updates.disclaimer')}</p>
        <p class="muted settings-foot">{t('updates.footer')}</p>
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
