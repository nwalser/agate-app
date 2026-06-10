// Scan orchestration for the security monitors. Owns the *result* signals
// (busy / report / last-run) and the actual all-account scans of the dark-web
// monitor (XposedOrNot) and exposed-password check (HIBP k-anonymity), plus the
// periodic loop that re-runs them while the vault stays unlocked. The on/off
// preferences (and their persistence) live in ./security.ts; this module reads
// those getters and is the only one here that touches IPC.
//
// There is deliberately no single-account lookup — both scans always cover every
// account, on an interval, never on the unlock critical path.
//
// Results are cached **encrypted** (sealed under the VMK in the OS keychain — see
// src-tauri/src/scancache.rs), not in localStorage: they carry the user's emails +
// which breaches they appear in (PII), so they're treated like every other secret.
// On unlock we hydrate from that cache so a re-unlock inside the scan period reuses
// the cached result instead of re-hitting the (slow, rate-limited, privacy-
// sensitive) providers; on lock the in-memory copy is dropped (the sealed cache
// stays). The cache is deleted on logout (backend) and rewritten whenever a scan
// completes or a monitor is switched off.

import { createEffect, createRoot, createSignal } from 'solid-js';
import { ipc } from '../lib/ipc.ts';
import { aggregateRelevantBreaches, mergeScanRun, type RelevantBreach } from '../lib/breachAggregation.ts';
import type { AccountBreaches, DarkWebReport, ExposedResult } from '../lib/types.ts';
import { darkwebMonitor, exposedCheck } from './security.ts';
import { status } from './session.ts';
import { toastError } from './toast.ts';

// How often the background scans re-run while the vault stays unlocked. Breach
// data changes slowly and the providers are rate-limited, so this is infrequent.
const SCAN_PERIOD_MS = 6 * 60 * 60 * 1000; // 6 hours

// On unlock the app is busy re-logging-in every connection and running the first
// full sync (self-hosted routes that through a loopback proxy). The breach scans
// are heavy network work, so we hold them off this critical path: schedule them a
// little after unlock and only if the cached result is stale. They never race the
// unlock + first sync for network/runtime.
const SCAN_DEFER_MS = 20 * 1000; // 20 seconds

/** A scan result is fresh if it ran within the scan period — don't re-run it. */
function isFresh(runAt: number | null): boolean {
  return runAt !== null && Date.now() - runAt < SCAN_PERIOD_MS;
}

const [darkwebReport, setDarkwebReport] = createSignal<DarkWebReport | null>(null);
const [exposedResults, setExposedResults] = createSignal<ExposedResult[] | null>(null);
const [darkwebBusy, setDarkwebBusy] = createSignal(false);
const [exposedBusy, setExposedBusy] = createSignal(false);
const [darkwebRunAt, setDarkwebRunAt] = createSignal<number | null>(null);
const [exposedRunAt, setExposedRunAt] = createSignal<number | null>(null);

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
// growing union across runs instead of just the latest window. Rehydrated from the
// encrypted cache on unlock; cleared on lock / when the monitor is switched off.
const checkedByEmail = new Map<string, AccountBreaches>();

// ── Encrypted result cache (sealed under the VMK by the backend) ──────────────

interface ScanCache {
  darkweb: DarkWebReport | null;
  darkwebAt: number | null;
  exposed: ExposedResult[] | null;
  exposedAt: number | null;
}

/** Serialize the current result signals into the opaque cache payload. */
function serializeCache(): string {
  const cache: ScanCache = {
    darkweb: darkwebReport(),
    darkwebAt: darkwebRunAt(),
    exposed: exposedResults(),
    exposedAt: exposedRunAt(),
  };
  return JSON.stringify(cache);
}

const isObj = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null;
const numOrNull = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) ? v : null);

/**
 * Parse the cached payload through a typed shape, returning safe defaults (all
 * null) on anything malformed plus a loud log — never a raw JSON.parse into the
 * store. Validation is shallow: the blob is GCM-authenticated and written by this
 * module, so the guard only defends against shape drift across versions.
 */
function parseCache(raw: string): ScanCache {
  const empty: ScanCache = { darkweb: null, darkwebAt: null, exposed: null, exposedAt: null };
  let data: unknown;
  try {
    data = JSON.parse(raw);
  } catch (err) {
    console.error('security scan cache: corrupt JSON, ignoring', err);
    return empty;
  }
  if (!isObj(data)) return empty;
  const darkweb =
    isObj(data.darkweb) && Array.isArray((data.darkweb as { accounts?: unknown }).accounts)
      ? (data.darkweb as unknown as DarkWebReport)
      : null;
  const exposed = Array.isArray(data.exposed) ? (data.exposed as unknown as ExposedResult[]) : null;
  return {
    darkweb,
    darkwebAt: numOrNull(data.darkwebAt),
    exposed,
    exposedAt: numOrNull(data.exposedAt),
  };
}

