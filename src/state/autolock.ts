// Auto-lock (vault timeout) preferences. Non-secret security/UI prefs, so they
// live in localStorage (like the clipboard-clear delay), never the keychain.
//   * idle minutes before Agate locks every connection (0 = never)
//   * whether minimizing/hiding the window locks immediately
// Both go through the shared createPersistedStore trust boundary (validate on
// read, best-effort write) instead of a hand-rolled readX/persist pair. The
// actual timer lives in hooks/useAutoLock.ts.

import { createPersistedStore, parseOneOf } from './persisted.ts';

// Offered idle timeouts in MINUTES; 0 = never. A fixed set (not a free-form
// number) keeps the storage boundary trivial to validate and matches the
// segmented picker in Settings → Security.
export const AUTO_LOCK_OPTIONS = [1, 5, 15, 30, 60, 0] as const;
export type AutoLockMinutes = (typeof AUTO_LOCK_OPTIONS)[number];

const DEFAULT_MINUTES: AutoLockMinutes = 15;

// ---- idle timeout (minutes) ----

const minutesStore = createPersistedStore<AutoLockMinutes>({
  key: 'agate.autoLockMinutes',
  raw: true,
  parse: parseOneOf(AUTO_LOCK_OPTIONS),
  fallback: () => DEFAULT_MINUTES,
});
export const autoLockMinutes = minutesStore.value;
export const setAutoLockMinutes = minutesStore.set;

// ---- lock on minimize ----

const minimizeStore = createPersistedStore<boolean>({
  key: 'agate.lockOnMinimize',
  raw: true,
  // Back-compat: earlier builds stored "1"/"0"; new writes are "true"/"false"
  // (createPersistedStore's raw mode), and both forms read back correctly.
  parse: (v) => (v === '1' || v === 'true' ? true : v === '0' || v === 'false' ? false : null),
  fallback: () => false,
});
export const lockOnMinimize = minimizeStore.value;
export const setLockOnMinimize = minimizeStore.set;
