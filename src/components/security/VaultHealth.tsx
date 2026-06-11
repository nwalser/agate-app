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
import { t } from '../../lib/i18n.ts';

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
    <Show when={!props.loading} fallback={<p class="sec-loading muted">{t('security.analysing')}</p>}>
      <Show when={r()} fallback={<p class="sec-loading muted">{t('security.noReport')}</p>}>
        {(rep) => {
          const atRisk = () => rep().atRisk.length;
          return (
            <section class="sec-card">
              <h3><Activity size={14} strokeWidth={1.75} /> {t('security.vaultHealth')}</h3>
              <div class="sec-summary">
                <Stat n={rep().totalLogins} label={t('security.logins')} />
                <Stat n={rep().reused} label={t('security.reused')} tone="bad" />
                <Stat n={rep().weak} label={t('security.weak')} tone="bad" />
                <Stat n={rep().old} label={t('security.old')} tone="warn" />
                <Stat n={rep().insecure} label={t('security.insecure')} tone="warn" />
                <Stat n={rep().noTotp} label={t('security.no2fa')} tone="warn" />
              </div>

              {/* Reference to the dedicated At-risk items view. */}
              <button class="sec-atrisk-link" onClick={() => props.onViewAtRisk()}>
                <Show
                  when={atRisk() > 0}
                  fallback={
                    <>
                      <ShieldCheck size={14} strokeWidth={1.75} class="sec-atrisk-clean" />
                      <span class="sec-atrisk-text">{t('security.noAtRiskItems')}</span>
                    </>
                  }
                >
                  <AlertTriangle size={14} strokeWidth={1.75} class="sec-atrisk-warn" />
                  <span class="sec-atrisk-text">
                    {atRisk() === 1
                      ? t('security.atRiskItems_one', { count: atRisk() })
                      : t('security.atRiskItems_other', { count: atRisk() })}
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
