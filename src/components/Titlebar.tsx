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

import { createMemo, createSignal, For, Match, onCleanup, onMount, Show, Switch } from 'solid-js';
import { getCurrentWindow } from '@tauri-apps/api/window';
import { Copy, Lock, Minus, Monitor, Moon, Search, Square, Sun, Terminal, X } from 'lucide-solid';
import { ipc } from '../lib/ipc.ts';
import type { VaultItem, WindowControl, WindowControlsLayout } from '../lib/types.ts';
import { typeIcon } from '../lib/vaultIcons.ts';
import {
  type Command,
  commandTerm,
  isCommandQuery,
  type RankedCommand,
  rankCommands,
} from '../lib/command.ts';
import { query, setQuery } from '../state/search.ts';
import { paletteSource } from '../state/palette.ts';
import { connectionNav } from '../state/connections.ts';
import { activeVault } from '../state/ui.ts';
import { lastSync, requestSync, syncState } from '../state/sync.ts';
import { setTheme, theme, type ThemePref } from '../state/theme.ts';
import { SyncIcon } from './SyncStatus.tsx';
import VaultSwitcher from './VaultSwitcher.tsx';
import './Titlebar.css';

// Theme button cycles through these in order (mirrors the old vault header).
const THEME_CYCLE: ThemePref[] = ['system', 'light', 'dark'];
const THEME_LABEL: Record<ThemePref, string> = {
  system: 'System theme',
  light: 'Light theme',
  dark: 'Dark theme',
};

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

// How many preview rows the search dropdown shows at once.
const RESULT_LIMIT = 8;

// Human "time since" for the sync status label. Recomputed as the titlebar's
// `now` clock ticks, so it reads "synced 2m ago" and keeps counting up without a
// fresh sync. The caller clamps a just-set timestamp to "just now" via the floor.
function relTime(ts: number, now: number): string {
  const sec = Math.max(0, Math.floor((now - ts) / 1000));
  if (sec < 60) return 'just now';
  const min = Math.floor(sec / 60);
  if (min < 60) return `${min}m ago`;
  const hr = Math.floor(min / 60);
  if (hr < 24) return `${hr}h ago`;
  return `${Math.floor(hr / 24)}d ago`;
}

// Wrap a vault item as a runnable command for the normal-search preview.
function itemCommand(it: VaultItem, openItem: (id: string) => void): Command {
  return {
    id: it.id,
    label: it.name,
    hint: it.username ?? undefined,
    icon: typeIcon(it.itemType),
    run: () => openItem(it.id),
  };
}

