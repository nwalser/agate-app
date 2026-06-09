// Cross-component state for dragging vault items onto a folder in the left rail.
//
// The HTML5 DnD `dataTransfer` payload is NOT readable during `dragover` (only its
// `types` are), yet the folder tree must know the dragged items' owning accounts
// while hovering — a folder belongs to one account and only same-account items can
// move into it. So the drag source (VaultList) publishes the dragged set here and
// the drop target (useFolderTree) reads it. Cleared on drop / dragend.

import { createSignal } from 'solid-js';

/** MIME type stamped on the drag so folder rows can recognise an item drag. */
export const ITEM_DRAG_MIME = 'application/x-agate-items';

export interface DraggedItem {
  id: string;
  accountEmail: string;
}

const [draggedItems, setDraggedItemsSignal] = createSignal<DraggedItem[] | null>(null);
export { draggedItems };

export function setDraggedItems(items: DraggedItem[]) {
  setDraggedItemsSignal(items.length > 0 ? items : null);
}

export function clearDraggedItems() {
  setDraggedItemsSignal(null);
}
