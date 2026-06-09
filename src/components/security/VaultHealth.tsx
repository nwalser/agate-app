// "Vault health" section of the Security center: the offline vault-health report.
// The audit runs in the backend (ipc.auditOffline) on mount; this renders the
// per-flag summary counts and the at-risk item list. No single rolled-up score —
// the per-flag breakdown is the signal. Reuses the .sec-* classes from
// SecurityCenter.css (imported by the parent).

import { createSignal, For, onMount, Show } from 'solid-js';
import { Activity, AlertTriangle } from 'lucide-solid';
import { ipc } from '../../lib/ipc.ts';
import type { VaultHealthReport } from '../../lib/types.ts';
import { toastError } from '../../state/toast.ts';
import { chipsFor } from './shared.tsx';

// A single summary count. `tone` tints the number once the count is non-zero, so
// problem categories stand out at a glance; the neutral "Logins" total stays plain.
function Stat(props: { n: number; label: string; tone?: 'bad' | 'warn' }) {
  const flagged = () => Boolean(props.tone) && props.n > 0;
  return (
    <div class="sec-stat" classList={{ bad: flagged() && props.tone === 'bad', warn: flagged() && props.tone === 'warn' }}>
      <span class="sec-stat-num">{props.n}</span>
      <span class="sec-stat-label muted">{props.label}</span>
    </div>
  );
}

export default function VaultHealth(props: { onOpenItem: (id: string) => void }) {
  const [report, setReport] = createSignal<VaultHealthReport | null>(null);
  const [loading, setLoading] = createSignal(true);

  onMount(() => {
    void (async () => {
      try {
        setReport(await ipc.auditOffline());
      } catch (err) {
        toastError(err);
      } finally {
        setLoading(false);
      }
    })();
  });

  return (
    <Show when={!loading()} fallback={<p class="sec-loading muted">Analysing your vault…</p>}>
      <Show when={report()} fallback={<p class="sec-loading muted">No report available.</p>}>
        {(r) => (
          <>
            <section class="sec-card">
              <h3><Activity size={14} strokeWidth={1.75} /> Vault health</h3>
              <div class="sec-summary">
                <Stat n={r().totalLogins} label="Logins" />
                <Stat n={r().reused} label="Reused" tone="bad" />
                <Stat n={r().weak} label="Weak" tone="bad" />
                <Stat n={r().old} label="Old" tone="warn" />
                <Stat n={r().insecure} label="Insecure" tone="warn" />
                <Stat n={r().noTotp} label="No 2FA" tone="warn" />
              </div>
            </section>

            <section class="sec-card">
              <h3><AlertTriangle size={14} strokeWidth={1.75} /> At-risk items</h3>
              <Show
                when={r().atRisk.length > 0}
                fallback={<p class="muted sec-empty">No at-risk items. Nicely done.</p>}
              >
                <ul class="sec-list">
                  <For each={r().atRisk}>
                    {(item) => (
                      <li>
                        <button class="sec-row" onClick={() => props.onOpenItem(item.id)} title="Open item">
                          <span class="sec-row-name truncate">{item.name}</span>
                          <span class="sec-chips">
                            <For each={chipsFor(item)}>{(c) => <span class="sec-chip">{c}</span>}</For>
                          </span>
                        </button>
                      </li>
                    )}
                  </For>
                </ul>
              </Show>
            </section>
          </>
        )}
      </Show>
    </Show>
  );
}
