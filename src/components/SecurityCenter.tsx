import { createSignal, For, type JSX, onMount, Show } from 'solid-js';
import {
  AlertTriangle,
  CheckCircle2,
  Clock,
  Database,
  Globe,
  Hourglass,
  Lock,
  Mail,
  RefreshCw,
  Settings as SettingsIcon,
  ShieldAlert,
  ShieldCheck,
  ShieldOff,
} from 'lucide-solid';
import { ipc } from '../lib/ipc.ts';
import type { AccountBreaches, BreachRecord, HealthBand, ItemAudit, VaultHealthReport } from '../lib/types.ts';
import {
  darkwebBusy,
  darkwebMonitor,
  darkwebReport,
  darkwebRunAt,
  exposedBusy,
  exposedCheck,
  exposedResults,
  exposedRunAt,
  relevantBreaches,
  runDarkwebScan,
  runExposedCheck,
} from '../state/security.ts';
import { toastError } from '../state/toast.ts';
import './SecurityCenter.css';

type Tab = 'overview' | 'exposed' | 'darkweb' | 'breaches';

const TABS: { id: Tab; label: string }[] = [
  { id: 'overview', label: 'Overview' },
  { id: 'exposed', label: 'Exposed passwords' },
  { id: 'darkweb', label: 'Dark web monitor' },
  { id: 'breaches', label: 'Breaches' },
];

// Data classes worth flagging in red — leaking these is materially worse.
const SEVERE_CLASSES = [
  'passwords',
  'credit cards',
  'bank account numbers',
  'social security numbers',
  'partial credit card data',
  'security questions and answers',
  'historical passwords',
  'auth tokens',
];

function isSevere(dataClass: string): boolean {
  return SEVERE_CLASSES.includes(dataClass.toLowerCase());
}

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

function chipsFor(item: ItemAudit): string[] {
  return [
    item.reused && 'Reused',
    item.weak && 'Weak',
    item.old && 'Old',
    item.insecureUri && 'Insecure',
    item.noTotp && 'No 2FA',
  ].filter((c): c is string => Boolean(c));
}

function lastRun(ts: number | null): string {
  if (ts === null) return 'Not run yet';
  return `Last checked ${new Date(ts).toLocaleString()}`;
}

function DataClassChips(props: { classes: string[] }) {
  return (
    <span class="sec-classes">
      <For each={props.classes}>
        {(c) => <span class="sec-class" classList={{ severe: isSevere(c) }}>{c}</span>}
      </For>
    </span>
  );
}

/** Shown in any tab whose feature is switched off in Settings. */
function DisabledNotice(props: { what: string }) {
  return (
    <p class="sec-disabled muted">
      <SettingsIcon size={13} strokeWidth={1.75} />
      {props.what} is turned off. Enable it in Settings → Security monitoring.
    </p>
  );
}

export default function SecurityCenter(props: { onOpenItem: (id: string) => void }) {
  const [tab, setTab] = createSignal<Tab>('overview');

  return (
    <div class="sec">
      <header class="sec-header">
        <ShieldCheck size={16} strokeWidth={1.75} />
        <h2>Vault security</h2>
      </header>

      <nav class="sec-tabs">
        <For each={TABS}>
          {(t) => (
            <button class="sec-tab" classList={{ active: tab() === t.id }} onClick={() => setTab(t.id)}>
              {t.label}
            </button>
          )}
        </For>
      </nav>

      <div class="sec-body">
        <Show when={tab() === 'overview'}>
          <Overview onOpenItem={props.onOpenItem} />
        </Show>
        <Show when={tab() === 'exposed'}>
          <ExposedPasswords onOpenItem={props.onOpenItem} />
        </Show>
        <Show when={tab() === 'darkweb'}>
          <DarkWebMonitor />
        </Show>
        <Show when={tab() === 'breaches'}>
          <Breaches />
        </Show>
      </div>
    </div>
  );
}

// ── Overview: offline vault health ───────────────────────────────────────────

