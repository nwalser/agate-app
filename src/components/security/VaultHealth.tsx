// "Overview" tab of the Security center: the offline vault-health report. The
// audit runs in the backend (ipc.auditOffline) on mount; this renders the score,
// the per-flag summary counts, and the at-risk item list. Reuses the .sec-*
// classes from SecurityCenter.css (imported by the parent).

import { createSignal, For, onMount, Show } from 'solid-js';
import { AlertTriangle } from 'lucide-solid';
import { ipc } from '../../lib/ipc.ts';
import type { VaultHealthReport } from '../../lib/types.ts';
import { toastError } from '../../state/toast.ts';
import { bandColor, bandLabel, chipsFor } from './shared.tsx';

function Stat(props: { n: number; label: string }) {
  return (
    <div class="sec-stat">
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
            <section class="sec-card sec-score-card">
              <div class="sec-score" style={{ color: bandColor(r().band) }}>
                <span class="sec-score-value">{r().score}</span>
                <span class="sec-score-max">/ 100</span>
              </div>
              <span
                class="sec-band"
                style={{ color: bandColor(r().band), 'border-color': bandColor(r().band) }}
              >
                {bandLabel(r().band)}
              </span>
            </section>

            <section class="sec-card">
              <div class="sec-summary">
                <Stat n={r().totalLogins} label="Logins" />
                <Stat n={r().reused} label="Reused" />
                <Stat n={r().weak} label="Weak" />
                <Stat n={r().old} label="Old" />
                <Stat n={r().insecure} label="Insecure" />
                <Stat n={r().noTotp} label="No 2FA" />
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
