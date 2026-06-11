// VaultListHeader integration for the custom-column config feature: a custom column
// renders its chosen icon + display label, its header menu offers "Configure
// column…" which opens the edit popover prefilled, and builtins offer no configure.
import { cleanup, render, fireEvent } from '@solidjs/testing-library';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import VaultListHeader from './VaultListHeader.tsx';
import { addCustomColumn, resetColumns } from '../state/columns.ts';

function renderHeader() {
  return render(() => (
    <VaultListHeader sortKey="name" sortDir="asc" onSort={() => undefined} onSetSort={() => undefined} />
  ));
}

const cellByLabel = (text: string) =>
  Array.from(document.querySelectorAll<HTMLElement>('.vault-head-resizable')).find(
    (c) => c.querySelector('.vault-head-label')?.textContent === text,
  );
const ctxItems = () => Array.from(document.querySelectorAll('.vault-ctx-item')).map((b) => b.textContent ?? '');

describe('VaultListHeader — custom column config', () => {
  beforeEach(() => {
    localStorage.clear();
    resetColumns();
  });
  afterEach(cleanup);

  it('renders a custom column with its display label + chosen icon', () => {
    addCustomColumn('env', { label: 'Environment', icon: 'tag' });
    renderHeader();
    const cell = cellByLabel('Environment');
    expect(cell).toBeTruthy();
    expect(cell!.querySelector('.vault-head-colicon')).toBeTruthy();
  });

  it('right-click → "Configure column…" opens the edit popover, prefilled + field fixed', () => {
    addCustomColumn('env', { label: 'Environment', icon: 'tag' });
    renderHeader();
    fireEvent.contextMenu(cellByLabel('Environment')!);
    const cfg = Array.from(document.querySelectorAll<HTMLButtonElement>('.vault-ctx-item')).find((b) =>
      b.textContent?.includes('Configure'),
    );
    expect(cfg).toBeTruthy();
    fireEvent.click(cfg!);

    expect(document.querySelector('.column-cfg-menu')).toBeTruthy();
    expect(document.querySelector('.column-cfg-field-name')?.textContent).toBe('env');
    expect(document.querySelector<HTMLInputElement>('.column-cfg-row input')?.value).toBe('Environment');
  });

  it('a builtin column header offers no Configure item', () => {
    renderHeader(); // defaults: [Name, username, website]
    // index 1 of the resizable cells = the first data column (a builtin).
    fireEvent.contextMenu(document.querySelectorAll<HTMLElement>('.vault-head-resizable')[1]);
    expect(ctxItems().some((t) => t.includes('Configure'))).toBe(false);
  });
});
