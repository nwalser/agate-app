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
import { t } from '../../lib/i18n.ts';
import './AuditSettings.css';

// Option lists are functions (not module constants) so the labels re-localize on
// a language flip — they're called in render.
const weakLevels = () => [
  { value: 2, label: t('auditSettings.weakBelowFair') },
  { value: 3, label: t('auditSettings.weakBelowGood') },
  { value: 4, label: t('auditSettings.weakBelowStrong') },
];

const oldOptions = () => [
  { value: 30, label: t('auditSettings.old1Month') },
  { value: 90, label: t('auditSettings.old3Months') },
  { value: 180, label: t('auditSettings.old6Months') },
  { value: 365, label: t('auditSettings.old1Year') },
  { value: 730, label: t('auditSettings.old2Years') },
];

const reuseOptions = () => [
  { value: 2, label: t('auditSettings.reuse2OrMore') },
  { value: 3, label: t('auditSettings.reuse3OrMore') },
  { value: 5, label: t('auditSettings.reuse5OrMore') },
];

export default function AuditSettings() {
  const c = auditConfig;

  return (
    <section class="settings-section">
        <h3>
          <ShieldCheck size={14} strokeWidth={1.75} /> {t('auditSettings.title')}
        </h3>
        <p class="muted settings-help">{t('auditSettings.help')}</p>

        <AuditCheck
          icon={Repeat}
          label={t('auditSettings.reusedLabel')}
          desc={t('auditSettings.reusedDesc')}
          enabled={c().reused}
          onToggle={(v) => setAuditOption('reused', v)}
        >
          <SettingSubField label={t('auditSettings.flagWhenSharedBy')}>
            <Select
              ariaLabel={t('auditSettings.reuseThreshold')}
              value={c().reuseMin}
              options={reuseOptions()}
              onChange={(v) => setAuditOption('reuseMin', v)}
            />
          </SettingSubField>
        </AuditCheck>

        <AuditCheck
          icon={Gauge}
          label={t('auditSettings.weakLabel')}
          desc={t('auditSettings.weakDesc')}
          enabled={c().weak}
          onToggle={(v) => setAuditOption('weak', v)}
        >
          <SettingSubField label={t('auditSettings.flagStrength')}>
            <Select
              ariaLabel={t('auditSettings.weakThreshold')}
              value={c().weakMaxScore}
              options={weakLevels()}
              onChange={(v) => setAuditOption('weakMaxScore', v)}
            />
          </SettingSubField>
        </AuditCheck>

        <AuditCheck
          icon={Clock}
          label={t('auditSettings.oldLabel')}
          desc={t('auditSettings.oldDesc')}
          enabled={c().old}
          onToggle={(v) => setAuditOption('old', v)}
        >
          <SettingSubField label={t('auditSettings.flagWhenOlderThan')}>
            <Select
              ariaLabel={t('auditSettings.oldThreshold')}
              value={c().oldDays}
              options={oldOptions()}
              onChange={(v) => setAuditOption('oldDays', v)}
            />
          </SettingSubField>
        </AuditCheck>

        <AuditCheck
          icon={Globe}
          label={t('auditSettings.insecureLabel')}
          desc={t('auditSettings.insecureDesc')}
          enabled={c().insecureUri}
          onToggle={(v) => setAuditOption('insecureUri', v)}
        />

        <AuditCheck
          icon={Timer}
          label={t('auditSettings.noTotpLabel')}
          desc={t('auditSettings.noTotpDesc')}
          enabled={c().noTotp}
          onToggle={(v) => setAuditOption('noTotp', v)}
        />

        <div class="settings-actions">
          <ResetButton label={t('auditSettings.resetToDefaults')} onClick={() => resetAuditConfig()} />
        </div>
    </section>
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
