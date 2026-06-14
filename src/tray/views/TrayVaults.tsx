// Tray › Vaults — full vault-connection management inside the popup, replacing
// the main window's ConnectionsSettings + Onboarding add-connection flow for
// the tray-only app. One stacked column: list the configured connections
// (Bitwarden accounts AND KeePass databases; status dot: unlocked / locked /
// needs 2FA), unlock / edit / remove each one inline, and an "Add vault" flow:
// pick the source first, then either the Bitwarden form (server pick → email +
// master password + store-credentials toggle → optional 2FA step) or the
// KeePass form (.kdbx file pick → database password + optional key file).
//
// KeePass connections reuse ConnectionSummary with the .kdbx path in `email`
// (the connection id); rows show the file NAME, the full path only as a title.
// They never need 2FA, and the Bitwarden edit panel does not apply to them.
//
// All mutations go through lib/ipc. After any successful mutation the backend
// broadcasts `agate://session-changed` and the popup shell refreshes itself —
// this view only reloads its own connection list. Secrets (master passwords,
// database passwords, 2FA codes) live in local signals and are never logged.

import { createSignal, For, onMount, Show, type JSX } from 'solid-js';
import { ArrowLeft, Cloud, FileKey, KeyRound, Pencil, Plus, Trash2, X } from 'lucide-solid';
import { ipc } from '../../lib/ipc.ts';
import { t } from '../../lib/i18n.ts';
import type { ConnectionSummary, ServerConfig, TwoFactorKind } from '../../lib/types.ts';
import { pushToast, toastError } from '../../state/toast.ts';
import './TrayVaults.css';

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

/** Last path segment of a file path (either separator) — KeePass row label. */
function fileNameOf(path: string): string {
  const i = Math.max(path.lastIndexOf('/'), path.lastIndexOf('\\'));
  return i >= 0 ? path.slice(i + 1) : path;
}

/** Row label: account email for Bitwarden, .kdbx file name for KeePass. */
function connLabel(c: ConnectionSummary): string {
  return c.kind === 'keepass' ? fileNameOf(c.email) : c.email;
}

/** Which inline panel is open under a connection row (one at a time). */
type Panel = { kind: 'unlock' | 'edit' | 'remove'; email: string } | null;