export default function Titlebar(props: { showSearch: boolean; onLock: () => void }) {
  function cycleTheme() {
    const idx = THEME_CYCLE.indexOf(theme());
    setTheme(THEME_CYCLE[(idx + 1) % THEME_CYCLE.length]);
  }

  const syncTitle = () => {
    if (syncState() === 'syncing') return 'Syncing…';
    if (syncState() === 'error') return 'Sync failed — click to retry';
    return lastSync() === null ? 'Not synced yet — click to sync' : 'Synced — click to sync now';
  };

  // A coarse clock that ticks every 30s so the sync status' relative time
  // ("synced 2m ago") re-renders on its own, not only when a sync fires.
  const [now, setNow] = createSignal(Date.now());
  onMount(() => {
    const t = setInterval(() => setNow(Date.now()), 30_000);
    onCleanup(() => clearInterval(t));
  });

  // Visible sync status text, shown beside the cloud icon in the actions cluster.
  const syncLabel = () => {
    if (syncState() === 'syncing') return 'Syncing…';
    if (syncState() === 'error') return 'Sync failed';
    const ts = lastSync();
    return ts === null ? 'Not synced' : `Synced ${relTime(ts, now())}`;
  };

  // Tracks the OS maximize state so the maximize button shows the right glyph
  // (single square = maximize, overlapping = restore). Seeded once, then kept in
  // sync via the window's resize event. Unused on macOS (no custom controls).
  const [maximized, setMaximized] = createSignal(false);
  // Where/what controls to draw. Linux overrides this from the desktop config.
  const [layout, setLayout] = createSignal<WindowControlsLayout>(DEFAULT_LAYOUT);

  // --- search dropdown: previews items (plain text) or commands (`/` prefix) ---
  // `focused` gates the dropdown so it only shows while the field has focus;
  // `selected` is the keyboard-highlighted row.
  const [focused, setFocused] = createSignal(false);
  const [selected, setSelected] = createSignal(0);
  let searchInput: HTMLInputElement | undefined;

  const commandMode = () => isCommandQuery(query());

  // Top matches for the current query: action commands in `/` mode, otherwise
  // live vault items wrapped as go-to commands. Ranked + capped for the preview.
  const results = createMemo<RankedCommand[]>(() => {
    const src = paletteSource();
    if (commandMode()) {
      return rankCommands(src.commands, commandTerm(query())).slice(0, RESULT_LIMIT);
    }
    const itemCmds = src.items.map((it) => itemCommand(it, src.openItem));
    return rankCommands(itemCmds, query()).slice(0, RESULT_LIMIT);
  });

  const dropdownOpen = () => focused() && query().trim().length > 0;
  const clampedSelected = () => Math.min(selected(), Math.max(0, results().length - 1));

  function activate(index: number) {
    const target = results()[index];
    if (!target) return;
    // A command is consumed (clear the field); a go-to keeps the query so the
    // list stays filtered behind the now-selected item.
    if (commandMode()) setQuery('');
    setSelected(0);
    searchInput?.blur();
    target.command.run();
  }

  function onSearchKeyDown(e: KeyboardEvent) {
    const count = results().length;
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      if (count > 0) setSelected((s) => (Math.min(s, count - 1) + 1) % count);
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      if (count > 0) setSelected((s) => (Math.min(s, count - 1) - 1 + count) % count);
    } else if (e.key === 'Enter') {
      e.preventDefault();
      activate(clampedSelected());
    } else if (e.key === 'Escape') {
      e.preventDefault();
      searchInput?.blur();
    }
  }

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

      {/* Connection switcher — only on the vault screen, and only when there's
          more than one connection to switch between. */}
      <Show when={props.showSearch && connectionNav().connections.length > 1}>
        <div class="titlebar-conn">
          <VaultSwitcher
            connections={connectionNav().connections}
            active={activeVault()}
            onSelect={connectionNav().switchVault}
          />
        </div>
      </Show>

      <div class="titlebar-center" data-tauri-drag-region>
        <Show when={props.showSearch}>
          <div class="titlebar-search">
            <Show when={commandMode()} fallback={<Search size={14} strokeWidth={1.75} />}>
              <Terminal size={14} strokeWidth={1.75} />
            </Show>
            <input
              ref={(el) => (searchInput = el)}
              placeholder="Search vault — type / for commands"
              value={query()}
              onInput={(e) => {
                setQuery(e.currentTarget.value);
                setSelected(0);
              }}
              onFocus={() => setFocused(true)}
              onBlur={() => setFocused(false)}
              onKeyDown={onSearchKeyDown}
            />
            <Show when={dropdownOpen()}>
              {/* Keep mousedown from blurring the input before the click lands. */}
              <div class="titlebar-results" role="listbox" onMouseDown={(e) => e.preventDefault()}>
                <Show
                  when={results().length > 0}
                  fallback={
                    <div class="titlebar-results-empty">
                      {commandMode() ? 'No matching commands' : 'No matches'}
                    </div>
                  }
                >
                  <For each={results()}>
                    {(entry, index) => {
                      const Icon = entry.command.icon;
                      const isSelected = () => index() === clampedSelected();
                      return (
                        <button
                          type="button"
                          class="titlebar-result"
                          classList={{ 'titlebar-result-selected': isSelected() }}
                          role="option"
                          aria-selected={isSelected()}
                          onMouseEnter={() => setSelected(index())}
                          onClick={() => activate(index())}
                        >
                          <Show when={Icon}>
                            {(IconC) => {
                              const ResolvedIcon = IconC();
                              return (
                                <span class="titlebar-result-icon">
                                  <ResolvedIcon size={15} strokeWidth={1.5} />
                                </span>
                              );
                            }}
                          </Show>
                          <span class="titlebar-result-label">
                            <For each={entry.spans}>
                              {(span) => (
                                <Show when={span.matched} fallback={<>{span.text}</>}>
                                  <mark class="titlebar-result-mark">{span.text}</mark>
                                </Show>
                              )}
                            </For>
                          </span>
                          <Show when={entry.command.hint}>
                            <span class="titlebar-result-hint">{entry.command.hint}</span>
                          </Show>
                        </button>
                      );
                    }}
                  </For>
                </Show>
              </div>
            </Show>
          </div>
        </Show>
      </div>

      <Show when={props.showSearch}>
        <div class="titlebar-actions">
          <button
            class="titlebar-btn titlebar-sync"
            title={syncTitle()}
            disabled={syncState() === 'syncing'}
            onClick={() => requestSync()}
          >
            <SyncIcon state={syncState()} lastSync={lastSync()} />
            <span class="titlebar-sync-label">{syncLabel()}</span>
          </button>
          <button class="titlebar-btn" title={THEME_LABEL[theme()]} onClick={cycleTheme}>
            <Switch fallback={<Monitor size={15} strokeWidth={1.75} />}>
              <Match when={theme() === 'light'}>
                <Sun size={15} strokeWidth={1.75} />
              </Match>
              <Match when={theme() === 'dark'}>
                <Moon size={15} strokeWidth={1.75} />
              </Match>
            </Switch>
          </button>
          <button class="titlebar-btn" title="Lock" onClick={() => props.onLock()}>
            <Lock size={15} strokeWidth={1.75} />
          </button>
        </div>
      </Show>

      <Show when={!IS_MAC}>
        <div class="titlebar-controls" classList={{ left: layout().side === 'left' }}>
          <For each={layout().buttons}>{(btn) => controlButton(btn)}</For>
        </div>
      </Show>
    </header>
  );
}
