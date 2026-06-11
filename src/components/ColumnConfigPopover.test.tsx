import { cleanup, render, fireEvent } from '@solidjs/testing-library';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import ColumnConfigPopover from './ColumnConfigPopover.tsx';
import { addCustomColumn, columns, resetColumns } from '../state/columns.ts';

const custom = (field: string) => columns().columns.find((c) => c.kind === 'custom' && c.field === field);
const textInputs = () => Array.from(document.querySelectorAll<HTMLInputElement>('.column-cfg-row input'));

describe('ColumnConfigPopover', () => {
  beforeEach(() => {
    localStorage.clear();
    resetColumns();
  });
  afterEach(cleanup);

  it('create: adds a custom column with the chosen field, name and icon', () => {
    const onClose = vi.fn();
    render(() => <ColumnConfigPopover mode="create" suggestions={['Environment']} at={{ x: 10, y: 10 }} onClose={onClose} />);

    const [fieldInput, nameInput] = textInputs();
    fireEvent.input(fieldInput, { target: { value: 'Environment' } });
    fireEvent.input(nameInput, { target: { value: 'Env' } });
    fireEvent.click(document.querySelector<HTMLButtonElement>('.column-cfg-icon[title="Tag"]')!);
    fireEvent.click(document.querySelector<HTMLButtonElement>('.column-cfg-save')!);

    expect(custom('Environment')).toEqual({ kind: 'custom', field: 'Environment', label: 'Env', icon: 'tag' });
    expect(onClose).toHaveBeenCalled();
  });

  it('create: blank field disables submit (no column added)', () => {
    render(() => <ColumnConfigPopover mode="create" suggestions={[]} at={{ x: 10, y: 10 }} onClose={() => {}} />);
    expect(document.querySelector<HTMLButtonElement>('.column-cfg-save')!.disabled).toBe(true);
  });

  it('edit: updates label + icon of the existing column, field fixed', () => {
    addCustomColumn('env'); // existing column, no label/icon
    const onClose = vi.fn();
    render(() => (
      <ColumnConfigPopover mode="edit" field="env" at={{ x: 10, y: 10 }} onClose={onClose} />
    ));

    // Field is fixed (shown, not an input): only the Name input is editable.
    const inputs = textInputs();
    expect(inputs).toHaveLength(1);
    fireEvent.input(inputs[0], { target: { value: 'Environment' } });
    fireEvent.click(document.querySelector<HTMLButtonElement>('.column-cfg-icon[title="Key"]')!);
    fireEvent.click(document.querySelector<HTMLButtonElement>('.column-cfg-save')!);

    expect(custom('env')).toEqual({ kind: 'custom', field: 'env', label: 'Environment', icon: 'key' });
    expect(onClose).toHaveBeenCalled();
  });

  it('edit: prefills the current label + icon and can clear the icon', () => {
    addCustomColumn('env', { label: 'Environment', icon: 'tag' });
    render(() => (
      <ColumnConfigPopover mode="edit" field="env" label="Environment" icon="tag" at={{ x: 10, y: 10 }} onClose={() => {}} />
    ));
    expect(textInputs()[0].value).toBe('Environment');
    expect(document.querySelector('.column-cfg-icon[title="Tag"]')!.classList.contains('selected')).toBe(true);

    fireEvent.click(document.querySelector<HTMLButtonElement>('.column-cfg-icon[title="No icon"]')!);
    fireEvent.click(document.querySelector<HTMLButtonElement>('.column-cfg-save')!);
    expect(custom('env')).toEqual({ kind: 'custom', field: 'env', label: 'Environment' });
  });
});
