// A thin vertical drag handle for resizing a pane by its right edge: drag to set a
// new width, double-click to reset. Mirrors the vault list's column resizer
// (VaultListHeader's ColResize) and captures the pointer so the drag tracks
// smoothly. Width is computed as pointerX − the handle's parent's left edge, so the
// handle must be rendered inside (or pinned to) an element whose left edge is the
// resized pane's left edge:
//   * sidebar  → child of the rail's flex parent, pinned at `left: var(--sidebar-width)`
//   * item list → child of the list pane itself, pinned at its right edge
// The variant class selects the positioning; this component only owns the drag.

export default function Resizer(props: {
  /** Positioning variant, e.g. 'sidebar-resizer' or 'list-resizer'. */
  variant: string;
  /** Apply the dragged width (px). The setter clamps + persists. */
  onResize: (px: number) => void;
  /** Reset to the default width (double-click). */
  onReset?: () => void;
  label?: string;
}) {
  // The parent container's left edge in viewport px, captured at drag start. The
  // resized pane starts at this same x, so width = pointerX − originLeft.
  let originLeft = 0;

  function onMove(e: PointerEvent) {
    props.onResize(e.clientX - originLeft);
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
      class={`resizer ${props.variant}`}
      role="separator"
      aria-orientation="vertical"
      aria-label={props.label ?? 'Resize'}
      onPointerDown={onDown}
      onDblClick={() => props.onReset?.()}
    />
  );
}
