// Settings › Connections — list configured Bitwarden accounts; add another; edit
// an existing one (re-authenticate, change server, or switch between storing its
// login vs. manual-unlock); unlock a manual/locked connection on demand; remove
// one; or log out of everything.
//
// "Store login" seals the account's master password under the app unlock so it
// opens automatically. "Manual unlock" never persists the password — the account
// stays locked until unlocked here with its master password.

import { createSignal, For, onMount, Show } from 'solid-js';
import { KeyRound, Lock, Pencil, Trash2, Unlock as UnlockIcon, UserPlus, X } from 'lucide-solid';
import { ipc } from '../../lib/ipc.ts';
import type { ConnectionSummary, ServerConfig, TwoFactorKind } from '../../lib/types.ts';
import { refreshSession, setAddingConnection } from '../../state/session.ts';
import { pushToast, toastError } from '../../state/toast.ts';

type Region = 'us' | 'eu' | 'selfHosted';

function regionOf(s: ServerConfig): Region {
  return s.region;
}
function baseUrlOf(s: ServerConfig): string {
  return s.region === 'selfHosted' ? s.baseUrl : '';
}
function makeServer(region: Region, baseUrl: string): ServerConfig {
  if (region === 'eu') return { region: 'eu' };
  if (region === 'selfHosted') return { region: 'selfHosted', baseUrl: baseUrl.trim() };
  return { region: 'us' };
}
function serverEq(a: ServerConfig, b: ServerConfig): boolean {
  if (a.region !== b.region) return false;
  if (a.region === 'selfHosted' && b.region === 'selfHosted') return a.baseUrl === b.baseUrl;
  return true;
}

