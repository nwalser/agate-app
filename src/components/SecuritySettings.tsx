import { For } from 'solid-js';
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
import './SecuritySettings.css';

function clearLabel(seconds: ClipboardClearSeconds): string {
  return seconds === 0 ? 'Never' : `${seconds}s`;
}

function timeoutLabel(minutes: AutoLockMinutes): string {
  if (minutes === 0) return 'Never';
  if (minutes === 60) return '1h';
  return `${minutes}m`;
}

/**
 * Security section for the Settings screen: toggles for the two periodic,
 * all-account checks. Both default on. Designed to drop into Settings.tsx as a
 * single `<SecuritySettings />`.
 */
export default function SecuritySettings() {
  return (
    <section class="settings-section">
      <h3>
        <ShieldAlert size={14} strokeWidth={1.75} /> Security monitoring
      </h3>
      <p class="muted settings-help">
        Periodic checks that run automatically across all your connections while the vault is
        unlocked. Results appear in the Security view.
      </p>

      <div class="settings-row sec-toggle-row">
        <span class="sec-toggle-text">
          <span class="sec-toggle-label">Exposed-password check</span>
          <span class="muted sec-toggle-desc">
            Checks your passwords against Have I Been Pwned using k-anonymity — only a partial hash
            of each password leaves your device, never the password itself.
          </span>
        </span>
        <Toggle checked={exposedCheck()} onChange={(v) => setExposedCheck(v)} label="Exposed-password check" />
      </div>

      <div class="settings-row sec-toggle-row">
        <span class="sec-toggle-text">
          <span class="sec-toggle-label">Dark-web monitor</span>
          <span class="muted sec-toggle-desc">
            Checks whether your accounts appear in known breaches. This sends your account
            <strong> email addresses</strong> to a third-party breach database (XposedOrNot) over an
            encrypted connection — unlike the password check, the full address leaves your device.
          </span>
        </span>
        <Toggle checked={darkwebMonitor()} onChange={(v) => void setDarkwebMonitor(v)} label="Dark-web monitor" />
      </div>

      <h3 class="sec-subhead">
        <Lock size={14} strokeWidth={1.75} /> Vault timeout
      </h3>
      <p class="muted settings-help">
        Lock every connection automatically after this much inactivity. The stored master passwords
        stay sealed; unlocking re-opens them. <strong>Never</strong> keeps the vault unlocked until
        you lock it yourself.
      </p>
      <div class="clip-options" role="radiogroup" aria-label="Auto-lock idle timeout">
        <For each={AUTO_LOCK_OPTIONS}>
          {(opt) => (
            <button
              type="button"
              role="radio"
              aria-checked={autoLockMinutes() === opt}
              class="clip-option"
              classList={{ active: autoLockMinutes() === opt }}
              onClick={() => setAutoLockMinutes(opt)}
            >
              {timeoutLabel(opt)}
            </button>
          )}
        </For>
      </div>
      <div class="settings-row sec-toggle-row">
        <span class="sec-toggle-text">
          <span class="sec-toggle-label">Lock when minimized</span>
          <span class="muted sec-toggle-desc">
            Lock immediately whenever the window is minimized or hidden, regardless of the idle
            timeout.
          </span>
        </span>
        <Toggle
          checked={lockOnMinimize()}
          onChange={(v) => setLockOnMinimize(v)}
          label="Lock when minimized"
        />
      </div>

      <h3 class="sec-subhead">
        <ClipboardCopy size={14} strokeWidth={1.75} /> Clipboard
      </h3>
      <p class="muted settings-help">
        How long a copied secret (password, TOTP, …) stays on the clipboard before Agate wipes it.
      </p>
      <div class="clip-options" role="radiogroup" aria-label="Clipboard auto-clear delay">
        <For each={CLIPBOARD_CLEAR_OPTIONS}>
          {(opt) => (
            <button
              type="button"
              role="radio"
              aria-checked={clipboardClearSeconds() === opt}
              class="clip-option"
              classList={{ active: clipboardClearSeconds() === opt }}
              onClick={() => setClipboardClearSeconds(opt)}
            >
              {clearLabel(opt)}
            </button>
          )}
        </For>
      </div>
    </section>
  );
}

function Toggle(props: { checked: boolean; onChange: (v: boolean) => void; label: string }) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={props.checked}
      aria-label={props.label}
      class="sec-switch"
      classList={{ on: props.checked }}
      onClick={() => props.onChange(!props.checked)}
    >
      <span class="sec-switch-knob" />
    </button>
  );
}
