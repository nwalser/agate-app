// Small presentation helpers shared across the Security center's tab views:
// health-band colour/label, the "severe data class" test, the at-risk chip set,
// the last-run timestamp line, and two tiny shared components (the leaked-data
// class chips, and the "feature is off in Settings" notice). All render-only —
// no IPC, no signals. They reuse the .sec-* classes from SecurityCenter.css,
// which the parent imports.

import { For } from 'solid-js';
import { Settings as SettingsIcon } from 'lucide-solid';
import type { HealthBand, ItemAudit } from '../../lib/types.ts';

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

export function bandColor(band: HealthBand): string {
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

export function bandLabel(band: HealthBand): string {
  return band.charAt(0).toUpperCase() + band.slice(1);
}

export function chipsFor(item: ItemAudit): string[] {
  return [
    item.reused && 'Reused',
    item.weak && 'Weak',
    item.old && 'Old',
    item.insecureUri && 'Insecure',
    item.noTotp && 'No 2FA',
  ].filter((c): c is string => Boolean(c));
}

export function lastRun(ts: number | null): string {
  if (ts === null) return 'Not run yet';
  return `Last checked ${new Date(ts).toLocaleString()}`;
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

/** Shown in any tab whose feature is switched off in Settings. */
export function DisabledNotice(props: { what: string }) {
  return (
    <p class="sec-disabled muted">
      <SettingsIcon size={13} strokeWidth={1.75} />
      {props.what} is turned off. Enable it in Settings → Security monitoring.
    </p>
  );
}