export default function TrayVaults(props: { onBack: () => void }): JSX.Element {
  const [connections, setConnections] = createSignal<ConnectionSummary[]>([]);
  const [loaded, setLoaded] = createSignal(false);
  const [view, setView] = createSignal<'list' | 'add'>('list');
  const [panel, setPanel] = createSignal<Panel>(null);
  // Emails whose unlock attempt reported "second factor required" — drives the
  // amber status dot until the row actually unlocks (a refresh clears it).
  const [tfPending, setTfPending] = createSignal<string[]>([]);

  async function refresh() {
    try {
      const list = await ipc.listConnections();
      setConnections(list);
      setTfPending((cur) => cur.filter((e) => list.some((c) => c.email === e && !c.unlocked)));
    } catch (err) {
      toastError(err);
    } finally {
      setLoaded(true);
    }
  }
  onMount(() => void refresh());

  function markTfPending(email: string) {
    setTfPending((cur) => (cur.includes(email) ? cur : [...cur, email]));
  }

  function togglePanel(kind: NonNullable<Panel>['kind'], email: string) {
    setPanel((cur) => (cur?.kind === kind && cur.email === email ? null : { kind, email }));
  }
  const isOpen = (kind: NonNullable<Panel>['kind'], email: string) => {
    const p = panel();
    return p !== null && p.kind === kind && p.email === email;
  };
  const closePanelAndRefresh = () => {
    setPanel(null);
    void refresh();
  };

  const needsTf = (c: ConnectionSummary) => !c.unlocked && tfPending().includes(c.email);
  const dotState = (c: ConnectionSummary) => (c.unlocked ? 'unlocked' : needsTf(c) ? 'tf' : 'locked');
  const dotTitle = (c: ConnectionSummary) =>
    c.unlocked
      ? t('connections.badgeUnlocked')
      : needsTf(c)
        ? t('trayVaults.needsTwoFactor')
        : t('connections.badgeLocked');

  return (
    <div class="tray-vaults">
      <Show
        when={view() === 'list'}
        fallback={
          <AddVault
            onDone={() => {
              setView('list');
              void refresh();
            }}
            onCancel={() => setView('list')}
          />
        }
      >
        <header class="tv-head">
          <button class="ghost tv-icon" title={t('common.back')} onClick={() => props.onBack()}>
            <ArrowLeft size={15} strokeWidth={1.75} />
          </button>
          <span class="tv-title">{t('trayVaults.title')}</span>
          <button
            class="ghost tv-icon"
            title={t('trayVaults.addVault')}
            onClick={() => {
              setPanel(null);
              setView('add');
            }}
          >
            <Plus size={15} strokeWidth={1.75} />
          </button>
        </header>

        <div class="tv-list">
          <Show when={loaded()} fallback={<div class="tv-status">{t('common.loading')}</div>}>
            <For
              each={connections()}
              fallback={<div class="tv-status">{t('trayVaults.empty')}</div>}
            >
              {(conn) => (
                <div class="tv-card">
                  <div class="tv-row">
                    <span class={`tv-dot ${dotState(conn)}`} title={dotTitle(conn)} />
                    <span class="tv-info">
                      <span
                        class="tv-email"
                        title={conn.kind === 'keepass' ? conn.email : undefined}
                      >
                        <Show when={conn.kind === 'keepass'}>
                          <FileKey size={12} strokeWidth={1.75} class="tv-kind-ico" />
                        </Show>
                        <span class="tv-name">{connLabel(conn)}</span>
                      </span>
                      <span class="tv-sub">
                        {conn.kind === 'keepass' ? t('trayVaults.keepass') : conn.serverLabel} ·{' '}
                        {conn.storeCredentials
                          ? t('connections.badgeAutoUnlock')
                          : t('connections.badgeManual')}
                      </span>
                    </span>
                    <span class="tv-actions">
                      {/* Stored-credential KeePass rows unlock with the app —
                          no row-level unlock (no 2FA fallback to offer). */}
                      <Show
                        when={
                          !conn.unlocked && (conn.kind !== 'keepass' || !conn.storeCredentials)
                        }
                      >
                        <button
                          title={t('connections.unlockNow')}
                          onClick={() => togglePanel('unlock', conn.email)}
                        >
                          <KeyRound size={14} strokeWidth={1.75} />
                        </button>
                      </Show>
                      {/* Edit (server / password change) is Bitwarden-only; a
                          KeePass "edit" would be re-adding the database. */}
                      <Show when={conn.kind === 'bitwarden'}>
                        <button
                          title={t('connections.editConnection')}
                          onClick={() => togglePanel('edit', conn.email)}
                        >
                          <Pencil size={14} strokeWidth={1.75} />
                        </button>
                      </Show>
                      <button
                        title={t('connections.removeConnection')}
                        onClick={() => togglePanel('remove', conn.email)}
                      >
                        <Trash2 size={14} strokeWidth={1.75} />
                      </button>
                    </span>
                  </div>

                  <Show when={isOpen('unlock', conn.email)}>
                    <Show
                      when={conn.kind === 'keepass'}
                      fallback={
                        <UnlockPanel
                          conn={conn}
                          onDone={closePanelAndRefresh}
                          onClose={() => setPanel(null)}
                          onTwoFactorPending={() => markTfPending(conn.email)}
                        />
                      }
                    >
                      <KeepassUnlockPanel
                        conn={conn}
                        onDone={closePanelAndRefresh}
                        onClose={() => setPanel(null)}
                      />
                    </Show>
                  </Show>
                  <Show when={isOpen('edit', conn.email)}>
                    <EditPanel
                      conn={conn}
                      onDone={closePanelAndRefresh}
                      onClose={() => setPanel(null)}
                    />
                  </Show>
                  <Show when={isOpen('remove', conn.email)}>
                    <RemoveConfirm
                      conn={conn}
                      onDone={closePanelAndRefresh}
                      onClose={() => setPanel(null)}
                    />
                  </Show>
                </div>
              )}
            </For>
          </Show>
        </div>
      </Show>
    </div>
  );
}

