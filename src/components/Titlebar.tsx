// Custom window titlebar. We run with native decorations disabled
// (tauri.conf.json `decorations: false`), so this owns the top strip of the
// window: a drag region, the vault search field (shown only on the vault
// screen), and reimplemented minimize / maximize / close controls.
//
// Dragging: the bar and its inert regions carry `data-tauri-drag-region`, which
// Tauri's webview hit-tests to start an OS window drag. Interactive children
// (the search input, the control buttons) are the event target instead, so they
// stay clickable and are not draggable.

import { createSignal, onCleanup, onMount, Show } from 'solid-js';
import { getCurrentWindow } from '@tauri-apps/api/window';
import { Copy, Minus, Search, Square, X } from 'lucide-solid';
import { query, setQuery } from '../state/search.ts';
import './Titlebar.css';

const appWindow = getCurrentWindow();

export default function Titlebar(props: { showSearch: boolean }) {
  // Tracks the OS maximize state so the middle button shows the right glyph
  // (single square = maximize, overlapping = restore). Seeded once, then kept in
  // sync via the window's resize event.
  const [maximized, setMaximized] = createSignal(false);

  function syncMaximized() {
    appWindow
      .isMaximized()
      .then(setMaximized)
      .catch(() => {
        // ignore: state query failed; the glyph stays as-is (cosmetic only)
      });
  }

  onMount(() => {
    syncMaximized();
    const unlisten = appWindow.onResized(syncMaximized);
    onCleanup(() => {
      void unlisten.then((un) => un());
    });
  });

  return (
    <header class="titlebar" data-tauri-drag-region>
      <div class="titlebar-brand" data-tauri-drag-region>
        Agate
      </div>

      <div class="titlebar-center" data-tauri-drag-region>
        <Show when={props.showSearch}>
          <div class="titlebar-search">
            <Search size={14} strokeWidth={1.75} />
            <input
              placeholder="Search vault…"
              value={query()}
              onInput={(e) => setQuery(e.currentTarget.value)}
            />
          </div>
        </Show>
      </div>

      <div class="titlebar-controls">
        <button class="titlebar-btn" title="Minimize" onClick={() => void appWindow.minimize()}>
          <Minus size={15} strokeWidth={1.75} />
        </button>
        <button
          class="titlebar-btn"
          title={maximized() ? 'Restore' : 'Maximize'}
          onClick={() => void appWindow.toggleMaximize()}
        >
          {maximized() ? <Copy size={13} strokeWidth={1.75} /> : <Square size={13} strokeWidth={1.75} />}
        </button>
        <button
          class="titlebar-btn titlebar-close"
          title="Close"
          onClick={() => void appWindow.close()}
        >
          <X size={16} strokeWidth={1.75} />
        </button>
      </div>
    </header>
  );
}
