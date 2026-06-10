// Root component of the tray quick-access popup (window label "tray"): a
// compact search-and-copy surface over the unified vault list. Renders instead
// of <App/> when main.tsx detects the popup window. All state lives in the
// injectable trayStore; this file is wiring + presentation.
//
// Lifecycle: the popup is shown/hidden by the Rust tray module — every show
// focuses the window, so `focus` doubles as "refresh session + items and grab
// the search box", and `blur` (which also hides the window) wipes the local
// item cache via store.clear().

import { createSignal, For, onCleanup, onMount, Show } from 'solid-js';
import { Dynamic } from 'solid-js/web';
import { ExternalLink, KeyRound, LockKeyhole, Search, Timer, UserRound } from 'lucide-solid';
import ToastHost from '../components/Toast.tsx';
import { ipc } from '../lib/ipc.ts';
import { copyWithAutoClear } from '../lib/clipboard.ts';
import { typeIcon } from '../lib/vaultIcons.ts';
import { pushToast, toastError } from '../state/toast.ts';
import { syncThemeFromStorage } from '../state/theme.ts';
import type { VaultItem } from '../lib/types.ts';
import { createTrayStore } from './trayStore.ts';
import './TrayApp.css';

export default function TrayApp() {
  const store = createTrayStore({
    ipc,
    copy: copyWithAutoClear,
    onError: toastError,
    // The reprompt gate (master-password re-entry) lives in the main window;
    // the popup never bypasses it and never re-implements it.
    onRepromptBlocked: () => pushToast('info', 'Master-password protected — open Agate to copy.'),
  });
  const [selected, setSelected] = createSignal(0);
  let searchEl: HTMLInputElement | undefined;

  const openApp = () => void ipc.showMainWindow().catch(toastError);

  function onFocus() {
    syncThemeFromStorage();
    setSelected(0);
    void store.refresh();
    searchEl?.focus();
  }

  // Blur means the popup is being hidden (Rust hides it on focus loss) — drop
  // the decrypted item cache so a hidden webview holds no vault data.
  function onBlur() {
    store.clear();
    setSelected(0);
  }

  function onKeyDown(e: KeyboardEvent) {
    const list = store.filtered();
    switch (e.key) {
      case 'Escape':
        void ipc.hideTrayWindow().catch(toastError);
        break;
      case 'ArrowDown':
        e.preventDefault();
        setSelected((i) => Math.min(i + 1, Math.max(list.length - 1, 0)));
        break;
      case 'ArrowUp':
        e.preventDefault();
        setSelected((i) => Math.max(i - 1, 0));
        break;
      case 'Enter': {
        e.preventDefault();
        const item = list[selected()];
        if (item?.itemType === 'login') void store.copyPassword(item);
        break;
      }
    }
  }

  onMount(() => {
    void store.refresh();
    searchEl?.focus();
    window.addEventListener('focus', onFocus);
    window.addEventListener('blur', onBlur);
    document.addEventListener('keydown', onKeyDown);
  });
  onCleanup(() => {
    window.removeEventListener('focus', onFocus);
    window.removeEventListener('blur', onBlur);
    document.removeEventListener('keydown', onKeyDown);
  });

  const row = (item: VaultItem, index: () => number) => (
    <li
      class="tray-row"
      classList={{ selected: index() === selected() }}
      onMouseEnter={() => setSelected(index())}
    >
      <span class="tray-type-icon">
        <Dynamic component={typeIcon(item.itemType)} size={15} />
      </span>
      <span class="tray-text">
        <span class="tray-name">{item.name}</span>
        <Show when={item.username}>
          <span class="tray-username">{item.username}</span>
        </Show>
      </span>
      <span class="tray-actions">
        <Show when={item.itemType === 'login'}>
          <Show when={item.username}>
            <button title="Copy username" onClick={() => void store.copyUsername(item)}>
              <UserRound size={14} />
            </button>
          </Show>
          <button title="Copy password" onClick={() => void store.copyPassword(item)}>
            <KeyRound size={14} />
          </button>
          <Show when={item.hasTotp}>
            <button title="Copy TOTP code" onClick={() => void store.copyTotp(item)}>
              <Timer size={14} />
            </button>
          </Show>
        </Show>
      </span>
    </li>
  );

  return (
    <div class="tray-app">
      <Show when={store.ready()} fallback={<div class="tray-status">Loading…</div>}>
        <Show
          when={store.unlocked()}
          fallback={
            <div class="tray-locked">
              <LockKeyhole size={28} />
              <span>Vault is locked</span>
              <button class="tray-unlock-btn" onClick={openApp}>
                <ExternalLink size={14} /> Open Agate
              </button>
            </div>
          }
        >
          <div class="tray-search">
            <Search size={14} />
            <input
              ref={searchEl}
              placeholder="Search vault…"
              value={store.query()}
              onInput={(e) => {
                store.setQuery(e.currentTarget.value);
                setSelected(0);
              }}
            />
          </div>
          <ul class="tray-list">
            <For each={store.filtered()} fallback={<li class="tray-status">No matches.</li>}>
              {row}
            </For>
          </ul>
          <footer class="tray-footer">
            <span class="tray-hint">↵ copy password · Esc close</span>
            <button class="tray-open" onClick={openApp}>
              <ExternalLink size={14} /> Open Agate
            </button>
          </footer>
        </Show>
      </Show>
      <ToastHost />
    </div>
  );
}
