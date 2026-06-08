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
  email: null,
};

const [status, setStatus] = createSignal<SessionStatus>(DEFAULT_STATUS);
const [server, setServer] = createSignal<ServerConfig>({ region: 'us' });
const [ready, setReady] = createSignal(false);

export { status, server, ready };

/** Refresh status + server config from the backend. */
export async function refreshSession(): Promise<void> {
  const [s, srv] = await Promise.all([ipc.getSessionStatus(), ipc.getServerConfig()]);
  setStatus(s);
  setServer(srv);
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
