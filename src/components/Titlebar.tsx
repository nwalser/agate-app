// Custom window titlebar. The window runs borderless on Windows/Linux
// (lib.rs disables decorations there), so this owns the top strip: a drag
// region, the vault search field (shown only on the vault screen), and our own
// minimize / maximize / close controls. macOS keeps its native title bar in
// overlay style — the real traffic-light buttons stay top-left, so we draw no
// controls there, just a gutter so our content clears them.
//
// Control placement mirrors the host so a borderless window feels native:
// Windows uses the right-hand min/maximize/close default; Linux asks the
// backend for the desktop's configured button-layout (side + order).
//
// Dragging: the bar and its inert regions carry `data-tauri-drag-region`, which
// Tauri's webview hit-tests to start an OS window drag. Interactive children
// (the search input, the control buttons) are the event target instead, so they
// stay clickable and are not draggable.

import { createSignal, For, onCleanup, onMount, Show } from 'solid-js';
import { getCurrentWindow } from '@tauri-apps/api/window';
import { Copy, Minus, Search, Square, X } from 'lucide-solid';
import { ipc } from '../lib/ipc.ts';
import type { WindowControl, WindowControlsLayout } from '../lib/types.ts';
import { query, setQuery } from '../state/search.ts';
import './Titlebar.css';

const appWindow = getCurrentWindow();

const UA = typeof navigator !== 'undefined' ? navigator.userAgent : '';
// macOS: native traffic lights (no custom controls). WKWebView reports
// "Macintosh" in its UA. Linux: webkit2gtk reports "Linux" (exclude Android).
const IS_MAC =
  /Macintosh|Mac OS X/.test(UA) ||
  (typeof navigator !== 'undefined' && /^Mac/.test(navigator.platform));
const IS_LINUX = /Linux/.test(UA) && !/Android/.test(UA);

// Right-hand minimize/maximize/close — the Windows convention and the fallback
// when a Linux desktop doesn't expose a button-layout.
const DEFAULT_LAYOUT: WindowControlsLayout = {
  side: 'right',
  buttons: ['minimize', 'maximize', 'close'],
};

export default function Titlebar(props: { showSearch: boolean }) {
  // Tracks the OS maximize state so the maximize button shows the right glyph
  // (single square = maximize, overlapping = restore). Seeded once, then kept in
  // sync via the window's resize event. Unused on macOS (no custom controls).
  const [maximized, setMaximized] = createSignal(false);
  // Where/what controls to draw. Linux overrides this from the desktop config.
  const [layout, setLayout] = createSignal<WindowControlsLayout>(DEFAULT_LAYOUT);

  function syncMaximized() {
    appWindow
      .isMaximized()
      .then(setMaximized)
      .catch(() => {
        // ignore: state query failed; the glyph stays as-is (cosmetic only)
      });
  }

  onMount(() => {
    if (IS_MAC) return;
    syncMaximized();
    const unlisten = appWindow.onResized(syncMaximized);
    onCleanup(() => {
      void unlisten.then((un) => un());
    });
    // Match the host's native control side/order on Linux; keep the default
    // elsewhere (and if the query fails, e.g. no gsettings).
    if (IS_LINUX) {
      ipc
        .windowControlsLayout()
        .then((l) => {
          if (l && l.buttons.length > 0) setLayout(l);
        })
        .catch(() => {
          // ignore: keep DEFAULT_LAYOUT
        });
    }
  });

  function controlButton(btn: WindowControl) {
    switch (btn) {
      case 'minimize':
        return (
          <button class="titlebar-btn" title="Minimize" onClick={() => void appWindow.minimize()}>
            <Minus size={15} strokeWidth={1.75} />
          </button>
        );
      case 'maximize':
        return (
          <button
            class="titlebar-btn"
            title={maximized() ? 'Restore' : 'Maximize'}
            onClick={() => void appWindow.toggleMaximize()}
          >
            {maximized() ? (
              <Copy size={13} strokeWidth={1.75} />
            ) : (
              <Square size={13} strokeWidth={1.75} />
            )}
          </button>
        );
      case 'close':
        return (
          <button
            class="titlebar-btn titlebar-close"
            title="Close"
            onClick={() => void appWindow.close()}
          >
            <X size={16} strokeWidth={1.75} />
          </button>
        );
    }
  }

  return (
    <header class="titlebar" classList={{ mac: IS_MAC }} data-tauri-drag-region>
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

      <Show when={!IS_MAC}>
        <div class="titlebar-controls" classList={{ left: layout().side === 'left' }}>
          <For each={layout().buttons}>{(btn) => controlButton(btn)}</For>
        </div>
      </Show>
    </header>
  );
}
