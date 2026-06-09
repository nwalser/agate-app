// A thin drag handle pinned to a left sidebar's right edge: drag to resize the
// shared sidebar width, double-click to reset it to the default. Mirrors the vault
// list's column resizer (VaultListHeader's ColResize) and captures the pointer so
// the drag tracks smoothly. Render it as a child of the sidebar's flex parent (the
// element whose left edge the sidebar starts at) — it positions itself at the seam
// via `left: var(--sidebar-width)`, so it must not live inside the scrolling rail.

import { resetSidebarWidth, setSidebarWidth } from '../state/ui.ts';

export default function SidebarResizer() {
  // The parent container's left edge in viewport px, captured at drag start. The
  // sidebar starts at this same x, so width = pointerX − originLeft.
  let originLeft = 0;

  function onMove(e: PointerEvent) {
    setSidebarWidth(e.clientX - originLeft);
  }
  function onUp(e: PointerEvent) {
    const h = e.currentTarget as HTMLElement;
    h.releasePointerCapture(e.pointerId);
    h.removeEventListener('pointermove', onMove);
    h.removeEventListener('pointerup', onUp);
    document.body.classList.remove('is-resizing');
  }
  function onDown(e: PointerEvent) {
    e.preventDefault();
    const h = e.currentTarget as HTMLElement;
    const container = h.parentElement;
    if (!container) return;
    originLeft = container.getBoundingClientRect().left;
    h.setPointerCapture(e.pointerId);
    h.addEventListener('pointermove', onMove);
    h.addEventListener('pointerup', onUp);
    document.body.classList.add('is-resizing');
  }

  return (
    <div
      class="sidebar-resizer"
      role="separator"
      aria-orientation="vertical"
      aria-label="Resize sidebar"
      onPointerDown={onDown}
      onDblClick={() => resetSidebarWidth()}
    />
  );
}
