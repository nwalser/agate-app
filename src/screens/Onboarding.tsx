import { createSignal, onMount, Show, For } from 'solid-js';
import { Lock, Server, ShieldCheck } from 'lucide-solid';
import { ipc } from '../lib/ipc.ts';
import { t } from '../lib/i18n.ts';
import type { ConnectionSummary, ServerConfig, TwoFactorKind } from '../lib/types.ts';
import { refreshSession } from '../state/session.ts';
import { pushToast, toastError } from '../state/toast.ts';
import './Onboarding.css';

type Region = 'us' | 'eu' | 'selfHosted';

/** Add (or re-authenticate) a Bitwarden connection. Its master password is sealed
 *  under the app-unlock key, so this is configured once per account. */
export default function Onboarding(props: { onDone?: () => void }) {
  const [region, setRegion] = createSignal<Region>('us');
  const [baseUrl, setBaseUrl] = createSignal('');
  const [email, setEmail] = createSignal('');
  const [password, setPassword] = createSignal('');
  // Store this account's master password (sealed) so it auto-unlocks, vs. require
  // unlocking it manually each session. Default: store (auto-unlock).
  const [storeCredentials, setStoreCredentials] = createSignal(true);
  const [busy, setBusy] = createSignal(false);

  const [twoFactorProviders, setTwoFactorProviders] = createSignal<TwoFactorKind[] | null>(null);
  const [tfProvider, setTfProvider] = createSignal<TwoFactorKind>('authenticator');
  const [tfToken, setTfToken] = createSignal('');

  // Saved connections (server + email) so the user never retypes a self-hosted URL.
  const [connections, setConnections] = createSignal<ConnectionSummary[]>([]);
  onMount(() => {
    void (async () => {
      try {
        setConnections(await ipc.listConnections());
      } catch {
        // ignore: no saved connections yet
      }
    })();
  });

  function useConnection(conn: ConnectionSummary) {
    const s = conn.server;
    if (s.region === 'selfHosted') {
      setRegion('selfHosted');
      setBaseUrl(s.baseUrl);
    } else {
      setRegion(s.region);
      setBaseUrl('');
    }
    setEmail(conn.email);
  }

  function serverConfig(): ServerConfig {
    if (region() === 'eu') return { region: 'eu' };
    if (region() === 'selfHosted') return { region: 'selfHosted', baseUrl: baseUrl().trim() };
    return { region: 'us' };
  }

  async function doAdd(withTwoFactor: boolean) {
    if (!email().trim() || !password()) {
      pushToast('error', t('onboarding.enterEmailAndPassword'));
      return;
    }
    setBusy(true);
    try {
      const tf = withTwoFactor
        ? { provider: tfProvider(), token: tfToken().trim(), remember: false }
        : undefined;
      const result = await ipc.addConnection(
        serverConfig(),
        email().trim(),
        password(),
        storeCredentials(),
        tf,
      );
      if (result.status === 'twoFactorRequired') {
        setTwoFactorProviders(result.providers);
        setTfProvider(result.providers[0] ?? 'authenticator');
        pushToast('info', t('onboarding.twoFactorRequired'));
      } else {
        await refreshSession();
        props.onDone?.();
      }
    } catch (err) {
      toastError(err);
    } finally {
      setBusy(false);
    }
  }

  async function sendEmailCode() {
    setBusy(true);
    try {
      await ipc.sendEmailCode(serverConfig(), email().trim(), password());
      pushToast('success', t('onboarding.codeSent'));
    } catch (err) {
      toastError(err);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div class="onboarding">
      <div class="onboarding-card">
        <div class="onboarding-brand">
          <ShieldCheck size={22} strokeWidth={1.75} />
          <span>Agate</span>
        </div>

        <Show
          when={!twoFactorProviders()}
          fallback={
            <div class="onboarding-step">
              <p class="muted onboarding-sub">{t('onboarding.twoFactorIntro')}</p>
              <div class="field">
                <label>{t('onboarding.provider')}</label>
                <select value={tfProvider()} onChange={(e) => setTfProvider(e.currentTarget.value as TwoFactorKind)}>
                  <For each={twoFactorProviders()!}>
                    {(p) => <option value={p}>{p === 'authenticator' ? t('onboarding.authenticatorApp') : t('onboarding.email')}</option>}
                  </For>
                </select>
              </div>
              <Show when={tfProvider() === 'email'}>
                <button class="ghost send-code" disabled={busy()} onClick={() => void sendEmailCode()}>
                  {t('onboarding.sendCodeToEmail')}
                </button>
              </Show>
              <div class="field">
                <label>{t('onboarding.verificationCode')}</label>
                <input
                  value={tfToken()}
                  inputmode="numeric"
                  autocomplete="one-time-code"
                  onInput={(e) => setTfToken(e.currentTarget.value)}
                  onKeyDown={(e) => e.key === 'Enter' && void doAdd(true)}
                />
              </div>
              <button class="primary full" disabled={busy()} onClick={() => void doAdd(true)}>
                {t('onboarding.verifyAndAdd')}
              </button>
              <button class="ghost full" disabled={busy()} onClick={() => setTwoFactorProviders(null)}>
                {t('common.back')}
              </button>
            </div>
          }
        >
          <div class="onboarding-step">
            <p class="muted onboarding-sub">{t('onboarding.addAccountIntro')}</p>
            <Show when={connections().length > 0}>
              <div class="field">
                <label>{t('onboarding.savedConnections')}</label>
                <div class="onboarding-connections">
                  <For each={connections()}>
                    {(conn) => (
                      <button type="button" class="onboarding-connection" onClick={() => useConnection(conn)}>
                        <Server size={13} strokeWidth={1.75} />
                        <span class="onboarding-connection-text">
                          <span>{conn.email}</span>
                          <span class="muted">{conn.serverLabel}</span>
                        </span>
                      </button>
                    )}
                  </For>
                </div>
              </div>
            </Show>
            <div class="field">
              <label>{t('onboarding.server')}</label>
              <select value={region()} onChange={(e) => setRegion(e.currentTarget.value as Region)}>
                <option value="us">{t('onboarding.regionUs')}</option>
                <option value="eu">{t('onboarding.regionEu')}</option>
                <option value="selfHosted">{t('onboarding.regionSelfHosted')}</option>
              </select>
            </div>
            <Show when={region() === 'selfHosted'}>
              <div class="field">
                <label>{t('onboarding.serverUrl')}</label>
                <input
                  placeholder="https://vault.example.com"
                  value={baseUrl()}
                  onInput={(e) => setBaseUrl(e.currentTarget.value)}
                />
              </div>
            </Show>
            <div class="field">
              <label>{t('onboarding.email')}</label>
              <input
                type="email"
                autocomplete="username"
                value={email()}
                onInput={(e) => setEmail(e.currentTarget.value)}
              />
            </div>
            <div class="field">
              <label>{t('onboarding.masterPassword')}</label>
              <input
                type="password"
                autocomplete="current-password"
                value={password()}
                onInput={(e) => setPassword(e.currentTarget.value)}
                onKeyDown={(e) => e.key === 'Enter' && void doAdd(false)}
              />
            </div>

            <button
              type="button"
              class="unlock-method"
              classList={{ active: storeCredentials() }}
              onClick={() => setStoreCredentials((v) => !v)}
            >
              <Lock size={18} strokeWidth={1.6} />
              <span class="unlock-method-text">
                <span class="unlock-method-title">{t('onboarding.storeLoginTitle')}</span>
                <span class="muted unlock-method-sub">
                  {t('onboarding.storeLoginSub')}
                </span>
              </span>
              <input type="checkbox" checked={storeCredentials()} tabindex={-1} />
            </button>

            <button class="primary full" disabled={busy()} onClick={() => void doAdd(false)}>
              {busy() ? t('onboarding.adding') : t('onboarding.addConnection')}
            </button>
            <Show when={props.onDone}>
              <button class="ghost full" disabled={busy()} onClick={() => props.onDone?.()}>
                {t('common.cancel')}
              </button>
            </Show>
          </div>
        </Show>

        <p class="onboarding-disclaimer muted">
          {t('onboarding.disclaimer')}
        </p>
      </div>
    </div>
  );
}
