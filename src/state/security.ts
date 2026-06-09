// Security feature *preferences*: the enable/disable toggles for the dark-web
// monitor and the exposed-password check (persisted, default ON). This module is
// the settings store — it owns only the on/off signals and their persistence, no
// IPC and no scan-result state. The scans themselves, their result signals, and
// the periodic loop live in ./securityScans.ts; the toggle setters delegate the
// on→scan / off→clear side-effects there.
//
// Preferences are non-secret UI prefs, so they live in localStorage (same as the
// theme), not the keychain. The dark-web monitor mirrors its on/off state into the
// backend consent flag (via the scan module) so turning the toggle off also
// revokes the backend's permission to call out.

import { createSignal } from 'solid-js';
import {
  clearDarkwebScan,
  clearExposedCheck,
  runDarkwebScan,
  runExposedCheck,
} from './securityScans.ts';

// Re-exported so existing callers (e.g. main.tsx) keep their import path stable.
export { initSecurity } from './securityScans.ts';

const KEY_DARKWEB = 'agate.security.darkwebMonitor';
const KEY_EXPOSED = 'agate.security.exposedCheck';

function readBool(key: string, fallback: boolean): boolean {
  try {
    const v = localStorage.getItem(key);
    if (v === 'true') return true;
    if (v === 'false') return false;
  } catch {
    // ignore: localStorage may be unavailable (private mode); use the default
  }
  return fallback;
}

function writeBool(key: string, value: boolean): void {
  try {
    localStorage.setItem(key, String(value));
  } catch {
    // ignore: persistence is best-effort; the in-memory signal still applies
  }
}

// Both features default ON.
const [darkwebMonitor, setDarkwebMonitorSig] = createSignal(readBool(KEY_DARKWEB, true));
const [exposedCheck, setExposedCheckSig] = createSignal(readBool(KEY_EXPOSED, true));

export { darkwebMonitor, exposedCheck };

export async function setDarkwebMonitor(enabled: boolean): Promise<void> {
  setDarkwebMonitorSig(enabled);
  writeBool(KEY_DARKWEB, enabled);
  if (enabled) {
    await runDarkwebScan();
  } else {
    await clearDarkwebScan();
  }
}

export function setExposedCheck(enabled: boolean): void {
  setExposedCheckSig(enabled);
  writeBool(KEY_EXPOSED, enabled);
  if (enabled) {
    void runExposedCheck();
  } else {
    clearExposedCheck();
  }
}