function Overview(props: { onOpenItem: (id: string) => void }) {
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

function Stat(props: { n: number; label: string }) {
  return (
    <div class="sec-stat">
      <span class="sec-stat-num">{props.n}</span>
      <span class="sec-stat-label muted">{props.label}</span>
    </div>
  );
}

// ── Exposed passwords: periodic HIBP k-anonymity check (all accounts) ─────────

function ExposedPasswords(props: { onOpenItem: (id: string) => void }) {
  return (
    <section class="sec-card">
      <div class="sec-card-head">
        <h3><Globe size={14} strokeWidth={1.75} /> Exposed passwords</h3>
        <span class="spacer" />
        <button class="ghost sec-refresh" disabled={exposedBusy() || !exposedCheck()} onClick={() => void runExposedCheck()}>
          <RefreshCw size={13} strokeWidth={1.75} class={exposedBusy() ? 'spin' : ''} /> Refresh
        </button>
      </div>

      <Show when={exposedCheck()} fallback={<DisabledNotice what="The exposed-password check" />}>
        <p class="muted sec-help">{lastRun(exposedRunAt())}</p>
        <Show when={exposedBusy() && !exposedResults()}>
          <p class="sec-loading muted">Checking against Have I Been Pwned…</p>
        </Show>
        <Show when={exposedResults()}>
          {(results) => (
            <Show
              when={results().length > 0}
              fallback={
                <p class="sec-clean">
                  <ShieldCheck size={14} strokeWidth={1.75} /> No exposed passwords found.
                </p>
              }
            >
              <ul class="sec-list sec-list-spaced">
                <For each={results()}>
                  {(ex) => (
                    <li>
                      <button class="sec-row" onClick={() => props.onOpenItem(ex.id)} title="Open item">
                        <ShieldOff size={14} strokeWidth={1.75} class="sec-row-danger" />
                        <span class="sec-row-name truncate">{ex.name}</span>
                        <span class="sec-breach-count">
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
        <p class="sec-attrib">Password data from Have I Been Pwned.</p>
      </Show>
    </section>
  );
}

// ── Dark web monitor: periodic all-account breach scan (XposedOrNot) ──────────

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

function DarkWebMonitor() {
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
                hint="Their account email is still checked, but logins/identities stored inside weren't. Unlock the connection (it may need 2FA), then refresh."
                emails={r().lockedConnections}
              />
              <EmailNotice
                icon={<Hourglass size={12} strokeWidth={1.75} />}
                title="Not checked yet"
                hint="More emails than one run's rate-limit budget. These rotate into the next scans — refresh to check the next batch now."
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

function BreachRow(props: { breach: BreachRecord }) {
  const b = () => props.breach;
  return (
    <li class="sec-breach">
      <div class="sec-breach-head">
        <span class="sec-breach-name">{b().name}</span>
        <Show when={b().breachDate}>{(d) => <span class="muted sec-breach-date">{d()}</span>}</Show>
        <Show when={b().verified}>
          <span class="sec-breach-verified" title="Verified breach">
            <CheckCircle2 size={11} strokeWidth={2} />
          </span>
        </Show>
      </div>
      <Show when={b().dataClasses.length > 0}>
        <DataClassChips classes={b().dataClasses} />
      </Show>
    </li>
  );
}

// ── Breaches: the breaches YOUR accounts appear in (account-relevant only) ─────

function Breaches() {
  return (
    <section class="sec-card">
      <h3><Database size={14} strokeWidth={1.75} /> Breaches affecting you</h3>
      <p class="muted sec-help">
        Known data breaches that one or more of your accounts appear in, and what each one exposed.
      </p>

      <Show when={darkwebMonitor()} fallback={<DisabledNotice what="The dark-web monitor" />}>
        <Show
          when={relevantBreaches().length > 0}
          fallback={
            <p class="sec-clean">
              <ShieldCheck size={14} strokeWidth={1.75} />
              {darkwebReport() ? 'None of your accounts appear in known breaches.' : 'No scan results yet.'}
            </p>
          }
        >
          <ul class="sec-dir-list">
            <For each={relevantBreaches()}>
              {(entry) => (
                <li class="sec-dir-item">
                  <div class="sec-dir-item-head">
                    <span class="sec-breach-name">{entry.breach.name}</span>
                    <Show when={entry.breach.verified}>
                      <span class="sec-breach-verified" title="Verified breach">
                        <CheckCircle2 size={11} strokeWidth={2} />
                      </span>
                    </Show>
                    <span class="spacer" />
                    <span class="sec-affected">
                      {entry.accountCount} of your account{entry.accountCount === 1 ? '' : 's'}
                    </span>
                  </div>
                  <div class="sec-dir-meta">
                    <Show when={entry.breach.domain}>
                      <span class="muted">{entry.breach.domain}</span>
                    </Show>
                    <Show when={entry.breach.breachDate}>
                      {(d) => <span class="muted">· {d()}</span>}
                    </Show>
                  </div>
                  <Show when={entry.breach.dataClasses.length > 0}>
                    <DataClassChips classes={entry.breach.dataClasses} />
                  </Show>
                </li>
              )}
            </For>
          </ul>
        </Show>
        <p class="sec-attrib">Breach data from XposedOrNot.</p>
      </Show>
    </section>
  );
}
