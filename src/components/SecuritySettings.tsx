import { ClipboardCopy, Lock } from 'lucide-solid';
import {
  CLIPBOARD_CLEAR_OPTIONS,
  clipboardClearSeconds,
  setClipboardClearSeconds,
  type ClipboardClearSeconds,
} from '../state/clipboard.ts';
import {
  AUTO_LOCK_OPTIONS,
  autoLockMinutes,
  lockOnMinimize,
  setAutoLockMinutes,
  setLockOnMinimize,
  type AutoLockMinutes,
} from '../state/autolock.ts';
import { Select, ToggleRow } from './settings/SettingsControls.tsx';
import { t } from '../lib/i18n.ts';
import './SecuritySettings.css';

function clearLabel(seconds: ClipboardClearSeconds): string {
  if (seconds === 0) return t('securitySettings.never');
  if (seconds === 60) return t('securitySettings.oneMinute');
  return t('securitySettings.seconds', { seconds });
}

function timeoutLabel(minutes: AutoLockMinutes): string {
  if (minutes === 0) return t('securitySettings.never');
  if (minutes === 60) return t('securitySettings.oneHour');
  return minutes === 1
    ? t('securitySettings.minuteOne', { minutes })
    : t('securitySettings.minutesMany', { minutes });
}

/** Lock + clipboard hygiene settings (the Security page). */
export default function SecuritySettings() {
  return (
    <section class="settings-section">
        <h3>
          <Lock size={14} strokeWidth={1.75} /> {t('securitySettings.vaultTimeout')}
        </h3>
        <p class="muted settings-help">
          {t('securitySettings.vaultTimeoutHelpBefore')}{' '}
          <strong>{t('securitySettings.never')}</strong>{' '}
          {t('securitySettings.vaultTimeoutHelpAfter')}
        </p>
        <Select
          ariaLabel={t('securitySettings.autoLockAriaLabel')}
          value={autoLockMinutes()}
          options={AUTO_LOCK_OPTIONS.map((opt) => ({ value: opt, label: timeoutLabel(opt) }))}
          onChange={(v) => setAutoLockMinutes(v)}
        />
        <ToggleRow
          label={t('securitySettings.lockWhenMinimized')}
          desc={t('securitySettings.lockWhenMinimizedDesc')}
          checked={lockOnMinimize()}
          onChange={(v) => setLockOnMinimize(v)}
        />

        <h3 class="sec-subhead">
          <ClipboardCopy size={14} strokeWidth={1.75} /> {t('securitySettings.clipboard')}
        </h3>
        <p class="muted settings-help">{t('securitySettings.clipboardHelp')}</p>
        <Select
          ariaLabel={t('securitySettings.clipboardAriaLabel')}
          value={clipboardClearSeconds()}
          options={CLIPBOARD_CLEAR_OPTIONS.map((opt) => ({ value: opt, label: clearLabel(opt) }))}
          onChange={(v) => setClipboardClearSeconds(v)}
        />
    </section>
  );
}
