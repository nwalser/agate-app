// Root component of the tray quick-access popup (window label "tray"): a
// compact search-and-copy surface over the unified vault list. Renders instead
// of <App/> when main.tsx detects the popup window. All state lives in the
// injectable trayStore; this file is wiring + presentation.
//
// Lifecycle: the popup is shown/hidden by the Rust tray module — every show
// focuses the window, so `focus` doubles as "refresh session + items and grab
// the search box". The popup is PINNED: always-on-top, never hides on focus
// loss — only the tray icon (toggle), Escape, or a close request hide it, and
// hiding keeps everything (query, scroll, selection, items): reopening must
// feel like the popup never went away. Because it can stay visible while the
// main window locks/unlocks, it also refreshes on the backend's
// `agate://session-changed` broadcast, dropping items the moment the session
// locks.

import { createEffect, createMemo, createSignal, For, on, onCleanup, onMount, Show } from 'solid-js';
import { Dynamic } from 'solid-js/web';
import { getCurrentWindow } from '@tauri-apps/api/window';
import { PhysicalPosition, PhysicalSize } from '@tauri-apps/api/dpi';
import { listen } from '@tauri-apps/api/event';
import {
  AppWindow,
  Eye,
  EyeOff,
  ExternalLink,
  Fingerprint,
  Globe,
  Info,
  KeyRound,
  LockKeyhole,
  LockOpen,
  LogIn,
  Plus,
  RefreshCw,
  Search,
  ShieldAlert,
  Timer,
  UserRound,
  X,
} from 'lucide-solid';
import ToastHost from '../components/Toast.tsx';
import Favicon from '../components/Favicon.tsx';
import CopyButton from '../components/CopyButton.tsx';
import { ipc } from '../lib/ipc.ts';
import { t } from '../lib/i18n.ts';
import { copyWithAutoClear } from '../lib/clipboard.ts';
import { typeIcon } from '../lib/vaultIcons.ts';
import { accountColorVar } from '../lib/accountColor.ts';
import { pushToast, toastError } from '../state/toast.ts';
import { syncThemeFromStorage } from '../state/theme.ts';
import { recordRecent } from '../state/recentItems.ts';
import { readColumnConfig } from '../state/columnConfig.ts';
import { UNLOCK_BEAT_MS } from '../lib/unlockBeat.ts';
import type { VaultItem } from '../lib/types.ts';
import {
  copyActionForKey,
  createTrayStore,
  draftFromContext,
  fillPopupHeight,
  loginNameFromUri,
  type FillRow,
} from './trayStore.ts';
import './TrayApp.css';

/** Human label for a zxcvbn score (0–4), for the add-form's strength meter. */
function strengthLabel(score: number): string {
  switch (score) {
    case 0:
      return t('tray.strength.veryWeak');
    case 1:
      return t('tray.strength.weak');
    case 2:
      return t('tray.strength.fair');
    case 3:
      return t('tray.strength.strong');
    default:
      return t('tray.strength.veryStrong');
  }
}

