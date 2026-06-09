// Settings › Audits — choose which offline security checks run, and tune their
// thresholds. The config is persisted (state/auditConfig.ts) and sent with every
// audit, so the Security center, the list's Security column, and the sidebar
// health badge all reflect it. The two network-based checks (exposed-password,
// dark-web) live under Settings › Security instead — these are the local checks.

import { Show, type JSX } from 'solid-js';
import { Clock, Globe, Repeat, ShieldCheck, Timer, Gauge } from 'lucide-solid';
import { auditConfig, resetAuditConfig, setAuditOption } from '../../state/auditConfig.ts';
import {
  ResetButton,
  Select,
  SettingSubField,
  ToggleRow,
} from '../../components/settings/SettingsControls.tsx';
import type { IconComponent } from '../../lib/icon.ts';
import './AuditSettings.css';

const WEAK_LEVELS = [
  { value: 2, label: 'Below fair' },
  { value: 3, label: 'Below good' },
  { value: 4, label: 'Below strong' },
];

const OLD_OPTIONS = [
  { value: 30, label: '1 month' },
  { value: 90, label: '3 months' },
  { value: 180, label: '6 months' },
  { value: 365, label: '1 year' },
  { value: 730, label: '2 years' },
];

const REUSE_OPTIONS = [
  { value: 2, label: '2 or more' },
  { value: 3, label: '3 or more' },
  { value: 5, label: '5 or more' },
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
          <SettingSubField label="Flag when shared by">
            <Select
              ariaLabel="Reuse threshold"
              value={c().reuseMin}
              options={REUSE_OPTIONS}
              onChange={(v) => setAuditOption('reuseMin', v)}
            />
          </SettingSubField>
        </AuditCheck>

        <AuditCheck
          icon={Gauge}
          label="Weak passwords"
          desc="Easy-to-guess passwords, scored offline with zxcvbn."
          enabled={c().weak}
          onToggle={(v) => setAuditOption('weak', v)}
        >
          <SettingSubField label="Flag strength">
            <Select
              ariaLabel="Weak-password threshold"
              value={c().weakMaxScore}
              options={WEAK_LEVELS}
              onChange={(v) => setAuditOption('weakMaxScore', v)}
            />
          </SettingSubField>
        </AuditCheck>

        <AuditCheck
          icon={Clock}
          label="Old passwords"
          desc="Passwords that haven't been changed in a long time."
          enabled={c().old}
          onToggle={(v) => setAuditOption('old', v)}
        >
          <SettingSubField label="Flag when older than">
            <Select
              ariaLabel="Old-password threshold"
              value={c().oldDays}
              options={OLD_OPTIONS}
              onChange={(v) => setAuditOption('oldDays', v)}
            />
          </SettingSubField>
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

        <ResetButton label="Reset to defaults" onClick={() => resetAuditConfig()} />
      </section>
    </div>
  );
}

// One audit check: a toggle row carrying the divider, plus an optional threshold
// sub-field revealed only while the check is on.
function AuditCheck(props: {
  icon: IconComponent;
  label: string;
  desc: string;
  enabled: boolean;
  onToggle: (v: boolean) => void;
  children?: JSX.Element;
}) {
  return (
    <div class="audit-check">
      <ToggleRow
        flush
        icon={props.icon}
        label={props.label}
        desc={props.desc}
        checked={props.enabled}
        onChange={props.onToggle}
      />
      <Show when={props.enabled && props.children}>{props.children}</Show>
    </div>
  );
}
