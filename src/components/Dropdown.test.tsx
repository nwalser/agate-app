// Unit tests for the shared custom <Dropdown> — the one picker that replaced
// every native <select>. Covers the contract the rest of the app relies on:
// the trigger shows the selected label, pointer + keyboard both select and
// return the ORIGINAL typed value (numbers stay numbers), typeahead jumps,
// and the menu closes on Escape / outside click.

import { cleanup, fireEvent, render, screen } from '@solidjs/testing-library';
import { createSignal } from 'solid-js';
import { afterEach, describe, expect, it } from 'vitest';
import { Dropdown } from './Dropdown.tsx';

const NUM_OPTS = [
  { value: 5, label: 'Five' },
  { value: 15, label: 'Fifteen' },
  { value: 60, label: 'Sixty' },
];

function renderNumeric(initial = 5) {
  const [v, setV] = createSignal(initial);
  render(() => (
    <Dropdown value={v()} onChange={setV} ariaLabel="threshold" options={NUM_OPTS} />
  ));
  return { value: v };
}

describe('Dropdown', () => {
  afterEach(cleanup);

  it('shows the selected option label on the trigger', () => {
    renderNumeric(15);
    expect(screen.getByRole('combobox', { name: 'threshold' }).textContent).toContain('Fifteen');
  });

  it('opens on click and selecting an option returns the original typed value', async () => {
    const { value } = renderNumeric(5);
    const trigger = screen.getByRole('combobox', { name: 'threshold' });
    // Closed: no listbox yet.
    expect(screen.queryByRole('listbox')).toBeNull();
    fireEvent.click(trigger);
    fireEvent.click(await screen.findByRole('option', { name: 'Sixty' }));
    expect(value()).toBe(60);
    expect(typeof value()).toBe('number');
    // Closed again, label updated.
    expect(screen.queryByRole('listbox')).toBeNull();
    expect(trigger.textContent).toContain('Sixty');
  });

  it('marks the active and selected options for assistive tech', async () => {
    renderNumeric(5);
    fireEvent.click(screen.getByRole('combobox', { name: 'threshold' }));
    const selected = await screen.findByRole('option', { name: 'Five' });
    expect(selected.getAttribute('aria-selected')).toBe('true');
    const other = screen.getByRole('option', { name: 'Sixty' });
    expect(other.getAttribute('aria-selected')).toBe('false');
  });

  it('navigates with the keyboard: ArrowDown then Enter picks the next option', async () => {
    const { value } = renderNumeric(5);
    const trigger = screen.getByRole('combobox', { name: 'threshold' });
    // ArrowDown opens (active = current = "Five"); a second moves to "Fifteen".
    fireEvent.keyDown(trigger, { key: 'ArrowDown' });
    await screen.findByRole('listbox');
    fireEvent.keyDown(trigger, { key: 'ArrowDown' });
    fireEvent.keyDown(trigger, { key: 'Enter' });
    expect(value()).toBe(15);
    expect(screen.queryByRole('listbox')).toBeNull();
  });

  it('type-ahead jumps to the first matching option', async () => {
    const { value } = renderNumeric(5);
    const trigger = screen.getByRole('combobox', { name: 'threshold' });
    fireEvent.click(trigger);
    await screen.findByRole('listbox');
    fireEvent.keyDown(trigger, { key: 's' }); // → "Sixty"
    fireEvent.keyDown(trigger, { key: 'Enter' });
    expect(value()).toBe(60);
  });

  it('Escape closes without changing the value', async () => {
    const { value } = renderNumeric(5);
    const trigger = screen.getByRole('combobox', { name: 'threshold' });
    fireEvent.click(trigger);
    await screen.findByRole('listbox');
    fireEvent.keyDown(trigger, { key: 'Escape' });
    expect(screen.queryByRole('listbox')).toBeNull();
    expect(value()).toBe(5);
  });

  it('closes when a pointer goes down outside the menu', async () => {
    render(() => (
      <>
        <button type="button">outside</button>
        <Dropdown value={'a'} onChange={() => {}} ariaLabel="letters" options={[
          { value: 'a', label: 'Alpha' },
          { value: 'b', label: 'Bravo' },
        ]} />
      </>
    ));
    fireEvent.click(screen.getByRole('combobox', { name: 'letters' }));
    await screen.findByRole('listbox');
    fireEvent.pointerDown(screen.getByText('outside'));
    expect(screen.queryByRole('listbox')).toBeNull();
  });

  it('does not open when there are no options', () => {
    render(() => <Dropdown value={''} onChange={() => {}} ariaLabel="empty" options={[]} />);
    fireEvent.click(screen.getByRole('combobox', { name: 'empty' }));
    expect(screen.queryByRole('listbox')).toBeNull();
  });
});