// ── Shared two-factor sub-form (provider pick, optional email send, code) ────
// Rendered inside a <form>, so Enter in the code field submits natively.

function TwoFactorFields(props: {
  providers: TwoFactorKind[];
  provider: TwoFactorKind;
  setProvider: (p: TwoFactorKind) => void;
  token: string;
  setToken: (v: string) => void;
  busy: boolean;
  onSendCode: () => void;
}) {
  return (
    <>
      <div class="tv-field">
        <label>{t('connections.provider')}</label>
        <select
          aria-label={t('connections.provider')}
          value={props.provider}
          onChange={(e) => props.setProvider(e.currentTarget.value as TwoFactorKind)}
        >
          <For each={props.providers}>
            {(p) => (
              <option value={p}>
                {p === 'authenticator'
                  ? t('connections.providerAuthenticator')
                  : t('connections.providerEmail')}
              </option>
            )}
          </For>
        </select>
      </div>
      <Show when={props.provider === 'email'}>
        <button
          type="button"
          class="ghost tv-link"
          disabled={props.busy}
          onClick={() => props.onSendCode()}
        >
          {t('connections.sendCodeToEmail')}
        </button>
      </Show>
      <div class="tv-field">
        <label>{t('connections.verificationCode')}</label>
        <input
          aria-label={t('connections.verificationCode')}
          value={props.token}
          inputmode="numeric"
          autocomplete="one-time-code"
          onInput={(e) => props.setToken(e.currentTarget.value)}
        />
      </div>
    </>
  );
}

// ── Server picker (region select + self-hosted URL) ──────────────────────────

function ServerFields(props: {
  region: Region;
  setRegion: (r: Region) => void;
  baseUrl: string;
  setBaseUrl: (v: string) => void;
}) {
  return (
    <>
      <div class="tv-field">
        <label>{t('connections.server')}</label>
        <select
          aria-label={t('connections.server')}
          value={props.region}
          onChange={(e) => props.setRegion(e.currentTarget.value as Region)}
        >
          <option value="us">{t('connections.serverUs')}</option>
          <option value="eu">{t('connections.serverEu')}</option>
          <option value="selfHosted">{t('connections.serverSelfHosted')}</option>
        </select>
      </div>
      <Show when={props.region === 'selfHosted'}>
        <div class="tv-field">
          <label>{t('connections.serverUrl')}</label>
          <input
            aria-label={t('connections.serverUrl')}
            placeholder="https://vault.example.com"
            value={props.baseUrl}
            onInput={(e) => props.setBaseUrl(e.currentTarget.value)}
          />
        </div>
      </Show>
    </>
  );
}

// ── Unlock a locked connection ────────────────────────────────────────────────
// Two modes:
//  - "stored": the connection's master password is sealed on this device and a
//    cold-start re-login left it waiting on a second factor — only a 2FA code
//    is needed (ipc.unlockConnection2fa / sendConnectionEmailCode use the
//    stored credentials backend-side).
//  - "password": manual-unlock connections (or fallback for stored ones, e.g.
//    after a failed re-login) — master password, with an inline 2FA step when
//    the server demands one.

