// "Breaches" tab of the Security center: the breaches YOUR accounts appear in
// (account-relevant only, never the full public catalogue), derived from the
// latest dark-web scan via relevantBreaches() in state/securityScans.ts. Reuses
// the .sec-* classes from SecurityCenter.css (imported by the parent).

import { For, Show } from 'solid-js';
import { CheckCircle2, Database, ShieldCheck } from 'lucide-solid';
import { darkwebMonitor } from '../../state/security.ts';
import { darkwebReport, relevantBreaches } from '../../state/securityScans.ts';
import { DataClassChips, DisabledNotice } from './shared.tsx';

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
