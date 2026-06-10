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

import { ipc } from '../lib/ipc.ts';
import { createPersistedStore, parseRawBool } from './persisted.ts';
import {
  clearDarkwebScan,
  clearExposedCheck,
  runDarkwebScan,
  runExposedCheck,
} from './securityScans.ts';
import { toastError } from './toast.ts';

// Re-exported so existing callers (e.g. main.tsx) keep their import path stable.
export { initSecurity } from './securityScans.ts';

// The dark-web monitor sends the vault's account emails to an external provider
// (XposedOrNot), so it is OPT-IN — default OFF, matching the backend consent
// flag's default. The exposed-password check stays default ON: k-anonymity, only
// 5 hex chars of a SHA-1 ever leave the device.
const darkweb = createPersistedStore<boolean>({
  key: 'agate.security.darkwebMonitor',
  parse: parseRawBool,
  fallback: () => false,
  raw: true,
});
const exposed = createPersistedStore<boolean>({
  key: 'agate.security.exposedCheck',
  parse: parseRawBool,
  fallback: () => true,
  raw: true,
});

export const darkwebMonitor = darkweb.value;
export const exposedCheck = exposed.value;

export async function setDarkwebMonitor(enabled: boolean): Promise<void> {
  darkweb.set(enabled);
  if (enabled) {
    // The ONE place backend consent is granted: the user's explicit toggle.
    try {
      await ipc.setDarkwebConsent(true);
    } catch (err) {
      toastError(err);
      return;
    }
    await runDarkwebScan();
  } else {
    await clearDarkwebScan();
  }
}

export function setExposedCheck(enabled: boolean): void {
  exposed.set(enabled);
  if (enabled) {
    void runExposedCheck();
  } else {
    clearExposedCheck();
  }
}
