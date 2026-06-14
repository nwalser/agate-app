// Tray settings view — the app's COMPLETE settings, compact, inside the 380px
// tray popup (the popup IS the app now). One scrollable column of stacked
// sections, ported from the main-window settings pages (which die with the main
// window):
//   Appearance  ← screens/settings/AppearanceSettings.tsx (theme + language only;
//                 the list-layout/density/columns prefs die with the big list)
//   Security    ← components/SecuritySettings.tsx, reused directly (ToggleRow +
//                 Select fit 380px as-is)
//   Unlock      ← screens/settings/UnlockSettings.tsx (change app password +
//                 Windows Hello / Touch ID toggle)
//   Startup     ← screens/settings/StartupSettings.tsx (launch-at-login ONLY —
//                 close-to-tray / start-in-tray are removed app-wide: there is
//                 no main window anymore)
//   Autofill    ← screens/settings/AutofillSettings.tsx (whole thing, compact)
//   Updates     ← screens/settings/UpdatesSettings.tsx (version line, manual
//                 check/install, auto-update prefs — compact)
//   Danger      ← "Log out everywhere" (ipc.logout) behind an inline confirm;
//                 it deletes every sealed credential + the app-unlock + Hello
//                 blobs (the connection list is kept — see connections.rs).
//
// The shell renders the header/back chrome; props.onBack is only called here
// after a successful logout (the settings no longer apply to a logged-out app).
// Shared controls come from SettingsControls.tsx — never a hand-rolled toggle.

import { createSignal, For, onMount, Show, type JSX } from 'solid-js';
import { getVersion } from '@tauri-apps/api/app';
import {
  AlertTriangle,
  CheckCircle2,
  DownloadCloud,
  Fingerprint,
  KeyRound,
  LogOut,
  Palette,
  Plus,
  Power,
  RefreshCw,
  Wand2,
  X,
} from 'lucide-solid';
import { ipc } from '../../lib/ipc.ts';
import { LOCALES, locale, setLocale, t } from '../../lib/i18n.ts';
import { setTheme, theme, type ThemePref } from '../../state/theme.ts';
import { refreshSession, status } from '../../state/session.ts';
import { pushToast, toastError } from '../../state/toast.ts';
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
import type { AutofillMode } from '../../lib/types.ts';
import SecuritySettings from '../../components/SecuritySettings.tsx';
import { Select, SettingRow, ToggleRow } from '../../components/settings/SettingsControls.tsx';
import './TraySettings.css';

const THEME_OPTIONS: { value: ThemePref; labelKey: string }[] = [
  { value: 'system', labelKey: 'theme.system' },
  { value: 'light', labelKey: 'theme.light' },
  { value: 'dark', labelKey: 'theme.dark' },
];

// Platform-appropriate name for the biometric unlock method (same derivation as
// UnlockSettings: brand tokens stay literal; the generic fallback re-localizes).
const UA = typeof navigator !== 'undefined' ? navigator.userAgent : '';
const biometricName = (): string =>
  /Mac/.test(UA)
    ? 'Touch ID'
    : /Windows/.test(UA)
      ? 'Windows Hello'
      : t('unlockSettings.biometricGeneric');

function formatChecked(ts: number | null): string {
  if (!ts) return t('updates.never');
  try {
    return new Date(ts).toLocaleString();
  } catch {
    // ignore: a bad timestamp is only cosmetic
    return t('updates.unknown');
  }
}

