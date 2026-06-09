// Settings › Connections — list configured Bitwarden accounts, add another, or
// log out of everything. Each connection's master password is sealed under the
// app-unlock key; removing one forgets its stored credentials on this device.

import { createSignal, For, onMount, Show } from 'solid-js';
import { Trash2, UserPlus } from 'lucide-solid';
import { ipc } from '../../lib/ipc.ts';
import type { ConnectionSummary } from '../../lib/types.ts';
import { refreshSession, setAddingConnection } from '../../state/session.ts';
import { pushToast, toastError } from '../../state/toast.ts';

export default function ConnectionsSettings() {
  const [connections, setConnections] = createSignal<ConnectionSummary[]>([]);

  async function loadConnections() {
    try {
      setConnections(await ipc.listConnections());
    } catch (err) {
      toastError(err);
    }
  }

  onMount(() => void loadConnections());

  async function removeConn(email: string) {
    try {
      await ipc.removeConnection(email);
      await loadConnections();
      await refreshSession();
      pushToast('success', 'Connection removed.');
    } catch (err) {
      toastError(err);
    }
  }

  async function logout() {
    try {
      await ipc.logout();
      await refreshSession();
    } catch (err) {
      toastError(err);
    }
  }

  return (
    <div class="settings-page">
      <section class="settings-section">
        <h3>Connections</h3>
        <p class="muted settings-help">
          Each connection is a Bitwarden account. One app unlock opens them all; removing one
          forgets its stored credentials on this device.
        </p>
        <For each={connections()}>
          {(conn) => (
            <div class="settings-row settings-account">
              <span class="settings-account-info">
                <span>{conn.email}</span>
                <span class="muted settings-account-server">{conn.serverLabel}</span>
              </span>
              <span class="row">
                <Show when={conn.unlocked}>
                  <span class="settings-account-active">Unlocked</span>
                </Show>
                <button
                  class="ghost icon-btn"
                  title="Remove connection"
                  onClick={() => void removeConn(conn.email)}
                >
                  <Trash2 size={14} strokeWidth={1.75} />
                </button>
              </span>
            </div>
          )}
        </For>
        <button class="add-account" onClick={() => setAddingConnection(true)}>
          <UserPlus size={14} strokeWidth={1.75} /> Add connection
        </button>
        <button class="danger" onClick={() => void logout()}>
          Log out of everything
        </button>
      </section>
    </div>
  );
}
