// AddColumnMenu: the discovered custom-field picker. The store is seeded directly
// (setCustomFields) so no IPC is needed — the menu's onMount refresh still fires but
// fails harmlessly in jsdom and leaves the seeded list in place.
import { cleanup, render, fireEvent } from '@solidjs/testing-library';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import AddColumnMenu from './AddColumnMenu.tsx';
import { addCustomColumn, columns, resetColumns } from '../state/columns.ts';
import { setCustomFields } from '../state/customFields.ts';

const custom = (field: string) => columns().columns.find((c) => c.kind === 'custom' && c.field === field);
const fieldRows = () => Array.from(document.querySelectorAll<HTMLButtonElement>('.column-add-field'));
const rowText = () => fieldRows().map((b) => b.textContent?.trim());

function renderMenu(onNewCustom = vi.fn(), onClose = vi.fn()) {
  render(() => <AddColumnMenu onClose={onClose} onNewCustom={onNewCustom} />);
  return { onNewCustom, onClose };
}

describe('AddColumnMenu — discovered custom fields', () => {
  beforeEach(() => {
    localStorage.clear();
    resetColumns();
    setCustomFields(['Environment', 'PIN', 'Recovery Code']);
  });
  afterEach(() => {
    cleanup();
    setCustomFields([]);
  });

  it('lists discovered fields and quick-adds the chosen one', () => {
    renderMenu();
    expect(rowText()).toEqual(['Environment', 'PIN', 'Recovery Code']);
    fireEvent.click(fieldRows().find((b) => b.textContent?.includes('PIN'))!);
    expect(custom('PIN')).toEqual({ kind: 'custom', field: 'PIN' });
  });

  it('excludes fields already shown as a column', () => {
    addCustomColumn('Environment');
    renderMenu();
    expect(rowText()).toEqual(['PIN', 'Recovery Code']);
  });

  it('the search box filters the discovered list (exact match hides the "Add" fallback)', () => {
    renderMenu();
    fireEvent.input(document.querySelector<HTMLInputElement>('.column-add-search input')!, {
      target: { value: 'PIN' },
    });
    expect(rowText()).toEqual(['PIN']);
  });

  it('a partial search still offers an "Add <typed>" escape hatch alongside matches', () => {
    renderMenu();
    fireEvent.input(document.querySelector<HTMLInputElement>('.column-add-search input')!, {
      target: { value: 'Rec' },
    });
    expect(rowText()).toEqual(['Recovery Code', 'Add “Rec”']);
  });

  it('offers an "Add <typed>" fallback for an un-scanned field name', () => {
    renderMenu();
    fireEvent.input(document.querySelector<HTMLInputElement>('.column-add-search input')!, {
      target: { value: 'Brand New' },
    });
    const rows = fieldRows();
    expect(rows).toHaveLength(1);
    expect(rows[0].textContent).toContain('Brand New');
    fireEvent.click(rows[0]);
    expect(custom('Brand New')).toEqual({ kind: 'custom', field: 'Brand New' });
  });

  it('"Add custom column…" opens the create popover and closes the menu', () => {
    const { onNewCustom, onClose } = renderMenu();
    fireEvent.click(document.querySelector<HTMLButtonElement>('.column-add-newcustom')!);
    expect(onNewCustom).toHaveBeenCalledWith(expect.objectContaining({ x: expect.any(Number), y: expect.any(Number) }));
    expect(onClose).toHaveBeenCalled();
  });
});
