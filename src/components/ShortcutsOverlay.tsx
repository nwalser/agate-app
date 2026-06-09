// Keyboard-shortcut cheat sheet. Press `?` (Shift+/) anywhere outside a text
// field to open it; Esc or a backdrop click closes it. Self-contained: it owns
// its open-state and its own global key listener, so it can be dropped into
// App.tsx without threading anything through the screens. The listed bindings
// mirror the handlers in Vault.tsx (list nav, history) and the titlebar (search,
// command palette).

import { createSignal, For, onCleanup, onMount, Show } from 'solid-js';
import { Keyboard, X } from 'lucide-solid';
import './ShortcutsOverlay.css';

// macOS shows ⌘ for the palette modifier; everything else shows Ctrl.
const IS_MAC =
  typeof navigator !== 'undefined' &&
  (/Mac/.test(navigator.platform) || /Mac OS X/.test(navigator.userAgent));
const MOD = IS_MAC ? '⌘' : 'Ctrl';

interface Shortcut {
  keys: string[];
  label: string;
}

const GROUPS: { title: string; shortcuts: Shortcut[] }[] = [
  {
    title: 'Navigation',
    shortcuts: [
      { keys: [MOD, 'K'], label: 'Command palette' },
      { keys: ['↑', '↓'], label: 'Move selection' },
      { keys: ['Home', 'End'], label: 'First / last item' },
      { keys: ['Alt', '←'], label: 'Back' },
      { keys: ['Alt', '→'], label: 'Forward' },
    ],
  },
  {
    title: 'Search',
    shortcuts: [
      { keys: ['Type'], label: 'Filter the vault list' },
      { keys: ['/'], label: 'Run a command from search' },
    ],
  },
  {
    title: 'General',
    shortcuts: [
      { keys: ['?'], label: 'This shortcut help' },
      { keys: ['Esc'], label: 'Close menu / overlay' },
    ],
  },
];

function isTypingTarget(e: KeyboardEvent): boolean {
  const t = e.target as HTMLElement | null;
  if (!t) return false;
  return (
    t.tagName === 'INPUT' ||
    t.tagName === 'TEXTAREA' ||
    t.tagName === 'SELECT' ||
    t.isContentEditable
  );
}

export default function ShortcutsOverlay() {
  const [open, setOpen] = createSignal(false);

  function onKeyDown(e: KeyboardEvent) {
    if (e.key === 'Escape' && open()) {
      setOpen(false);
      return;
    }
    // `?` is Shift+/ on most layouts; ignore while typing or with other modifiers.
    if (e.key === '?' && !e.ctrlKey && !e.metaKey && !e.altKey && !isTypingTarget(e)) {
      e.preventDefault();
      setOpen((v) => !v);
    }
  }

  onMount(() => document.addEventListener('keydown', onKeyDown));
  onCleanup(() => document.removeEventListener('keydown', onKeyDown));

  return (
    <Show when={open()}>
      <div class="shortcuts-backdrop" onClick={() => setOpen(false)}>
        <div class="shortcuts-card" role="dialog" aria-label="Keyboard shortcuts" onClick={(e) => e.stopPropagation()}>
          <div class="shortcuts-head">
            <span class="shortcuts-title">
              <Keyboard size={15} strokeWidth={1.75} /> Keyboard shortcuts
            </span>
            <button class="ghost icon-btn" title="Close" onClick={() => setOpen(false)}>
              <X size={15} strokeWidth={1.75} />
            </button>
          </div>
          <div class="shortcuts-groups">
            <For each={GROUPS}>
              {(group) => (
                <div class="shortcuts-group">
                  <div class="shortcuts-group-title">{group.title}</div>
                  <For each={group.shortcuts}>
                    {(sc) => (
                      <div class="shortcuts-row">
                        <span class="shortcuts-keys">
                          <For each={sc.keys}>{(k) => <kbd>{k}</kbd>}</For>
                        </span>
                        <span class="shortcuts-label">{sc.label}</span>
                      </div>
                    )}
                  </For>
                </div>
              )}
            </For>
          </div>
        </div>
      </div>
    </Show>
  );
}
