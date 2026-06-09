// Auto-lock (vault timeout) preferences. Non-secret security/UI prefs, so they
// live in localStorage (like the clipboard-clear delay), never the keychain.
//   * idle minutes before Agate locks every connection (0 = never)
//   * whether minimizing/hiding the window locks immediately
// Both are validated at the storage trust boundary; a corrupt/absent value falls
// back to a safe default. The actual timer lives in hooks/useAutoLock.ts.

import { createSignal } from 'solid-js';

// Offered idle timeouts in MINUTES; 0 = never. A fixed set (not a free-form
// number) keeps the storage boundary trivial to validate and matches the
// segmented picker in Settings → Security.
export const AUTO_LOCK_OPTIONS = [1, 5, 15, 30, 60, 0] as const;
export type AutoLockMinutes = (typeof AUTO_LOCK_OPTIONS)[number];

const MINUTES_KEY = 'agate.autoLockMinutes';
const MINIMIZE_KEY = 'agate.lockOnMinimize';
const DEFAULT_MINUTES: AutoLockMinutes = 15;

function isValidMinutes(n: number): n is AutoLockMinutes {
  return (AUTO_LOCK_OPTIONS as readonly number[]).includes(n);
}

// Validate at the storage trust boundary: anything not in the known set (absent
// key, or a corrupt/tampered value) falls back to the default.
function readMinutes(): AutoLockMinutes {
  try {
    const v = localStorage.getItem(MINUTES_KEY);
    if (v !== null) {
      const n = Number(v);
      if (Number.isFinite(n) && isValidMinutes(n)) return n;
    }
  } catch {
    // ignore: localStorage may be unavailable (private mode); use the default
  }
  return DEFAULT_MINUTES;
}

function readBool(key: string): boolean {
  try {
    return localStorage.getItem(key) === '1';
  } catch {
    // ignore: storage unavailable → default off
    return false;
  }
}

// ---- idle timeout (minutes) ----

const [autoLockMinutes, setMinutesSignal] = createSignal<AutoLockMinutes>(readMinutes());
export { autoLockMinutes };

export function setAutoLockMinutes(m: AutoLockMinutes) {
  setMinutesSignal(m);
  try {
    localStorage.setItem(MINUTES_KEY, String(m));
  } catch {
    // ignore: persistence is best-effort; the in-memory signal still applies
  }
}

// ---- lock on minimize ----

const [lockOnMinimize, setMinimizeSignal] = createSignal<boolean>(readBool(MINIMIZE_KEY));
export { lockOnMinimize };

export function setLockOnMinimize(v: boolean) {
  setMinimizeSignal(v);
  try {
    localStorage.setItem(MINIMIZE_KEY, v ? '1' : '0');
  } catch {
    // ignore: persistence is best-effort; the in-memory signal still applies
  }
}
