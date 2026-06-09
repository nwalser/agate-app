import { ClipboardCopy, Lock, ShieldAlert } from 'lucide-solid';
import {
  darkwebMonitor,
  exposedCheck,
  setDarkwebMonitor,
  setExposedCheck,
} from '../state/security.ts';
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
import ExportSettings from './ExportSettings.tsx';
import './SecuritySettings.css';

function clearLabel(seconds: ClipboardClearSeconds): string {
  if (seconds === 0) return 'Never';
  if (seconds === 60) return '1 minute';
  return `${seconds} seconds`;
}

function timeoutLabel(minutes: AutoLockMinutes): string {
  if (minutes === 0) return 'Never';
  if (minutes === 60) return '1 hour';
  return `${minutes} minute${minutes === 1 ? '' : 's'}`;
}

/**
 * Security section for the Settings screen: toggles for the two periodic,
 * all-account checks. Both default on. Designed to drop into Settings.tsx as a
 * single `<SecuritySettings />`.
 */
export default function SecuritySettings() {
  return (
    <>
      <section class="settings-section">
        <h3>
          <ShieldAlert size={14} strokeWidth={1.75} /> Security monitoring
        </h3>
        <p class="muted settings-help">
          Periodic checks that run automatically across all your connections while the vault is
          unlocked. Results appear in the Security view.
        </p>

        <ToggleRow
          label="Exposed-password check"
          desc="Checks your passwords against Have I Been Pwned using k-anonymity — only a partial hash of each password leaves your device, never the password itself."
          checked={exposedCheck()}
          onChange={(v) => setExposedCheck(v)}
        />
        <ToggleRow
          label="Dark-web monitor"
          desc={
            <>
              Checks whether your accounts appear in known breaches. This sends your account{' '}
              <strong>email addresses</strong> to a third-party breach database (XposedOrNot) over an
              encrypted connection — unlike the password check, the full address leaves your device.
            </>
          }
          checked={darkwebMonitor()}
          onChange={(v) => void setDarkwebMonitor(v)}
        />

        <h3 class="sec-subhead">
          <Lock size={14} strokeWidth={1.75} /> Vault timeout
        </h3>
        <p class="muted settings-help">
          Lock every connection automatically after this much inactivity. The stored master
          passwords stay sealed; unlocking re-opens them. <strong>Never</strong> keeps the vault
          unlocked until you lock it yourself.
        </p>
        <Select
          ariaLabel="Auto-lock idle timeout"
          value={autoLockMinutes()}
          options={AUTO_LOCK_OPTIONS.map((opt) => ({ value: opt, label: timeoutLabel(opt) }))}
          onChange={(v) => setAutoLockMinutes(v)}
        />
        <ToggleRow
          label="Lock when minimized"
          desc="Lock immediately whenever the window is minimized or hidden, regardless of the idle timeout."
          checked={lockOnMinimize()}
          onChange={(v) => setLockOnMinimize(v)}
        />

        <h3 class="sec-subhead">
          <ClipboardCopy size={14} strokeWidth={1.75} /> Clipboard
        </h3>
        <p class="muted settings-help">
          How long a copied secret (password, TOTP, …) stays on the clipboard before Agate wipes it.
        </p>
        <Select
          ariaLabel="Clipboard auto-clear delay"
          value={clipboardClearSeconds()}
          options={CLIPBOARD_CLEAR_OPTIONS.map((opt) => ({ value: opt, label: clearLabel(opt) }))}
          onChange={(v) => setClipboardClearSeconds(v)}
        />
      </section>
      <ExportSettings />
    </>
  );
}
