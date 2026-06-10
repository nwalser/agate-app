// Scan orchestration for the security monitors. Owns the *result* signals
// (busy / report / last-run) and the actual all-account scans of the dark-web
// monitor (XposedOrNot) and exposed-password check (HIBP k-anonymity), plus the
// periodic loop that re-runs them while the vault stays unlocked. The on/off
// preferences (and their persistence) live in ./security.ts.
//
// Built as a FACTORY (`createSecurityScans`) with its dependencies injected —
// the app uses the default singleton below; tests construct fresh instances
// with fake deps (no module mocking, no cross-test state bleed, no `started`
// latch ordering). Same pattern as `createDetailCache`.
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

/** Exactly the IPC surface the scans touch — what tests fake. */
export type SecurityScanIpc = Pick<
  typeof ipc,
  'loadSecurityScans' | 'cacheSecurityScans' | 'darkwebScanVault' | 'auditExposed'
>;

export interface SecurityScansDeps {
  ipc: SecurityScanIpc;
  /** Reactive: whether the vault is unlocked (drives hydrate/defer/clear). */
  unlocked: () => boolean;
  /** Reactive toggles from ./security.ts. */
  darkwebEnabled: () => boolean;
  exposedEnabled: () => boolean;
  onError: (err: unknown) => void;
  /** Test hooks; production uses the defaults. */
  scanPeriodMs?: number;
  scanDeferMs?: number;
}

