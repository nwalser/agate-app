// Shared Settings controls — the SINGLE switch, option picker, labelled row, and
// reset button used on every Settings page, so the configuration surface reads the
// same everywhere. Boolean preference → <Switch> / <ToggleRow>; pick-one-of-a-small
// -closed-set → <Segmented>. Section chrome (.settings-section / h3 / .settings-help)
// stays in Settings.css. Forms (Connections, app-password) keep labelled inputs —
// those are auth forms, not preferences.

import { For, Show, type JSX } from 'solid-js';
import { RotateCcw } from 'lucide-solid';
import type { IconComponent } from '../../lib/icon.ts';
import './SettingsControls.css';

// The one on/off switch for the whole app.
export function Switch(props: {
  checked: boolean;
  onChange: (v: boolean) => void;
  label: string;
  disabled?: boolean;
}) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={props.checked}
      aria-label={props.label}
      class="setting-switch"
      classList={{ on: props.checked }}
      disabled={props.disabled}
      onClick={() => props.onChange(!props.checked)}
    >
      <span class="setting-switch-knob" />
    </button>
  );
}

// A labelled settings row: optional leading icon · label + optional description ·
// trailing control slot. Rows stack with hairline dividers within a section. Pass
// `flush` to drop the row's own padding/divider when it lives inside a wrapper that
// supplies them (e.g. an audit check with a revealed sub-field).
export function SettingRow(props: {
  icon?: IconComponent;
  label: string;
  desc?: JSX.Element;
  dim?: boolean;
  flush?: boolean;
  control: JSX.Element;
}) {
  return (
    <div class="setting-row" classList={{ dim: props.dim, flush: props.flush }}>
      <Show when={props.icon}>
        {(icon) => {
          const Icon = icon();
          return <Icon size={16} strokeWidth={1.6} class="setting-row-icon" />;
        }}
      </Show>
      <span class="setting-row-text">
        <span class="setting-row-label">{props.label}</span>
        <Show when={props.desc}>
          <span class="setting-row-desc muted">{props.desc}</span>
        </Show>
      </span>
      <span class="setting-row-control">{props.control}</span>
    </div>
  );
}

// Convenience: a SettingRow whose trailing control is the canonical Switch — the
// shape of nearly every boolean preference.
export function ToggleRow(props: {
  icon?: IconComponent;
  label: string;
  desc?: JSX.Element;
  checked: boolean;
  onChange: (v: boolean) => void;
  disabled?: boolean;
  flush?: boolean;
}) {
  return (
    <SettingRow
      icon={props.icon}
      label={props.label}
      desc={props.desc}
      dim={props.disabled}
      flush={props.flush}
      control={
        <Switch
          checked={props.checked}
          onChange={props.onChange}
          label={props.label}
          disabled={props.disabled}
        />
      }
    />
  );
}

// The one option picker: a segmented button group for a small closed set (theme,
// language, timeouts, thresholds, …). Replaces both the old bespoke pill rows and
// native <select> dropdowns for fixed enumerations.
export function Segmented<T extends string | number>(props: {
  value: T;
  options: { value: T; label: string; icon?: IconComponent }[];
  onChange: (v: T) => void;
  ariaLabel?: string;
}) {
  return (
    <div class="setting-segmented" role="radiogroup" aria-label={props.ariaLabel}>
      <For each={props.options}>
        {(opt) => (
          <button
            type="button"
            role="radio"
            aria-checked={props.value === opt.value}
            class="setting-seg-option"
            classList={{ active: props.value === opt.value }}
            onClick={() => props.onChange(opt.value)}
          >
            <Show when={opt.icon}>
              {(icon) => {
                const Icon = icon();
                return <Icon size={15} strokeWidth={1.6} />;
              }}
            </Show>
            <span>{opt.label}</span>
          </button>
        )}
      </For>
    </div>
  );
}

// The one dropdown picker: a styled native <select> for choosing a single value
// from a list (timeouts, clipboard delay, thresholds, export format). Option values
// may be numbers — the typed value is preserved across the string round-trip.
export function Select<T extends string | number>(props: {
  value: T;
  options: { value: T; label: string }[];
  onChange: (v: T) => void;
  ariaLabel?: string;
}) {
  return (
    <select
      class="setting-select"
      aria-label={props.ariaLabel}
      value={String(props.value)}
      onChange={(e) => {
        const raw = e.currentTarget.value;
        const match = props.options.find((o) => String(o.value) === raw);
        if (match) props.onChange(match.value);
      }}
    >
      <For each={props.options}>{(o) => <option value={String(o.value)}>{o.label}</option>}</For>
    </select>
  );
}

// A labelled sub-field (a control revealed under an enabled toggle, e.g. an audit
// threshold). Label sits above the control, indented to align under the row text.
export function SettingSubField(props: { label: string; children: JSX.Element }) {
  return (
    <div class="setting-subfield">
      <span class="setting-subfield-label muted">{props.label}</span>
      {props.children}
    </div>
  );
}

// The one reset link, shared by every page that offers "restore defaults".
export function ResetButton(props: { label: string; onClick: () => void }) {
  return (
    <button type="button" class="setting-reset" onClick={() => props.onClick()}>
      <RotateCcw size={13} strokeWidth={1.75} /> {props.label}
    </button>
  );
}
