// Settings › Audits — choose which offline security checks run, and tune their
// thresholds. The config is persisted (state/auditConfig.ts) and sent with every
// audit, so the Security center, the list's Security column, and the sidebar
// health badge all reflect it. The two network-based checks (exposed-password,
// dark-web) live under Settings › Security instead — these are the local checks.

import { For, Show, type JSX } from 'solid-js';
import { Clock, Globe, Repeat, RotateCcw, ShieldCheck, Timer, Gauge } from 'lucide-solid';
import { auditConfig, resetAuditConfig, setAuditOption } from '../../state/auditConfig.ts';
import './AuditSettings.css';

const WEAK_LEVELS: { score: number; label: string }[] = [
  { score: 2, label: 'Below fair' },
  { score: 3, label: 'Below good' },
  { score: 4, label: 'Below strong' },
];

const OLD_OPTIONS: { days: number; label: string }[] = [
  { days: 30, label: '1 month' },
  { days: 90, label: '3 months' },
  { days: 180, label: '6 months' },
  { days: 365, label: '1 year' },
  { days: 730, label: '2 years' },
];

const REUSE_OPTIONS: { n: number; label: string }[] = [
  { n: 2, label: '2 or more' },
  { n: 3, label: '3 or more' },
  { n: 5, label: '5 or more' },
];

export default function AuditSettings() {
  const c = auditConfig;

  return (
    <div class="settings-page">
      <section class="settings-section">
        <h3>
          <ShieldCheck size={14} strokeWidth={1.75} /> Security audits
        </h3>
        <p class="muted settings-help">
          Local checks over your decrypted vault — nothing leaves your device. Turn each on or off
          and tune what counts as a problem. Results drive the Security center, the list's Security
          column, and the sidebar badge.
        </p>

        <AuditCheck
          icon={Repeat}
          label="Reused passwords"
          desc="The same password used on more than one login."
          enabled={c().reused}
          onToggle={(v) => setAuditOption('reused', v)}
        >
          <ThresholdSelect
            label="Flag when shared by"
            value={c().reuseMin}
            options={REUSE_OPTIONS.map((o) => ({ value: o.n, label: o.label }))}
            onChange={(v) => setAuditOption('reuseMin', v)}
          />
        </AuditCheck>

        <AuditCheck
          icon={Gauge}
          label="Weak passwords"
          desc="Easy-to-guess passwords, scored offline with zxcvbn."
          enabled={c().weak}
          onToggle={(v) => setAuditOption('weak', v)}
        >
          <ThresholdSelect
            label="Flag strength"
            value={c().weakMaxScore}
            options={WEAK_LEVELS.map((o) => ({ value: o.score, label: o.label }))}
            onChange={(v) => setAuditOption('weakMaxScore', v)}
          />
        </AuditCheck>

        <AuditCheck
          icon={Clock}
          label="Old passwords"
          desc="Passwords that haven't been changed in a long time."
          enabled={c().old}
          onToggle={(v) => setAuditOption('old', v)}
        >
          <ThresholdSelect
            label="Flag when older than"
            value={c().oldDays}
            options={OLD_OPTIONS.map((o) => ({ value: o.days, label: o.label }))}
            onChange={(v) => setAuditOption('oldDays', v)}
          />
        </AuditCheck>

        <AuditCheck
          icon={Globe}
          label="Insecure website"
          desc="A login whose website uses http:// instead of https://."
          enabled={c().insecureUri}
          onToggle={(v) => setAuditOption('insecureUri', v)}
        />

        <AuditCheck
          icon={Timer}
          label="No one-time code"
          desc="A login without a TOTP / two-factor code stored."
          enabled={c().noTotp}
          onToggle={(v) => setAuditOption('noTotp', v)}
        />

        <button class="ghost audit-reset" onClick={() => resetAuditConfig()}>
          <RotateCcw size={13} strokeWidth={1.75} /> Reset to defaults
        </button>
      </section>
    </div>
  );
}

function AuditCheck(props: {
  icon: typeof Repeat;
  label: string;
  desc: string;
  enabled: boolean;
  onToggle: (v: boolean) => void;
  children?: JSX.Element;
}) {
  const Icon = props.icon;
  return (
    <div class="audit-check" classList={{ off: !props.enabled }}>
      <div class="audit-check-head">
        <Icon size={16} strokeWidth={1.6} class="audit-check-icon" />
        <span class="audit-check-text">
          <span class="audit-check-label">{props.label}</span>
          <span class="muted audit-check-desc">{props.desc}</span>
        </span>
        <Toggle checked={props.enabled} onChange={props.onToggle} label={props.label} />
      </div>
      <Show when={props.enabled && props.children}>
        <div class="audit-check-config">{props.children}</div>
      </Show>
    </div>
  );
}

function ThresholdSelect(props: {
  label: string;
  value: number;
  options: { value: number; label: string }[];
  onChange: (v: number) => void;
}) {
  return (
    <label class="audit-threshold">
      <span class="muted">{props.label}</span>
      <select value={props.value} onChange={(e) => props.onChange(Number(e.currentTarget.value))}>
        <For each={props.options}>{(o) => <option value={o.value}>{o.label}</option>}</For>
      </select>
    </label>
  );
}

function Toggle(props: { checked: boolean; onChange: (v: boolean) => void; label: string }) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={props.checked}
      aria-label={props.label}
      class="audit-switch"
      classList={{ on: props.checked }}
      onClick={() => props.onChange(!props.checked)}
    >
      <span class="audit-switch-knob" />
    </button>
  );
}
