import { ShieldAlert } from 'lucide-solid';
import {
  darkwebMonitor,
  exposedCheck,
  setDarkwebMonitor,
  setExposedCheck,
} from '../state/security.ts';
import './SecuritySettings.css';

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