export default function ConnectionsSettings() {
  const [connections, setConnections] = createSignal<ConnectionSummary[]>([]);
  // Email of the connection whose edit / unlock panel is open (only one at a time).
  const [editing, setEditing] = createSignal<string | null>(null);
  const [unlocking, setUnlocking] = createSignal<string | null>(null);

  async function loadConnections() {
    try {
      setConnections(await ipc.listConnections());
    } catch (err) {
      toastError(err);
    }
  }

  onMount(() => void loadConnections());

  async function reload() {
    await loadConnections();
    await refreshSession();
  }

  async function removeConn(email: string) {
    try {
      await ipc.removeConnection(email);
      setEditing(null);
      setUnlocking(null);
      await reload();
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

  function toggleEdit(email: string) {
    setUnlocking(null);
    setEditing((cur) => (cur === email ? null : email));
  }
  function toggleUnlock(email: string) {
    setEditing(null);
    setUnlocking((cur) => (cur === email ? null : email));
  }

  return (
    <div class="settings-page">
      <section class="settings-section">
        <h3>Connections</h3>
        <p class="muted settings-help">
          Each connection is a Bitwarden account. Choose per account whether its login is stored
          (opens automatically) or unlocked manually. Removing one forgets its stored credentials on
          this device.
        </p>
        <For each={connections()}>
          {(conn) => (
            <div class="settings-account-card">
              <div class="settings-row settings-account">
                <span class="settings-account-info">
                  <span>{conn.email}</span>
                  <span class="muted settings-account-server">{conn.serverLabel}</span>
                </span>
                <span class="settings-account-badges">
                  <span class="settings-badge" classList={{ 'settings-badge-warn': !conn.storeCredentials }}>
                    {conn.storeCredentials ? 'Auto-unlock' : 'Manual'}
                  </span>
                  <span
                    class="settings-badge"
                    classList={{ 'settings-badge-ok': conn.unlocked, 'settings-badge-muted': !conn.unlocked }}
                  >
                    {conn.unlocked ? 'Unlocked' : 'Locked'}
                  </span>
                </span>
                <span class="row settings-account-actions">
                  <Show when={!conn.unlocked}>
                    <button
                      class="ghost icon-btn"
                      title="Unlock now"
                      onClick={() => toggleUnlock(conn.email)}
                    >
                      <KeyRound size={14} strokeWidth={1.75} />
                    </button>
                  </Show>
                  <button class="ghost icon-btn" title="Edit connection" onClick={() => toggleEdit(conn.email)}>
                    <Pencil size={14} strokeWidth={1.75} />
                  </button>
                  <button
                    class="ghost icon-btn"
                    title="Remove connection"
                    onClick={() => void removeConn(conn.email)}
                  >
                    <Trash2 size={14} strokeWidth={1.75} />
                  </button>
                </span>
              </div>

              <Show when={editing() === conn.email}>
                <EditConnection
                  conn={conn}
                  onClose={() => setEditing(null)}
                  onDone={() => {
                    setEditing(null);
                    void reload();
                  }}
                />
              </Show>
              <Show when={unlocking() === conn.email}>
                <UnlockConnection
                  conn={conn}
                  onClose={() => setUnlocking(null)}
                  onDone={() => {
                    setUnlocking(null);
                    void reload();
                  }}
                />
              </Show>
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
    </div>
  );
}

// Shared two-factor sub-form (provider pick, optional email send, code entry).
function TwoFactorStep(props: {
  providers: TwoFactorKind[];
  provider: TwoFactorKind;
  setProvider: (p: TwoFactorKind) => void;
  token: string;
  setToken: (t: string) => void;
  busy: boolean;
  onSendCode: () => void;
  onSubmit: () => void;
}) {
  return (
    <>
      <div class="field">
        <label>Provider</label>
        <select
          value={props.provider}
          onChange={(e) => props.setProvider(e.currentTarget.value as TwoFactorKind)}
        >
          <For each={props.providers}>
            {(p) => <option value={p}>{p === 'authenticator' ? 'Authenticator app' : 'Email'}</option>}
          </For>
        </select>
      </div>
      <Show when={props.provider === 'email'}>
        <button class="ghost send-code" disabled={props.busy} onClick={() => props.onSendCode()}>
          Send code to email
        </button>
      </Show>
      <div class="field">
        <label>Verification code</label>
        <input
          value={props.token}
          inputmode="numeric"
          autocomplete="one-time-code"
          onInput={(e) => props.setToken(e.currentTarget.value)}
          onKeyDown={(e) => e.key === 'Enter' && props.onSubmit()}
        />
      </div>
    </>
  );
}

// Edit an existing connection: re-authenticate, change server, and/or switch
// between storing the login and manual unlock.
function EditConnection(props: {
  conn: ConnectionSummary;
  onDone: () => void;
  onClose: () => void;
}) {
  const [region, setRegion] = createSignal<Region>(regionOf(props.conn.server));
  const [baseUrl, setBaseUrl] = createSignal(baseUrlOf(props.conn.server));
  const [store, setStore] = createSignal(props.conn.storeCredentials);
  const [password, setPassword] = createSignal('');
  const [busy, setBusy] = createSignal(false);

  const [tfProviders, setTfProviders] = createSignal<TwoFactorKind[] | null>(null);
  const [tfProvider, setTfProvider] = createSignal<TwoFactorKind>('authenticator');
  const [tfToken, setTfToken] = createSignal('');

  const server = () => makeServer(region(), baseUrl());
  const serverChanged = () => !serverEq(server(), props.conn.server);
  const enablingStore = () => store() && !props.conn.storeCredentials;
  // A password is required to re-authenticate (server change or turning storage on).
  const passwordRequired = () => serverChanged() || enablingStore();

  async function save(withTf: boolean) {
    if (passwordRequired() && !password()) {
      pushToast('error', 'Enter your master password to apply these changes.');
      return;
    }
    setBusy(true);
    try {
      const tf = withTf
        ? { provider: tfProvider(), token: tfToken().trim(), remember: false }
        : undefined;
      const pwd = password() ? password() : undefined;
      const result = await ipc.updateConnection(props.conn.email, server(), store(), pwd, tf);
      if (result.status === 'twoFactorRequired') {
        setTfProviders(result.providers);
        setTfProvider(result.providers[0] ?? 'authenticator');
        pushToast('info', 'Two-factor authentication required.');
      } else {
        pushToast('success', 'Connection updated.');
        props.onDone();
      }
    } catch (err) {
      toastError(err);
    } finally {
      setBusy(false);
    }
  }

  async function sendCode() {
    setBusy(true);
    try {
      await ipc.sendEmailCode(server(), props.conn.email, password());
      pushToast('success', 'Code sent to your email.');
    } catch (err) {
      toastError(err);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div class="settings-conn-form">
      <div class="settings-conn-form-head">
        <span class="settings-conn-form-title">Edit connection</span>
        <button class="ghost icon-btn" title="Close" onClick={() => props.onClose()}>
          <X size={14} strokeWidth={1.75} />
        </button>
      </div>

      <Show
        when={!tfProviders()}
        fallback={
          <TwoFactorStep
            providers={tfProviders() ?? []}
            provider={tfProvider()}
            setProvider={setTfProvider}
            token={tfToken()}
            setToken={setTfToken}
            busy={busy()}
            onSendCode={() => void sendCode()}
            onSubmit={() => void save(true)}
          />
        }
      >
        <div class="field">
          <label>Server</label>
          <select value={region()} onChange={(e) => setRegion(e.currentTarget.value as Region)}>
            <option value="us">Bitwarden — US (bitwarden.com)</option>
            <option value="eu">Bitwarden — EU (bitwarden.eu)</option>
            <option value="selfHosted">Self-hosted / Vaultwarden…</option>
          </select>
        </div>
        <Show when={region() === 'selfHosted'}>
          <div class="field">
            <label>Server URL</label>
            <input
              placeholder="https://vault.example.com"
              value={baseUrl()}
              onInput={(e) => setBaseUrl(e.currentTarget.value)}
            />
          </div>
        </Show>
        <label class="checkbox settings-bind">
          <input type="checkbox" checked={store()} onChange={(e) => setStore(e.currentTarget.checked)} />
          Store login on this device (auto-unlock)
        </label>
        <div class="field">
          <label>
            Master password
            <Show when={!passwordRequired()}>
              <span class="muted"> (only to re-authenticate)</span>
            </Show>
          </label>
          <input
            type="password"
            autocomplete="current-password"
            placeholder={passwordRequired() ? 'Required for this change' : 'Leave blank to keep current'}
            value={password()}
            onInput={(e) => setPassword(e.currentTarget.value)}
            onKeyDown={(e) => e.key === 'Enter' && void save(false)}
          />
        </div>
      </Show>

      <button
        class="primary full"
        disabled={busy()}
        onClick={() => void save(tfProviders() !== null)}
      >
        {busy() ? 'Saving…' : tfProviders() ? 'Verify & save' : 'Save changes'}
      </button>
    </div>
  );
}

// Unlock a manual / locked connection on demand with its master password.
function UnlockConnection(props: {
  conn: ConnectionSummary;
  onDone: () => void;
  onClose: () => void;
}) {
  const [password, setPassword] = createSignal('');
  const [busy, setBusy] = createSignal(false);

  const [tfProviders, setTfProviders] = createSignal<TwoFactorKind[] | null>(null);
  const [tfProvider, setTfProvider] = createSignal<TwoFactorKind>('authenticator');
  const [tfToken, setTfToken] = createSignal('');

  async function unlock(withTf: boolean) {
    if (!password()) {
      pushToast('error', 'Enter this account’s master password.');
      return;
    }
    setBusy(true);
    try {
      const tf = withTf
        ? { provider: tfProvider(), token: tfToken().trim(), remember: false }
        : undefined;
      const result = await ipc.unlockConnection(props.conn.email, password(), tf);
      if (result.status === 'twoFactorRequired') {
        setTfProviders(result.providers);
        setTfProvider(result.providers[0] ?? 'authenticator');
        pushToast('info', 'Two-factor authentication required.');
      } else {
        pushToast('success', 'Connection unlocked.');
        props.onDone();
      }
    } catch (err) {
      toastError(err);
    } finally {
      setBusy(false);
    }
  }

  async function sendCode() {
    setBusy(true);
    try {
      await ipc.sendEmailCode(props.conn.server, props.conn.email, password());
      pushToast('success', 'Code sent to your email.');
    } catch (err) {
      toastError(err);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div class="settings-conn-form">
      <div class="settings-conn-form-head">
        <span class="settings-conn-form-title">
          <UnlockIcon size={13} strokeWidth={1.75} /> Unlock {props.conn.email}
        </span>
        <button class="ghost icon-btn" title="Close" onClick={() => props.onClose()}>
          <X size={14} strokeWidth={1.75} />
        </button>
      </div>

      <Show
        when={!tfProviders()}
        fallback={
          <TwoFactorStep
            providers={tfProviders() ?? []}
            provider={tfProvider()}
            setProvider={setTfProvider}
            token={tfToken()}
            setToken={setTfToken}
            busy={busy()}
            onSendCode={() => void sendCode()}
            onSubmit={() => void unlock(true)}
          />
        }
      >
        <div class="field">
          <label>Master password</label>
          <input
            type="password"
            autocomplete="current-password"
            value={password()}
            onInput={(e) => setPassword(e.currentTarget.value)}
            onKeyDown={(e) => e.key === 'Enter' && void unlock(false)}
          />
        </div>
      </Show>

      <button
        class="primary full"
        disabled={busy()}
        onClick={() => void unlock(tfProviders() !== null)}
      >
        <Lock size={14} strokeWidth={1.75} />
        {busy() ? 'Unlocking…' : tfProviders() ? 'Verify & unlock' : 'Unlock'}
      </button>
    </div>
  );
}
