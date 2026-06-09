// Multi-select state for the vault list: the set of checked ids, the anchor row
// (fixed end of a shift/keyboard range) and the cursor row (moving end + keyboard
// focus). `onRowClick` handles mouse selection (shift extends a range over the
// *displayed* order, ctrl/cmd toggles one row, plain click opens the item).
// `handleListKeyDown` adds file-explorer keyboard nav, and `marqueeSelect` feeds
// the rubber-band box selection. Kept in a hook so the list, the bulk bar, the
// detail effect and the marquee all read/write one selection.

import { type Accessor, createMemo, createSignal } from 'solid-js';
import type { VaultItem } from '../lib/types.ts';
import { moveIndex, rangeBetween } from '../lib/listSelection.ts';

export function useVaultSelection(deps: {
  // The filtered list in render (sorted) order — range selection keys off it so
  // visual order and logical order never diverge.
  displayed: Accessor<VaultItem[]>;
  // Open a single item in the detail pane (a plain click / Enter selects to view).
  setSelectedId: (id: string | null) => void;
  // Closing the bulk bar's Move dropdown when the selection is cleared, so it
  // doesn't re-appear pre-expanded the next time items are selected.
  closeMoveMenu: () => void;
}) {
  // `anchor` = fixed end of a range; `cursor` = moving end + keyboard focus row.
  const [selectedIds, setSelectedIds] = createSignal<Set<string>>(new Set());
  const [anchorId, setAnchorId] = createSignal<string | null>(null);
  const [cursorId, setCursorId] = createSignal<string | null>(null);

  const selectedCount = createMemo(() => selectedIds().size);

  function clearSelection() {
    setSelectedIds(new Set<string>());
    setAnchorId(null);
    // The bulk bar stays mounted (hidden), so close its Move dropdown too —
    // otherwise it re-appears pre-expanded the next time items are selected.
    deps.closeMoveMenu();
  }

  // ---- mouse selection (single-click selects; modifiers multi-select) ----
  function onRowClick(item: VaultItem, e: MouseEvent) {
    const visible = deps.displayed();
    if (e.shiftKey) {
      const aId = anchorId() ?? cursorId();
      const aIdx = visible.findIndex((it) => it.id === aId);
      const cIdx = visible.findIndex((it) => it.id === item.id);
      if (aIdx !== -1 && cIdx !== -1) {
        const range = rangeBetween(visible, aIdx, cIdx).map((it) => it.id);
        // Ctrl+Shift adds the range to the existing selection; Shift alone replaces.
        const next = e.ctrlKey || e.metaKey ? new Set([...selectedIds(), ...range]) : new Set(range);
        setSelectedIds(next);
        if (!anchorId()) setAnchorId(aId ?? item.id);
        setCursorId(item.id);
        return;
      }
      // No usable anchor → fall through to a single select.
    }
    if (e.ctrlKey || e.metaKey) {
      const next = new Set(selectedIds());
      if (next.has(item.id)) next.delete(item.id);
      else next.add(item.id);
      setSelectedIds(next);
      setAnchorId(item.id);
      setCursorId(item.id);
      return;
    }
    // Plain click: open the item and reset multi-selection, but remember this row
    // as the anchor/cursor so a follow-up shift-click or arrow key ranges from it.
    clearSelection();
    deps.setSelectedId(item.id);
    setAnchorId(item.id);
    setCursorId(item.id);
  }

  function onCheckboxToggle(item: VaultItem, checked: boolean) {
    const next = new Set(selectedIds());
    if (checked) next.add(item.id);
    else next.delete(item.id);
    setSelectedIds(next);
    setAnchorId(item.id);
    setCursorId(item.id);
  }

  /** Select every visible (displayed) item — Ctrl+A and the empty-area menu. */
  function selectAll() {
    const ids = deps.displayed().map((it) => it.id);
    setSelectedIds(new Set(ids));
    setAnchorId(ids[0] ?? null);
    setCursorId(ids[ids.length - 1] ?? null);
  }

  // ---- marquee ("bungee") box selection ----
  // Replace the selection with `ids` (in displayed order). The marquee owner
  // (VaultList) computes the full set every pointermove — including any pre-drag
  // base when ctrl/shift is held — so a shrinking box correctly de-selects.
  function marqueeSelect(ids: string[]) {
    setSelectedIds(new Set(ids));
    if (ids.length > 0) {
      setAnchorId(ids[0]);
      setCursorId(ids[ids.length - 1]);
    } else {
      setAnchorId(null);
    }
  }

  // ---- file-explorer keyboard navigation (list-scoped) ----
  function handleListKeyDown(e: KeyboardEvent) {
    // Never hijack typing in a field (e.g. an inline editor inside the list).
    const t = e.target as HTMLElement | null;
    if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.isContentEditable)) return;

    const visible = deps.displayed();
    const ids = visible.map((it) => it.id);
    if (ids.length === 0) return;
    const curIdx = ids.indexOf(cursorId() ?? '');

    // Ctrl/Cmd+A — select everything visible.
    if ((e.ctrlKey || e.metaKey) && (e.key === 'a' || e.key === 'A')) {
      e.preventDefault();
      selectAll();
      return;
    }

    switch (e.key) {
      case 'ArrowDown':
      case 'ArrowUp':
      case 'Home':
      case 'End': {
        e.preventDefault();
        const nextIdx =
          e.key === 'Home'
            ? 0
            : e.key === 'End'
              ? ids.length - 1
              : moveIndex(curIdx, e.key === 'ArrowDown' ? 1 : -1, ids.length);
        const nextId = ids[nextIdx];
        if (!nextId) return;
        if (e.shiftKey) {
          let aIdx = ids.indexOf(anchorId() ?? '');
          if (aIdx < 0) {
            aIdx = curIdx >= 0 ? curIdx : nextIdx;
            setAnchorId(ids[aIdx] ?? nextId);
          }
          setSelectedIds(new Set(rangeBetween(visible, aIdx, nextIdx).map((it) => it.id)));
        } else {
          setSelectedIds(new Set([nextId]));
          setAnchorId(nextId);
        }
        setCursorId(nextId);
        return;
      }
      case ' ':
      case 'Spacebar': {
        e.preventDefault();
        const cid = cursorId();
        if (!cid) return;
        const next = new Set(selectedIds());
        if (next.has(cid)) next.delete(cid);
        else next.add(cid);
        setSelectedIds(next);
        setAnchorId(cid);
        return;
      }
      case 'Enter': {
        e.preventDefault();
        const cid = cursorId();
        if (!cid) return;
        clearSelection();
        deps.setSelectedId(cid);
        setAnchorId(cid);
        setCursorId(cid);
        return;
      }
      case 'Escape': {
        if (selectedIds().size > 0) {
          e.preventDefault();
          clearSelection();
        }
        return;
      }
    }
  }

  return {
    selectedIds,
    selectedCount,
    cursorId,
    clearSelection,
    selectAll,
    onRowClick,
    onCheckboxToggle,
    marqueeSelect,
    handleListKeyDown,
    isSelected: (id: string) => selectedIds().has(id),
  };
}

export type VaultSelection = ReturnType<typeof useVaultSelection>;