function UnlockPanel(props: {
  conn: ConnectionSummary;
  onDone: () => void;
  onClose: () => void;
  onTwoFactorPending: () => void;
}) {
  const [mode, setMode] = createSignal<'stored' | 'password'>(
    props.conn.storeCredentials ? 'stored' : 'password',
  );
  const [password, setPassword] = createSignal('');
  const [busy, setBusy] = createSignal(false);
  const [tfProviders, setTfProviders] = createSignal<TwoFactorKind[] | null>(null);
  const [tfProvider, setTfProvider] = createSignal<TwoFactorKind>('authenticator');
  const [tfToken, setTfToken] = createSignal('');

  function switchMode(m: 'stored' | 'password') {
    setMode(m);
    setTfProviders(null);
    setTfProvider('authenticator');
    setTfToken('');
  }

  async function unlockStored() {
    if (!tfToken().trim()) return;
    setBusy(true);
    try {
      await ipc.unlockConnection2fa(props.conn.email, {
        provider: tfProvider(),
        token: tfToken().trim(),
        remember: false,
      });
      pushToast('success', t('connections.unlocked'));
      props.onDone();
    } catch (err) {
      toastError(err);
    } finally {
      setBusy(false);
    }
  }

  async function unlockWithPassword(withTf: boolean) {
    if (!password()) {
      pushToast('error', t('connections.enterAccountMasterPw'));
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
        props.onTwoFactorPending();
        pushToast('info', t('connections.twoFactorRequired'));
      } else {
        pushToast('success', t('connections.unlocked'));
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
      if (mode() === 'stored') await ipc.sendConnectionEmailCode(props.conn.email);
      else await ipc.sendEmailCode(props.conn.server, props.conn.email, password());
      pushToast('success', t('connections.codeSent'));
    } catch (err) {
      toastError(err);
    } finally {
      setBusy(false);
    }
  }

  const submit = () => {
    if (mode() === 'stored') void unlockStored();
    else void unlockWithPassword(tfProviders() !== null);
  };

  return (
    <form
      class="tv-panel"
      onSubmit={(e) => {
        e.preventDefault();
        submit();
      }}
    >
      <div class="tv-panel-head">
        <span class="tv-panel-title">
          {t('connections.unlockEmail', { email: props.conn.email })}
        </span>
        <button
          type="button"
          class="ghost tv-icon"
          title={t('common.close')}
          onClick={() => props.onClose()}
        >
          <X size={14} strokeWidth={1.75} />
        </button>
      </div>

      <Show
        when={mode() === 'password'}
        fallback={
          <>
            <p class="tv-note">{t('trayVaults.storedUnlockIntro')}</p>
            <TwoFactorFields
              providers={['authenticator', 'email']}
              provider={tfProvider()}
              setProvider={setTfProvider}
              token={tfToken()}
              setToken={setTfToken}
              busy={busy()}
              onSendCode={() => void sendCode()}
            />
            <button
              type="button"
              class="ghost tv-link"
              disabled={busy()}
              onClick={() => switchMode('password')}
            >
              {t('trayVaults.useMasterPassword')}
            </button>
          </>
        }
      >
        <Show
          when={!tfProviders()}
          fallback={
            <TwoFactorFields
              providers={tfProviders() ?? []}
              provider={tfProvider()}
              setProvider={setTfProvider}
              token={tfToken()}
              setToken={setTfToken}
              busy={busy()}
              onSendCode={() => void sendCode()}
            />
          }
        >
          <div class="tv-field">
            <label>{t('connections.masterPassword')}</label>
            <input
              aria-label={t('connections.masterPassword')}
              type="password"
              autocomplete="current-password"
              value={password()}
              onInput={(e) => setPassword(e.currentTarget.value)}
            />
          </div>
          <Show when={props.conn.storeCredentials}>
            <button
              type="button"
              class="ghost tv-link"
              disabled={busy()}
              onClick={() => switchMode('stored')}
            >
              {t('trayVaults.useStoredLogin')}
            </button>
          </Show>
        </Show>
      </Show>

      <button type="submit" class="primary tv-submit" disabled={busy()}>
        {busy()
          ? t('connections.unlocking')
          : mode() === 'stored' || tfProviders()
            ? t('connections.verifyAndUnlock')
            : t('connections.unlock')}
      </button>
    </form>
  );
}

