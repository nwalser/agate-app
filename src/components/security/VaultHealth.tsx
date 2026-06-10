// "Vault health" section of the Security center: the per-flag summary of the
// offline vault-health audit. No single rolled-up score, and no item list — the
// at-risk items live in the standard 'At risk' rail filter view (VaultFilter
// kind 'atRisk'), referenced here by count.
// Render-only: the audit report + loading state are owned by SecurityCenter and
// passed down. Reuses the .sec-* classes from SecurityCenter.css (imported by the
// parent).

import { Show } from 'solid-js';
import { Activity, AlertTriangle, ChevronRight, ShieldCheck } from 'lucide-solid';
import type { VaultHealthReport } from '../../lib/types.ts';

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

export default function VaultHealth(props: {
  report: VaultHealthReport | null;
  loading: boolean;
  onViewAtRisk: () => void;
}) {
  const r = () => props.report;
  return (
    <Show when={!props.loading} fallback={<p class="sec-loading muted">Analysing your vault…</p>}>
      <Show when={r()} fallback={<p class="sec-loading muted">No report available.</p>}>
        {(rep) => {
          const atRisk = () => rep().atRisk.length;
          return (
            <section class="sec-card">
              <h3><Activity size={14} strokeWidth={1.75} /> Vault health</h3>
              <div class="sec-summary">
                <Stat n={rep().totalLogins} label="Logins" />
                <Stat n={rep().reused} label="Reused" tone="bad" />
                <Stat n={rep().weak} label="Weak" tone="bad" />
                <Stat n={rep().old} label="Old" tone="warn" />
                <Stat n={rep().insecure} label="Insecure" tone="warn" />
                <Stat n={rep().noTotp} label="No 2FA" tone="warn" />
              </div>

              {/* Reference to the dedicated At-risk items view. */}
              <button class="sec-atrisk-link" onClick={() => props.onViewAtRisk()}>
                <Show
                  when={atRisk() > 0}
                  fallback={
                    <>
                      <ShieldCheck size={14} strokeWidth={1.75} class="sec-atrisk-clean" />
                      <span class="sec-atrisk-text">No at-risk items</span>
                    </>
                  }
                >
                  <AlertTriangle size={14} strokeWidth={1.75} class="sec-atrisk-warn" />
                  <span class="sec-atrisk-text">
                    {atRisk()} at-risk item{atRisk() === 1 ? '' : 's'}
                  </span>
                </Show>
                <ChevronRight size={15} strokeWidth={2} class="sec-atrisk-chev" />
              </button>
            </section>
          );
        }}
      </Show>
    </Show>
  );
}
