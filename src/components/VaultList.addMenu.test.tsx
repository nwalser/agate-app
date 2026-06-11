// Regression: the "+" add-column popover is <Portal>ed to <body>, but Solid routes
// DELEGATED events (pointerdown) up the COMPONENT tree — so a pointerdown on a chip
// reaches the list's marquee handler on `.vault-table`. That handler must NOT treat
// a portaled-menu pointerdown as an empty-space marquee drag, which focuses the
// table + pointer-captures it and SWALLOWS the chip/Reset click. User-visible bug:
// clicking a chip or "Reset columns" in the running app does nothing.
//
// jsdom has no layout, so the marquee handler's scrollbar-gutter guard
// (`offsetX >= clientWidth`, i.e. `0 >= 0`) bails early and hides the bug. We stub a
// real clientWidth/Height on the table so the handler runs the way it does in a
// real WebView, then assert a portaled-chip pointerdown never starts a marquee.
import { cleanup, render, fireEvent } from '@solidjs/testing-library';
// A primary-button pointerdown the marquee handler will actually act on. jsdom's
// synthetic pointer events don't reliably carry `button`/`pointerId`, so we build
// one explicitly and let it bubble (DOM) to Solid's delegated `pointerdown`.
function primaryPointerDown(target: Element) {
  const ev = new Event('pointerdown', { bubbles: true, cancelable: true });
  Object.defineProperty(ev, 'button', { value: 0 });
  Object.defineProperty(ev, 'pointerId', { value: 1 });
  target.dispatchEvent(ev);
}
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import VaultList from './VaultList.tsx';
import { columns, resetColumns } from '../state/columns.ts';
import { createDetailCache } from '../state/detailCache.ts';
import { makeItem } from '../testing/factories.ts';

function renderList() {
  return render(() => (
    <VaultList
      items={[makeItem({ id: 'i1', name: 'Example', accountEmail: 'a@b.c', username: 'user', uri: 'https://example.com' })]}
      folders={[]}
      sortKey="name"
      sortDir="asc"
      onSort={() => undefined}
      onSetSort={() => undefined}
      selectedId={null}
      selectedCount={0}
      isSelected={() => false}
      cursorId={null}
      onRowClick={() => undefined}
      onRowContextMenu={() => undefined}
      onCheckboxToggle={() => undefined}
      onCopyCell={() => undefined}
      onOpenWebsite={() => undefined}
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

const ids = () => columns().columns.map((c) => (c.kind === 'builtin' ? c.id : `custom:${c.field}`));
const openAddMenu = () => fireEvent.click(document.querySelector<HTMLButtonElement>('[title="Add column"]')!);
const chip = (label: string) =>
  Array.from(document.querySelectorAll<HTMLButtonElement>('.column-add-chip')).find((c) =>
    c.textContent?.includes(label),
  )!;

// Give the table a non-zero layout + a no-throw pointer-capture so the marquee
// handler runs exactly as it would in a real WebView.
function primeTable(): { table: HTMLElement; capture: ReturnType<typeof vi.fn> } {
  const table = document.querySelector<HTMLElement>('.vault-table')!;
  Object.defineProperty(table, 'clientWidth', { configurable: true, value: 800 });
  Object.defineProperty(table, 'clientHeight', { configurable: true, value: 600 });
  const capture = vi.fn();
  table.setPointerCapture = capture as unknown as typeof table.setPointerCapture;
  return { table, capture };
}

describe('VaultList — portaled add-column menu vs. the marquee handler', () => {
  beforeEach(() => {
    localStorage.clear();
    resetColumns(); // [username, website]
  });
  afterEach(cleanup);

  it('positive control: pointerdown on empty table space DOES start a marquee', () => {
    renderList();
    const { capture } = primeTable();
    primaryPointerDown(document.querySelector<HTMLElement>('.vault-rows')!);
    expect(capture).toHaveBeenCalled();
  });

  it('pointerdown on an add-menu chip does NOT start a table marquee', () => {
    renderList();
    const { capture } = primeTable();
    openAddMenu();
    primaryPointerDown(chip('Folder'));
    expect(capture).not.toHaveBeenCalled();
  });

  it('a realistic pointerdown+click on a chip adds the column', () => {
    renderList();
    primeTable();
    openAddMenu();
    const folder = chip('Folder');
    primaryPointerDown(folder);
    fireEvent.click(folder);
    expect(ids()).toContain('folder');
  });
});
