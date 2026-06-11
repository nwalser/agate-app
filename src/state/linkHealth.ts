// Link-health (broken-link) checker state — a "Vault Cleanup" tool, separate from
// the security monitors. Owns the result signals (busy / report / last-run) and
// the single on-demand scan.
//
// Built as a FACTORY (`createLinkHealth`) with its dependencies injected — the app
// uses the default singleton below; tests construct fresh instances with fake deps
// (no module mocking). Same pattern as `createSecurityScans`, but deliberately
// much smaller:
//   - ON-DEMAND ONLY. There is no periodic loop and no unlock-time auto-run. The
//     scan pings every web URL in the vault, which reveals the vault's domain list
//     to those servers + any network observer, so it runs *only* when the user
//     clicks "Scan now".
//   - NO CACHE. The report is held in memory only and dropped on lock; a re-unlock
//     re-runs on demand. (Results are derived vault metadata, but there's no value
//     in persisting a one-shot reachability snapshot that goes stale immediately.)

import { createEffect, createRoot, createSignal } from 'solid-js';
import { ipc } from '../lib/ipc.ts';
import type { LinkCheckReport } from '../lib/types.ts';
import { status } from './session.ts';
import { toastError } from './toast.ts';

/** Exactly the IPC surface the checker touches — what tests fake. */
export type LinkHealthIpc = Pick<typeof ipc, 'linkCheckVault'>;

export interface LinkHealthDeps {
  ipc: LinkHealthIpc;
  /** Reactive: whether the vault is unlocked (gates the scan + clears on lock). */
  unlocked: () => boolean;
  onError: (err: unknown) => void;
}

export function createLinkHealth(deps: LinkHealthDeps) {
  const [report, setReport] = createSignal<LinkCheckReport | null>(null);
  const [busy, setBusy] = createSignal(false);
  const [runAt, setRunAt] = createSignal<number | null>(null);

  /** Run the link-health scan over every unlocked vault. No-op while locked or
   *  already running. */
  async function runScan(): Promise<void> {
    if (!deps.unlocked() || busy()) return;
    setBusy(true);
    try {
      setReport(await deps.ipc.linkCheckVault());
      setRunAt(Date.now());
    } catch (err) {
      deps.onError(err);
    } finally {
      setBusy(false);
    }
  }

  /** Drop the in-memory result (called on lock). */
  function clear(): void {
    setReport(null);
    setRunAt(null);
  }

  let started = false;

  /** Wire the lock→clear side effect. Called once at startup. Cheap no-op while
   *  nothing changes; never starts a scan on its own. */
  function initLinkHealth(): void {
    if (started) return;
    started = true;
    createRoot(() => {
      let wasUnlocked = false;
      createEffect(() => {
        const unlocked = deps.unlocked();
        if (!unlocked && wasUnlocked) clear();
        wasUnlocked = unlocked;
      });
    });
  }

  return { report, busy, runAt, runScan, clear, initLinkHealth };
}

export type LinkHealth = ReturnType<typeof createLinkHealth>;

// ── The app's singleton, wired to the real deps. ──
const linkHealth = createLinkHealth({
  ipc,
  unlocked: () => status().unlocked,
  onError: toastError,
});

export const { report, busy, runAt, runScan, clear, initLinkHealth } = linkHealth;
