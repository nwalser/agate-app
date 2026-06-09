// "Breaches" tab of the Security center: the breaches YOUR accounts appear in
// (account-relevant only, never the full public catalogue), derived from the
// latest dark-web scan via relevantBreaches() in state/securityScans.ts. Reuses
// the .sec-* classes from SecurityCenter.css (imported by the parent).

import { createSignal, For, Show } from 'solid-js';
import { CheckCircle2, ChevronRight, Database, RefreshCw, ShieldCheck } from 'lucide-solid';
import type { RelevantBreach } from '../../lib/breachAggregation.ts';
import { darkwebMonitor } from '../../state/security.ts';
import { darkwebBusy, darkwebReport, relevantBreaches, runDarkwebScan } from '../../state/securityScans.ts';
import { BreachDetails, DataClassChips, DisabledNotice } from './shared.tsx';

/** One account-relevant breach: a clickable summary that expands to full detail. */
function BreachDirItem(props: { entry: RelevantBreach }) {
  const b = () => props.entry.breach;
  const count = () => props.entry.accountCount;
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
        <Show when={b().verified}>
          <span class="sec-breach-verified" title="Verified breach">
            <CheckCircle2 size={11} strokeWidth={2} />
          </span>
        </Show>
        <span class="spacer" />
        <span class="sec-affected">
          {count()} of your account{count() === 1 ? '' : 's'}
        </span>
      </button>
      <div class="sec-dir-meta">
        <Show when={b().domain}>
          <span class="muted">{b().domain}</span>
        </Show>
        <Show when={b().breachDate}>{(d) => <span class="muted">· {d()}</span>}</Show>
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

export default function BreachDirectory() {
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
            <Show
              when={darkwebReport()}
              fallback={
                <div class="sec-empty-cta">
                  <p class="muted sec-empty">No scan results yet.</p>
                  <button
                    class="primary sec-run-btn"
                    disabled={darkwebBusy()}
                    onClick={() => void runDarkwebScan()}
                  >
                    <RefreshCw size={13} strokeWidth={1.75} class={darkwebBusy() ? 'spin' : ''} /> Run
                    scan now
                  </button>
                </div>
              }
            >
              <p class="sec-clean">
                <ShieldCheck size={14} strokeWidth={1.75} /> None of your accounts appear in known
                breaches.
              </p>
            </Show>
          }
        >
          <ul class="sec-dir-list">
            <For each={relevantBreaches()}>{(entry) => <BreachDirItem entry={entry} />}</For>
          </ul>
        </Show>
        <p class="sec-attrib">Breach data from XposedOrNot.</p>
      </Show>
    </section>
  );
}
