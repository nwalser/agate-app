import { createSignal, For, onMount, Show } from 'solid-js';
import { ArrowLeft, Copy, DownloadCloud, Fingerprint, Monitor, Moon, RefreshCw, Sun, Trash2, UserPlus } from 'lucide-solid';
import { writeText } from '@tauri-apps/plugin-clipboard-manager';
import { ipc } from '../lib/ipc.ts';
import type { ConnectionSummary, PasswordGenOptions } from '../lib/types.ts';
import { refreshSession, setAddingConnection, status } from '../state/session.ts';
import { pushToast, toastError } from '../state/toast.ts';
import { setTheme, theme, type ThemePref } from '../state/theme.ts';
import './Settings.css';

// Theme picker options (segmented control in the Appearance section).
const THEME_OPTIONS: { value: ThemePref; label: string; icon: typeof Sun }[] = [
  { value: 'system', label: 'System', icon: Monitor },
  { value: 'light', label: 'Light', icon: Sun },
  { value: 'dark', label: 'Dark', icon: Moon },
];

export default function Settings(props: { onBack: () => void }) {
  const [newPw, setNewPw] = createSignal('');
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

  // ---- connections ----
  const [connections, setConnections] = createSignal<ConnectionSummary[]>([]);
  async function loadConnections() {
    try {
      setConnections(await ipc.listConnections());
    } catch (err) {
      toastError(err);
    }
  }

  onMount(() => {
    void (async () => {
      try {
        setHelloAvailable(await ipc.helloAvailable());
      } catch (err) {
        toastError(err);
      }
    })();
    void loadConnections();
  });

  async function removeConn(email: string) {
    try {
      await ipc.removeConnection(email);
      await loadConnections();
      await refreshSession();
      pushToast('success', 'Connection removed.');
    } catch (err) {
      toastError(err);
    }
  }

  async function logout() {
    try {
      await ipc.logout();
      await refreshSession();
    } catch (err) {
      toastError(err);
    }
  }

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

  async function changeAppPw() {
    if (newPw().length < 8) {
      pushToast('error', 'App password must be at least 8 characters.');
      return;
    }
    if (newPw() !== confirmPw()) {
      pushToast('error', 'Passwords do not match.');
      return;
    }
    setBusy(true);
    try {
      await ipc.changeAppUnlock(newPw());
      setNewPw('');
      setConfirmPw('');
      pushToast('success', 'App password changed.');
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
          <h3>Appearance</h3>
          <p class="muted settings-help">
            Choose a light or dark theme, or follow your system setting.
          </p>
          <div class="theme-options">
            <For each={THEME_OPTIONS}>
              {(opt) => {
                const Icon = opt.icon;
                return (
                  <button
                    class="theme-option"
                    classList={{ active: theme() === opt.value }}
                    onClick={() => setTheme(opt.value)}
                  >
                    <Icon size={16} strokeWidth={1.6} />
                    <span>{opt.label}</span>
                  </button>
                );
              }}
            </For>
          </div>
        </section>

        <section class="settings-section">
          <h3>Connections</h3>
          <p class="muted settings-help">
            Each connection is a Bitwarden account. One app unlock opens them all; removing one
            forgets its stored credentials on this device.
          </p>
          <For each={connections()}>
            {(conn) => (
              <div class="settings-row settings-account">
                <span class="settings-account-info">
                  <span>{conn.email}</span>
                  <span class="muted settings-account-server">{conn.serverLabel}</span>
                </span>
                <span class="row">
                  <Show when={conn.unlocked}>
                    <span class="settings-account-active">Unlocked</span>
                  </Show>
                  <button class="ghost icon-btn" title="Remove connection" onClick={() => void removeConn(conn.email)}>
                    <Trash2 size={14} strokeWidth={1.75} />
                  </button>
                </span>
              </div>
            )}
          </For>
          <button class="add-account" onClick={() => setAddingConnection(true)}>
            <UserPlus size={14} strokeWidth={1.75} /> Add connection
          </button>
          <button class="danger" onClick={() => void logout()}>
            Log out of everything
          </button>
        </section>

        <section class="settings-section">
          <h3>App unlock</h3>
          <p class="muted settings-help">
            Change the single app password that unlocks every connection. Stored master passwords
            are re-protected under the new one automatically.
          </p>
          <div class="field">
            <label>New app password</label>
            <input type="password" autocomplete="new-password" value={newPw()} onInput={(e) => setNewPw(e.currentTarget.value)} />
          </div>
          <div class="field">
            <label>Confirm new password</label>
            <input type="password" autocomplete="new-password" value={confirmPw()} onInput={(e) => setConfirmPw(e.currentTarget.value)} />
          </div>
          <button class="primary" disabled={busy()} onClick={() => void changeAppPw()}>
            Change app password
          </button>
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
