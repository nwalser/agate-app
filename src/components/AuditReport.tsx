import { createSignal, For, onMount, Show } from 'solid-js';
import {
  AlertTriangle,
  Clock,
  Globe,
  RefreshCw,
  ShieldCheck,
  ShieldOff,
  X,
} from 'lucide-solid';
import { ipc } from '../lib/ipc.ts';
import type { ExposedResult, HealthBand, ItemAudit, VaultHealthReport } from '../lib/types.ts';
import { toastError } from '../state/toast.ts';
import './AuditReport.css';

function bandColor(band: HealthBand): string {
  switch (band) {
    case 'critical':
    case 'poor':
      return 'var(--destructive)';
    case 'fair':
      return 'var(--warning)';
    case 'good':
      return 'var(--primary)';
    case 'excellent':
      return 'var(--success)';
  }
}

function bandLabel(band: HealthBand): string {
  return band.charAt(0).toUpperCase() + band.slice(1);
}

interface IssueChip {
  label: string;
  active: boolean;
}

function chipsFor(item: ItemAudit): IssueChip[] {
  return [
    { label: 'Reused', active: item.reused },
    { label: 'Weak', active: item.weak },
    { label: 'Old', active: item.old },
    { label: 'Insecure', active: item.insecureUri },
    { label: 'No 2FA', active: item.noTotp },
  ].filter((c) => c.active);
}

export default function AuditReport(props: {
  onClose: () => void;
  onOpenItem: (id: string) => void;
}) {
  const [report, setReport] = createSignal<VaultHealthReport | null>(null);
  const [loading, setLoading] = createSignal(true);

  const [exposed, setExposed] = createSignal<ExposedResult[] | null>(null);
  const [exposedBusy, setExposedBusy] = createSignal(false);

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

  async function runExposed() {
    setExposedBusy(true);
    try {
      setExposed(await ipc.auditExposed());
    } catch (err) {
      toastError(err);
    } finally {
      setExposedBusy(false);
    }
  }

  return (
    <div class="audit">
      <header class="audit-header">
        <ShieldCheck size={16} strokeWidth={1.75} />
        <h2>Vault security</h2>
        <span class="spacer" />
        <button class="ghost icon-btn" title="Close" onClick={() => props.onClose()}>
          <X size={16} strokeWidth={1.75} />
        </button>
      </header>

      <div class="audit-body">
        <Show
          when={!loading()}
          fallback={<p class="audit-loading muted">Analysing your vault…</p>}
        >
          <Show
            when={report()}
            fallback={<p class="audit-loading muted">No report available.</p>}
          >
            {(r) => (
              <>
                <section class="audit-section audit-score-section">
                  <div
                    class="audit-score"
                    style={{ color: bandColor(r().band) }}
                  >
                    <span class="audit-score-value">{r().score}</span>
                    <span class="audit-score-max">/ 100</span>
                  </div>
                  <span
                    class="audit-band"
                    style={{
                      color: bandColor(r().band),
                      'border-color': bandColor(r().band),
                    }}
                  >
                    {bandLabel(r().band)}
                  </span>
                </section>

                <section class="audit-section">
                  <div class="audit-summary">
                    <div class="audit-stat">
                      <span class="audit-stat-num">{r().totalLogins}</span>
                      <span class="audit-stat-label muted">Logins</span>
                    </div>
                    <div class="audit-stat">
                      <span class="audit-stat-num">{r().reused}</span>
                      <span class="audit-stat-label muted">Reused</span>
                    </div>
                    <div class="audit-stat">
                      <span class="audit-stat-num">{r().weak}</span>
                      <span class="audit-stat-label muted">Weak</span>
                    </div>
                    <div class="audit-stat">
                      <span class="audit-stat-num">{r().old}</span>
                      <span class="audit-stat-label muted">Old</span>
                    </div>
                    <div class="audit-stat">
                      <span class="audit-stat-num">{r().insecure}</span>
                      <span class="audit-stat-label muted">Insecure</span>
                    </div>
                    <div class="audit-stat">
                      <span class="audit-stat-num">{r().noTotp}</span>
                      <span class="audit-stat-label muted">No 2FA</span>
                    </div>
                  </div>
                </section>

                <section class="audit-section">
                  <h3>
                    <AlertTriangle size={14} strokeWidth={1.75} /> At-risk items
                  </h3>
                  <Show
                    when={r().atRisk.length > 0}
                    fallback={<p class="muted audit-empty">No at-risk items. Nicely done.</p>}
                  >
                    <ul class="audit-risk-list">
                      <For each={r().atRisk}>
                        {(item) => (
                          <li>
                            <button
                              class="audit-risk-row"
                              onClick={() => props.onOpenItem(item.id)}
                              title="Open item"
                            >
                              <span class="audit-risk-name truncate">{item.name}</span>
                              <span class="audit-chips">
                                <For each={chipsFor(item)}>
                                  {(chip) => <span class="audit-chip">{chip.label}</span>}
                                </For>
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

        <section class="audit-section">
          <h3>
            <Globe size={14} strokeWidth={1.75} /> Exposed passwords (HaveIBeenPwned)
          </h3>
          <p class="muted audit-help">
            This is the only check that contacts the network. It uses k-anonymity: only the first
            five characters of each password's SHA-1 hash leave your device — never the password
            itself.
          </p>

          <button class="primary audit-run-btn" disabled={exposedBusy()} onClick={() => void runExposed()}>
            <RefreshCw size={14} strokeWidth={1.75} /> Run exposed-password check
          </button>

          <Show when={exposedBusy()}>
            <p class="audit-loading muted">Checking against HaveIBeenPwned…</p>
          </Show>

          <Show when={!exposedBusy() && exposed()}>
            {(results) => (
              <Show
                when={results().length > 0}
                fallback={
                  <p class="audit-clean">
                    <ShieldCheck size={14} strokeWidth={1.75} /> No exposed passwords found.
                  </p>
                }
              >
                <ul class="audit-exposed-list">
                  <For each={results()}>
                    {(ex) => (
                      <li>
                        <button
                          class="audit-risk-row"
                          onClick={() => props.onOpenItem(ex.id)}
                          title="Open item"
                        >
                          <ShieldOff size={14} strokeWidth={1.75} class="audit-exposed-icon" />
                          <span class="audit-risk-name truncate">{ex.name}</span>
                          <span class="audit-breach-count">
                            <Clock size={12} strokeWidth={1.75} />
                            {ex.count.toLocaleString()} breaches
                          </span>
                        </button>
                      </li>
                    )}
                  </For>
                </ul>
              </Show>
            )}
          </Show>
        </section>
      </div>
    </div>
  );
}
