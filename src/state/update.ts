// Auto-update preferences + the shared check/install actions. The two booleans
// are non-secret UI prefs, persisted in localStorage (like the theme + audit
// config), never the keychain, and validated at the storage boundary. Both the
// Updates settings page and the startup auto-check (App.tsx) drive the same
// signals here, so a background check on launch is reflected live when the page
// opens — one update path, not two.

import { createSignal } from 'solid-js';
import { ipc } from '../lib/ipc.ts';
import { pushToast } from './toast.ts';

export interface UpdateConfig {
  /** Check for a newer release automatically on launch. */
  autoCheck: boolean;
  /** When a launch check finds an update, download + install it without asking. */
  autoInstall: boolean;
}

export const DEFAULT_UPDATE_CONFIG: UpdateConfig = {
  autoCheck: true,
  autoInstall: false,
};

const CONFIG_KEY = 'agate.updateConfig';
const LAST_CHECKED_KEY = 'agate.updateLastChecked';

// ── persisted config ─────────────────────────────────────────────────────────
function readConfig(): UpdateConfig {
  try {
    const raw = localStorage.getItem(CONFIG_KEY);
    if (!raw) return DEFAULT_UPDATE_CONFIG;
    const parsed: unknown = JSON.parse(raw);
    if (typeof parsed !== 'object' || parsed === null) return DEFAULT_UPDATE_CONFIG;
    const o = parsed as Record<string, unknown>;
    const bool = (v: unknown, d: boolean) => (typeof v === 'boolean' ? v : d);
    return {
      autoCheck: bool(o.autoCheck, DEFAULT_UPDATE_CONFIG.autoCheck),
      autoInstall: bool(o.autoInstall, DEFAULT_UPDATE_CONFIG.autoInstall),
    };
  } catch {
    // ignore: corrupt/unavailable config falls back to defaults
    return DEFAULT_UPDATE_CONFIG;
  }
}

const [updateConfig, setConfigSig] = createSignal<UpdateConfig>(readConfig());
export { updateConfig };

export function setUpdateOption<K extends keyof UpdateConfig>(key: K, value: UpdateConfig[K]) {
  const next: UpdateConfig = { ...updateConfig(), [key]: value };
  setConfigSig(next);
  try {
    localStorage.setItem(CONFIG_KEY, JSON.stringify(next));
  } catch {
    // ignore: persistence is best-effort; the in-memory signal still applies
  }
}

// ── last-checked timestamp (persisted, ms since epoch) ───────────────────────
function readLastChecked(): number | null {
  try {
    const raw = localStorage.getItem(LAST_CHECKED_KEY);
    if (!raw) return null;
    const n = Number(raw);
    return Number.isFinite(n) && n > 0 ? n : null;
  } catch {
    // ignore: unavailable storage just means "never checked here"
    return null;
  }
}

const [lastCheckedAt, setLastCheckedSig] = createSignal<number | null>(readLastChecked());
export { lastCheckedAt };

function stampChecked() {
  const now = Date.now();
  setLastCheckedSig(now);
  try {
    localStorage.setItem(LAST_CHECKED_KEY, String(now));
  } catch {
    // ignore: persistence is best-effort; the in-memory signal still applies
  }
}

// ── runtime status (in-memory, per session) ─────────────────────────────────
// availableVersion: null = not checked this session; '' = checked, up to date;
// otherwise the version string of the available update.
const [availableVersion, setAvailableVersion] = createSignal<string | null>(null);
const [checking, setChecking] = createSignal(false);
const [installing, setInstalling] = createSignal(false);
export { availableVersion, checking, installing };

/** Check for an update. Returns the available version, or null if up to date.
 *  Throws on failure — callers decide whether to surface it. */
export async function checkForUpdate(): Promise<string | null> {
  setChecking(true);
  try {
    const version = await ipc.checkUpdate();
    setAvailableVersion(version ?? '');
    stampChecked();
    return version;
  } finally {
    setChecking(false);
  }
}

/** Download + install the available update, then relaunch. The backend restarts
 *  the app on success, so this normally never returns; if it does fail partway,
 *  the installing flag is cleared and the error re-thrown for the caller. */
export async function installUpdate(): Promise<void> {
  setInstalling(true);
  try {
    await ipc.runUpdate();
  } catch (err) {
    setInstalling(false);
    throw err;
  }
}

/** Run once at startup. No-op unless auto-check is on. Silent when up to date;
 *  when an update is found it either auto-installs (if enabled) or raises a
 *  single info toast pointing at Settings › Updates. */
export async function runStartupUpdateCheck(): Promise<void> {
  if (!updateConfig().autoCheck) return;
  try {
    const version = await checkForUpdate();
    if (!version) return;
    if (updateConfig().autoInstall) {
      await installUpdate();
    } else {
      pushToast('info', `Agate ${version} is available — install it in Settings › Updates.`);
    }
  } catch {
    // ignore: a failed background check must never block startup; the user can
    // still check (and see the error) by hand in Settings › Updates
  }
}