// ── Unlock a locked KeePass database ─────────────────────────────────────────
// Manual-unlock KeePass connections only: one database password, no stored /
// 2FA modes (stored-credential databases are opened by the app-level unlock).

function KeepassUnlockPanel(props: {
  conn: ConnectionSummary;
  onDone: () => void;
  onClose: () => void;
}) {
  const [password, setPassword] = createSignal('');
  const [busy, setBusy] = createSignal(false);

  async function unlock() {
    if (!password()) {
      pushToast('error', t('trayVaults.enterDbPassword'));
      return;
    }
    setBusy(true);
    try {
      await ipc.unlockKeepassConnection(props.conn.email, password());
      pushToast('success', t('connections.unlocked'));
      props.onDone();
    } catch (err) {
      toastError(err);
    } finally {
      setBusy(false);
    }
  }

  return (
    <form
      class="tv-panel"
      onSubmit={(e) => {
        e.preventDefault();
        void unlock();
      }}
    >
      <div class="tv-panel-head">
        <span class="tv-panel-title">
          {t('trayVaults.unlockDb', { name: fileNameOf(props.conn.email) })}
        </span>
        <button
          type="button"
          class="ghost tv-icon"
          title={t('common.close')}
          onClick={() => props.onClose()}
        >
          <X size={14} strokeWidth={1.75} />
        </button>
      </div>
      <div class="tv-field">
        <label>{t('trayVaults.dbPassword')}</label>
        <input
          aria-label={t('trayVaults.dbPassword')}
          type="password"
          autocomplete="current-password"
          value={password()}
          onInput={(e) => setPassword(e.currentTarget.value)}
        />
      </div>
      <button type="submit" class="primary tv-submit" disabled={busy()}>
        {busy() ? t('connections.unlocking') : t('connections.unlock')}
      </button>
    </form>
  );
}

// ── Edit an existing connection ───────────────────────────────────────────────
// Change server / storeCredentials; the master password is only required when
// the change forces a re-authentication (server change or turning storage on).

function EditPanel(props: { conn: ConnectionSummary; onDone: () => void; onClose: () => void }) {
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
  const passwordRequired = () => serverChanged() || enablingStore();

  async function save(withTf: boolean) {
    if (passwordRequired() && !password()) {
      pushToast('error', t('connections.enterMasterPwToApply'));
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
        pushToast('info', t('connections.twoFactorRequired'));
      } else {
        pushToast('success', t('connections.updated'));
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
      pushToast('success', t('connections.codeSent'));
    } catch (err) {
      toastError(err);
    } finally {
      setBusy(false);
    }
  }

  return (
    <form
      class="tv-panel"
      onSubmit={(e) => {
        e.preventDefault();
        void save(tfProviders() !== null);
      }}
    >
      <div class="tv-panel-head">
        <span class="tv-panel-title">{t('connections.editConnection')}</span>
        <button
          type="button"
          class="ghost tv-icon"
          title={t('common.close')}
          onClick={() => props.onClose()}
        >
          <X size={14} strokeWidth={1.75} />
        </button>
      </div>

      <Show
        when={!tfProviders()}
        fallback={
          <TwoFactorFields
            providers={tfProviders() ?? []}
            provider={tfProvider()}
            setProvider={setTfProvider}
            token={tfToken()}
            setToken={setTfToken}
            busy={busy()}
            onSendCode={() => void sendCode()}
          />
        }
      >
        <ServerFields
          region={region()}
          setRegion={setRegion}
          baseUrl={baseUrl()}
          setBaseUrl={setBaseUrl}
        />
        <label class="tv-check">
          <input
            type="checkbox"
            checked={store()}
            onChange={(e) => setStore(e.currentTarget.checked)}
          />
          <span>{t('connections.storeLogin')}</span>
        </label>
        <div class="tv-field">
          <label>
            {t('connections.masterPassword')}
            <Show when={!passwordRequired()}>
              <span class="tv-hint"> {t('connections.masterPasswordOnlyReauth')}</span>
            </Show>
          </label>
          <input
            aria-label={t('connections.masterPassword')}
            type="password"
            autocomplete="current-password"
            placeholder={
              passwordRequired()
                ? t('connections.pwRequiredForChange')
                : t('connections.pwLeaveBlank')
            }
            value={password()}
            onInput={(e) => setPassword(e.currentTarget.value)}
          />
        </div>
      </Show>

      <button type="submit" class="primary tv-submit" disabled={busy()}>
        {busy()
          ? t('connections.saving')
          : tfProviders()
            ? t('connections.verifyAndSave')
            : t('connections.saveChanges')}
      </button>
    </form>
  );
}

