// Regression test: clicking a value cell in the column (table) view copies that
// cell's value, and does NOT bubble to the row (which would select/open the item).
// Captures the "copy by clicking on cell does not work" bug — previously only a
// tiny hover button copied; the cell body was inert and just selected the row.

import { cleanup, fireEvent, render } from '@solidjs/testing-library';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import VaultList from './VaultList.tsx';
import { resetColumns } from '../state/columns.ts';
import { createDetailCache } from '../state/detailCache.ts';
import { makeItem } from '../testing/factories.ts';
import type { ColumnSpec } from '../state/columnConfig.ts';
import type { VaultItem } from '../lib/types.ts';

const login = (over: Partial<VaultItem> = {}): VaultItem =>
  makeItem({
    id: 'i1',
    name: 'Example',
    accountEmail: 'a@b.c',
    accountLabel: 'Cloud',
    username: 'user',
    uri: 'https://example.com',
    ...over,
  });

function renderList(
  items: VaultItem[],
  handlers: {
    onCopyCell?: (i: VaultItem, c: ColumnSpec) => void;
    onOpenWebsite?: (i: VaultItem) => void;
    onRowClick?: () => void;
  } = {},
) {
  return render(() => (
    <VaultList
      items={items}
      folders={[]}
      sortKey="name"
      sortDir="asc"
      onSort={() => undefined}
      onSetSort={() => undefined}
      selectedId={null}
      selectedCount={0}
      isSelected={() => false}
      cursorId={null}
      onRowClick={handlers.onRowClick ?? (() => undefined)}
      onRowContextMenu={() => undefined}
      onCheckboxToggle={() => undefined}
      onCopyCell={handlers.onCopyCell ?? (() => undefined)}
      onOpenWebsite={handlers.onOpenWebsite ?? (() => undefined)}
      onListKeyDown={() => undefined}
      onMarqueeSelect={() => undefined}
      enableItemDrag={false}
      onCreateItem={() => undefined}
      onSelectAll={() => undefined}
      emptyMessage="empty"
      cacheToken={0}
      security={null}
      detailCache={createDetailCache()}
    />
  ));
}

describe('VaultList — click cell to copy', () => {
  beforeEach(() => {
    localStorage.clear();
    resetColumns(); // defaults: [username, website] columns
  });
  afterEach(cleanup);

  it('copies the cell value when the cell body is clicked', () => {
    const onCopyCell = vi.fn();
    renderList([login({ id: 'r1' })], { onCopyCell });
    const row = document.querySelector('[data-item-id="r1"]')!;
    const cell = row.querySelector('.vault-cell-copyable')!; // the username cell
    expect(cell).toBeTruthy();
    fireEvent.click(cell);
    expect(onCopyCell).toHaveBeenCalledTimes(1);
  });

  it('does not select/open the row when copying a cell (stops propagation)', () => {
    const onRowClick = vi.fn();
    renderList([login({ id: 'r1' })], { onRowClick });
    const cell = document.querySelector('[data-item-id="r1"] .vault-cell-copyable')!;
    fireEvent.click(cell);
    expect(onRowClick).not.toHaveBeenCalled();
  });

  it('leaves non-value cells (no copyable value) inert', () => {
    // A login with no username → that cell carries no copyable value.
    const onCopyCell = vi.fn();
    renderList([login({ id: 'r1', username: null, uri: null })], { onCopyCell });
    const row = document.querySelector('[data-item-id="r1"]')!;
    expect(row.querySelector('.vault-cell-copyable')).toBeNull();
  });
});

describe('VaultList — website column', () => {
  beforeEach(() => {
    localStorage.clear();
    resetColumns(); // defaults: [username, website] columns
  });
  afterEach(cleanup);

  it('shows only the site host (drops scheme + path/query)', () => {
    renderList([login({ id: 'r1', uri: 'https://www.github.com/login?x=1' })]);
    const cell = document.querySelector('[data-item-id="r1"] .vault-cell-link .vault-cell-val')!;
    expect(cell.textContent).toBe('www.github.com');
  });

  it('opens the website when the cell is clicked (not copy, no row select)', () => {
    const onOpenWebsite = vi.fn();
    const onCopyCell = vi.fn();
    const onRowClick = vi.fn();
    renderList([login({ id: 'r1' })], { onOpenWebsite, onCopyCell, onRowClick });
    const cell = document.querySelector('[data-item-id="r1"] .vault-cell-link')!;
    fireEvent.click(cell);
    expect(onOpenWebsite).toHaveBeenCalledTimes(1);
    expect(onOpenWebsite.mock.calls[0][0].id).toBe('r1');
    expect(onCopyCell).not.toHaveBeenCalled();
    expect(onRowClick).not.toHaveBeenCalled();
  });

  it('leaves the website cell inert when the row has no URI', () => {
    renderList([login({ id: 'r1', uri: null })]);
    expect(document.querySelector('[data-item-id="r1"] .vault-cell-link')).toBeNull();
  });
});
