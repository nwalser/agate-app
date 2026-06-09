// Bridge between the Vault screen (which owns the connection list + the
// switch-vault logic) and the custom window titlebar (components/Titlebar.tsx),
// which hosts the connection dropdown but lives outside the Vault tree in
// App.tsx. The Vault registers a nav source on mount; the titlebar reads it to
// render the switcher and route a pick back into the screen.
//
// Mirrors the search / palette bridges. In-memory only, never persisted — the
// active-vault scope itself is persisted in state/ui.ts; this is just the live
// connection list + the screen's switch handler. Cleared when the Vault unmounts
// (lock / logout) so a stale handler can't fire against a torn-down screen.

import { createSignal } from 'solid-js';
import type { ConnectionSummary } from '../lib/types.ts';

export interface ConnectionNav {
  /** Live connections (locked + unlocked), as the rail/switcher show them. */
  connections: ConnectionSummary[];
  /** Scope the list to one connection email, or null for all vaults merged. */
  switchVault: (email: string | null) => void;
}

const EMPTY: ConnectionNav = { connections: [], switchVault: () => {} };

const [connectionNav, setConnectionNav] = createSignal<ConnectionNav>(EMPTY);

/** Reset to the empty source — call when the Vault unmounts. */
function clearConnectionNav() {
  setConnectionNav(EMPTY);
}

export { connectionNav, setConnectionNav, clearConnectionNav };