// ── Remove a connection (inline confirm) ─────────────────────────────────────

function RemoveConfirm(props: {
  conn: ConnectionSummary;
  onDone: () => void;
  onClose: () => void;
}) {
  const [busy, setBusy] = createSignal(false);

  async function remove() {
    setBusy(true);
    try {
      await ipc.removeConnection(props.conn.email);
      pushToast('success', t('connections.removed'));
      props.onDone();
    } catch (err) {
      toastError(err);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div class="tv-panel">
      <p class="tv-confirm-text">{t('trayVaults.removeConfirm', { email: props.conn.email })}</p>
      <div class="tv-confirm-actions">
        <button class="ghost" disabled={busy()} onClick={() => props.onClose()}>
          {t('common.cancel')}
        </button>
        <button class="danger" disabled={busy()} onClick={() => void remove()}>
          {t('common.remove')}
        </button>
      </div>
    </div>
  );
}

// ── Add a vault (inline view swap) ────────────────────────────────────────────
// Step 1: pick the source — a Bitwarden account or a KeePass database. The
// header's back button steps back to the choice (or to the list from there).

type AddSource = 'choose' | 'bitwarden' | 'keepass';

function AddVault(props: { onDone: () => void; onCancel: () => void }) {
  const [source, setSource] = createSignal<AddSource>('choose');

  return (
    <>
      <header class="tv-head">
        <button
          class="ghost tv-icon"
          title={t('common.back')}
          onClick={() => (source() === 'choose' ? props.onCancel() : setSource('choose'))}
        >
          <ArrowLeft size={15} strokeWidth={1.75} />
        </button>
        <span class="tv-title">{t('trayVaults.addVault')}</span>
      </header>
      <Show when={source() === 'choose'}>
        <div class="tv-form">
          <p class="tv-note">{t('trayVaults.sourceTitle')}</p>
          <button type="button" class="tv-source-btn" onClick={() => setSource('bitwarden')}>
            <Cloud size={16} strokeWidth={1.75} />
            <span>{t('trayVaults.sourceBitwarden')}</span>
          </button>
          <button type="button" class="tv-source-btn" onClick={() => setSource('keepass')}>
            <FileKey size={16} strokeWidth={1.75} />
            <span>{t('trayVaults.sourceKeepass')}</span>
          </button>
        </div>
      </Show>
      <Show when={source() === 'bitwarden'}>
        <AddBitwardenForm onDone={props.onDone} />
      </Show>
      <Show when={source() === 'keepass'}>
        <AddKeepassForm onDone={props.onDone} />
      </Show>
    </>
  );
}

// ── Add a Bitwarden account ───────────────────────────────────────────────────
// Field semantics identical to the main window's Onboarding: server pick →
// email + master password + store-credentials toggle → submit; a
// twoFactorRequired result swaps in the 2FA step (provider pick, email-code
// send, code entry); success returns to the list.

function AddBitwardenForm(props: { onDone: () => void }) {
  const [region, setRegion] = createSignal<Region>('us');
  const [baseUrl, setBaseUrl] = createSignal('');
  const [email, setEmail] = createSignal('');
  const [password, setPassword] = createSignal('');
  // Store this account's master password (sealed) so it auto-unlocks, vs.
  // require unlocking it manually each session. Default: store (auto-unlock).
  const [storeCredentials, setStoreCredentials] = createSignal(true);
  const [busy, setBusy] = createSignal(false);
  const [tfProviders, setTfProviders] = createSignal<TwoFactorKind[] | null>(null);
  const [tfProvider, setTfProvider] = createSignal<TwoFactorKind>('authenticator');
  const [tfToken, setTfToken] = createSignal('');

  const server = () => makeServer(region(), baseUrl());

  async function add(withTf: boolean) {
    if (!email().trim() || !password()) {
      pushToast('error', t('onboarding.enterEmailAndPassword'));
      return;
    }
    setBusy(true);
    try {
      const tf = withTf
        ? { provider: tfProvider(), token: tfToken().trim(), remember: false }
        : undefined;
      const result = await ipc.addConnection(
        server(),
        email().trim(),
        password(),
        storeCredentials(),
        tf,
      );
      if (result.status === 'twoFactorRequired') {
        setTfProviders(result.providers);
        setTfProvider(result.providers[0] ?? 'authenticator');
        pushToast('info', t('connections.twoFactorRequired'));
      } else {
        pushToast('success', t('trayVaults.added'));
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
      await ipc.sendEmailCode(server(), email().trim(), password());
      pushToast('success', t('connections.codeSent'));
    } catch (err) {
      toastError(err);
    } finally {
      setBusy(false);
    }
  }

  return (
    <form
      class="tv-form"
      onSubmit={(e) => {
        e.preventDefault();
        void add(tfProviders() !== null);
      }}
    >
      <Show
        when={!tfProviders()}
        fallback={
          <>
            <p class="tv-note">{t('onboarding.twoFactorIntro')}</p>
            <TwoFactorFields
              providers={tfProviders() ?? []}
              provider={tfProvider()}
              setProvider={setTfProvider}
              token={tfToken()}
              setToken={setTfToken}
              busy={busy()}
              onSendCode={() => void sendCode()}
            />
            <button type="submit" class="primary tv-submit" disabled={busy()}>
              {busy() ? t('onboarding.adding') : t('onboarding.verifyAndAdd')}
            </button>
            <button
              type="button"
              class="ghost tv-submit"
              disabled={busy()}
              onClick={() => setTfProviders(null)}
            >
              {t('common.back')}
            </button>
          </>
        }
      >
        <ServerFields
          region={region()}
          setRegion={setRegion}
          baseUrl={baseUrl()}
          setBaseUrl={setBaseUrl}
        />
        <div class="tv-field">
          <label>{t('onboarding.email')}</label>
          <input
            aria-label={t('onboarding.email')}
            type="email"
            autocomplete="username"
            value={email()}
            onInput={(e) => setEmail(e.currentTarget.value)}
          />
        </div>
        <div class="tv-field">
          <label>{t('onboarding.masterPassword')}</label>
          <input
            aria-label={t('onboarding.masterPassword')}
            type="password"
            autocomplete="current-password"
            value={password()}
            onInput={(e) => setPassword(e.currentTarget.value)}
          />
        </div>
        <label class="tv-check">
          <input
            type="checkbox"
            checked={storeCredentials()}
            onChange={(e) => setStoreCredentials(e.currentTarget.checked)}
          />
          <span>{t('connections.storeLogin')}</span>
        </label>
        <button type="submit" class="primary tv-submit" disabled={busy()}>
          {busy() ? t('onboarding.adding') : t('onboarding.addConnection')}
        </button>
      </Show>
    </form>
  );
}

// ── Add a KeePass database ────────────────────────────────────────────────────
// Local-only flow, no 2FA: pick the .kdbx file, enter the database password,
// optionally pick a key file, choose whether to remember the password (sealed
// under the VMK, same semantics as the Bitwarden store-credentials toggle).

function AddKeepassForm(props: { onDone: () => void }) {
  const [path, setPath] = createSignal<string | null>(null);
  const [password, setPassword] = createSignal('');
  const [keyfile, setKeyfile] = createSignal<string | null>(null);
  // Default mirrors the Bitwarden form: remember (auto-unlock with the app).
  const [storeCredentials, setStoreCredentials] = createSignal(true);
  const [busy, setBusy] = createSignal(false);

  async function pickDatabase() {
    try {
      const picked = await ipc.pickKeepassDatabase();
      if (picked !== null) setPath(picked);
    } catch (err) {
      toastError(err);
    }
  }

  async function pickKeyfile() {
    try {
      const picked = await ipc.pickKeepassKeyfile();
      if (picked !== null) setKeyfile(picked);
    } catch (err) {
      toastError(err);
    }
  }

  async function add() {
    const p = path();
    if (!p || !password()) {
      pushToast('error', t('trayVaults.selectDbAndPassword'));
      return;
    }
    setBusy(true);
    try {
      await ipc.addKeepassConnection(p, password(), keyfile(), storeCredentials());
      pushToast('success', t('trayVaults.added'));
      props.onDone();
    } catch (err) {
      toastError(err);
    } finally {
      setBusy(false);
    }
  }

  const dbLabel = () => {
    const p = path();
    return p === null ? t('trayVaults.chooseFile') : fileNameOf(p);
  };
  const keyfileLabel = () => {
    const k = keyfile();
    return k === null ? t('trayVaults.chooseFile') : fileNameOf(k);
  };

  return (
    <form
      class="tv-form"
      onSubmit={(e) => {
        e.preventDefault();
        void add();
      }}
    >
      <div class="tv-field">
        <label>{t('trayVaults.databaseFile')}</label>
        <button
          type="button"
          class="tv-file-btn"
          classList={{ placeholder: path() === null }}
          disabled={busy()}
          title={path() ?? undefined}
          onClick={() => void pickDatabase()}
        >
          {dbLabel()}
        </button>
      </div>
      <div class="tv-field">
        <label>{t('trayVaults.dbPassword')}</label>
        <input
          aria-label={t('trayVaults.dbPassword')}
          type="password"
          autocomplete="current-password"
          value={password()}
          onInput={(e) => setPassword(e.currentTarget.value)}
        />
      </div>
      <div class="tv-field">
        <label>
          {t('trayVaults.keyfile')} <span class="tv-hint">{t('trayVaults.keyfileOptional')}</span>
        </label>
        <div class="tv-file-row">
          <button
            type="button"
            class="tv-file-btn"
            classList={{ placeholder: keyfile() === null }}
            disabled={busy()}
            title={keyfile() ?? undefined}
            onClick={() => void pickKeyfile()}
          >
            {keyfileLabel()}
          </button>
          <Show when={keyfile() !== null}>
            <button
              type="button"
              class="ghost tv-icon"
              title={t('trayVaults.clearKeyfile')}
              disabled={busy()}
              onClick={() => setKeyfile(null)}
            >
              <X size={14} strokeWidth={1.75} />
            </button>
          </Show>
        </div>
      </div>
      <label class="tv-check">
        <input
          type="checkbox"
          checked={storeCredentials()}
          onChange={(e) => setStoreCredentials(e.currentTarget.checked)}
        />
        <span>{t('trayVaults.rememberDbPassword')}</span>
      </label>
      <button type="submit" class="primary tv-submit" disabled={busy()}>
        {busy() ? t('onboarding.adding') : t('trayVaults.addKeepass')}
      </button>
    </form>
  );
}