/** Write the current results to the encrypted cache. Best-effort: a keychain
 *  hiccup leaves the in-memory results intact for this session. */
function persistCache(): void {
  void ipc.cacheSecurityScans(serializeCache()).catch((err) => {
    // ignore: cache write is best-effort; in-memory results still apply this session
    console.error('security scan cache write failed', err);
  });
}

/** Hydrate the result signals from the encrypted cache (called on unlock). Only
 *  hydrates a monitor's results while that monitor is enabled. */
async function loadCache(): Promise<void> {
  try {
    const raw = await ipc.loadSecurityScans();
    if (raw === null) return;
    const cache = parseCache(raw);
    if (darkwebMonitor() && cache.darkweb) {
      checkedByEmail.clear();
      for (const a of cache.darkweb.accounts) checkedByEmail.set(a.email, a);
      setDarkwebReport(cache.darkweb);
      setDarkwebRunAt(cache.darkwebAt);
    }
    if (exposedCheck() && cache.exposed) {
      setExposedResults(cache.exposed);
      setExposedRunAt(cache.exposedAt);
    }
  } catch (err) {
    toastError(err);
  }
}

/** Drop the in-memory result copies (called on lock). The sealed cache stays. */
function clearInMemory(): void {
  checkedByEmail.clear();
  setDarkwebReport(null);
  setExposedResults(null);
  setDarkwebRunAt(null);
  setExposedRunAt(null);
}

/** Run the dark-web monitor over every account (no-op if disabled or locked). */
export async function runDarkwebScan(): Promise<void> {
  if (!darkwebMonitor() || !status().unlocked || darkwebBusy()) return;
  setDarkwebBusy(true);
  try {
    // Consent is granted in exactly ONE place: the explicit Settings toggle
    // (state/security.ts). The scan itself must never re-grant it — that would
    // rubber-stamp the backend's trust-boundary gate on every auto-run.
    const run = await ipc.darkwebScanVault();
    setDarkwebReport(mergeScanRun(checkedByEmail, run));
    setDarkwebRunAt(Date.now());
    persistCache();
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
    persistCache();
  } catch (err) {
    toastError(err);
  } finally {
    setExposedBusy(false);
  }
}

/**
 * Switching the dark-web monitor off: revoke the backend's permission to call
 * out, drop the accumulated results, and rewrite the cache without them. Called by
 * the toggle setter in ./security.ts (kept here so all scan-result state mutation
 * stays in one place).
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
  persistCache();
}

/** Switching the exposed-password check off: drop its results + rewrite the cache. */
export function clearExposedCheck(): void {
  setExposedResults(null);
  setExposedRunAt(null);
  persistCache();
}

/**
 * The account-relevant breach directory: the breaches your *own* accounts appear
 * in (from the latest dark-web scan), deduplicated across accounts and annotated
 * with which of your accounts each one hit. Never the full public catalogue.
 */
export function relevantBreaches(): RelevantBreach[] {
  const report = darkwebReport();
  if (!report) return [];
  return aggregateRelevantBreaches(report.accounts);
}

let started = false;

/** Run the enabled scans, but only those whose cached result has gone stale.
 *  Exported so the post-sync hook can piggyback on it: a JS interval doesn't
 *  fire during OS sleep, so the 5-minute sync is the wake-up that catches a
 *  missed 6h tick. Free no-op while everything is fresh. */
export function runStaleScans(): void {
  if (!isFresh(darkwebRunAt())) void runDarkwebScan();
  if (!isFresh(exposedRunAt())) void runExposedCheck();
}

/**
 * Start the periodic security loop. Called once at startup. On unlock the encrypted
 * cache is hydrated immediately (cheap, local), then the scans are scheduled
 * `SCAN_DEFER_MS` later — never on the unlock critical path, where they would race
 * the per-connection re-login and first sync — and then only if the cached result
 * is stale. They also re-run on a fixed interval while the vault stays unlocked.
 * On lock the in-memory results are dropped (the sealed cache survives). Cheap
 * no-ops when nothing is enabled, the vault is locked, or a fresh result exists.
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
        void loadCache();
        if (deferTimer) clearTimeout(deferTimer);
        deferTimer = setTimeout(() => {
          deferTimer = undefined;
          if (status().unlocked) runStaleScans();
        }, SCAN_DEFER_MS);
      } else if (!unlocked && wasUnlocked) {
        // Locked: cancel any pending deferred scan and drop the in-memory results.
        if (deferTimer) {
          clearTimeout(deferTimer);
          deferTimer = undefined;
        }
        clearInMemory();
      }
      wasUnlocked = unlocked;
    });
  });

  setInterval(() => {
    if (!status().unlocked) return;
    runStaleScans();
  }, SCAN_PERIOD_MS);
}
