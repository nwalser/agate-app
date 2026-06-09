// Security feature state: enable/disable preferences (persisted, default ON) and
// periodic automatic scans of *all* connected accounts. There is deliberately no
// single-account lookup — the dark-web monitor and the exposed-password check
// always cover every account, on an interval while the vault is unlocked. The
// toggles live in Settings → Security.
//
// Preferences are non-secret UI prefs, so they live in localStorage (same as the
// theme), not the keychain. The dark-web monitor mirrors its on/off state into the
// backend consent flag (`set_darkweb_consent`) that the scan command enforces, so
// turning the toggle off also revokes the backend's permission to call out.

import { createEffect, createRoot, createSignal } from 'solid-js';
import { ipc } from '../lib/ipc.ts';
import type { BreachRecord, DarkWebReport, ExposedResult } from '../lib/types.ts';
import { status } from './session.ts';
import { toastError } from './toast.ts';

const KEY_DARKWEB = 'agate.security.darkwebMonitor';
const KEY_EXPOSED = 'agate.security.exposedCheck';

// How often the background scans re-run while the vault stays unlocked. Breach
// data changes slowly and the providers are rate-limited, so this is infrequent.
const SCAN_PERIOD_MS = 6 * 60 * 60 * 1000; // 6 hours

function readBool(key: string, fallback: boolean): boolean {
  try {
    const v = localStorage.getItem(key);
    if (v === 'true') return true;
    if (v === 'false') return false;
  } catch {
    // ignore: localStorage may be unavailable (private mode); use the default
  }
  return fallback;
}

function writeBool(key: string, value: boolean): void {
  try {
    localStorage.setItem(key, String(value));
  } catch {
    // ignore: persistence is best-effort; the in-memory signal still applies
  }
}

// Both features default ON.
const [darkwebMonitor, setDarkwebMonitorSig] = createSignal(readBool(KEY_DARKWEB, true));
const [exposedCheck, setExposedCheckSig] = createSignal(readBool(KEY_EXPOSED, true));

const [darkwebReport, setDarkwebReport] = createSignal<DarkWebReport | null>(null);
const [exposedResults, setExposedResults] = createSignal<ExposedResult[] | null>(null);
const [darkwebBusy, setDarkwebBusy] = createSignal(false);
const [exposedBusy, setExposedBusy] = createSignal(false);
const [darkwebRunAt, setDarkwebRunAt] = createSignal<number | null>(null);
const [exposedRunAt, setExposedRunAt] = createSignal<number | null>(null);

export {
  darkwebBusy,
  darkwebMonitor,
  darkwebReport,
  darkwebRunAt,
  exposedBusy,
  exposedCheck,
  exposedResults,
  exposedRunAt,
};

/** Run the dark-web monitor over every account (no-op if disabled or locked). */
export async function runDarkwebScan(): Promise<void> {
  if (!darkwebMonitor() || !status().unlocked || darkwebBusy()) return;
  setDarkwebBusy(true);
  try {
    // The backend scan refuses unless consent is recorded; keep it in sync.
    await ipc.setDarkwebConsent(true);
    setDarkwebReport(await ipc.darkwebScanVault());
    setDarkwebRunAt(Date.now());
  } catch (err) {
    toastError(err);
  } finally {
    setDarkwebBusy(false);
  }
}

/** Run the exposed-password check (no-op if disabled or locked). */
export async function runExposedCheck(): Promise<void> {
  if (!exposedCheck() || !status().unlocked || exposedBusy()) return;
  setExposedBusy(true);
  try {
    setExposedResults(await ipc.auditExposed());
    setExposedRunAt(Date.now());
  } catch (err) {
    toastError(err);
  } finally {
    setExposedBusy(false);
  }
}

export async function setDarkwebMonitor(enabled: boolean): Promise<void> {
  setDarkwebMonitorSig(enabled);
  writeBool(KEY_DARKWEB, enabled);
  if (enabled) {
    await runDarkwebScan();
  } else {
    // Revoke the backend's permission to call out, and drop stale results.
    try {
      await ipc.setDarkwebConsent(false);
    } catch (err) {
      toastError(err);
    }
    setDarkwebReport(null);
    setDarkwebRunAt(null);
  }
}

export function setExposedCheck(enabled: boolean): void {
  setExposedCheckSig(enabled);
  writeBool(KEY_EXPOSED, enabled);
  if (enabled) {
    void runExposedCheck();
  } else {
    setExposedResults(null);
    setExposedRunAt(null);
  }
}

/**
 * The account-relevant breach directory: the breaches your *own* accounts appear
 * in (from the latest dark-web scan), deduplicated across accounts and annotated
 * with how many of your accounts each one hit. Never the full public catalogue.
 */
export function relevantBreaches(): { breach: BreachRecord; accountCount: number }[] {
  const report = darkwebReport();
  if (!report) return [];
  const byName = new Map<string, { breach: BreachRecord; accountCount: number }>();
  for (const account of report.accounts) {
    for (const breach of account.breaches) {
      const key = breach.name.toLowerCase();
      const existing = byName.get(key);
      if (existing) {
        existing.accountCount += 1;
        // Prefer the record carrying the most "what leaked" detail.
        if (breach.dataClasses.length > existing.breach.dataClasses.length) {
          existing.breach = breach;
        }
      } else {
        byName.set(key, { breach, accountCount: 1 });
      }
    }
  }
  return [...byName.values()].sort((a, b) => b.accountCount - a.accountCount);
}

let started = false;

/**
 * Start the periodic security loop. Called once at startup. Runs the enabled
 * scans whenever the vault transitions to unlocked, then on a fixed interval
 * while it stays unlocked. Cheap no-ops when nothing is enabled or the vault is
 * locked.
 */
export function initSecurity(): void {
  if (started) return;
  started = true;

  createRoot(() => {
    let wasUnlocked = false;
    createEffect(() => {
      const unlocked = status().unlocked;
      if (unlocked && !wasUnlocked) {
        void runDarkwebScan();
        void runExposedCheck();
      }
      wasUnlocked = unlocked;
    });
  });

  setInterval(() => {
    if (!status().unlocked) return;
    void runDarkwebScan();
    void runExposedCheck();
  }, SCAN_PERIOD_MS);
}
