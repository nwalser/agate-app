// Root component of the tray quick-access popup (window label "tray"): a
// compact search-and-copy surface over the unified vault list. Renders instead
// of <App/> when main.tsx detects the popup window. All state lives in the
// injectable trayStore; this file is wiring + presentation.
//
// Lifecycle: the popup is shown/hidden by the Rust tray module — every show
// focuses the window, so `focus` doubles as "refresh session + items and grab
// the search box". Hiding intentionally keeps everything (query, scroll,
// selection, items): reopening must feel like the popup never went away. The
// refresh-on-show reconciles items in place and drops them on lock.

import { createSignal, For, onCleanup, onMount, Show } from 'solid-js';
import { Dynamic } from 'solid-js/web';
import { ExternalLink, KeyRound, LockKeyhole, Search, Timer, UserRound } from 'lucide-solid';
import ToastHost from '../components/Toast.tsx';
import { ipc } from '../lib/ipc.ts';
import { t } from '../lib/i18n.ts';
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
    onRepromptBlocked: () => pushToast('info', t('tray.repromptBlocked')),
  });
  const [selected, setSelected] = createSignal(0);
  let searchEl: HTMLInputElement | undefined;

  const openApp = () => void ipc.showMainWindow().catch(toastError);

  function onFocus() {
    syncThemeFromStorage();
    void store.refresh();
    // Select (not clear) the previous query: it stays visible, and typing
    // starts a fresh search without an explicit clear.
    searchEl?.focus();
    searchEl?.select();
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
    document.addEventListener('keydown', onKeyDown);
  });
  onCleanup(() => {
    window.removeEventListener('focus', onFocus);
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
            <button title={t('tray.copyUsername')} onClick={() => void store.copyUsername(item)}>
              <UserRound size={14} />
            </button>
          </Show>
          <button title={t('tray.copyPassword')} onClick={() => void store.copyPassword(item)}>
            <KeyRound size={14} />
          </button>
          <Show when={item.hasTotp}>
            <button title={t('tray.copyTotp')} onClick={() => void store.copyTotp(item)}>
              <Timer size={14} />
            </button>
          </Show>
        </Show>
      </span>
    </li>
  );

  return (
    <div class="tray-app">
      <Show when={store.ready()} fallback={<div class="tray-status">{t('common.loading')}</div>}>
        <Show
          when={store.unlocked()}
          fallback={
            <div class="tray-locked">
              <LockKeyhole size={28} />
              <span>{t('tray.locked')}</span>
              <button class="tray-unlock-btn" onClick={openApp}>
                <ExternalLink size={14} /> {t('tray.openAgate')}
              </button>
            </div>
          }
        >
          <div class="tray-search">
            <Search size={14} />
            <input
              ref={searchEl}
              placeholder={t('tray.searchPlaceholder')}
              value={store.query()}
              onInput={(e) => {
                store.setQuery(e.currentTarget.value);
                setSelected(0);
              }}
            />
          </div>
          <ul class="tray-list">
            <For each={store.filtered()} fallback={<li class="tray-status">{t('tray.noMatches')}</li>}>
              {row}
            </For>
          </ul>
          <footer class="tray-footer">
            <span class="tray-hint">{t('tray.footerHint')}</span>
            <button class="tray-open" onClick={openApp}>
              <ExternalLink size={14} /> {t('tray.openAgate')}
            </button>
          </footer>
        </Show>
      </Show>
      <ToastHost />
    </div>
  );
}
