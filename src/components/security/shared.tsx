// Small presentation helpers shared across the Security center's tab views:
// health-band colour/label, the "severe data class" test, the at-risk chip set,
// the last-run timestamp line, and two tiny shared components (the leaked-data
// class chips, and the "feature is off in Settings" notice). All render-only —
// no IPC, no signals. They reuse the .sec-* classes from SecurityCenter.css,
// which the parent imports.

import { For, Show } from 'solid-js';
import { Settings as SettingsIcon } from 'lucide-solid';
import type { BreachRecord } from '../../lib/types.ts';

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

export function isSevere(dataClass: string): boolean {
  return SEVERE_CLASSES.includes(dataClass.toLowerCase());
}

export function DataClassChips(props: { classes: string[] }) {
  return (
    <span class="sec-classes">
      <For each={props.classes}>
        {(c) => <span class="sec-class" classList={{ severe: isSevere(c) }}>{c}</span>}
      </For>
    </span>
  );
}

/**
 * Humanize XposedOrNot's terse `password_risk` codes into a readable phrase.
 * Unknown/empty values are filtered out upstream, so any value here is meaningful.
 */
function passwordRiskLabel(risk: string): string {
  switch (risk.toLowerCase()) {
    case 'plaintext':
      return 'Stored in plaintext';
    case 'easytocrack':
      return 'Weakly hashed (easy to crack)';
    case 'hardtocrack':
      return 'Strongly hashed (hard to crack)';
    case 'unknown':
      return 'Unknown';
    default:
      return risk;
  }
}

/**
 * The expandable "more information" panel for a single breach: its description,
 * the headline facts (accounts affected, how passwords were stored), and the full
 * list of what data leaked. Render-only; the description is plain text (never
 * `innerHTML`) so a provider string can't inject markup.
 */
export function BreachDetails(props: { breach: BreachRecord }) {
  const b = () => props.breach;
  const pwn = () => b().pwnCount;
  const hasFacts = () => pwn() !== null || Boolean(b().passwordRisk);
  const isBare = () => !b().description && !hasFacts() && b().dataClasses.length === 0;
  return (
    <div class="sec-breach-detail">
      <Show when={b().description}>{(d) => <p class="sec-breach-desc">{d()}</p>}</Show>
      <Show when={hasFacts()}>
        <dl class="sec-breach-facts">
          <Show when={pwn() !== null}>
            <div class="sec-fact">
              <dt class="muted">Accounts affected</dt>
              <dd>{pwn()?.toLocaleString()}</dd>
            </div>
          </Show>
          <Show when={b().passwordRisk}>
            {(r) => (
              <div class="sec-fact">
                <dt class="muted">Password storage</dt>
                <dd classList={{ severe: r().toLowerCase() !== 'hardtocrack' }}>
                  {passwordRiskLabel(r())}
                </dd>
              </div>
            )}
          </Show>
        </dl>
      </Show>
      <Show when={b().dataClasses.length > 0}>
        <div class="sec-breach-leaked">
          <span class="muted">What leaked:</span>
          <DataClassChips classes={b().dataClasses} />
        </div>
      </Show>
      <Show when={isBare()}>
        <p class="muted sec-breach-desc">No further details were provided for this breach.</p>
      </Show>
    </div>
  );
}

/** Shown in any tab whose feature is switched off in Settings. */
export function DisabledNotice(props: { what: string }) {
  return (
    <p class="sec-disabled muted">
      <SettingsIcon size={13} strokeWidth={1.75} />
      {props.what} is turned off. Enable it in Settings → Security monitoring.
    </p>
  );
}
