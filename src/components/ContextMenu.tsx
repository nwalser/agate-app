// Reusable right-click context menu: a full-viewport backdrop (closes on click /
// right-click) plus a positioned menu box clamped to the viewport, closing on
// Escape too. Reuses the global .vault-ctx / .vault-menu-backdrop classes (from
// Vault.css) that the item-row and folder menus already use, so every menu in the
// app looks and behaves identically. Callers hold an `{ x, y, … }` signal and
// render `<ContextMenu x y onClose>` with `CtxItem` / `CtxSep` / `CtxTitle` inside.

import { type JSX, createEffect, createSignal, onCleanup, onMount } from 'solid-js';

export function ContextMenu(props: { x: number; y: number; onClose: () => void; children: JSX.Element }) {
  let el: HTMLDivElement | undefined;
  const [pos, setPos] = createSignal({ x: props.x, y: props.y });

  // Re-clamp whenever the requested position changes (a fresh right-click can
  // reposition the same open menu). Width/height are position-independent, so
  // measuring the live element is safe even before it's moved.
  createEffect(() => {
    const px = props.x;
    const py = props.y;
    const r = el?.getBoundingClientRect();
    let x = px;
    let y = py;
    if (r) {
      if (x + r.width > window.innerWidth - 8) x = Math.max(8, window.innerWidth - r.width - 8);
      if (y + r.height > window.innerHeight - 8) y = Math.max(8, window.innerHeight - r.height - 8);
    }
    setPos({ x, y });
  });

  function onKey(e: KeyboardEvent) {
    if (e.key === 'Escape') {
      e.preventDefault();
      props.onClose();
    }
  }
  onMount(() => document.addEventListener('keydown', onKey));
  onCleanup(() => document.removeEventListener('keydown', onKey));

  return (
    <>
      <div
        class="vault-menu-backdrop"
        onClick={() => props.onClose()}
        onContextMenu={(e) => {
          e.preventDefault();
          props.onClose();
        }}
      />
      <div
        ref={(node) => (el = node)}
        class="vault-ctx"
        role="menu"
        style={{ left: pos().x + 'px', top: pos().y + 'px' }}
      >
        {props.children}
      </div>
    </>
  );
}

export function CtxItem(props: {
  onClick: () => void;
  danger?: boolean;
  disabled?: boolean;
  children: JSX.Element;
}) {
  return (
    <button
      class="vault-ctx-item"
      classList={{ danger: props.danger }}
      disabled={props.disabled}
      role="menuitem"
      onClick={() => props.onClick()}
    >
      {props.children}
    </button>
  );
}

export function CtxSep() {
  return <div class="vault-ctx-sep" />;
}

export function CtxTitle(props: { children: JSX.Element }) {
  return <div class="vault-ctx-title">{props.children}</div>;
}
