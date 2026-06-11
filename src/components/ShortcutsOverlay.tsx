// Keyboard-shortcut cheat sheet. Press `?` (Shift+/) anywhere outside a text
// field to open it; Esc or a backdrop click closes it. Self-contained: it owns
// its open-state and its own global key listener, so it can be dropped into
// App.tsx without threading anything through the screens. The listed bindings
// mirror the handlers in Vault.tsx (list nav, history) and the titlebar (search,
// command palette).

import { createSignal, For, onCleanup, onMount, Show } from 'solid-js';
import { Keyboard, X } from 'lucide-solid';
import { t } from '../lib/i18n.ts';
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

// Built inside the reactive render (via groups()) so the labels re-read from t()
// when the language flips. Key caps (⌘, ↑, Esc, "Type", …) stay literal — they
// are keyboard symbols, not translatable prose.
function groups(): { title: string; shortcuts: Shortcut[] }[] {
  return [
    {
      title: t('shortcuts.navigation'),
      shortcuts: [
        { keys: [MOD, 'K'], label: t('shortcuts.commandPalette') },
        { keys: ['↑', '↓'], label: t('shortcuts.moveSelection') },
        { keys: ['Home', 'End'], label: t('shortcuts.firstLast') },
        { keys: ['Alt', '←'], label: t('shortcuts.back') },
        { keys: ['Alt', '→'], label: t('shortcuts.forward') },
      ],
    },
    {
      title: t('shortcuts.search'),
      shortcuts: [
        { keys: ['Type'], label: t('shortcuts.typeToFilter') },
        { keys: ['/'], label: t('shortcuts.runCommand') },
      ],
    },
    {
      title: t('shortcuts.general'),
      shortcuts: [
        { keys: ['?'], label: t('shortcuts.thisHelp') },
        { keys: ['Esc'], label: t('shortcuts.closeMenu') },
      ],
    },
  ];
}

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
        <div class="shortcuts-card" role="dialog" aria-label={t('shortcuts.title')} onClick={(e) => e.stopPropagation()}>
          <div class="shortcuts-head">
            <span class="shortcuts-title">
              <Keyboard size={15} strokeWidth={1.75} /> {t('shortcuts.title')}
            </span>
            <button class="ghost icon-btn" title={t('common.close')} onClick={() => setOpen(false)}>
              <X size={15} strokeWidth={1.75} />
            </button>
          </div>
          <div class="shortcuts-groups">
            <For each={groups()}>
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
