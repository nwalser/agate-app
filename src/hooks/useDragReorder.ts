// Reusable drag-to-reorder wiring for vertical lists (column menu, sidebar
// settings, the nav rail). Only the grip returned by `handleProps` is draggable —
// NOT the whole row — so the row's own buttons (hide / reveal / move) keep getting
// plain clicks instead of being swallowed by a row-level drag (the bug that made
// columns feel un-hideable). The drop position is a gap in [0, count]; the caller
// paints an insert line from `gap()` and the hook calls `onReorder(from, to)` with
// the array index `to` already corrected for the removed row. Pure math + its tests
// live in lib/reorder.ts.
//
// Both factories take the row's reactive index accessor (the one `<For>` hands its
// callback), read at event time — so a row keeps the right index after the list
// reorders, exactly as inline handlers reading `i()` would.

import { type Accessor, createSignal } from 'solid-js';
import { gapFromRow, gapToIndex } from '../lib/reorder.ts';

/** Marker attribute the hook stamps on each row so a grip can find its row element
 *  (to use as the drag image). Exposed for tests/markup that need the selector. */
export const REORDER_ROW_ATTR = 'data-reorder-row';

export interface DragReorder {
  /** Index of the row currently being dragged, or null when idle. */
  dragIndex: () => number | null;
  /** Insertion gap in [0, count] the drop would land in, or null when idle. */
  gap: () => number | null;
  /** Spread onto the drag-handle grip inside a row (pass the row's `<For>` index). */
  handleProps: (index: Accessor<number>) => {
    draggable: true;
    onDragStart: (e: DragEvent) => void;
    onDragEnd: () => void;
  };
  /** Spread onto each reorderable row element (pass the row's `<For>` index). */
  rowProps: (index: Accessor<number>) => {
    [REORDER_ROW_ATTR]: true;
    onDragOver: (e: DragEvent) => void;
    onDrop: (e: DragEvent) => void;
  };
}

export function useDragReorder(opts: { onReorder: (from: number, to: number) => void }): DragReorder {
  const [dragIndex, setDragIndex] = createSignal<number | null>(null);
  const [gap, setGap] = createSignal<number | null>(null);

  function reset() {
    setDragIndex(null);
    setGap(null);
  }

  return {
    dragIndex,
    gap,
    handleProps: (index) => ({
      draggable: true,
      onDragStart: (e) => {
        const i = index();
        setDragIndex(i);
        setGap(i); // dropping where it started is a no-op
        if (e.dataTransfer) {
          e.dataTransfer.effectAllowed = 'move';
          e.dataTransfer.setData('text/plain', String(i));
          // Drag the whole row, not the tiny grip, for a legible drag image.
          const row = (e.currentTarget as HTMLElement).closest(`[${REORDER_ROW_ATTR}]`);
          if (row instanceof HTMLElement) {
            const r = row.getBoundingClientRect();
            e.dataTransfer.setDragImage(row, e.clientX - r.left, e.clientY - r.top);
          }
        }
      },
      onDragEnd: reset,
    }),
    rowProps: (index) => ({
      [REORDER_ROW_ATTR]: true,
      onDragOver: (e) => {
        if (dragIndex() === null) return; // ignore foreign drags (e.g. item→folder)
        e.preventDefault();
        if (e.dataTransfer) e.dataTransfer.dropEffect = 'move';
        const r = (e.currentTarget as HTMLElement).getBoundingClientRect();
        setGap(gapFromRow(index(), r.top, r.height, e.clientY));
      },
      onDrop: (e) => {
        const from = dragIndex();
        const g = gap();
        if (from === null || g === null) return;
        e.preventDefault();
        reset();
        const to = gapToIndex(from, g);
        if (to !== from) opts.onReorder(from, to);
      },
    }),
  };
}
