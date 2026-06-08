// Non-secret UI preferences, persisted in localStorage (not the keychain):
//   * sidebar collapse state
//   * which vault (connection) the list is scoped to — null = all connections
//     merged (the unified view), or a connection email for a single vault.
// Validated at the storage boundary; corrupt/unavailable storage falls back to
// safe defaults.

import { createSignal } from 'solid-js';

const COLLAPSE_KEY = 'agate.sidebarCollapsed';
const ACTIVE_VAULT_KEY = 'agate.activeVault';

function readBool(key: string): boolean {
  try {
    return localStorage.getItem(key) === '1';
  } catch {
    // ignore: storage unavailable → default collapsed=false
    return false;
  }
}

// ---- sidebar collapse ----

const [sidebarCollapsed, setCollapsedSignal] = createSignal(readBool(COLLAPSE_KEY));
export { sidebarCollapsed };

export function toggleSidebar() {
  const next = !sidebarCollapsed();
  setCollapsedSignal(next);
  try {
    localStorage.setItem(COLLAPSE_KEY, next ? '1' : '0');
  } catch {
    // ignore: persistence is best-effort; the in-memory signal still applies
  }
}

// ---- active vault (connection scope) ----

function readActiveVault(): string | null {
  try {
    const v = localStorage.getItem(ACTIVE_VAULT_KEY);
    return v && v.length > 0 ? v : null;
  } catch {
    // ignore: storage unavailable → default to the unified "all vaults" view
    return null;
  }
}

const [activeVault, setActiveVaultSignal] = createSignal<string | null>(readActiveVault());
export { activeVault };

/** Scope the list to a single connection email, or null for all vaults merged. */
export function setActiveVault(email: string | null) {
  setActiveVaultSignal(email);
  try {
    if (email) localStorage.setItem(ACTIVE_VAULT_KEY, email);
    else localStorage.removeItem(ACTIVE_VAULT_KEY);
  } catch {
    // ignore: persistence is best-effort; the in-memory signal still applies
  }
}
