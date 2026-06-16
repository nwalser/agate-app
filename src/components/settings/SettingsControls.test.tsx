// Unit tests for the shared Settings controls. These are the ONE switch + ONE
// option picker used on every Settings page, so their behaviour (click toggles,
// click selects, aria reflects state) is the contract every page relies on.

import { cleanup, fireEvent, render, screen } from '@solidjs/testing-library';
import { createSignal } from 'solid-js';
import { afterEach, describe, expect, it } from 'vitest';
import { Select, Switch, ToggleRow } from './SettingsControls.tsx';

describe('Switch', () => {
  afterEach(cleanup);

  it('reflects checked state in aria-checked and flips it on click', () => {
    const [on, setOn] = createSignal(false);
    render(() => <Switch checked={on()} onChange={setOn} label="Test" />);
    const sw = document.querySelector<HTMLElement>('.setting-switch')!;
    expect(sw.getAttribute('aria-checked')).toBe('false');
    fireEvent.click(sw);
    expect(on()).toBe(true);
    expect(sw.getAttribute('aria-checked')).toBe('true');
  });

  it('does not fire onChange when disabled', () => {
    let calls = 0;
    render(() => <Switch checked={false} onChange={() => (calls += 1)} label="Test" disabled />);
    const sw = document.querySelector<HTMLButtonElement>('.setting-switch')!;
    expect(sw.disabled).toBe(true);
    fireEvent.click(sw);
    expect(calls).toBe(0);
  });
});

describe('ToggleRow', () => {
  afterEach(cleanup);

  it('renders label + description and toggles via its switch', () => {
    const [on, setOn] = createSignal(true);
    render(() => (
      <ToggleRow label="Auto check" desc="Look each launch" checked={on()} onChange={setOn} />
    ));
    expect(document.querySelector('.setting-row-label')!.textContent).toBe('Auto check');
    expect(document.querySelector('.setting-row-desc')!.textContent).toContain('Look each launch');
    fireEvent.click(document.querySelector('.setting-switch')!);
    expect(on()).toBe(false);
  });
});

describe('Select', () => {
  afterEach(cleanup);

  it('reflects the selected value and reports the typed (numeric) value on change', async () => {
    const [v, setV] = createSignal(5);
    render(() => (
      <Select
        value={v()}
        onChange={setV}
        ariaLabel="threshold"
        options={[
          { value: 5, label: 'Five' },
          { value: 15, label: 'Fifteen' },
          { value: 60, label: 'Sixty' },
        ]}
      />
    ));
    // The trigger shows the selected option's label, not its raw value.
    const trigger = screen.getByRole('combobox', { name: 'threshold' });
    expect(trigger.textContent).toContain('Five');
    // Open the menu and pick "Sixty".
    fireEvent.click(trigger);
    fireEvent.click(await screen.findByRole('option', { name: 'Sixty' }));
    // onChange must hand back the original number, not the stringified option value.
    expect(v()).toBe(60);
    expect(typeof v()).toBe('number');
    expect(trigger.textContent).toContain('Sixty');
  });
});
