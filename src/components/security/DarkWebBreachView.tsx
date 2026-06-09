// "Dark web monitor" tab of the Security center: the periodic all-account breach
// scan (XposedOrNot). Reads the scan-result signals from state/securityScans.ts
// and the on/off toggle from state/security.ts; triggers a manual refresh via
// runDarkwebScan. Renders the per-account breach results plus the grouped notices
// for emails that were locked, pending, or errored this run. Reuses the .sec-*
// classes from SecurityCenter.css (imported by the parent).

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
  ShieldOff,
} from 'lucide-solid';
import type { AccountBreaches, BreachRecord } from '../../lib/types.ts';
import { darkwebMonitor } from '../../state/security.ts';
import { darkwebBusy, darkwebReport, darkwebRunAt, runDarkwebScan } from '../../state/securityScans.ts';
import { BreachDetails, DataClassChips, DisabledNotice, lastRun } from './shared.tsx';

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

function BreachRow(props: { breach: BreachRecord }) {
  const b = () => props.breach;
  const [open, setOpen] = createSignal(false);
  return (
    <li class="sec-breach" classList={{ open: open() }}>
      <button
        type="button"
        class="sec-breach-toggle"
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
      </button>
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

function AccountResult(props: { account: AccountBreaches }) {
  const a = () => props.account;
  return (
    <div class="sec-account">
      <div class="sec-account-head">
        <Mail size={13} strokeWidth={1.75} />
        <span class="sec-account-email truncate">{a().email}</span>
        <Show
          when={a().breaches.length > 0}
          fallback={
            <span class="sec-account-clean">
              <CheckCircle2 size={13} strokeWidth={1.75} /> Clean
            </span>
          }
        >
          <span class="sec-account-bad">
            <ShieldOff size={13} strokeWidth={1.75} />
            {a().breaches.length} breach{a().breaches.length === 1 ? '' : 'es'}
          </span>
        </Show>
      </div>

      <Show when={a().exposedData.length > 0}>
        <div class="sec-exposed-line">
          <span class="muted">Leaked:</span>
          <DataClassChips classes={a().exposedData} />
        </div>
      </Show>

      <Show when={a().breaches.length > 0}>
        <ul class="sec-breaches">
          <For each={a().breaches}>{(b) => <BreachRow breach={b} />}</For>
        </ul>
      </Show>
    </div>
  );
}

export default function DarkWebBreachView() {
  return (
    <section class="sec-card">
      <div class="sec-card-head">
        <h3><ShieldAlert size={14} strokeWidth={1.75} /> Dark web monitor</h3>
        <span class="spacer" />
        <button class="ghost sec-refresh" disabled={darkwebBusy() || !darkwebMonitor()} onClick={() => void runDarkwebScan()}>
          <RefreshCw size={13} strokeWidth={1.75} class={darkwebBusy() ? 'spin' : ''} /> Refresh
        </button>
      </div>

      <Show when={darkwebMonitor()} fallback={<DisabledNotice what="The dark-web monitor" />}>
        <p class="muted sec-help">{lastRun(darkwebRunAt())}</p>
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
              <div class="sec-report-summary">
                <span><strong>{r().accounts.length}</strong> checked</span>
                <span class="sec-report-bad"><strong>{r().totalBreaches}</strong> breaches</span>
                <span class="sec-report-good"><strong>{r().clean}</strong> clean</span>
              </div>

              <Show
                when={r().accounts.length > 0}
                fallback={<p class="muted sec-empty">No account emails found in your vault.</p>}
              >
                <h4 class="sec-group-label">
                  <CheckCircle2 size={12} strokeWidth={1.75} /> Checked emails ({r().accounts.length})
                </h4>
                <div class="sec-accounts">
                  <For each={r().accounts}>{(acct) => <AccountResult account={acct} />}</For>
                </div>
              </Show>

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