export default function TrayApp() {
  const store = createTrayStore({
    ipc,
    copy: copyWithAutoClear,
    // Copies count as "used" for the main window's titlebar recents (shared
    // localStorage). The popup's own list order deliberately ignores recency —
    // rows must not jump right after a copy.
    onUsed: (item) => recordRecent(item.id),
    onError: toastError,
    // The reprompt gate (master-password re-entry) lives in the main window;
    // the popup never bypasses it and never re-implements it.
    onRepromptBlocked: () => pushToast('info', t('tray.repromptBlocked')),
    // Same deferral for 2FA: the popup unlocks what it can; 2FA-enforced
    // connections are finished in the main window's unlock screen.
    onTwoFactorPending: (emails) =>
      pushToast('info', t('tray.twoFactorPending', { emails: emails.join(', ') })),
  });
  const [selected, setSelected] = createSignal(0);
  const [password, setPassword] = createSignal('');
  // The main list's favicon preference (Settings → Appearance) gates favicon
  // FETCHES too — a privacy choice (icons load from the sites themselves), so
  // the popup honors it. Re-read on every show; the webviews share storage.
  const [showFavicons, setShowFavicons] = createSignal(readColumnConfig().favicons);
  const [revealPw, setRevealPw] = createSignal(false);
  let searchEl: HTMLInputElement | undefined;
  let passwordEl: HTMLInputElement | undefined;
  let listEl: HTMLUListElement | undefined;
  let nameEl: HTMLInputElement | undefined;

  // Unlock animation beat (the main Unlock screen's success pop at popup
  // scale, same keyframes + the SAME shared duration so both windows play it
  // together): on every locked→unlocked flip — own form, Hello, or the main
  // window via the session broadcast — flash a green open-lock pop while the
  // list view animates in underneath, then drop the flash.
  const [justUnlocked, setJustUnlocked] = createSignal(false);
  let flashTimer: ReturnType<typeof setTimeout> | undefined;
  createEffect(
    on(
      store.unlocked,
      (now, prev) => {
        if (!now || prev !== false) return;
        setJustUnlocked(true);
        clearTimeout(flashTimer);
        flashTimer = setTimeout(() => setJustUnlocked(false), UNLOCK_BEAT_MS);
      },
      { defer: true },
    ),
  );
  onCleanup(() => clearTimeout(flashTimer));

  // An unlock running in ANOTHER window (the main Unlock screen) broadcasts
  // `unlock-started`; mirror its decrypt animation here so both surfaces read as
  // one. Reset on the trailing `session-changed` (fires even if that unlock
  // failed). The popup's own unlock uses store.unlocking(); this covers the rest.
  const [extUnlocking, setExtUnlocking] = createSignal(false);
  const isUnlocking = () => store.unlocking() || extUnlocking();

  const openApp = () => void ipc.showMainWindow().catch(toastError);

  /** The app a fill would land in (window title, else process name). */
  const fillTargetLabel = () => {
    const c = store.pending()?.context;
    return c?.windowTitle || c?.processName || t('autofill.unknownTarget');
  };

  /** Cancel an autofill prompt: drop the backend detection and hide the popup. */
  function cancelFill() {
    store.exitFill();
    void ipc.hideTrayWindow().catch(toastError);
  }

  // ── Autofill popup sizing ───────────────────────────────────────────────────
  // In fill mode the popup is a compact chooser sized by fillPopupHeight (capped
  // at a few rows; longer lists scroll), anchored at the bottom so it grows
  // upward from the tray. Every other view keeps the default height.
  const DEFAULT_POPUP_H = 520;

  // Resize keeping the bottom edge fixed (it sits just above the taskbar), so the
  // popup grows/shrinks upward. Best-effort: sizing is cosmetic.
  async function setPopupHeight(logicalH: number) {
    const win = getCurrentWindow();
    try {
      const scale = await win.scaleFactor();
      const target = Math.round(logicalH * scale);
      const size = await win.outerSize();
      if (Math.abs(size.height - target) < 2) return;
      const pos = await win.outerPosition();
      await win.setSize(new PhysicalSize(size.width, target));
      await win.setPosition(new PhysicalPosition(pos.x, pos.y + (size.height - target)));
    } catch {
      // ignore: best-effort cosmetics; the popup works at any size
    }
  }

  // Size the window to the active view — only the unlocked fill view is custom;
  // the guard in setPopupHeight makes the default case a no-op (no flicker).
  createEffect(() => {
    const custom = store.fillMode() && store.unlocked();
    const count = store.pending()?.candidates.length ?? 0;
    void setPopupHeight(custom ? fillPopupHeight(count) : DEFAULT_POPUP_H);
  });

  // No match for the detected app → show the brief note, then auto-dismiss.
  let emptyHideTimer: ReturnType<typeof setTimeout> | undefined;
  createEffect(() => {
    const empty =
      store.fillMode() && store.unlocked() && (store.pending()?.candidates.length ?? 0) === 0;
    clearTimeout(emptyHideTimer);
    if (empty) emptyHideTimer = setTimeout(() => cancelFill(), 1800);
  });
  onCleanup(() => clearTimeout(emptyHideTimer));

  async function onFocus() {
    syncThemeFromStorage();
    setShowFavicons(readColumnConfig().favicons);
    await store.refresh();
    // Reconcile fill mode with the backend on every show (a tray-icon open clears
    // the pending detection, so this resolves to off for a normal open).
    await store.syncFill();
    if (!store.unlocked()) {
      passwordEl?.focus();
      return;
    }
    // Select (not clear) the previous query so typing starts a fresh search; in
    // fill mode the query was reset, so there's nothing to select.
    searchEl?.focus();
    if (!store.fillMode()) searchEl?.select();
  }

  // ── Add-login form wiring ───────────────────────────────────────────────────

  async function openAdd() {
    setRevealPw(false);
    await store.enterAdd();
    nameEl?.focus();
  }

  /** From a detected-but-unmatched autofill target: drop the detection and open
   *  the add form seeded with that app's website + a guessed name, so a missing
   *  login is captured in one step instead of being a dead end. */
  async function addFromDetection() {
    setRevealPw(false);
    const ctx = store.pending()?.context ?? null;
    clearTimeout(emptyHideTimer);
    store.exitFill();
    await store.enterAdd(draftFromContext(ctx));
    nameEl?.focus();
  }

  async function saveNewLogin() {
    if (await store.saveNew()) {
      pushToast('success', t('tray.loginSaved'));
      searchEl?.focus();
    }
  }

  // Debounced reuse check: ask the backend whether the draft password is
  // already in use, a beat after typing/generation stops.
  const draftPassword = createMemo(() => store.draft().password);
  let reuseTimer: ReturnType<typeof setTimeout> | undefined;
  createEffect(() => {
    const pw = draftPassword();
    void pw;
    if (!store.addMode()) return;
    clearTimeout(reuseTimer);
    reuseTimer = setTimeout(() => void store.checkReuse(), 350);
  });
  onCleanup(() => clearTimeout(reuseTimer));

  async function unlockWithPassword() {
    if (await store.unlock(password())) {
      setPassword('');
      // A detection may have arrived while locked — recompute its candidates now
      // that the vault is open.
      await store.syncFill();
      searchEl?.focus();
    }
  }

  async function unlockWithHello() {
    await store.unlockHello();
    await store.syncFill();
    // The Hello consent dialog takes focus; the pinned popup stays visible,
    // but pull focus back so the result is keyboard-ready.
    await ipc.showTrayWindow().catch(toastError);
  }

  // Solid re-renders synchronously on set, so the new .selected row exists by
  // the time we scroll it into view. Shared by the copy list and the fill list.
  const move = (delta: number, length: number) => {
    setSelected((i) => Math.max(0, Math.min(i + delta, Math.max(length - 1, 0))));
    listEl?.querySelector('.selected')?.scrollIntoView({ block: 'nearest' });
  };

  function onKeyDown(e: KeyboardEvent) {
    // While locked the only global key is Escape — Enter must keep submitting
    // the unlock form, not get preventDefault-ed away here.
    if (e.key === 'Escape') {
      if (store.fillMode()) cancelFill();
      else if (store.addMode()) store.exitAdd();
      else void ipc.hideTrayWindow().catch(toastError);
      return;
    }
    if (!store.unlocked()) return;

    // Fill mode: arrow-navigate the candidate / search rows, Enter fills.
    if (store.fillMode()) {
      const rows = store.fillRows();
      switch (e.key) {
        case 'ArrowDown':
          e.preventDefault();
          move(1, rows.length);
          break;
        case 'ArrowUp':
          e.preventDefault();
          move(-1, rows.length);
          break;
        case 'Enter': {
          e.preventDefault();
          const r = rows[selected()];
          if (r) void store.fill(r);
          break;
        }
      }
      return;
    }

    // Add form: it owns the keyboard (Enter submits natively) — only Escape
    // (handled above) is global, mirroring the locked unlock form.
    if (store.addMode()) return;

    const list = store.filtered();
    switch (e.key) {
      case 'ArrowDown':
        e.preventDefault();
        move(1, list.length);
        break;
      case 'ArrowUp':
        e.preventDefault();
        move(-1, list.length);
        break;
      case 'Enter': {
        e.preventDefault();
        const item = list[selected()];
        if (item?.itemType !== 'login') break;
        const action = copyActionForKey(e);
        if (action === 'username') {
          if (item.username) void store.copyUsername(item);
        } else if (action === 'totp') {
          if (item.hasTotp) void store.copyTotp(item);
        } else {
          void store.copyPassword(item);
        }
        break;
      }
    }
  }

  onMount(() => {
    void store.refresh();
    searchEl?.focus();
    // Refresh on the Rust-side focus event (WindowEvent::Focused), not the DOM
    // `focus` event: WebView2 doesn't reliably fire DOM focus after a
    // hide()/show()+set_focus() cycle, which left the popup rendering its
    // mount-time session state (e.g. still "locked") after the vault unlocked.
    const unlistenFocus = getCurrentWindow().onFocusChanged(({ payload: focused }) => {
      if (focused) void onFocus();
    });
    // Deterministic show-refresh: the Rust tray module emits this the instant it
    // shows the popup. The focus event above is unreliable — WebView2 doesn't
    // always fire it after a hide()/show()+set_focus() cycle (the popup can be
    // shown without taking foreground), which left the popup rendering its stale
    // session state (e.g. still "locked" after the vault unlocked elsewhere).
    // This fires on every show regardless of focus.
    const unlistenShown = listen('agate://tray-shown', () => void onFocus());
    // The pinned popup can be visible (unfocused) while the main window locks,
    // unlocks or edits connections — refresh on the backend broadcast instead
    // of waiting for the next focus, so a lock drops the list immediately.
    const unlistenSession = listen('agate://session-changed', () => {
      void store.refresh().finally(() => setExtUnlocking(false));
    });
    // Another window started an unlock — borrow the same decrypt animation while
    // it runs (only meaningful in the locked view; cleared by session-changed).
    const unlistenUnlockStarted = listen('agate://unlock-started', () => {
      if (!store.unlocked()) setExtUnlocking(true);
    });
    // Autofill: the backend detected a login field in another app and showed the
    // popup by the tray. Refresh session state, then enter fill mode (which sizes
    // the window to the candidate list).
    const unlistenDetected = listen('autofill://detected', () => {
      void (async () => {
        await store.refresh();
        await store.syncFill();
        setSelected(0);
      })();
    });
    document.addEventListener('keydown', onKeyDown);
    onCleanup(() => {
      void unlistenFocus.then((un) => un());
      void unlistenShown.then((un) => un());
      void unlistenSession.then((un) => un());
      void unlistenUnlockStarted.then((un) => un());
      void unlistenDetected.then((un) => un());
      document.removeEventListener('keydown', onKeyDown);
    });
  });

  const row = (item: VaultItem, index: () => number) => (
    <li
      class="tray-row"
      classList={{ selected: index() === selected() }}
      onMouseEnter={() => setSelected(index())}
    >
      <span class="tray-type-icon">
        <Show
          when={showFavicons()}
          fallback={<Dynamic component={typeIcon(item.itemType)} size={15} />}
        >
          <Favicon
            uri={item.uri}
            size={15}
            fallback={<Dynamic component={typeIcon(item.itemType)} size={15} />}
          />
        </Show>
      </span>
      <span class="tray-text">
        <span class="tray-name">{item.name}</span>
        <Show when={item.username}>
          <span class="tray-username">{item.username}</span>
        </Show>
      </span>
      <Show when={store.multiAccount()}>
        <span
          class="tray-account-dot"
          style={{ background: accountColorVar(item.accountEmail) }}
          title={`${item.accountLabel} · ${item.accountEmail}`}
        />
      </Show>
      <span class="tray-actions">
        <Show when={item.itemType === 'login'}>
          <Show when={item.username}>
            <CopyButton
              size={14}
              label={t('tray.copyUsername')}
              icon={<UserRound size={14} />}
              onCopy={() => store.copyUsername(item)}
            />
          </Show>
          <CopyButton
            size={14}
            label={t('tray.copyPassword')}
            icon={<KeyRound size={14} />}
            onCopy={() => store.copyPassword(item)}
          />
          <Show when={item.hasTotp}>
            <CopyButton
              size={14}
              label={t('tray.copyTotp')}
              icon={<Timer size={14} />}
              onCopy={() => store.copyTotp(item)}
            />
          </Show>
        </Show>
      </span>
    </li>
  );

  // Fill-mode row: clicking anywhere (or the action) types the login into the
  // detected target. No clipboard is involved.
  const fillRow = (r: FillRow, index: () => number) => (
    <li
      class="tray-row"
      classList={{ selected: index() === selected() }}
      onMouseEnter={() => setSelected(index())}
      onClick={() => void store.fill(r)}
    >
      <span class="tray-type-icon">
        <KeyRound size={15} />
      </span>
      <span class="tray-text">
        <span class="tray-name">{r.name}</span>
        <Show when={r.username}>
          <span class="tray-username">{r.username}</span>
        </Show>
      </span>
      <span class="tray-actions">
        <button
          title={t('autofill.fill')}
          disabled={store.filling()}
          onClick={(e) => {
            e.stopPropagation();
            void store.fill(r);
          }}
        >
          <LogIn size={14} />
        </button>
      </span>
    </li>
  );

  return (
    <div class="tray-app" classList={{ 'just-unlocked': justUnlocked() }}>
      <Show when={store.ready()} fallback={<div class="tray-status">{t('common.loading')}</div>}>
        <Show
          when={store.unlocked()}
          fallback={
            <div class="tray-locked">
              {/* Same account-palette aurora the main Unlock screen weaves behind
                  its unlocking animation, popup-scaled — shown only while an
                  unlock is running, so both windows read as one surface. */}
              <Show when={isUnlocking()}>
                <div class="tray-unlock-aurora" aria-hidden="true" />
              </Show>
              <span class="tray-lock-badge" classList={{ working: isUnlocking() }}>
                <LockKeyhole size={26} />
              </span>
              <span>{isUnlocking() ? t('tray.unlocking') : t('tray.locked')}</span>
              {/* Same honest indeterminate sweep as the main Unlock screen. */}
              <Show when={isUnlocking()}>
                <div class="tray-unlock-progress">
                  <div class="tray-unlock-progress-bar" />
                </div>
              </Show>
              {/* Unlock in place once app-unlock is configured; before
                  onboarding the popup can only hand off to the main window. */}
              <Show
                when={store.appUnlockConfigured()}
                fallback={
                  <button class="tray-unlock-btn" onClick={openApp}>
                    <ExternalLink size={14} /> {t('tray.openAgate')}
                  </button>
                }
              >
                <form
                  class="tray-unlock-form"
                  onSubmit={(e) => {
                    e.preventDefault();
                    void unlockWithPassword();
                  }}
                >
                  <input
                    ref={passwordEl}
                    type="password"
                    aria-label={t('unlock.appPassword')}
                    placeholder={t('tray.appPasswordPlaceholder')}
                    autocomplete="current-password"
                    value={password()}
                    disabled={isUnlocking()}
                    onInput={(e) => setPassword(e.currentTarget.value)}
                  />
                  <button
                    type="submit"
                    class="tray-unlock-btn"
                    disabled={isUnlocking() || !password()}
                  >
                    <LockOpen size={14} />
                    {isUnlocking() ? t('tray.unlocking') : t('tray.unlock')}
                  </button>
                </form>
                <Show when={store.helloConfigured()}>
                  <button
                    class="tray-hello-btn"
                    disabled={isUnlocking()}
                    onClick={() => void unlockWithHello()}
                  >
                    <Fingerprint size={14} /> {t('tray.unlockWithHello')}
                  </button>
                </Show>
                <button class="tray-open" onClick={openApp}>
                  <ExternalLink size={14} /> {t('tray.openAgate')}
                </button>
              </Show>
            </div>
          }
        >
          <Show
            when={store.fillMode()}
            fallback={
              <Show
                when={store.addMode()}
                fallback={
                  <>
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
                      <button
                        class="tray-add-btn"
                        title={t('tray.addLogin')}
                        onClick={() => void openAdd()}
                      >
                        <Plus size={15} />
                      </button>
                    </div>
                    <ul class="tray-list" ref={listEl}>
                      <For
                        each={store.filtered()}
                        fallback={<li class="tray-status">{t('tray.noMatches')}</li>}
                      >
                        {row}
                      </For>
                    </ul>
                    <footer class="tray-footer">
                      <span class="tray-hint">{t('tray.footerHint')}</span>
                      <button class="tray-open" onClick={openApp}>
                        <ExternalLink size={14} /> {t('tray.openAgate')}
                      </button>
                    </footer>
                  </>
                }
              >
                {/* Add-login form: quick capture with generation, dedupe hints
                    and a reused-password callout. Anything richer (folders,
                    custom fields, …) belongs to the main window's editor. */}
                <div class="tray-add-head">
                  <Plus size={14} />
                  <span class="tray-add-title">{t('tray.newLogin')}</span>
                  <button
                    class="tray-fill-cancel"
                    title={t('common.cancel')}
                    onClick={() => store.exitAdd()}
                  >
                    <X size={14} />
                  </button>
                </div>
                <form
                  class="tray-add-form"
                  onSubmit={(e) => {
                    e.preventDefault();
                    void saveNewLogin();
                  }}
                >
                  <input
                    ref={nameEl}
                    placeholder={t('common.name')}
                    value={store.draft().name}
                    onInput={(e) => store.setDraft({ name: e.currentTarget.value })}
                  />
                  <input
                    placeholder={t('common.username')}
                    autocomplete="off"
                    value={store.draft().username}
                    onInput={(e) => store.setDraft({ username: e.currentTarget.value })}
                  />
                  <div class="tray-add-password">
                    <input
                      type={revealPw() ? 'text' : 'password'}
                      placeholder={t('common.password')}
                      autocomplete="new-password"
                      value={store.draft().password}
                      onInput={(e) => store.setDraft({ password: e.currentTarget.value })}
                    />
                    <button
                      type="button"
                      title={revealPw() ? t('common.hide') : t('common.show')}
                      onClick={() => setRevealPw((v) => !v)}
                    >
                      {revealPw() ? <EyeOff size={14} /> : <Eye size={14} />}
                    </button>
                    <button
                      type="button"
                      title={t('tray.generatePassword')}
                      onClick={() => void store.generateDraftPassword()}
                    >
                      <RefreshCw size={14} />
                    </button>
                  </div>
                  <Show when={store.draft().password.length > 0 && store.strength() !== null}>
                    <div class="tray-strength" classList={{ [`s${store.strength()}`]: true }}>
                      <div class="tray-strength-track">
                        <div class="tray-strength-fill" />
                      </div>
                      <span class="tray-strength-label">
                        {strengthLabel(store.strength() ?? 0)}
                      </span>
                    </div>
                  </Show>
                  <Show when={store.reuseCount() > 0}>
                    <div class="tray-add-callout warn">
                      <ShieldAlert size={13} />
                      <span>{t('tray.passwordReused', { count: store.reuseCount() })}</span>
                    </div>
                  </Show>
                  <div class="tray-add-website">
                    <span class="tray-add-website-icon">
                      <Show
                        when={showFavicons() && store.draft().uri.trim().length > 0}
                        fallback={<Globe size={14} />}
                      >
                        <Favicon
                          uri={store.draft().uri}
                          size={14}
                          fallback={<Globe size={14} />}
                        />
                      </Show>
                    </span>
                    <input
                      placeholder={t('column.website')}
                      autocomplete="off"
                      value={store.draft().uri}
                      onInput={(e) => {
                        const uri = e.currentTarget.value;
                        // Guess the name from the site while it's still untouched.
                        if (!store.draft().name.trim())
                          store.setDraft({ uri, name: loginNameFromUri(uri) });
                        else store.setDraft({ uri });
                      }}
                    />
                  </div>
                  <Show when={store.similar().length > 0}>
                    <div class="tray-add-callout info">
                      <div class="tray-add-callout-head">
                        <Info size={13} />
                        <span>{t('tray.similarExisting')}</span>
                      </div>
                      <ul class="tray-add-similar">
                        <For each={store.similar()}>
                          {(it) => (
                            <li>
                              <span class="tray-name">{it.name}</span>
                              <Show when={it.username}>
                                <span class="tray-username">{it.username}</span>
                              </Show>
                            </li>
                          )}
                        </For>
                      </ul>
                    </div>
                  </Show>
                  <Show when={store.accounts().length > 1}>
                    <select
                      class="tray-add-account"
                      value={store.account()}
                      onChange={(e) => store.setAccount(e.currentTarget.value)}
                    >
                      <For each={store.accounts()}>
                        {(email) => <option value={email}>{email}</option>}
                      </For>
                    </select>
                  </Show>
                  <Show when={store.accounts().length === 0}>
                    <div class="tray-add-callout warn">
                      <ShieldAlert size={13} />
                      <span>{t('tray.noUnlockedAccount')}</span>
                    </div>
                  </Show>
                  <button
                    type="submit"
                    class="tray-unlock-btn"
                    disabled={
                      store.saving() || !store.draft().name.trim() || store.accounts().length === 0
                    }
                  >
                    <Plus size={14} />
                    {store.saving() ? t('tray.saving') : t('tray.saveLogin')}
                  </button>
                </form>
              </Show>
            }
          >
            {/* Autofill fill mode: a login field was detected in another app.
                Matches → a list (window sized to it); no match → a brief note
                that auto-dismisses. */}
            <Show
              when={(store.pending()?.candidates.length ?? 0) > 0}
              fallback={
                <div
                  class="tray-fill-empty"
                  onMouseEnter={() => clearTimeout(emptyHideTimer)}
                >
                  <AppWindow size={18} />
                  <span>{t('autofill.noneFound', { target: fillTargetLabel() })}</span>
                  <button class="tray-add-from-app" onClick={() => void addFromDetection()}>
                    <Plus size={14} /> {t('tray.addLogin')}
                  </button>
                </div>
              }
            >
              <div class="tray-fill-target">
                <AppWindow size={14} />
                <span class="tray-fill-target-name" title={fillTargetLabel()}>
                  {t('autofill.fillInto', { target: fillTargetLabel() })}
                </span>
                <button class="tray-fill-cancel" title={t('common.cancel')} onClick={cancelFill}>
                  <X size={14} />
                </button>
              </div>
              <ul class="tray-list" ref={listEl}>
                <For each={store.fillRows()}>{fillRow}</For>
              </ul>
            </Show>
          </Show>
        </Show>
      </Show>
      <Show when={justUnlocked()}>
        <div class="tray-unlock-flash" aria-hidden="true">
          <span class="tray-unlock-flash-icon">
            <LockOpen size={24} />
          </span>
          <span class="tray-unlock-flash-text">{t('unlock.vaultUnlocked')}</span>
        </div>
      </Show>
      <ToastHost />
    </div>
  );
}
