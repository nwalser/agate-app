// Settings › Sends — manage Bitwarden Sends (ephemeral shares) across all
// unlocked connections: list each with its type/usage, and revoke ones you no
// longer need. Backed by the SDK's sends client (list + delete). Creating Sends
// is a follow-up.

import { createSignal, For, onMount, Show } from 'solid-js';
import { Send as SendIcon, Trash2 } from 'lucide-solid';
import { ipc } from '../../lib/ipc.ts';
import type { SendSummary } from '../../lib/types.ts';
import { relativeFromNow } from '../../lib/dates.ts';
import { pushToast, toastError } from '../../state/toast.ts';

export default function SendsSettings() {
  const [sends, setSends] = createSignal<SendSummary[]>([]);
  const [loading, setLoading] = createSignal(true);
  const [removing, setRemoving] = createSignal<string | null>(null);

  async function load() {
    setLoading(true);
    try {
      setSends(await ipc.listSends());
    } catch (err) {
      toastError(err);
    } finally {
      setLoading(false);
    }
  }
  onMount(() => void load());

  async function revoke(s: SendSummary) {
    setRemoving(s.id);
    try {
      await ipc.deleteSend(s.accountEmail, s.id);
      pushToast('success', 'Send revoked.');
      await load();
    } catch (err) {
      toastError(err);
    } finally {
      setRemoving(null);
    }
  }

  function meta(s: SendSummary): string {
    const views = s.maxAccessCount != null ? `${s.accessCount}/${s.maxAccessCount}` : `${s.accessCount}`;
    const parts = [s.sendType, `${views} views`];
    if (s.hasPassword) parts.push('password');
    if (s.disabled) parts.push('disabled');
    if (s.expirationDate) parts.push(`expires ${relativeFromNow(s.expirationDate)}`);
    return parts.join(' · ');
  }

  return (
    <div class="settings-page">
      <section class="settings-section">
        <h3>
          <SendIcon size={14} strokeWidth={1.75} /> Sends
        </h3>
        <p class="muted settings-help">
          Ephemeral shares from your accounts. Revoke any you no longer need.
        </p>
        <Show when={!loading()} fallback={<p class="muted">Loading…</p>}>
          <Show when={sends().length > 0} fallback={<p class="muted">No active Sends.</p>}>
            <For each={sends()}>
              {(s) => (
                <div class="settings-row send-row">
                  <span class="send-info">
                    <span class="send-name truncate">{s.name}</span>
                    <span class="muted send-meta">{meta(s)}</span>
                  </span>
                  <button class="danger" disabled={removing() === s.id} onClick={() => void revoke(s)}>
                    <Trash2 size={13} strokeWidth={1.75} /> Revoke
                  </button>
                </div>
              )}
            </For>
          </Show>
        </Show>
      </section>
    </div>
  );
}
