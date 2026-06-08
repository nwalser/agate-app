import { createSignal, onMount, Show } from 'solid-js';
import { ArrowLeft, Copy, DownloadCloud, Fingerprint, RefreshCw } from 'lucide-solid';
import { writeText } from '@tauri-apps/plugin-clipboard-manager';
import { ipc } from '../lib/ipc.ts';
import type { PasswordGenOptions, ServerConfig } from '../lib/types.ts';
import { refreshSession, server, status } from '../state/session.ts';
import { pushToast, toastError } from '../state/toast.ts';
import './Settings.css';

function serverLabel(s: ServerConfig): string {
  if (s.region === 'eu') return 'Bitwarden EU';
  if (s.region === 'selfHosted') return s.baseUrl;
  return 'Bitwarden US';
}

export default function Settings(props: { onBack: () => void }) {
  const [localPw, setLocalPw] = createSignal('');
  const [confirmPw, setConfirmPw] = createSignal('');
  const [busy, setBusy] = createSignal(false);

  const [opts, setOpts] = createSignal<PasswordGenOptions>({
    length: 16,
    uppercase: true,
    lowercase: true,
    numbers: true,
    special: true,
  });
  const [generated, setGenerated] = createSignal('');

  // ---- Windows Hello ----
  const [helloAvailable, setHelloAvailable] = createSignal(false);
  const [helloBusy, setHelloBusy] = createSignal(false);

  onMount(() => {
    void (async () => {
      try {
        setHelloAvailable(await ipc.helloAvailable());
      } catch (err) {
        toastError(err);
      }
    })();
  });

  async function toggleHello() {
    setHelloBusy(true);
    try {
      if (status().helloConfigured) {
        await ipc.helloDisable();
        await refreshSession();
        pushToast('success', 'Windows Hello unlock disabled.');
      } else {
        await ipc.helloEnable();
        await refreshSession();
        pushToast('success', 'Windows Hello unlock enabled.');
      }
    } catch (err) {
      toastError(err);
    } finally {
      setHelloBusy(false);
    }
  }

  // ---- Updates ----
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

  async function enableLocal() {
    if (localPw().length < 4) {
      pushToast('error', 'Local password must be at least 4 characters.');
      return;
    }
    if (localPw() !== confirmPw()) {
      pushToast('error', 'Local passwords do not match.');
      return;
    }
    setBusy(true);
    try {
      await ipc.enableLocalUnlock(localPw());
      setLocalPw('');
      setConfirmPw('');
      await refreshSession();
      pushToast('success', 'Local unlock enabled.');
    } catch (err) {
      toastError(err);
    } finally {
      setBusy(false);
    }
  }

  async function disableLocal() {
    setBusy(true);
    try {
      await ipc.disableLocalUnlock();
      await refreshSession();
      pushToast('success', 'Local unlock disabled.');
    } catch (err) {
      toastError(err);
    } finally {
      setBusy(false);
    }
  }

  async function generate() {
    try {
      setGenerated(await ipc.generatePassword(opts()));
    } catch (err) {
      toastError(err);
    }
  }

  function setOpt<K extends keyof PasswordGenOptions>(key: K, value: PasswordGenOptions[K]) {
    setOpts({ ...opts(), [key]: value });
  }

  return (
    <div class="settings">
      <header class="settings-header">
        <button class="ghost icon-btn" title="Back" onClick={() => props.onBack()}>
          <ArrowLeft size={16} strokeWidth={1.75} />
        </button>
        <h2>Settings</h2>
      </header>

      <div class="settings-body">
        <section class="settings-section">
          <h3>Account</h3>
          <div class="settings-kv">
            <span class="muted">Email</span>
            <span>{status().email ?? '—'}</span>
          </div>
          <div class="settings-kv">
            <span class="muted">Server</span>
            <span>{serverLabel(server())}</span>
          </div>
          <button class="danger" onClick={() => void (async () => { await ipc.logout(); await refreshSession(); })()}>
            Log out
          </button>
        </section>

        <section class="settings-section">
          <h3>Local-password unlock</h3>
          <p class="muted settings-help">
            Unlock with a separate local password instead of your master password. Your master
            password is never stored on this device.
          </p>
          <Show
            when={status().localUnlockConfigured}
            fallback={
              <>
                <div class="field">
                  <label>Local password</label>
                  <input type="password" value={localPw()} onInput={(e) => setLocalPw(e.currentTarget.value)} />
                </div>
                <div class="field">
                  <label>Confirm local password</label>
                  <input type="password" value={confirmPw()} onInput={(e) => setConfirmPw(e.currentTarget.value)} />
                </div>
                <button class="primary" disabled={busy()} onClick={() => void enableLocal()}>
                  Enable local unlock
                </button>
              </>
            }
          >
            <p class="settings-enabled">✓ Local unlock is enabled for this account.</p>
            <button class="danger" disabled={busy()} onClick={() => void disableLocal()}>
              Disable local unlock
            </button>
          </Show>
        </section>

        <section class="settings-section">
          <h3>
            <Fingerprint size={14} strokeWidth={1.75} /> Windows Hello
          </h3>
          <p class="muted settings-help">
            Unlock your vault with Windows Hello (face, fingerprint, or PIN) instead of typing a
            password.
          </p>
          <Show
            when={helloAvailable()}
            fallback={
              <div class="settings-row settings-row-disabled">
                <span class="muted">Windows Hello is not available on this device.</span>
              </div>
            }
          >
            <div class="settings-row">
              <span>{status().helloConfigured ? 'Enabled' : 'Disabled'}</span>
              <button
                classList={{ primary: !status().helloConfigured, danger: status().helloConfigured }}
                disabled={helloBusy()}
                onClick={() => void toggleHello()}
              >
                {status().helloConfigured ? 'Disable' : 'Enable'}
              </button>
            </div>
          </Show>
        </section>

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

        <section class="settings-section">
          <h3>Password generator</h3>
          <div class="field">
            <label>Length: {opts().length}</label>
            <input
              type="range"
              min="5"
              max="64"
              value={opts().length}
              onInput={(e) => setOpt('length', Number(e.currentTarget.value))}
            />
          </div>
          <div class="gen-toggles">
            <label class="checkbox">
              <input type="checkbox" checked={opts().uppercase} onChange={(e) => setOpt('uppercase', e.currentTarget.checked)} /> A-Z
            </label>
            <label class="checkbox">
              <input type="checkbox" checked={opts().lowercase} onChange={(e) => setOpt('lowercase', e.currentTarget.checked)} /> a-z
            </label>
            <label class="checkbox">
              <input type="checkbox" checked={opts().numbers} onChange={(e) => setOpt('numbers', e.currentTarget.checked)} /> 0-9
            </label>
            <label class="checkbox">
              <input type="checkbox" checked={opts().special} onChange={(e) => setOpt('special', e.currentTarget.checked)} /> !@#
            </label>
          </div>
          <Show when={generated()}>
            <div class="detail-value-row gen-result">
              <code class="detail-value mono truncate">{generated()}</code>
              <button class="ghost icon-btn" title="Copy" onClick={() => void writeText(generated()).then(() => pushToast('success', 'Copied.'))}>
                <Copy size={14} />
              </button>
            </div>
          </Show>
          <button class="primary gen-btn" onClick={() => void generate()}>
            <RefreshCw size={14} strokeWidth={1.75} /> Generate
          </button>
        </section>

        <p class="muted settings-foot">Agate · unofficial Bitwarden client · GPL-3.0</p>
      </div>
    </div>
  );
}