export default function TraySettings(props: { onBack: () => void }): JSX.Element {
  // ── Unlock: change app password ─────────────────────────────────────────────
  const [newPw, setNewPw] = createSignal('');
  const [confirmPw, setConfirmPw] = createSignal('');
  const [pwBusy, setPwBusy] = createSignal(false);

  // ── Unlock: Windows Hello / Touch ID ────────────────────────────────────────
  const [helloAvailable, setHelloAvailable] = createSignal(false);
  const [helloBusy, setHelloBusy] = createSignal(false);

  // ── Startup ─────────────────────────────────────────────────────────────────
  const [autostart, setAutostart] = createSignal(false);
  const [autostartBusy, setAutostartBusy] = createSignal(false);

  // ── Autofill ────────────────────────────────────────────────────────────────
  const [afMode, setAfMode] = createSignal<AutofillMode>('off');
  const [afSupported, setAfSupported] = createSignal(true);
  const [afHotkey, setAfHotkey] = createSignal('');
  const [afBusy, setAfBusy] = createSignal(false);
  const [afSubmit, setAfSubmit] = createSignal(false);
  const [afDenylist, setAfDenylist] = createSignal<string[]>([]);
  // The draft in the "add a process name" input under the denylist editor.
  const [denyDraft, setDenyDraft] = createSignal('');

  // ── Updates / danger ────────────────────────────────────────────────────────
  const [version, setVersion] = createSignal('');
  const [confirmLogout, setConfirmLogout] = createSignal(false);
  const [loggingOut, setLoggingOut] = createSignal(false);

  onMount(() => {
    // Each loader is independent — one failing backend probe must not blank the
    // whole settings view, so they run and error-surface separately.
    void (async () => {
      try {
        await refreshSession(); // populates status().helloConfigured
      } catch (err) {
        toastError(err);
      }
    })();
    void (async () => {
      try {
        setHelloAvailable(await ipc.helloAvailable());
      } catch (err) {
        toastError(err);
      }
    })();
    void (async () => {
      try {
        setAutostart(await ipc.getAutostart());
      } catch (err) {
        toastError(err);
      }
    })();
    void (async () => {
      try {
        const s = await ipc.autofillStatus();
        setAfMode(s.mode);
        setAfSupported(s.supported);
        setAfHotkey(s.hotkey);
        setAfSubmit(s.submit);
        setAfDenylist(s.denylist);
      } catch (err) {
        toastError(err);
      }
    })();
    // Build info is informational — leave it blank if the host can't report it.
    void getVersion().then(setVersion).catch(() => {});
  });

  async function changeAppPw() {
    if (newPw().length < 8) {
      pushToast('error', t('unlockSettings.pwMinLength'));
      return;
    }
    if (newPw() !== confirmPw()) {
      pushToast('error', t('unlockSettings.pwMismatch'));
      return;
    }
    setPwBusy(true);
    try {
      await ipc.changeAppUnlock(newPw());
      setNewPw('');
      setConfirmPw('');
      await refreshSession();
      pushToast('success', t('unlockSettings.appUnlockUpdated'));
    } catch (err) {
      toastError(err);
    } finally {
      setPwBusy(false);
    }
  }

  async function toggleHello() {
    setHelloBusy(true);
    try {
      if (status().helloConfigured) {
        await ipc.helloDisable();
        await refreshSession();
        pushToast('success', t('unlockSettings.biometricDisabled', { name: biometricName() }));
      } else {
        await ipc.helloEnable();
        await refreshSession();
        pushToast('success', t('unlockSettings.biometricEnabled', { name: biometricName() }));
      }
    } catch (err) {
      toastError(err);
    } finally {
      setHelloBusy(false);
    }
  }

  // Persist first, reflect only on success — a failed write must not leave the
  // switch lying about the stored state (same shape as StartupSettings).
  async function toggleAutostart() {
    setAutostartBusy(true);
    const next = !autostart();
    try {
      await ipc.setAutostart(next);
      setAutostart(next);
    } catch (err) {
      toastError(err);
    } finally {
      setAutostartBusy(false);
    }
  }

  async function changeAutofillMode(next: AutofillMode) {
    if (next === afMode()) return;
    setAfBusy(true);
    try {
      await ipc.autofillSetMode(next);
      setAfMode(next);
    } catch (err) {
      toastError(err);
    } finally {
      setAfBusy(false);
    }
  }

  // Persist first, reflect only on success — a failed write must not leave the
  // switch lying about the stored state (same shape as toggleAutostart).
  async function toggleAutofillSubmit(next: boolean) {
    setAfBusy(true);
    try {
      await ipc.autofillSetSubmit(next);
      setAfSubmit(next);
    } catch (err) {
      toastError(err);
    } finally {
      setAfBusy(false);
    }
  }

  // Normalize an entry the way the matcher compares process stems: trimmed,
  // lowercased. Empty after trim → null (ignored).
  function normalizeDenyEntry(raw: string): string | null {
    const v = raw.trim().toLowerCase();
    return v.length ? v : null;
  }

  // Persist a new denylist and reflect only on success (same posture as the
  // submit toggle). Dedupe keeps the input idempotent.
  async function commitDenylist(next: string[]) {
    const deduped = [...new Set(next)];
    setAfBusy(true);
    try {
      await ipc.autofillSetDenylist(deduped);
      setAfDenylist(deduped);
    } catch (err) {
      toastError(err);
    } finally {
      setAfBusy(false);
    }
  }

  async function addDenyEntry() {
    const entry = normalizeDenyEntry(denyDraft());
    if (!entry) return;
    if (afDenylist().includes(entry)) {
      setDenyDraft('');
      return;
    }
    await commitDenylist([...afDenylist(), entry]);
    setDenyDraft('');
  }

  async function removeDenyEntry(entry: string) {
    await commitDenylist(afDenylist().filter((e) => e !== entry));
  }

  const afOptions = (): { value: AutofillMode; label: string }[] => [
    { value: 'off', label: t('autofill.mode.off') },
    { value: 'hotkey', label: t('autofill.mode.hotkey') },
    { value: 'watch', label: t('autofill.mode.watch') },
  ];

  const afDesc = () => {
    switch (afMode()) {
      case 'hotkey':
        return t('autofill.hotkeyHint', { hotkey: afHotkey() });
      case 'watch':
        return t('autofill.watchHint');
      default:
        return t('autofill.offHint');
    }
  };

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

  async function doLogout() {
    setLoggingOut(true);
    try {
      await ipc.logout();
      await refreshSession();
      // Settings no longer apply to a logged-out app — hand back to the shell.
      props.onBack();
    } catch (err) {
      toastError(err);
    } finally {
      setLoggingOut(false);
      setConfirmLogout(false);
    }
  }

  return (
    <div class="tray-settings">
      {/* ── Appearance: theme + language (list prefs die with the big list) ── */}
      <section class="settings-section">
        <h3>
          <Palette size={14} strokeWidth={1.75} /> {t('appearance.title')}
        </h3>
        <p class="muted settings-help">{t('appearance.help')}</p>
        <Select
          ariaLabel={t('appearance.title')}
          value={theme()}
          options={THEME_OPTIONS.map((o) => ({ value: o.value, label: t(o.labelKey) }))}
          onChange={(v) => setTheme(v)}
        />
        <h3 class="sec-subhead">{t('appearance.language')}</h3>
        <p class="muted settings-help">{t('appearance.languageHelp')}</p>
        <Select
          ariaLabel={t('appearance.language')}
          value={locale()}
          options={LOCALES.map((l) => ({ value: l.id, label: l.label }))}
          onChange={(v) => setLocale(v)}
        />
      </section>

      {/* ── Security: vault timeout, lock-on-minimize, clipboard — the shared
             component reused directly (its rows fit 380px as-is). ── */}
      <SecuritySettings />

      {/* ── Unlock: change app password ── */}
      <section class="settings-section">
        <h3>
          <KeyRound size={14} strokeWidth={1.75} /> {t('unlockSettings.appPassword')}
        </h3>
        <p class="muted settings-help">{t('unlockSettings.appPasswordHelp')}</p>
        <div class="field">
          <label>{t('unlockSettings.newAppPassword')}</label>
          <input
            type="password"
            autocomplete="new-password"
            value={newPw()}
            onInput={(e) => setNewPw(e.currentTarget.value)}
          />
        </div>
        <div class="field">
          <label>{t('unlockSettings.confirmPassword')}</label>
          <input
            type="password"
            autocomplete="new-password"
            value={confirmPw()}
            onInput={(e) => setConfirmPw(e.currentTarget.value)}
          />
        </div>
        <div class="settings-actions">
          <button class="primary" disabled={pwBusy()} onClick={() => void changeAppPw()}>
            {t('unlockSettings.updateAppUnlock')}
          </button>
        </div>
      </section>

      {/* ── Unlock: Windows Hello / Touch ID ── */}
      <section class="settings-section">
        <h3>
          <Fingerprint size={14} strokeWidth={1.75} /> {biometricName()}
        </h3>
        <p class="muted settings-help">
          {t('unlockSettings.biometricHelp', { name: biometricName() })}
        </p>
        <Show
          when={helloAvailable()}
          fallback={
            <p class="muted settings-help">
              {t('unlockSettings.biometricUnavailable', { name: biometricName() })}
            </p>
          }
        >
          <ToggleRow
            label={t('unlockSettings.useBiometric', { name: biometricName() })}
            checked={status().helloConfigured}
            disabled={helloBusy()}
            onChange={() => void toggleHello()}
          />
        </Show>
      </section>

      {/* ── Startup: launch-at-login ONLY (close/start-in-tray are gone —
             there is no main window anymore). ── */}
      <section class="settings-section">
        <h3>
          <Power size={14} strokeWidth={1.75} /> {t('startup.title')}
        </h3>
        <p class="muted settings-help">{t('startup.help')}</p>
        <ToggleRow
          label={t('startup.launch')}
          checked={autostart()}
          disabled={autostartBusy()}
          onChange={() => void toggleAutostart()}
        />
      </section>

      {/* ── Autofill: detection mode (off / hotkey / always-watch) ── */}
      <section class="settings-section">
        <h3>
          <Wand2 size={14} strokeWidth={1.75} /> {t('autofill.title')}
        </h3>
        <p class="muted settings-help">{t('autofill.help')}</p>
        <Show
          when={afSupported()}
          fallback={<p class="muted settings-help">{t('autofill.unsupported')}</p>}
        >
          <SettingRow
            label={t('autofill.modeLabel')}
            desc={afDesc()}
            dim={afBusy()}
            control={
              <Select
                value={afMode()}
                options={afOptions()}
                onChange={(v) => void changeAutofillMode(v)}
                ariaLabel={t('autofill.modeLabel')}
              />
            }
          />
          <p class="muted settings-help">{t('autofill.securityNote')}</p>
          {/* Auto-submit + the per-app denylist only apply once a mode is armed. */}
          <Show when={afMode() !== 'off'}>
            <ToggleRow
              label={t('autofill.submit')}
              desc={t('autofill.submitHint')}
              checked={afSubmit()}
              disabled={afBusy()}
              onChange={(v) => void toggleAutofillSubmit(v)}
            />
            <div class="tray-af-denylist">
              <span class="setting-row-label">{t('autofill.denylist')}</span>
              <p class="muted settings-help">{t('autofill.denylistHint')}</p>
              <Show when={afDenylist().length > 0}>
                <ul class="tray-af-chips">
                  <For each={afDenylist()}>
                    {(entry) => (
                      <li class="tray-af-chip">
                        <span class="tray-af-chip-text">{entry}</span>
                        <button
                          type="button"
                          class="tray-af-chip-remove"
                          title={t('common.remove')}
                          aria-label={t('common.remove')}
                          disabled={afBusy()}
                          onClick={() => void removeDenyEntry(entry)}
                        >
                          <X size={12} strokeWidth={2} />
                        </button>
                      </li>
                    )}
                  </For>
                </ul>
              </Show>
              <form
                class="tray-af-deny-add"
                onSubmit={(e) => {
                  e.preventDefault();
                  void addDenyEntry();
                }}
              >
                <input
                  class="tray-af-deny-input"
                  type="text"
                  value={denyDraft()}
                  placeholder={t('autofill.denylistPlaceholder')}
                  aria-label={t('autofill.denylist')}
                  onInput={(e) => setDenyDraft(e.currentTarget.value)}
                />
                <button
                  type="submit"
                  class="tray-settings-btn tray-af-deny-btn"
                  disabled={afBusy() || normalizeDenyEntry(denyDraft()) === null}
                >
                  <Plus size={14} strokeWidth={1.75} /> {t('autofill.denylistAdd')}
                </button>
              </form>
            </div>
          </Show>
        </Show>
      </section>

      {/* ── Updates: version line, manual check/install, auto prefs ── */}
      <section class="settings-section">
        <h3>
          <DownloadCloud size={14} strokeWidth={1.75} /> {t('updates.title')}
        </h3>
        <Show when={version()}>
          <p class="muted settings-help">{t('updates.versionLabel', { version: version() })}</p>
        </Show>
        <Show
          when={availableVersion()}
          fallback={
            <>
              {/* '' = a check ran, nothing newer (null = not checked yet). */}
              <Show when={availableVersion() === ''}>
                <p class="tray-settings-uptodate">
                  <CheckCircle2 size={13} strokeWidth={2} /> {t('updates.upToDate')}
                </p>
              </Show>
              <div class="settings-actions">
                <button class="primary tray-settings-btn" disabled={checking()} onClick={() => void check()}>
                  <RefreshCw size={14} strokeWidth={1.75} class={checking() ? 'spin' : ''} />
                  {checking() ? t('updates.checking') : t('updates.checkForUpdates')}
                </button>
              </div>
            </>
          }
        >
          {(v) => (
            <>
              <p class="tray-settings-update-available">
                {t('updates.versionAvailable', { version: v() })}
              </p>
              <div class="settings-actions">
                <button class="primary tray-settings-btn" disabled={installing()} onClick={() => void install()}>
                  <DownloadCloud size={14} strokeWidth={1.75} />
                  {installing() ? t('updates.installing') : t('updates.installAndRestart')}
                </button>
              </div>
            </>
          )}
        </Show>
        <p class="muted tray-settings-last-checked">
          {t('updates.lastChecked', { time: formatChecked(lastCheckedAt()) })}
        </p>
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
        <p class="muted tray-settings-foot">{t('updates.footer')}</p>
      </section>

      {/* ── Danger: log out everywhere (inline confirm — it wipes every sealed
             credential + the app-unlock + Hello blobs; connection list kept). ── */}
      <section class="settings-section tray-settings-danger">
        <h3>
          <AlertTriangle size={14} strokeWidth={1.75} /> {t('traySettings.danger')}
        </h3>
        <p class="muted settings-help">{t('traySettings.logoutHelp')}</p>
        <Show
          when={confirmLogout()}
          fallback={
            <div class="settings-actions">
              <button class="danger tray-settings-btn" onClick={() => setConfirmLogout(true)}>
                <LogOut size={14} strokeWidth={1.75} /> {t('connections.logoutAll')}
              </button>
            </div>
          }
        >
          <p class="tray-settings-confirm">{t('traySettings.logoutConfirm')}</p>
          <div class="settings-actions">
            <button class="ghost" disabled={loggingOut()} onClick={() => setConfirmLogout(false)}>
              {t('common.cancel')}
            </button>
            <button class="danger tray-settings-btn" disabled={loggingOut()} onClick={() => void doLogout()}>
              <LogOut size={14} strokeWidth={1.75} /> {t('traySettings.logoutConfirmAction')}
            </button>
          </div>
        </Show>
      </section>
    </div>
  );
}
