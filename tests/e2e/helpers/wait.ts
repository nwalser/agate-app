/**
 * Deterministic waiting for e2e specs.
 *
 * Prefer waiting on an observable CONDITION over a fixed `browser.pause()` — a
 * sleep is too short on a loaded box (flaky) and too long on a fast one (slow).
 * Use the TIMEOUT scale below instead of ad-hoc numbers so a spec that
 * legitimately needs longer is visible at a glance.
 */
import { browser } from '@wdio/globals';

export const TIMEOUT = {
  /** modal opens, async setter applies, a screen transition */
  quick: 1_000,
  /** most UI updates, form submits, reactive re-renders */
  normal: 3_000,
  /** larger data load, debounced chains */
  slow: 5_000,
  /** process boot, driver churn */
  crawl: 15_000,
} as const;

/**
 * Wait until `cond` returns truthy (polled). The deterministic replacement for
 * `browser.pause()`. Throws with `msg` on timeout so failures are legible.
 */
export async function waitFor(
  cond: () => boolean | Promise<boolean>,
  msg = 'condition not met',
  timeout: number = TIMEOUT.normal,
): Promise<void> {
  await browser.waitUntil(async () => !!(await cond()), {
    timeout,
    interval: 30,
    timeoutMsg: msg,
  });
}

/**
 * A *deliberate* fixed delay — only for genuinely time-based waits that have no
 * observable condition (a known debounce window, a toast TTL). Named so
 * reviewers can tell "I gave up and slept" (bad) from "this is intrinsically
 * time-based" (acceptable). Do NOT use to paper over ordering.
 */
export async function settle(ms: number, _reason: string): Promise<void> {
  await browser.pause(ms);
}
