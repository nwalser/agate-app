// Session/auth state shared across screens. A thin reactive cache over the
// backend status, plus the chosen server config.

import { createSignal } from 'solid-js';
import { ipc } from '../lib/ipc.ts';
import type { ServerConfig, SessionStatus } from '../lib/types.ts';

const DEFAULT_STATUS: SessionStatus = {
  loggedIn: false,
  unlocked: false,
  localUnlockConfigured: false,
  helloConfigured: false,
  darkwebConsent: false,
  email: null,
};

const [status, setStatus] = createSignal<SessionStatus>(DEFAULT_STATUS);
const [server, setServer] = createSignal<ServerConfig>({ region: 'us' });
const [ready, setReady] = createSignal(false);
// When true, App shows a blank Onboarding so the user can log into a NEW account
// while their other accounts remain remembered.
const [addingAccount, setAddingAccount] = createSignal(false);

export { status, server, ready, addingAccount, setAddingAccount };

/** Refresh status + server config from the backend. */
export async function refreshSession(): Promise<void> {
  const [s, srv] = await Promise.all([ipc.getSessionStatus(), ipc.getServerConfig()]);
  setStatus(s);
  setServer(srv);
  // A completed refresh ends any add-account flow (login/switch resolved it).
  setAddingAccount(false);
  setReady(true);
}

export function setServerConfig(srv: ServerConfig): void {
  setServer(srv);
}

/** Which top-level screen the session implies. */
export function screenForStatus(s: SessionStatus): 'onboarding' | 'unlock' | 'vault' {
  if (s.unlocked) return 'vault';
  if (s.localUnlockConfigured && s.email) return 'unlock';
  if (s.loggedIn) return 'unlock';
  return 'onboarding';
}

// Test-only hook (webdriver e2e): re-derive the screen after a spec swaps the
// fake IPC backend (see lib/ipc.ts `__agateInvoke`). A reload would wipe the
// in-page fake, so specs call this instead. Same hard gate as the IPC seam —
// `__AGATE_TEST_HOOKS__` is false for `tauri build`, so this is dead-code-
// eliminated from release bundles and never ships.
if (__AGATE_TEST_HOOKS__ && typeof window !== 'undefined' && navigator.webdriver) {
  (window as Window & { __agateRefreshSession?: () => Promise<void> }).__agateRefreshSession =
    () => refreshSession();
}
