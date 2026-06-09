// Offline security-audit configuration — which checks run and their thresholds.
// Non-secret UI preference, persisted in localStorage (like the theme/columns),
// never the keychain. The config is sent to the backend `audit_offline` (see
// ipc.auditOffline), so every audit surface — the Security center, the list's
// Security column, and the sidebar health badge — reflects it. Mirrors
// `AuditConfig` in src-tauri/src/audit.rs. Validated at the storage boundary.

import { createSignal } from 'solid-js';

export interface AuditConfig {
  /** Flag passwords used by more than one login. */
  reused: boolean;
  /** Flag weak passwords (zxcvbn score below `weakMaxScore`). */
  weak: boolean;
  /** Flag passwords older than `oldDays`. */
  old: boolean;
  /** Flag logins with an http:// (non-TLS) website. */
  insecureUri: boolean;
  /** Flag logins without a one-time code (TOTP). */
  noTotp: boolean;
  /** Weak if the zxcvbn strength score (0–4) is below this (2–4). */
  weakMaxScore: number;
  /** Old if the password is older than this many days. */
  oldDays: number;
  /** Reused if a password is shared by at least this many logins (≥ 2). */
  reuseMin: number;
}

export const DEFAULT_AUDIT_CONFIG: AuditConfig = {
  reused: true,
  weak: true,
  old: true,
  insecureUri: true,
  noTotp: true,
  weakMaxScore: 3,
  oldDays: 365,
  reuseMin: 2,
};

const STORAGE_KEY = 'agate.auditConfig';

// Inclusive [min, max] bounds for the numeric (threshold) options — the single
// source of truth used on both read (sanitize persisted values) and write (clamp
// programmatic setters), so the storage-boundary invariant holds symmetrically.
const NUM_BOUNDS = {
  weakMaxScore: [2, 4],
  oldDays: [1, 3650],
  reuseMin: [2, 100],
} as const;

function clampInt(v: unknown, min: number, max: number, fallback: number): number {
  if (typeof v !== 'number' || !Number.isFinite(v)) return fallback;
  return Math.min(max, Math.max(min, Math.round(v)));
}

function read(): AuditConfig {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return DEFAULT_AUDIT_CONFIG;
    const parsed: unknown = JSON.parse(raw);
    if (typeof parsed !== 'object' || parsed === null) return DEFAULT_AUDIT_CONFIG;
    const o = parsed as Record<string, unknown>;
    const bool = (v: unknown, d: boolean) => (typeof v === 'boolean' ? v : d);
    const d = DEFAULT_AUDIT_CONFIG;
    return {
      reused: bool(o.reused, d.reused),
      weak: bool(o.weak, d.weak),
      old: bool(o.old, d.old),
      insecureUri: bool(o.insecureUri, d.insecureUri),
      noTotp: bool(o.noTotp, d.noTotp),
      weakMaxScore: clampInt(o.weakMaxScore, ...NUM_BOUNDS.weakMaxScore, d.weakMaxScore),
      oldDays: clampInt(o.oldDays, ...NUM_BOUNDS.oldDays, d.oldDays),
      reuseMin: clampInt(o.reuseMin, ...NUM_BOUNDS.reuseMin, d.reuseMin),
    };
  } catch {
    // ignore: corrupt/unavailable config falls back to defaults
    return DEFAULT_AUDIT_CONFIG;
  }
}

const [auditConfig, setAuditConfigSig] = createSignal<AuditConfig>(read());
export { auditConfig };

function persist(next: AuditConfig) {
  setAuditConfigSig(next);
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(next));
  } catch {
    // ignore: persistence is best-effort; the in-memory signal still applies
  }
}

export function setAuditOption<K extends keyof AuditConfig>(key: K, value: AuditConfig[K]) {
  let next: AuditConfig[K] = value;
  // Clamp numeric (threshold) writes to the same bounds read() enforces, so the
  // signal + persisted value can never hold an out-of-range threshold.
  if (typeof value === 'number' && key in NUM_BOUNDS) {
    const [min, max] = NUM_BOUNDS[key as keyof typeof NUM_BOUNDS];
    next = clampInt(value, min, max, DEFAULT_AUDIT_CONFIG[key] as number) as AuditConfig[K];
  }
  persist({ ...auditConfig(), [key]: next });
}

export function resetAuditConfig() {
  persist({ ...DEFAULT_AUDIT_CONFIG });
}

/** Snapshot of the config to send to the backend `audit_offline`. */
export function auditConfigPayload(): AuditConfig {
  return auditConfig();
}
