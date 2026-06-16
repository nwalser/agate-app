// Default destination vault for NEW items. Not a secret — a non-secret UI
// preference (which unlocked, writable connection the add-item form preselects),
// so it lives in localStorage like the theme / clipboard prefs, never the
// keychain. The value is a connection id (a Bitwarden account email or a KeePass
// .kdbx path); '' means "no preference — use the first available writable vault".
// A stored id that is gone / locked / read-only at create time is ignored: the
// add form validates it against the live destinations and falls back.

import { createPersistedStore } from './persisted.ts';

const store = createPersistedStore<string>({
  key: 'agate.defaultAccount',
  parse: (value) => (typeof value === 'string' ? value : null),
  fallback: () => '',
  raw: true, // a bare connection id, not JSON
});

/** The pinned default connection id, or '' when none is set. Reactive. */
export const defaultAccount = store.value;

/** Pin `email` as the default destination for new items. */
export function setDefaultAccount(email: string): void {
  store.set(email);
}

/** Clear the default (back to "use the first available writable vault"). */
export function clearDefaultAccount(): void {
  store.reset();
}
