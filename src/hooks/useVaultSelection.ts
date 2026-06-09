// Multi-select state for the vault list: the set of checked ids plus the anchor
// row used for shift-range selection. `onRowClick` is the single click handler —
// shift extends a range over the *displayed* (sorted) order, ctrl/cmd toggles one
// row, and a plain click opens the item (clearing any multi-selection). Kept in a
// hook so the list, the bulk bar, and the detail effect all read one selection.

import { type Accessor, createMemo, createSignal } from 'solid-js';
import type { VaultItem } from '../lib/types.ts';

export function useVaultSelection(deps: {
  // The filtered list in render (sorted) order — shift-range selection keys off it
  // so visual order and logical order never diverge.
  displayed: Accessor<VaultItem[]>;
  // Open a single item in the detail pane (a plain click selects to view).
  setSelectedId: (id: string | null) => void;
  // Closing the bulk bar's Move dropdown when the selection is cleared, so it
  // doesn't re-appear pre-expanded the next time items are selected.
  closeMoveMenu: () => void;
}) {
  // Multi-select state. `anchor` is the last clicked row for shift-range select.
  const [selectedIds, setSelectedIds] = createSignal<Set<string>>(new Set());
  const [anchorId, setAnchorId] = createSignal<string | null>(null);

  const selectedCount = createMemo(() => selectedIds().size);

  function clearSelection() {
    setSelectedIds(new Set<string>());
    setAnchorId(null);
    // The bulk bar stays mounted (hidden), so close its Move dropdown too —
    // otherwise it re-appears pre-expanded the next time items are selected.
    deps.closeMoveMenu();
  }

  // ---- selection handling (single-click selects; modifiers multi-select) ----
  function onRowClick(item: VaultItem, e: MouseEvent) {
    const visible = deps.displayed();
    if (e.shiftKey && anchorId()) {
      const anchorIdx = visible.findIndex((it) => it.id === anchorId());
      const clickIdx = visible.findIndex((it) => it.id === item.id);
      if (anchorIdx !== -1 && clickIdx !== -1) {
        const [lo, hi] = anchorIdx < clickIdx ? [anchorIdx, clickIdx] : [clickIdx, anchorIdx];
        const next = new Set(selectedIds());
        for (let i = lo; i <= hi; i++) next.add(visible[i].id);
        setSelectedIds(next);
        return;
      }
    }
    if (e.ctrlKey || e.metaKey) {
      const next = new Set(selectedIds());
      if (next.has(item.id)) next.delete(item.id);
      else next.add(item.id);
      setSelectedIds(next);
      setAnchorId(item.id);
      return;
    }
    // Plain click: open the item and reset any multi-selection.
    clearSelection();
    deps.setSelectedId(item.id);
  }

  function onCheckboxToggle(item: VaultItem, checked: boolean) {
    const next = new Set(selectedIds());
    if (checked) next.add(item.id);
    else next.delete(item.id);
    setSelectedIds(next);
    setAnchorId(item.id);
  }

  return {
    selectedIds,
    selectedCount,
    clearSelection,
    onRowClick,
    onCheckboxToggle,
    isSelected: (id: string) => selectedIds().has(id),
  };
}

export type VaultSelection = ReturnType<typeof useVaultSelection>;
