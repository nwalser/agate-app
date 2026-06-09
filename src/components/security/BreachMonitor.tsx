// "Breaches" section of the Security center: the unified breach view. Folds the
// old dark-web-monitor and breaches-directory tabs into one breach-centric list —
// every known data breach one or more of YOUR accounts appears in, deduplicated
// across accounts, each row showing which of your accounts it hit and what leaked.
// Clean accounts are not listed (only breaches found are). Reads the cached scan
// signals from state/securityScans.ts and the on/off toggle from state/security.ts;
// a manual refresh re-runs the all-account scan. Reuses the .sec-* classes from
// SecurityCenter.css (imported by the parent).

import { createSignal, For, type JSX, Show } from 'solid-js';
import {
  AlertTriangle,
  CheckCircle2,
  ChevronRight,
  Hourglass,
  Lock,
  Mail,
  RefreshCw,
  ShieldAlert,
  ShieldCheck,
} from 'lucide-solid';
import type { RelevantBreach } from '../../lib/breachAggregation.ts';
import { darkwebMonitor } from '../../state/security.ts';
import { darkwebBusy, darkwebReport, relevantBreaches, runDarkwebScan } from '../../state/securityScans.ts';
import { BreachDetails, DataClassChips, DisabledNotice } from './shared.tsx';

/** A labelled, collapsible-by-emptiness list of emails not in the checked set. */
function EmailNotice(props: { icon: JSX.Element; title: string; hint: string; emails: string[] }) {
  return (
    <Show when={props.emails.length > 0}>
      <h4 class="sec-group-label">
        {props.icon} {props.title} ({props.emails.length})
      </h4>
      <p class="muted sec-group-hint">{props.hint}</p>
      <ul class="sec-notice-list">
        <For each={props.emails}>
          {(e) => (
            <li class="sec-notice-item">
              <span class="truncate">{e}</span>
            </li>
          )}
        </For>
      </ul>
    </Show>
  );
}

/** One breach: a clickable summary that expands to full detail, with the affected
 *  account emails shown beneath. */
function BreachRow(props: { entry: RelevantBreach }) {
  const b = () => props.entry.breach;
  const accounts = () => props.entry.accounts;
  const [open, setOpen] = createSignal(false);
  return (
    <li class="sec-dir-item" classList={{ open: open() }}>
      <button
        type="button"
        class="sec-dir-toggle"
        aria-expanded={open()}
        onClick={() => setOpen(!open())}
      >
        <ChevronRight size={13} strokeWidth={2} class="sec-breach-chevron" />
        <span class="sec-breach-name">{b().name}</span>
        <Show when={b().breachDate}>{(d) => <span class="muted sec-breach-date">{d()}</span>}</Show>
        <Show when={b().verified}>
          <span class="sec-breach-verified" title="Verified breach">
            <CheckCircle2 size={11} strokeWidth={2} />
          </span>
        </Show>
        <span class="spacer" />
        <span class="sec-affected">
          {accounts().length} account{accounts().length === 1 ? '' : 's'}
        </span>
      </button>

      {/* Which of your accounts this breach hit. */}
      <div class="sec-breach-accounts">
        <For each={accounts()}>
          {(email) => (
            <span class="sec-account-chip">
              <Mail size={11} strokeWidth={1.75} /> <span class="truncate">{email}</span>
            </span>
          )}
        </For>
      </div>

      <Show
        when={open()}
        fallback={
          <Show when={b().dataClasses.length > 0}>
            <DataClassChips classes={b().dataClasses} />
          </Show>
        }
      >
        <BreachDetails breach={b()} />
      </Show>
    </li>
  );
}

export default function BreachMonitor() {
  // Count of the user's own accounts that appear in any breach (not clean ones).
  const affectedAccounts = () =>
    darkwebReport()?.accounts.filter((a) => a.breaches.length > 0).length ?? 0;

  return (
    <section class="sec-card">
      <div class="sec-card-head">
        <h3><ShieldAlert size={14} strokeWidth={1.75} /> Breaches</h3>
        <span class="spacer" />
        <button
          class="ghost sec-refresh"
          disabled={darkwebBusy() || !darkwebMonitor()}
          onClick={() => void runDarkwebScan()}
        >
          <RefreshCw size={13} strokeWidth={1.75} class={darkwebBusy() ? 'spin' : ''} /> Refresh
        </button>
      </div>

      <Show when={darkwebMonitor()} fallback={<DisabledNotice what="The dark-web monitor" />}>
        <Show when={darkwebBusy() && !darkwebReport()}>
          <p class="sec-loading muted">Scanning your accounts for breaches…</p>
        </Show>

        <Show when={!darkwebReport() && !darkwebBusy()}>
          <div class="sec-empty-cta">
            <p class="muted sec-empty">No scan results yet.</p>
            <button class="primary sec-run-btn" disabled={darkwebBusy()} onClick={() => void runDarkwebScan()}>
              <RefreshCw size={13} strokeWidth={1.75} /> Run scan now
            </button>
          </div>
        </Show>

        <Show when={darkwebReport()}>
          {(r) => (
            <>
              <Show
                when={relevantBreaches().length > 0}
                fallback={
                  <p class="sec-clean">
                    <ShieldCheck size={14} strokeWidth={1.75} /> None of your accounts appear in known
                    breaches.
                  </p>
                }
              >
                <div class="sec-report-summary">
                  <span class="sec-report-bad">
                    <strong>{relevantBreaches().length}</strong> breach{relevantBreaches().length === 1 ? '' : 'es'}
                  </span>
                  <span>
                    <strong>{affectedAccounts()}</strong> of your account{affectedAccounts() === 1 ? '' : 's'} affected
                  </span>
                </div>
                <ul class="sec-dir-list">
                  <For each={relevantBreaches()}>{(entry) => <BreachRow entry={entry} />}</For>
                </ul>
              </Show>

              {/* Coverage caveats — emails the scan couldn't fully cover this run. */}
              <EmailNotice
                icon={<Lock size={12} strokeWidth={1.75} />}
                title="Vaults not read — connection locked"
                hint="Email still checked; vault contents weren't. Unlock the connection (may need 2FA), then refresh."
                emails={r().lockedConnections}
              />
              <EmailNotice
                icon={<Hourglass size={12} strokeWidth={1.75} />}
                title="Not checked yet"
                hint="Over this run's rate-limit budget. Refresh to check the next batch."
                emails={r().pending}
              />
              <Show when={r().errored.length > 0}>
                <h4 class="sec-group-label warn">
                  <AlertTriangle size={12} strokeWidth={1.75} /> Lookup failed ({r().errored.length})
                </h4>
                <p class="muted sec-group-hint">Transient — retried on the next scan.</p>
                <ul class="sec-notice-list">
                  <For each={r().errored}>
                    {(e) => (
                      <li class="sec-notice-item">
                        <span class="truncate">{e.email}</span>
                        <span class="muted sec-notice-reason truncate">{e.error}</span>
                      </li>
                    )}
                  </For>
                </ul>
              </Show>
            </>
          )}
        </Show>

        <p class="sec-attrib">Breach data from XposedOrNot.</p>
      </Show>
    </section>
  );
}
