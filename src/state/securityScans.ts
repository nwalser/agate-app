// Scan orchestration for the security monitors. Owns the *result* signals
// (busy / report / last-run) and the actual all-account scans of the dark-web
// monitor (XposedOrNot) and exposed-password check (HIBP k-anonymity), plus the
// periodic loop that re-runs them while the vault stays unlocked. The on/off
// preferences (and their persistence) live in ./security.ts; this module reads
// those getters and is the only one here that touches IPC.
//
// There is deliberately no single-account lookup — both scans always cover every
// account, on an interval, never on the unlock critical path.

import { createEffect, createRoot, createSignal } from 'solid-js';
import { ipc } from '../lib/ipc.ts';
import { aggregateRelevantBreaches, mergeScanRun, type RelevantBreach } from '../lib/breachAggregation.ts';
import type { AccountBreaches, DarkWebReport, ExposedResult } from '../lib/types.ts';
import { darkwebMonitor, exposedCheck } from './security.ts';
import { status } from './session.ts';
import { toastError } from './toast.ts';

// Persisted last-run timestamps (epoch ms). Survive lock/unlock and restart so a
// re-unlock inside the scan period reuses the cached result instead of re-hitting
// the (slow, rate-limited, privacy-sensitive) providers on every unlock.
const KEY_DARKWEB_AT = 'agate.security.darkwebRunAt';
const KEY_EXPOSED_AT = 'agate.security.exposedRunAt';

// How often the background scans re-run while the vault stays unlocked. Breach
// data changes slowly and the providers are rate-limited, so this is infrequent.
const SCAN_PERIOD_MS = 6 * 60 * 60 * 1000; // 6 hours

// On unlock the app is busy re-logging-in every connection and running the first
// full sync (self-hosted routes that through a loopback proxy). The breach scans
// are heavy network work, so we hold them off this critical path: schedule them a
// little after unlock and only if the cached result is stale. They never race the
// unlock + first sync for network/runtime.
const SCAN_DEFER_MS = 20 * 1000; // 20 seconds

function readTime(key: string): number | null {
  try {
    const v = localStorage.getItem(key);
    if (v === null) return null;
    const n = Number(v);
    return Number.isFinite(n) ? n : null;
  } catch {
    // ignore: localStorage may be unavailable (private mode); treat as never run
    return null;
  }
}

function writeTime(key: string, value: number | null): void {
  try {
    if (value === null) localStorage.removeItem(key);
    else localStorage.setItem(key, String(value));
  } catch {
    // ignore: persistence is best-effort; the in-memory signal still applies
  }
}

/** A scan result is fresh if it ran within the scan period — don't re-run it. */
function isFresh(runAt: number | null): boolean {
  return runAt !== null && Date.now() - runAt < SCAN_PERIOD_MS;
}

const [darkwebReport, setDarkwebReport] = createSignal<DarkWebReport | null>(null);
const [exposedResults, setExposedResults] = createSignal<ExposedResult[] | null>(null);
const [darkwebBusy, setDarkwebBusy] = createSignal(false);
const [exposedBusy, setExposedBusy] = createSignal(false);
const [darkwebRunAt, setDarkwebRunAt] = createSignal<number | null>(readTime(KEY_DARKWEB_AT));
const [exposedRunAt, setExposedRunAt] = createSignal<number | null>(readTime(KEY_EXPOSED_AT));

export {
  darkwebBusy,
  darkwebReport,
  darkwebRunAt,
  exposedBusy,
  exposedResults,
  exposedRunAt,
};

// Checked-email accumulator. The backend scans at most a rotating window per run
// (provider rate budget), so a single run only covers part of a large vault. We
// merge each run's results here, keyed by email, so the Security view shows the
// growing union across runs instead of just the latest window. Cleared when the
// monitor is switched off. Session-scoped (not persisted): breach data is re-fetched.
const checkedByEmail = new Map<string, AccountBreaches>();

/** Run the dark-web monitor over every account (no-op if disabled or locked). */
export async function runDarkwebScan(): Promise<void> {
  if (!darkwebMonitor() || !status().unlocked || darkwebBusy()) return;
  setDarkwebBusy(true);
  try {
    // The backend scan refuses unless consent is recorded; keep it in sync.
    await ipc.setDarkwebConsent(true);
    const run = await ipc.darkwebScanVault();
    setDarkwebReport(mergeScanRun(checkedByEmail, run));
    const at = Date.now();
    setDarkwebRunAt(at);
    writeTime(KEY_DARKWEB_AT, at);
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
    const at = Date.now();
    setExposedRunAt(at);
    writeTime(KEY_EXPOSED_AT, at);
  } catch (err) {
    toastError(err);
  } finally {
    setExposedBusy(false);
  }
}

/**
 * Switching the dark-web monitor off: revoke the backend's permission to call
 * out, drop the accumulated results, and clear the persisted last-run timestamp.
 * Called by the toggle setter in ./security.ts (kept here so all scan-result
 * state mutation stays in one place).
 */
export async function clearDarkwebScan(): Promise<void> {
  try {
    await ipc.setDarkwebConsent(false);
  } catch (err) {
    toastError(err);
  }
  checkedByEmail.clear();
  setDarkwebReport(null);
  setDarkwebRunAt(null);
  writeTime(KEY_DARKWEB_AT, null);
}

/** Switching the exposed-password check off: drop its results + last-run stamp. */
export function clearExposedCheck(): void {
  setExposedResults(null);
  setExposedRunAt(null);
  writeTime(KEY_EXPOSED_AT, null);
}

/**
 * The account-relevant breach directory: the breaches your *own* accounts appear
 * in (from the latest dark-web scan), deduplicated across accounts and annotated
 * with how many of your accounts each one hit. Never the full public catalogue.
 */
export function relevantBreaches(): RelevantBreach[] {
  const report = darkwebReport();
  if (!report) return [];
  return aggregateRelevantBreaches(report.accounts);
}

let started = false;

/** Run the enabled scans, but only those whose cached result has gone stale. */
function runStaleScans(): void {
  if (!isFresh(darkwebRunAt())) void runDarkwebScan();
  if (!isFresh(exposedRunAt())) void runExposedCheck();
}

/**
 * Start the periodic security loop. Called once at startup. After the vault
 * transitions to unlocked the scans are scheduled `SCAN_DEFER_MS` later — never
 * on the unlock critical path, where they would race the per-connection re-login
 * and first sync — and then only if the cached result is stale. They also re-run
 * on a fixed interval while the vault stays unlocked. Cheap no-ops when nothing
 * is enabled, the vault is locked, or a fresh result already exists.
 */
export function initSecurity(): void {
  if (started) return;
  started = true;

  createRoot(() => {
    let wasUnlocked = false;
    let deferTimer: ReturnType<typeof setTimeout> | undefined;
    createEffect(() => {
      const unlocked = status().unlocked;
      if (unlocked && !wasUnlocked) {
        if (deferTimer) clearTimeout(deferTimer);
        deferTimer = setTimeout(() => {
          deferTimer = undefined;
          if (status().unlocked) runStaleScans();
        }, SCAN_DEFER_MS);
      } else if (!unlocked && wasUnlocked && deferTimer) {
        // Locked again before the deferred scan fired — cancel it.
        clearTimeout(deferTimer);
        deferTimer = undefined;
      }
      wasUnlocked = unlocked;
    });
  });

  setInterval(() => {
    if (!status().unlocked) return;
    runStaleScans();
  }, SCAN_PERIOD_MS);
}
