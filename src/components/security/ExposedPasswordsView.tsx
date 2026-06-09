// "Exposed passwords" tab of the Security center: the periodic HIBP k-anonymity
// check across every account. Reads the scan-result signals from
// state/securityScans.ts and the on/off toggle from state/security.ts; triggers a
// manual refresh via runExposedCheck. Reuses the .sec-* classes from
// SecurityCenter.css (imported by the parent).

import { For, Show } from 'solid-js';
import { Clock, Globe, RefreshCw, ShieldCheck, ShieldOff } from 'lucide-solid';
import { exposedCheck } from '../../state/security.ts';
import { exposedBusy, exposedResults, exposedRunAt, runExposedCheck } from '../../state/securityScans.ts';
import { DisabledNotice, lastRun } from './shared.tsx';

export default function ExposedPasswordsView(props: { onOpenItem: (id: string) => void }) {
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
