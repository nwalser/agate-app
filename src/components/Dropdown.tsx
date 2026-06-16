// The ONE custom dropdown picker — a styled button + portaled listbox that
// replaces every native <select> in the app (the OS-drawn popup never matched
// the dark/square theme and clipped oddly inside the 380px tray). Keyboard- and
// screen-reader-accessible: combobox trigger + listbox/option roles, arrow/Home/
// End/typeahead navigation, click-outside + Esc to close. The menu renders in a
// Portal with fixed positioning (flips above when there's no room below) so it
// is never clipped by a scrolling form container.
//
// Generic over string | number values; the typed value is preserved (callers get
// back the original option value, not a stringified copy — numeric pickers rely
// on this). The shared Settings <Select> and the tray add-item / connection
// forms all funnel through here — one picker, one look.

import { For, Show, createEffect, createSignal, onCleanup } from 'solid-js';
import { Portal } from 'solid-js/web';
import { Check, ChevronDown } from 'lucide-solid';
import './Dropdown.css';

let uid = 0;

const MENU_MAX = 240; // px — cap the menu height, then it scrolls
const GAP = 4; // px between trigger and menu

export function Dropdown<T extends string | number>(props: {
  value: T;
  options: { value: T; label: string }[];
  onChange: (v: T) => void;
  ariaLabel?: string;
  class?: string;
  disabled?: boolean;
  placeholder?: string;
}) {
  const id = `dd-${(uid += 1)}`;
  const [open, setOpen] = createSignal(false);
  const [active, setActive] = createSignal(0);
  const [rect, setRect] = createSignal<DOMRect | null>(null);

  let triggerEl: HTMLButtonElement | undefined;
  let menuEl: HTMLDivElement | undefined;

  const selectedIndex = () => props.options.findIndex((o) => o.value === props.value);
  const selectedLabel = () => props.options[selectedIndex()]?.label ?? props.placeholder ?? '';

  const measure = () => {
    if (triggerEl) setRect(triggerEl.getBoundingClientRect());
  };

  const openMenu = () => {
    if (props.disabled || props.options.length === 0) return;
    measure();
    const sel = selectedIndex();
    setActive(sel >= 0 ? sel : 0);
    setOpen(true);
  };
  const closeMenu = () => {
    setOpen(false);
    triggerEl?.focus();
  };
  const choose = (i: number) => {
    const o = props.options[i];
    if (o) props.onChange(o.value);
    setOpen(false);
    triggerEl?.focus();
  };

  // Type-ahead: typing characters jumps to the first option that starts with the
  // accumulated buffer (matches native <select> behaviour). Buffer resets after a
  // short idle.
  let buf = '';
  let bufTimer: number | undefined;
  const typeahead = (ch: string) => {
    buf += ch.toLowerCase();
    if (bufTimer) clearTimeout(bufTimer);
    bufTimer = window.setTimeout(() => (buf = ''), 600);
    const idx = props.options.findIndex((o) => o.label.toLowerCase().startsWith(buf));
    if (idx >= 0) setActive(idx);
  };

  const onKeyDown = (e: KeyboardEvent) => {
    if (props.disabled) return;
    const n = props.options.length;
    if (!open()) {
      if (e.key === 'ArrowDown' || e.key === 'ArrowUp' || e.key === 'Enter' || e.key === ' ') {
        e.preventDefault();
        openMenu();
      }
      return;
    }
    switch (e.key) {
      case 'ArrowDown':
        e.preventDefault();
        setActive((i) => Math.min(n - 1, i + 1));
        break;
      case 'ArrowUp':
        e.preventDefault();
        setActive((i) => Math.max(0, i - 1));
        break;
      case 'Home':
        e.preventDefault();
        setActive(0);
        break;
      case 'End':
        e.preventDefault();
        setActive(n - 1);
        break;
      case 'Enter':
      case ' ':
        e.preventDefault();
        choose(active());
        break;
      case 'Escape':
        e.preventDefault();
        closeMenu();
        break;
      case 'Tab':
        setOpen(false);
        break;
      default:
        if (e.key.length === 1) typeahead(e.key);
    }
  };

  // Fixed-position style for the portaled menu: anchored to the trigger's current
  // rect, flipped above when the space below is too small.
  const menuStyle = () => {
    const r = rect();
    if (!r) return {};
    const below = window.innerHeight - r.bottom;
    const above = r.top;
    const flip = below < MENU_MAX && above > below;
    const maxH = Math.max(120, Math.min(MENU_MAX, (flip ? above : below) - GAP - 4));
    const base = { left: `${r.left}px`, width: `${r.width}px`, 'max-height': `${maxH}px` };
    return flip
      ? { ...base, bottom: `${window.innerHeight - r.top + GAP}px` }
      : { ...base, top: `${r.bottom + GAP}px` };
  };

  // While open: close on outside pointerdown, re-measure on scroll/resize so the
  // menu tracks the trigger. The effect's cleanup tears the listeners down when
  // open() flips back to false.
  createEffect(() => {
    if (!open()) return;
    const onPointer = (e: PointerEvent) => {
      const target = e.target as Node;
      if (triggerEl?.contains(target) || menuEl?.contains(target)) return;
      setOpen(false);
    };
    const onReflow = () => measure();
    document.addEventListener('pointerdown', onPointer, true);
    window.addEventListener('scroll', onReflow, true);
    window.addEventListener('resize', onReflow);
    onCleanup(() => {
      document.removeEventListener('pointerdown', onPointer, true);
      window.removeEventListener('scroll', onReflow, true);
      window.removeEventListener('resize', onReflow);
    });
  });

  // Keep the active option scrolled into view as the highlight moves.
  createEffect(() => {
    if (!open()) return;
    const el = menuEl?.children.item(active()) as HTMLElement | null;
    el?.scrollIntoView?.({ block: 'nearest' });
  });

  onCleanup(() => {
    if (bufTimer) clearTimeout(bufTimer);
  });

  return (
    <div class={`dropdown${props.class ? ` ${props.class}` : ''}`} classList={{ open: open() }}>
      <button
        ref={triggerEl}
        type="button"
        class="dropdown-trigger"
        role="combobox"
        aria-haspopup="listbox"
        aria-expanded={open()}
        aria-controls={id}
        aria-activedescendant={open() ? `${id}-opt-${active()}` : undefined}
        aria-label={props.ariaLabel}
        disabled={props.disabled}
        onClick={() => (open() ? closeMenu() : openMenu())}
        onKeyDown={onKeyDown}
      >
        <span class="dropdown-trigger-label">{selectedLabel()}</span>
        <ChevronDown size={15} class="dropdown-chevron" aria-hidden="true" />
      </button>
      <Show when={open()}>
        <Portal>
          <div
            ref={menuEl}
            id={id}
            class="dropdown-menu"
            role="listbox"
            aria-label={props.ariaLabel}
            style={menuStyle()}
          >
            <For each={props.options}>
              {(o, i) => (
                <div
                  id={`${id}-opt-${i()}`}
                  role="option"
                  class="dropdown-option"
                  classList={{ active: active() === i(), selected: o.value === props.value }}
                  aria-selected={o.value === props.value}
                  onPointerEnter={() => setActive(i())}
                  onClick={() => choose(i())}
                >
                  <span class="dropdown-option-label">{o.label}</span>
                  <Show when={o.value === props.value}>
                    <Check size={14} class="dropdown-option-check" aria-hidden="true" />
                  </Show>
                </div>
              )}
            </For>
          </div>
        </Portal>
      </Show>
    </div>
  );
}
