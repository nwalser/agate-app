import { createSignal, For, onMount, Show } from 'solid-js';
import {
  AlertTriangle,
  CheckCircle2,
  Clock,
  Database,
  Globe,
  Mail,
  RefreshCw,
  Search,
  ShieldAlert,
  ShieldCheck,
  ShieldOff,
} from 'lucide-solid';
import { ipc } from '../lib/ipc.ts';
import type {
  AccountBreaches,
  BreachRecord,
  DarkWebReport,
  ExposedResult,
  HealthBand,
  ItemAudit,
  VaultHealthReport,
} from '../lib/types.ts';
import { status, refreshSession } from '../state/session.ts';
import { pushToast, toastError } from '../state/toast.ts';
import './SecurityCenter.css';

type Tab = 'overview' | 'exposed' | 'darkweb' | 'directory';

const TABS: { id: Tab; label: string }[] = [
  { id: 'overview', label: 'Overview' },
  { id: 'exposed', label: 'Exposed passwords' },
  { id: 'darkweb', label: 'Dark web monitor' },
  { id: 'directory', label: 'Breach directory' },
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

/** HIBP descriptions contain HTML; render as plain text (no innerHTML). */
function stripHtml(html: string): string {
  return html
    .replace(/<[^>]*>/g, '')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/\s+/g, ' ')
    .trim();
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
            <button
              class="sec-tab"
              classList={{ active: tab() === t.id }}
              onClick={() => setTab(t.id)}
            >
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
        <Show when={tab() === 'directory'}>
          <BreachDirectory />
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

// ── Exposed passwords: HIBP k-anonymity (privacy-preserving) ──────────────────

function ExposedPasswords(props: { onOpenItem: (id: string) => void }) {
  const [exposed, setExposed] = createSignal<ExposedResult[] | null>(null);
  const [busy, setBusy] = createSignal(false);

  async function run() {
    setBusy(true);
    try {
      setExposed(await ipc.auditExposed());
    } catch (err) {
      toastError(err);
    } finally {
      setBusy(false);
    }
  }

  return (
    <section class="sec-card">
      <h3><Globe size={14} strokeWidth={1.75} /> Exposed passwords</h3>
      <p class="muted sec-help">
        Checks your passwords against Have I Been Pwned using k-anonymity: only the first five
        characters of each password's SHA-1 hash leave your device — never the password itself.
      </p>

      <button class="primary sec-run-btn" disabled={busy()} onClick={() => void run()}>
        <RefreshCw size={14} strokeWidth={1.75} class={busy() ? 'spin' : ''} /> Run exposed-password check
      </button>

      <Show when={busy()}>
        <p class="sec-loading muted">Checking against Have I Been Pwned…</p>
      </Show>

      <Show when={!busy() && exposed()}>
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
    </section>
  );
}

// ── Dark web monitor: opt-in email breach lookup (XposedOrNot) ────────────────

function DarkWebMonitor() {
  const [report, setReport] = createSignal<DarkWebReport | null>(null);
  const [single, setSingle] = createSignal<AccountBreaches | null>(null);
  const [email, setEmail] = createSignal('');
  const [busy, setBusy] = createSignal(false);
  const [enabling, setEnabling] = createSignal(false);
  const [disabling, setDisabling] = createSignal(false);

  const consented = () => status().darkwebConsent;

  async function enable() {
    setEnabling(true);
    try {
      await ipc.setDarkwebConsent(true);
      await refreshSession();
    } catch (err) {
      toastError(err);
    } finally {
      setEnabling(false);
    }
  }

  async function disable() {
    setDisabling(true);
    try {
      await ipc.setDarkwebConsent(false);
      await refreshSession();
      setReport(null);
      setSingle(null);
    } catch (err) {
      toastError(err);
    } finally {
      setDisabling(false);
    }
  }

  async function scanVault() {
    setBusy(true);
    setSingle(null);
    try {
      const r = await ipc.darkwebScanVault();
      setReport(r);
      if (r.skipped > 0) {
        pushToast('info', `${r.skipped} more email${r.skipped === 1 ? '' : 's'} not scanned (daily rate limit).`);
      }
    } catch (err) {
      toastError(err);
    } finally {
      setBusy(false);
    }
  }

  async function scanOne(e: Event) {
    e.preventDefault();
    const addr = email().trim();
    if (!addr) return;
    setBusy(true);
    setReport(null);
    try {
      setSingle(await ipc.darkwebScanEmail(addr));
    } catch (err) {
      toastError(err);
    } finally {
      setBusy(false);
    }
  }

  return (
    <section class="sec-card">
      <h3><ShieldAlert size={14} strokeWidth={1.75} /> Dark web monitor</h3>

      <Show
        when={consented()}
        fallback={
          <div class="sec-consent">
            <p class="sec-consent-lead">
              Check whether your accounts appear in known data breaches and see exactly what data
              leaked.
            </p>
            <p class="muted sec-help">
              To do this, Agate sends the email address you choose to a third-party breach database
              (<strong>XposedOrNot</strong>). Unlike the password check — where only a partial hash
              leaves your device — this sends your <strong>full email address</strong> over an
              encrypted connection to a server Agate does not operate. Enable this only for addresses
              you control. Nothing is sent until you turn this on and start a scan.
            </p>
            <button class="primary sec-run-btn" disabled={enabling()} onClick={() => void enable()}>
              <ShieldCheck size={14} strokeWidth={1.75} /> Enable dark web monitor
            </button>
          </div>
        }
      >
        <p class="muted sec-help">
          Scans the email addresses in your vault against a third-party breach database. Your full
          email address is sent to the provider over an encrypted connection.
        </p>

        <div class="sec-actions">
          <button class="primary sec-run-btn" disabled={busy()} onClick={() => void scanVault()}>
            <RefreshCw size={14} strokeWidth={1.75} class={busy() ? 'spin' : ''} /> Scan my accounts
          </button>
          <button class="ghost sec-link-btn" disabled={disabling()} onClick={() => void disable()}>
            Turn off
          </button>
        </div>

        <form class="sec-email-form" onSubmit={(e) => void scanOne(e)}>
          <div class="sec-email-input">
            <Mail size={14} strokeWidth={1.75} />
            <input
              type="email"
              placeholder="Check a specific address…"
              value={email()}
              onInput={(e) => setEmail(e.currentTarget.value)}
            />
          </div>
          <button class="ghost sec-run-btn" type="submit" disabled={busy() || !email().trim()}>
            <Search size={14} strokeWidth={1.75} /> Check
          </button>
        </form>

        <Show when={busy()}>
          <p class="sec-loading muted">Checking for breaches…</p>
        </Show>

        <Show when={!busy() && single()}>
          {(acct) => (
            <div class="sec-accounts">
              <AccountResult account={acct()} />
            </div>
          )}
        </Show>

        <Show when={!busy() && report()}>
          {(r) => (
            <div class="sec-accounts">
              <div class="sec-report-summary">
                <span><strong>{r().accounts.length}</strong> scanned</span>
                <span class="sec-report-bad"><strong>{r().totalBreaches}</strong> breaches</span>
                <span class="sec-report-good"><strong>{r().clean}</strong> clean</span>
              </div>
              <Show
                when={r().accounts.length > 0}
                fallback={<p class="muted sec-empty">No account emails found in your vault.</p>}
              >
                <For each={r().accounts}>{(acct) => <AccountResult account={acct} />}</For>
              </Show>
            </div>
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

// ── Breach directory: curated catalogue of known leaks (HIBP) ─────────────────

const DIRECTORY_RENDER_CAP = 150;

function BreachDirectory() {
  const [all, setAll] = createSignal<BreachRecord[] | null>(null);
  const [loading, setLoading] = createSignal(true);
  const [query, setQuery] = createSignal('');

  onMount(() => {
    void (async () => {
      try {
        setAll(await ipc.breachDirectory());
      } catch (err) {
        toastError(err);
      } finally {
        setLoading(false);
      }
    })();
  });

  const matches = () => {
    const list = all() ?? [];
    const q = query().trim().toLowerCase();
    if (!q) return list;
    return list.filter(
      (b) =>
        b.name.toLowerCase().includes(q) ||
        b.domain.toLowerCase().includes(q) ||
        b.dataClasses.some((c) => c.toLowerCase().includes(q)),
    );
  };

  return (
    <section class="sec-card">
      <h3><Database size={14} strokeWidth={1.75} /> Breach directory</h3>
      <p class="muted sec-help">
        A catalogue of known data breaches and what each one exposed. No data leaves your device —
        this is a public reference list.
      </p>

      <Show when={!loading()} fallback={<p class="sec-loading muted">Loading breach directory…</p>}>
        <Show when={all()} fallback={<p class="muted sec-empty">Directory unavailable.</p>}>
          <div class="sec-dir-search">
            <Search size={14} strokeWidth={1.75} />
            <input
              placeholder="Search breaches (name, domain, leaked data)…"
              value={query()}
              onInput={(e) => setQuery(e.currentTarget.value)}
            />
          </div>

          <p class="muted sec-dir-count">
            {matches().length.toLocaleString()} of {(all() ?? []).length.toLocaleString()} breaches
            {matches().length > DIRECTORY_RENDER_CAP ? ` — showing first ${DIRECTORY_RENDER_CAP}` : ''}
          </p>

          <ul class="sec-dir-list">
            <For each={matches().slice(0, DIRECTORY_RENDER_CAP)}>
              {(b) => (
                <li class="sec-dir-item">
                  <div class="sec-dir-item-head">
                    <span class="sec-breach-name">{b.name}</span>
                    <Show when={b.verified}>
                      <span class="sec-breach-verified" title="Verified breach">
                        <CheckCircle2 size={11} strokeWidth={2} />
                      </span>
                    </Show>
                    <span class="spacer" />
                    <Show when={b.breachDate}>{(d) => <span class="muted sec-breach-date">{d()}</span>}</Show>
                  </div>
                  <div class="sec-dir-meta">
                    <Show when={b.domain}>
                      <span class="muted">{b.domain}</span>
                    </Show>
                    <Show when={b.pwnCount}>
                      {(c) => <span class="muted">· {c().toLocaleString()} accounts</span>}
                    </Show>
                  </div>
                  <Show when={b.dataClasses.length > 0}>
                    <DataClassChips classes={b.dataClasses} />
                  </Show>
                  <Show when={b.description}>
                    {(d) => <p class="sec-dir-desc muted">{stripHtml(d())}</p>}
                  </Show>
                </li>
              )}
            </For>
          </ul>
        </Show>
      </Show>
      <p class="sec-attrib">
        Data from{' '}
        <a href="https://haveibeenpwned.com" target="_blank" rel="noopener noreferrer">
          Have I Been Pwned
        </a>.
      </p>
    </section>
  );
}
