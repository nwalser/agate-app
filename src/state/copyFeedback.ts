// "Just copied" feedback + the live clipboard-wipe countdown, in one reactive
// cell. There is exactly one system clipboard, so there is exactly one active
// copy: every successful copy (lib/clipboard.ts) calls noteCopied, which bumps a
// monotonic `token` and — for a secret that auto-clears — runs a 1-Hz countdown
// from `clearSeconds` to 0. UI reads this: a CopyButton shows the countdown only
// while `copyState().token` matches the token its own click produced, so a newer
// copy elsewhere cleanly reverts it. This replaced the old "X copied" toast.
//
// A global singleton (like the toast pipeline), not a deps-injected factory: it
// owns a process-wide resource (the clipboard timer) with no inputs to fake — the
// tests drive it with vi.useFakeTimers().

import { createSignal } from 'solid-js';

export interface CopyState {
  /** Monotonic id, bumped on every successful copy. Lets a button distinguish
   *  the copy it triggered from a later one that superseded it. */
  token: number;
  /** Seconds the value will live on the clipboard before auto-clear. 0 for a
   *  non-secret copy (username, website, …) that never clears. */
  clearSeconds: number;
  /** Live seconds left until the wipe; 0 once cleared or for a non-secret copy. */
  remaining: number;
}

const [copyState, setCopyState] = createSignal<CopyState>({
  token: 0,
  clearSeconds: 0,
  remaining: 0,
});
export { copyState };

let ticker: ReturnType<typeof setInterval> | undefined;
let seq = 0;

function stopTicker(): void {
  if (ticker) {
    clearInterval(ticker);
    ticker = undefined;
  }
}

/** Record a successful copy; returns its token. Starts the once-a-second
 *  countdown when the value auto-clears (clearSeconds > 0). */
export function noteCopied(clearSeconds: number): number {
  stopTicker();
  const token = ++seq;
  setCopyState({ token, clearSeconds, remaining: clearSeconds });
  if (clearSeconds > 0) {
    ticker = setInterval(() => {
      setCopyState((s) => {
        const remaining = Math.max(0, s.remaining - 1);
        if (remaining === 0) stopTicker();
        return { ...s, remaining };
      });
    }, 1000);
  }
  return token;
}

/** End a copy's countdown early (clipboard wiped or replaced). No-op when a newer
 *  copy already took over — that copy owns the countdown now. */
export function endCopy(token: number): void {
  if (copyState().token !== token) return;
  stopTicker();
  setCopyState((s) => ({ ...s, remaining: 0 }));
}
