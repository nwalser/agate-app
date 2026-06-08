// Session/auth state shared across screens. A thin reactive cache over the
// backend status, plus the chosen server config.

import { createSignal } from 'solid-js';
import { ipc } from '../lib/ipc.ts';
import type { ServerConfig, SessionStatus } from '../lib/types.ts';

const DEFAULT_STATUS: SessionStatus = {
  appUnlockConfigured: false,
  unlocked: false,
  helloConfigured: false,
  darkwebConsent: false,
  connectionCount: 0,
  liveCount: 0,
};

const [status, setStatus] = createSignal<SessionStatus>(DEFAULT_STATUS);
const [server, setServer] = createSignal<ServerConfig>({ region: 'us' });
const [ready, setReady] = createSignal(false);
// When true, App shows the connection-add flow (over the unlocked vault) so the
// user can add another Bitwarden account without locking the others.
const [addingConnection, setAddingConnection] = createSignal(false);

export { status, server, ready, addingConnection, setAddingConnection };

/** Refresh status + server config from the backend. */
export async function refreshSession(): Promise<void> {
  const [s, srv] = await Promise.all([ipc.getSessionStatus(), ipc.getServerConfig()]);
  setStatus(s);
  setServer(srv);
  // A completed refresh ends any add-connection flow.
  setAddingConnection(false);
  setReady(true);
}

export function setServerConfig(srv: ServerConfig): void {
  setServer(srv);
}

/** Which top-level screen the session implies. */
export function screenForStatus(s: SessionStatus): 'setup' | 'unlock' | 'vault' {
  if (!s.appUnlockConfigured) return 'setup';
  if (!s.unlocked) return 'unlock';
  return 'vault';
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
