// THE localStorage persistence path for UI-preference stores: one tested
// trust-boundary (validate on read, never raw-JSON.parse into a store), one
// best-effort write path, and explicit versioned migrations — instead of every
// store hand-rolling its own readX/persist pair (where the groupBy
// string→object migration had to be ad-hoc legacy sniffing).
//
// Non-secret values ONLY (theme-class prefs). Secrets live in the OS keychain.

import { createSignal, type Accessor } from 'solid-js';

export interface PersistedStoreOptions<T> {
  /** localStorage key. */
  key: string;
  /**
   * Validate an UNKNOWN parsed value into a T, or null to fall back to the
   * default. This is the trust boundary: defensive, no `any`, no throwing.
   * Receives the raw parsed JSON (object form) or the raw string for stores
   * that persist plain strings — see `raw`.
   */
  parse: (value: unknown) => T | null;
  /** Default when absent/corrupt/unavailable. */
  fallback: () => T;
  /**
   * Persist as a raw string instead of JSON (for legacy keys that stored e.g.
   * "true"/"15" directly). `parse` then receives the raw string.
   */
  raw?: boolean;
}

export interface PersistedStore<T> {
  value: Accessor<T>;
  /** Set + best-effort persist (the in-memory signal always applies). */
  set: (next: T) => void;
  /** Reset to the fallback and persist it. */
  reset: () => void;
  /** Remove the key from storage entirely and drop the signal to the fallback —
   *  for callers that want the key ABSENT (e.g. clear-on-logout), not written as
   *  the default value. */
  clear: () => void;
  /** Re-read from storage into the signal. For the multi-webview case: the tray
   *  popup and the main window share localStorage but NOT signals, so a value the
   *  other window wrote since this store loaded only reaches here on a re-read
   *  (call it when the window regains focus / is shown). */
  refresh: () => void;
  /** The CURRENT persisted value as a fresh read (not the in-memory signal), for
   *  callers that merge over what other webviews persisted before writing. */
  peek: () => T;
}

export function createPersistedStore<T>(opts: PersistedStoreOptions<T>): PersistedStore<T> {
  const read = (): T => {
    try {
      const rawValue = localStorage.getItem(opts.key);
      if (rawValue === null) return opts.fallback();
      const candidate: unknown = opts.raw ? rawValue : JSON.parse(rawValue);
      const parsed = opts.parse(candidate);
      if (parsed !== null) return parsed;
      console.error(`persisted store ${opts.key}: invalid stored value, using defaults`);
    } catch (err) {
      // Corrupt JSON or unavailable storage (private mode): loud + defaults.
      console.error(`persisted store ${opts.key}: unreadable, using defaults`, err);
    }
    return opts.fallback();
  };

  const [value, setSignal] = createSignal<T>(read());

  const persist = (next: T) => {
    try {
      localStorage.setItem(opts.key, opts.raw ? String(next) : JSON.stringify(next));
    } catch {
      // ignore: persistence is best-effort; the in-memory signal still applies
    }
  };

  return {
    value,
    set: (next: T) => {
      setSignal(() => next);
      persist(next);
    },
    reset: () => {
      const next = opts.fallback();
      setSignal(() => next);
      persist(next);
    },
    refresh: () => setSignal(() => read()),
    peek: read,
    clear: () => {
      try {
        localStorage.removeItem(opts.key);
      } catch {
        // ignore: removal is best-effort; the in-memory signal still resets
      }
      setSignal(() => opts.fallback());
    },
  };
}

/** Common parser: a boolean persisted as "true"/"false" (raw mode). */
export function parseRawBool(value: unknown): boolean | null {
  if (value === 'true') return true;
  if (value === 'false') return false;
  return null;
}

/** Common parser: one of a closed set of values. */
export function parseOneOf<T>(options: readonly T[]): (value: unknown) => T | null {
  return (value: unknown) => {
    const candidate = typeof value === 'string' && options.every((o) => typeof o === 'number')
      ? Number(value)
      : value;
    return (options as readonly unknown[]).includes(candidate) ? (candidate as T) : null;
  };
}