interface ScanCache {
  darkweb: DarkWebReport | null;
  darkwebAt: number | null;
  exposed: ExposedResult[] | null;
  exposedAt: number | null;
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

export function createSecurityScans(deps: SecurityScansDeps) {
  const scanPeriod = deps.scanPeriodMs ?? SCAN_PERIOD_MS;
  const scanDefer = deps.scanDeferMs ?? SCAN_DEFER_MS;

  /** A scan result is fresh if it ran within the scan period — don't re-run it. */
  const isFresh = (runAt: number | null): boolean =>
    runAt !== null && Date.now() - runAt < scanPeriod;

  const [darkwebReport, setDarkwebReport] = createSignal<DarkWebReport | null>(null);
  const [exposedResults, setExposedResults] = createSignal<ExposedResult[] | null>(null);
  const [darkwebBusy, setDarkwebBusy] = createSignal(false);
  const [exposedBusy, setExposedBusy] = createSignal(false);
  const [darkwebRunAt, setDarkwebRunAt] = createSignal<number | null>(null);
  const [exposedRunAt, setExposedRunAt] = createSignal<number | null>(null);

  // Checked-email accumulator. The backend scans at most a rotating window per run
  // (provider rate budget), so a single run only covers part of a large vault. We
  // merge each run's results here, keyed by email, so the Security view shows the
  // growing union across runs instead of just the latest window. Rehydrated from
  // the encrypted cache on unlock; cleared on lock / monitor off.
  const checkedByEmail = new Map<string, AccountBreaches>();

  function serializeCache(): string {
    const cache: ScanCache = {
      darkweb: darkwebReport(),
      darkwebAt: darkwebRunAt(),
      exposed: exposedResults(),
      exposedAt: exposedRunAt(),
    };
    return JSON.stringify(cache);
  }

  /** Write the current results to the encrypted cache. Best-effort: a keychain
   *  hiccup leaves the in-memory results intact for this session. */
  function persistCache(): void {
    void deps.ipc.cacheSecurityScans(serializeCache()).catch((err) => {
      // ignore: cache write is best-effort; in-memory results still apply this session
      console.error('security scan cache write failed', err);
    });
  }

  /** Hydrate the result signals from the encrypted cache (called on unlock). Only
   *  hydrates a monitor's results while that monitor is enabled. */
  async function loadCache(): Promise<void> {
    try {
      const raw = await deps.ipc.loadSecurityScans();
      if (raw === null) return;
      const cache = parseCache(raw);
      if (deps.darkwebEnabled() && cache.darkweb) {
        checkedByEmail.clear();
        for (const a of cache.darkweb.accounts) checkedByEmail.set(a.email, a);
        setDarkwebReport(cache.darkweb);
        setDarkwebRunAt(cache.darkwebAt);
      }
      if (deps.exposedEnabled() && cache.exposed) {
        setExposedResults(cache.exposed);
        setExposedRunAt(cache.exposedAt);
      }
    } catch (err) {
      deps.onError(err);
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
  async function runDarkwebScan(): Promise<void> {
    if (!deps.darkwebEnabled() || !deps.unlocked() || darkwebBusy()) return;
    setDarkwebBusy(true);
    try {
      // Consent is granted in exactly ONE place: the explicit Settings toggle
      // (state/security.ts). The scan itself must never re-grant it — that would
      // rubber-stamp the backend's trust-boundary gate on every auto-run.
      const run = await deps.ipc.darkwebScanVault();
      setDarkwebReport(mergeScanRun(checkedByEmail, run));
      setDarkwebRunAt(Date.now());
      persistCache();
    } catch (err) {
      deps.onError(err);
    } finally {
      setDarkwebBusy(false);
    }
  }

  /** Run the exposed-password check (no-op if disabled or locked). */
  async function runExposedCheck(): Promise<void> {
    if (!deps.exposedEnabled() || !deps.unlocked() || exposedBusy()) return;
    setExposedBusy(true);
    try {
      setExposedResults(await deps.ipc.auditExposed());
      setExposedRunAt(Date.now());
      persistCache();
    } catch (err) {
      deps.onError(err);
    } finally {
      setExposedBusy(false);
    }
  }

  /**
   * Switching the dark-web monitor off: drop the accumulated results and rewrite
   * the cache without them. Consent is NOT touched here — both the grant AND the
   * revoke live in ./security.ts's toggle (one place), and consent isn't part of
   * this module's IPC surface at all.
   */
  function clearDarkwebScan(): void {
    checkedByEmail.clear();
    setDarkwebReport(null);
    setDarkwebRunAt(null);
    persistCache();
  }

  /** Switching the exposed-password check off: drop its results + rewrite cache. */
  function clearExposedCheck(): void {
    setExposedResults(null);
    setExposedRunAt(null);
    persistCache();
  }

  /**
   * The account-relevant breach directory: the breaches your *own* accounts appear
   * in (from the latest dark-web scan), deduplicated across accounts and annotated
   * with which of your accounts each one hit. Never the full public catalogue.
   */
  function relevantBreaches(): RelevantBreach[] {
    const report = darkwebReport();
    if (!report) return [];
    return aggregateRelevantBreaches(report.accounts);
  }

  let started = false;

  /** Run the enabled scans, but only those whose cached result has gone stale.
   *  Also called from the post-sync hook: a JS interval doesn't fire during OS
   *  sleep, so the 5-minute sync is the wake-up that catches a missed 6h tick.
   *  Free no-op while everything is fresh. */
  function runStaleScans(): void {
    if (!isFresh(darkwebRunAt())) void runDarkwebScan();
    if (!isFresh(exposedRunAt())) void runExposedCheck();
  }

  /**
   * Start the periodic security loop. Called once at startup. On unlock the
   * encrypted cache is hydrated immediately (cheap, local), then the scans are
   * scheduled `scanDefer` later — never on the unlock critical path, where they
   * would race the per-connection re-login and first sync — and then only if the
   * cached result is stale. They also re-run on a fixed interval while the vault
   * stays unlocked. On lock the in-memory results are dropped (the sealed cache
   * survives). Cheap no-ops when nothing is enabled, locked, or fresh.
   */
  function initSecurity(): void {
    if (started) return;
    started = true;

    createRoot(() => {
      let wasUnlocked = false;
      let deferTimer: ReturnType<typeof setTimeout> | undefined;
      createEffect(() => {
        const unlocked = deps.unlocked();
        if (unlocked && !wasUnlocked) {
          void loadCache();
          if (deferTimer) clearTimeout(deferTimer);
          deferTimer = setTimeout(() => {
            deferTimer = undefined;
            if (deps.unlocked()) runStaleScans();
          }, scanDefer);
        } else if (!unlocked && wasUnlocked) {
          // Locked: cancel any pending deferred scan and drop in-memory results.
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
      if (!deps.unlocked()) return;
      runStaleScans();
    }, scanPeriod);
  }

  return {
    darkwebReport,
    exposedResults,
    darkwebBusy,
    exposedBusy,
    darkwebRunAt,
    exposedRunAt,
    runDarkwebScan,
    runExposedCheck,
    clearDarkwebScan,
    clearExposedCheck,
    relevantBreaches,
    runStaleScans,
    initSecurity,
  };
}

export type SecurityScans = ReturnType<typeof createSecurityScans>;

// ── The app's singleton, wired to the real deps. Accessors are lazy closures so
// the ./security.ts ↔ this-module import cycle resolves exactly as before. ──
const scans = createSecurityScans({
  ipc,
  unlocked: () => status().unlocked,
  darkwebEnabled: () => darkwebMonitor(),
  exposedEnabled: () => exposedCheck(),
  onError: toastError,
});

export const {
  darkwebReport,
  exposedResults,
  darkwebBusy,
  exposedBusy,
  darkwebRunAt,
  exposedRunAt,
  runDarkwebScan,
  runExposedCheck,
  clearDarkwebScan,
  clearExposedCheck,
  relevantBreaches,
  runStaleScans,
  initSecurity,
} = scans;
