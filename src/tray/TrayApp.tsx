// Root component of the tray quick-access popup (window label "tray"): a
// compact search-and-copy surface over the unified vault list. Renders instead
// of <App/> when main.tsx detects the popup window. All state lives in the
// injectable trayStore; this file is wiring + presentation.
//
// Lifecycle: the popup is shown/hidden by the Rust tray module — every show
// focuses the window, so `focus` doubles as "refresh session + items and grab
// the search box". The popup hides on focus loss (a click anywhere outside it),
// plus the tray icon (toggle), Escape, or a close request — EXCEPT while the
// add/edit-login form is open, which PINS it (`ipc.setTrayPinned`, mirroring
// `store.addMode`) so a stray click can't discard a half-typed login. Hiding
// keeps everything (query, scroll, selection, items): reopening must feel like
// the popup never went away. Because the pinned form can stay visible while the
// main window locks/unlocks, it also refreshes on the backend's
// `agate://session-changed` broadcast, dropping items the moment the session
// locks.

import { createEffect, createMemo, createSignal, For, Match, on, onCleanup, onMount, Show, Switch } from 'solid-js';
import { Dynamic } from 'solid-js/web';
import { getCurrentWindow } from '@tauri-apps/api/window';
import { listen } from '@tauri-apps/api/event';
import {
  AppWindow,
  ArrowLeft,
  Eye,
  EyeOff,
  Fingerprint,
  Globe,
  Info,
  KeyRound,
  LockKeyhole,
  LockOpen,
  Pencil,
  Plus,
  RefreshCw,
  Save,
  Search,
  Settings as SettingsIcon,
  ShieldAlert,
  ShieldCheck,
  Star,
  Timer,
  Trash2,
  UserRound,
  Users,
  Wand2,
  X,
} from 'lucide-solid';
import ToastHost from '../components/Toast.tsx';
import Favicon from '../components/Favicon.tsx';
import CopyButton from '../components/CopyButton.tsx';
import { Dropdown } from '../components/Dropdown.tsx';
import { Switch as ToggleSwitch } from '../components/settings/SettingsControls.tsx';
import { ipc } from '../lib/ipc.ts';
import { t } from '../lib/i18n.ts';
import { copyWithAutoClear } from '../lib/clipboard.ts';
import { typeIcon } from '../lib/vaultIcons.ts';
import { accountColorVar } from '../lib/accountColor.ts';
import { pushToast, toastError } from '../state/toast.ts';
import { syncThemeFromStorage } from '../state/theme.ts';
import { recordRecent } from '../state/recentItems.ts';
import { readColumnConfig } from '../state/columnConfig.ts';
import { clearGeneratorHistory } from '../state/generatorHistory.ts';
import { lockOnMinimize } from '../state/autolock.ts';
import { defaultAccount } from '../state/defaultAccount.ts';
import { useAutoLock } from '../hooks/useAutoLock.ts';
import { UNLOCK_BEAT_MS } from '../lib/unlockBeat.ts';
import type { VaultItem } from '../lib/types.ts';
import TrayOnboarding from './views/TrayOnboarding.tsx';
import TrayVaults from './views/TrayVaults.tsx';
import TraySettings from './views/TraySettings.tsx';
import TrayGenerator from './views/TrayGenerator.tsx';
import TrayDetail from './views/TrayDetail.tsx';
import {
  copyActionForKey,
  createTrayStore,
  draftFromContext,
  fillTargetLabel as fillTargetLabelOf,
  loginNameFromUri,
} from './trayStore.ts';
import './TrayApp.css';

/** The popup's top-level views. `list` is home; the others render over it with a
 *  back header and pin the popup against click-outside-to-hide. */
type TrayView = 'list' | 'detail' | 'generator' | 'vaults' | 'settings';

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
  const [view, setView] = createSignal<TrayView>('list');
  const [detailItem, setDetailItem] = createSignal<VaultItem | null>(null);

  /** Open the full detail view for one item (row click, or a reprompt-blocked
   *  copy — the detail view owns the app-password gate). */
  function openDetail(item: VaultItem) {
    setDetailItem(item);
    setView('detail');
  }

  const store = createTrayStore({
    ipc,
    copy: copyWithAutoClear,
    // Copies count as "used" for the recents ranking (shared localStorage). The
    // popup's own list order deliberately ignores recency — rows must not jump
    // right after a copy.
    onUsed: (item) => recordRecent(item.id),
    onError: toastError,
    // A reprompt-protected copy routes to the detail view, whose app-password
    // gate (RepromptGate) is the ONE reprompt path. The fill flow has no item
    // to open — it just explains itself.
    onRepromptBlocked: (item) => {
      if (item) openDetail(item);
      else pushToast('info', t('tray.repromptBlocked'));
    },
    // Connections still needing 2FA after an unlock are finished in the Vaults
    // view — take the user straight there.
    onTwoFactorPending: (emails) => {
      pushToast('info', t('tray.twoFactorPending', { emails: emails.join(', ') }));
      setView('vaults');
    },
    // The add form preselects the vault the user pinned as default in Vaults.
    defaultAccount,
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

  /** Lock everything: backend lock, drop session-only buffers, back to home. */
  async function doLock() {
    try {
      await ipc.lock();
      clearGeneratorHistory(); // session-only secrets die with the session
      setView('list');
      setDetailItem(null);
      store.setShowTrash(false);
      await store.refresh();
    } catch (err) {
      toastError(err);
    }
  }

  // Idle vault timeout (Settings → Security). The minimize arm is meaningless
  // for the popup; lock-on-hide below covers "the popup went away".
  useAutoLock({ unlocked: store.unlocked, lock: () => void doLock() });

  // Leave trash mode the moment it empties (the last item was restored or purged)
  // so the user lands back on the live list instead of an empty trash.
  createEffect(() => {
    if (store.showTrash() && store.trashCount() === 0) store.setShowTrash(false);
  });

  // Optional hard mode: lock the moment the popup hides (Settings → Security).
  // visibilitychange (not blur) so a pinned-but-unfocused popup stays unlocked.
  onMount(() => {
    const onVisibility = () => {
      if (document.visibilityState === 'hidden' && lockOnMinimize() && store.unlocked()) {
        void doLock();
      }
    };
    document.addEventListener('visibilitychange', onVisibility);
    onCleanup(() => document.removeEventListener('visibilitychange', onVisibility));
  });

  /** The app a fill would land in (window title, else process name). */
  const fillTargetLabel = () =>
    fillTargetLabelOf(store.pending()?.context) ?? t('autofill.unknownTarget');

  // A login the user reached via their OWN search in fill mode, awaiting the
  // "remember this site for it?" decision before the fill goes through. Null
  // otherwise (an auto-matched pick fills straight away).
  const [fillChoice, setFillChoice] = createSignal<VaultItem | null>(null);
  // Drop a stale choice whenever fill mode ends (filled, dismissed, or the detection
  // cleared) so it never lingers into the next detection.
  createEffect(on(() => store.fillMode(), (active) => !active && setFillChoice(null)));

  /** Fill mode but nothing in the (pre-filtered) list matches the detected target —
   *  the cue to offer "save a new login here" (browsers' save-password prompt).
   *  Keyed on the visible list so the offer never contradicts a shown candidate. */
  const noVaultMatch = () => store.fillMode() && store.filtered().length === 0;

  /** Cancel an autofill prompt: drop the backend detection and hide the popup. */
  function cancelFill() {
    store.exitFill();
    void ipc.hideTrayWindow().catch(toastError);
  }

  // The popup is a single fixed-size surface (380×520, set in tauri.conf.json):
  // autofill no longer resizes it into a compact chooser — it shows the normal
  // list with a pre-applied filter — so there is exactly one window size.

  // Pin the popup against click-outside-to-hide while any form-bearing surface
  // is up: the add/edit-login form, every non-list view (settings, vaults,
  // generator, detail — half-typed input must survive a stray click), and the
  // first-run onboarding. Only the plain list (and the locked unlock form)
  // hides on focus loss. The backend owns the actual hide (it watches the OS
  // focus event) — here we just mirror the pin flag.
  createEffect(() => {
    const pinned =
      store.addMode() ||
      view() !== 'list' ||
      (store.ready() && !store.unlocked() && !store.appUnlockConfigured());
    void ipc.setTrayPinned(pinned).catch(toastError);
  });

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
    // Focus + select the search so typing starts fresh — including the filter
    // pre-applied in fill mode, which a keystroke then replaces to search wider.
    searchEl?.focus();
    searchEl?.select();
  }

  // ── Add-login form wiring ───────────────────────────────────────────────────

  async function openAdd() {
    setRevealPw(false);
    await store.enterAdd();
    nameEl?.focus();
  }

  /** Open the edit form for an existing login (reprompt / non-login items defer
   *  to the main window — enterEdit no-ops and leaves the list view up). */
  async function openEdit(item: VaultItem) {
    setRevealPw(false);
    await store.enterEdit(item);
    if (store.addMode()) nameEl?.focus();
  }

  /** From a detected-but-unmatched autofill target: drop the detection and open
   *  the add form seeded with that app's website + a guessed name, so a missing
   *  login is captured in one step instead of being a dead end. */
  async function addFromDetection() {
    setRevealPw(false);
    const ctx = store.pending()?.context ?? null;
    store.exitFill();
    await store.enterAdd(draftFromContext(ctx));
    nameEl?.focus();
  }

  // Provider-specific grouping labels: Bitwarden organizes into "folders",
  // KeePass into "groups". The picker + its root option follow the destination.
  const groupingLabel = () =>
    store.accountKind() === 'keepass' ? t('tray.group') : t('tray.folder');
  const rootGroupingLabel = () =>
    store.accountKind() === 'keepass' ? t('tray.noGroup') : t('tray.noFolder');

  async function saveLogin() {
    const wasEdit = store.editing() !== null;
    if (await store.save()) {
      pushToast('success', wasEdit ? t('tray.loginUpdated') : t('tray.loginSaved'));
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
  // the time we scroll it into view. The one list serves both copy and fill.
  const move = (delta: number, length: number) => {
    setSelected((i) => Math.max(0, Math.min(i + delta, Math.max(length - 1, 0))));
    listEl?.querySelector('.selected')?.scrollIntoView({ block: 'nearest' });
  };

  function onKeyDown(e: KeyboardEvent) {
    // While locked the only global key is Escape — Enter must keep submitting
    // the unlock form, not get preventDefault-ed away here.
    if (e.key === 'Escape') {
      // A pending "remember this site?" prompt backs out to the fill list first.
      if (fillChoice()) setFillChoice(null);
      else if (store.fillMode()) cancelFill();
      else if (store.addMode()) store.exitAdd();
      else if (view() !== 'list') {
        setView('list');
        setDetailItem(null);
      } else if (store.showTrash()) store.setShowTrash(false);
      else void ipc.hideTrayWindow().catch(toastError);
      return;
    }
    if (!store.unlocked()) return;

    // Add form + sub-views own their keyboard (Enter submits natively) — only
    // Escape (handled above) is global, mirroring the locked unlock form.
    if (store.addMode() || view() !== 'list') return;

    const list = store.filtered();

    // Fill mode: the list is filtered to the detected target; Enter picks the
    // selected login to fill instead of copying it. With a "remember this site?"
    // prompt open, Enter takes the recommended path (remember + fill).
    if (store.fillMode()) {
      const choice = fillChoice();
      switch (e.key) {
        case 'ArrowDown':
          e.preventDefault();
          if (!choice) move(1, list.length);
          break;
        case 'ArrowUp':
          e.preventDefault();
          if (!choice) move(-1, list.length);
          break;
        case 'Enter': {
          e.preventDefault();
          if (choice) resolveFillChoice(choice, true);
          else {
            const item = list[selected()];
            if (item) pickForFill(item);
          }
          break;
        }
      }
      return;
    }

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
    // popup by the tray. Refresh session state, then enter fill mode — the normal
    // list with a pre-applied filter (the window size never changes). Force the
    // list view so the fill banner + list are what shows, not a stale sub-view.
    const unlistenDetected = listen('autofill://detected', () => {
      void (async () => {
        await store.refresh();
        await store.syncFill();
        setView('list');
        setDetailItem(null);
        store.setShowTrash(false);
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

  const fillTarget = (item: VaultItem) => ({
    accountEmail: item.accountEmail,
    itemId: item.id,
    reprompt: item.reprompt,
    hasTotp: item.hasTotp,
  });

  /** Pick a login to fill (fill mode only; logins only). An auto-matched pick (no
   *  manual search) fills straight away. A login the user found via their OWN search
   *  presumably doesn't match this site yet, so — when there's a target to remember —
   *  first ask whether to remember it (the confirm banner), instead of filling. */
  const pickForFill = (item: VaultItem) => {
    if (item.itemType !== 'login') return;
    if (!item.reprompt && store.userSearchedInFill() && store.canRemember()) {
      setFillChoice(item);
      return;
    }
    void store.fill(fillTarget(item));
  };

  /** Resolve the "remember this site?" prompt: fill, optionally remembering first. */
  const resolveFillChoice = (item: VaultItem, remember: boolean) => {
    setFillChoice(null);
    void store.fill(fillTarget(item), remember);
  };

  // One row for both modes: normally a click opens the detail view; while a fill
  // is pending it injects the login into the detected target instead.
  const row = (item: VaultItem, index: () => number) => (
    <li
      class="tray-row"
      classList={{ selected: index() === selected() }}
      onMouseEnter={() => setSelected(index())}
      onClick={() => (store.fillMode() ? pickForFill(item) : openDetail(item))}
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
      {/* Action clicks must not bubble into the row's open-detail / fill click. */}
      <span class="tray-actions" onClick={(e) => e.stopPropagation()}>
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
          <button title={t('tray.editLogin')} onClick={() => void openEdit(item)}>
            <Pencil size={14} />
          </button>
        </Show>
      </span>
    </li>
  );

  return (
    <div class="tray-app" classList={{ 'just-unlocked': justUnlocked() }}>
      <Show when={store.ready()} fallback={<div class="tray-status">{t('common.loading')}</div>}>
        <Show
          when={store.unlocked()}
          fallback={
            <Show
              when={store.appUnlockConfigured()}
              fallback={
                <TrayOnboarding
                  onDone={() => {
                    void store.refresh().then(() => setView('vaults'));
                  }}
                />
              }
            >
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
            </div>
            </Show>
          }
        >
          <Show
            when={store.addMode()}
            fallback={
              <Switch>
                <Match when={view() === 'detail' && detailItem()}>
                  {(item) => (
                    <TrayDetail
                      item={item()}
                      onBack={() => {
                        setView('list');
                        setDetailItem(null);
                      }}
                      onEdit={(it) => {
                        setView('list');
                        setDetailItem(null);
                        void openEdit(it);
                      }}
                      onChanged={() => void store.refresh()}
                    />
                  )}
                </Match>
                <Match when={view() === 'generator'}>
                  <TrayGenerator onBack={() => setView('list')} />
                </Match>
                <Match when={view() === 'vaults'}>
                  <TrayVaults onBack={() => setView('list')} />
                </Match>
                <Match when={view() === 'settings'}>
                  <div class="tray-subhead">
                    <button
                      class="tray-subhead-back"
                      title={t('common.back')}
                      onClick={() => setView('list')}
                    >
                      <ArrowLeft size={15} />
                    </button>
                    <span class="tray-subhead-title">{t('settings.title')}</span>
                  </div>
                  <TraySettings onBack={() => setView('list')} />
                </Match>
                <Match when={view() === 'list'}>
                  {/* Fill mode: a login field was detected in another app. The list is
                      filtered to that target SECRETLY (the search box stays empty —
                      see syncFill); this banner names the target a click would fill,
                      and lets the user abort (✕ / Esc). */}
                  <Show when={store.fillMode()}>
                    <div class="tray-fill-target">
                      <AppWindow size={14} />
                      <span class="tray-fill-target-name" title={fillTargetLabel()}>
                        {t('autofill.fillInto', { target: fillTargetLabel() })}
                      </span>
                      <button
                        class="tray-fill-cancel"
                        title={t('common.cancel')}
                        onClick={cancelFill}
                      >
                        <X size={14} />
                      </button>
                    </div>
                  </Show>
                  {/* The user reached a login via their OWN search (so it likely
                      doesn't match this site yet): before filling, ask whether to
                      remember the site for it. "Remember & fill" stores the site's
                      domain on the login; "Just fill" fills without remembering. */}
                  <Show when={store.fillMode() && fillChoice()}>
                    {(item) => (
                      <div class="tray-fill-remember">
                        <span class="tray-fill-remember-text">
                          {t('autofill.rememberPrompt', {
                            name: item().name,
                            target: fillTargetLabel(),
                          })}
                        </span>
                        <div class="tray-fill-remember-actions">
                          <button
                            class="tray-fill-remember-yes"
                            disabled={store.filling()}
                            onClick={() => resolveFillChoice(item(), true)}
                          >
                            {t('autofill.rememberAndFill')}
                          </button>
                          <button
                            class="tray-fill-remember-no"
                            disabled={store.filling()}
                            onClick={() => resolveFillChoice(item(), false)}
                          >
                            {t('autofill.justFill')}
                          </button>
                        </div>
                      </div>
                    )}
                  </Show>
                  {/* No vault login matched the detected target — offer to save a
                      new one (the browser-style "save this login?" prompt),
                      prefilled with the site + the username we read. */}
                  <Show when={noVaultMatch()}>
                    <div class="tray-fill-save">
                      <span class="tray-fill-save-text">
                        {t('autofill.noneFound', { target: fillTargetLabel() })}
                      </span>
                      <button
                        class="tray-fill-save-btn"
                        onClick={() => void addFromDetection()}
                      >
                        <Save size={13} />
                        {t('autofill.saveLogin')}
                      </button>
                    </div>
                  </Show>
                  {/* Trash mode: the same list over the trashed items, with a
                      header to step back to the live vault. The row → detail
                      path is where Restore / Delete-permanently live. */}
                  <Show when={store.showTrash()}>
                    <div class="tray-trash-bar">
                      <Trash2 size={14} />
                      <span class="tray-trash-bar-name">{t('tray.trash')}</span>
                      <button
                        class="tray-fill-cancel"
                        title={t('common.back')}
                        onClick={() => store.setShowTrash(false)}
                      >
                        <ArrowLeft size={14} />
                      </button>
                    </div>
                  </Show>
                  {/* Hidden while the "remember this site?" prompt is up, so that
                      decision is a focused step rather than a searchable list. */}
                  <Show when={!fillChoice()}>
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
                      <Show when={!store.showTrash()}>
                        <button
                          class="tray-add-btn"
                          title={t('tray.addLogin')}
                          onClick={() => void (store.fillMode() ? addFromDetection() : openAdd())}
                        >
                          <Plus size={15} />
                        </button>
                      </Show>
                    </div>
                    <ul class="tray-list" ref={listEl}>
                      <For
                        each={store.filtered()}
                        fallback={<li class="tray-status">{t('tray.noMatches')}</li>}
                      >
                        {row}
                      </For>
                    </ul>
                  </Show>
                  {/* Entry into the trash — only when something is in it, and not
                      while autofill is mid-pick. */}
                  <Show when={!store.showTrash() && !store.fillMode() && store.trashCount() > 0}>
                    <button
                      class="tray-trash-toggle"
                      onClick={() => {
                        store.setShowTrash(true);
                        setSelected(0);
                      }}
                    >
                      <Trash2 size={13} />
                      {t('tray.trash')} ({store.trashCount()})
                    </button>
                  </Show>
                  <footer class="tray-footer">
                    <div class="tray-footer-nav">
                      <button
                        class="tray-footer-btn"
                        title={t('generator.title')}
                        onClick={() => setView('generator')}
                      >
                        <Wand2 size={15} />
                      </button>
                      <button
                        class="tray-footer-btn"
                        title={t('trayVaults.title')}
                        onClick={() => setView('vaults')}
                      >
                        <Users size={15} />
                      </button>
                      <button
                        class="tray-footer-btn"
                        title={t('settings.title')}
                        onClick={() => setView('settings')}
                      >
                        <SettingsIcon size={15} />
                      </button>
                    </div>
                    <button class="tray-footer-btn tray-footer-lock" title={t('tray.lock')} onClick={() => void doLock()}>
                      <LockKeyhole size={15} />
                    </button>
                  </footer>
                </Match>
              </Switch>
            }
          >
            {/* Add/edit-login form: quick capture (or a quick edit of the
                four exposed fields) with generation, dedupe hints and a
                reused-password callout. Anything richer (folders, custom
                fields, …) belongs to the main window's editor; an edit here
                preserves those untouched (see buildEditInput). */}
            <div class="tray-add-head">
              <Show when={store.editing()} fallback={<Plus size={14} />}>
                <Pencil size={14} />
              </Show>
              <span class="tray-add-title">
                {store.editing() ? t('tray.editLogin') : t('tray.newLogin')}
              </span>
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
                void saveLogin();
              }}
            >
              {/* Destination: WHERE the item is created. Create-only — an edit is
                  pinned to the item's existing vault (an item can't move across
                  providers here). The picker lists only writable, unlocked
                  connections, so the rest of the form can be provider-specific. */}
              <Show when={!store.editing()}>
                <Show
                  when={store.accounts().length > 0}
                  fallback={
                    <div class="tray-add-callout warn">
                      <ShieldAlert size={13} />
                      <span>{t('tray.noUnlockedAccount')}</span>
                    </div>
                  }
                >
                  <div class="tray-add-field">
                    <span class="tray-add-field-label">{t('tray.destinationVault')}</span>
                    <Dropdown
                      ariaLabel={t('tray.destinationVault')}
                      value={store.account()}
                      onChange={(v) => store.setAccount(v)}
                      options={store.accounts().map((email) => ({
                        value: email,
                        label: store.accountLabel(email),
                      }))}
                    />
                  </div>
                </Show>
              </Show>

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
              {/* Dedupe hints are for capturing NEW logins; on an edit the
                  item's own stored password would always read as "reused",
                  so hide the callout. */}
              <Show when={!store.editing() && store.reuseCount() > 0}>
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
              {/* TOTP authenticator key — both writable providers store one. */}
              <div class="tray-add-totp">
                <KeyRound size={14} />
                <input
                  placeholder={t('tray.totpKey')}
                  autocomplete="off"
                  value={store.draft().totp}
                  onInput={(e) => store.setDraft({ totp: e.currentTarget.value })}
                />
              </div>
              {/* Notes — both providers. */}
              <textarea
                class="tray-add-notes"
                placeholder={t('tray.notes')}
                rows={2}
                value={store.draft().notes}
                onInput={(e) => store.setDraft({ notes: e.currentTarget.value })}
              />
              <Show when={!store.editing() && store.similar().length > 0}>
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
              {/* Grouping within the chosen vault: a Bitwarden "folder" or a
                  KeePass "group", labeled for the destination's provider. Hidden
                  when the vault has none — there's only the root to pick. */}
              <Show when={store.folderOptions().length > 0}>
                <div class="tray-add-field">
                  <span class="tray-add-field-label">{groupingLabel()}</span>
                  <Dropdown
                    ariaLabel={groupingLabel()}
                    value={store.folderId() ?? ''}
                    onChange={(v) => store.setFolderId(v || null)}
                    options={[
                      { value: '', label: rootGroupingLabel() },
                      ...store.folderOptions().map((f) => ({ value: f.id ?? '', label: f.name })),
                    ]}
                  />
                </div>
              </Show>
              {/* WHERE a NEW Bitwarden item is stored: the organization (personal
                  vault, or one the account belongs to) and — for an org — which
                  collection. An org cipher must live in a collection, so picking an
                  org auto-selects its first. Create-only (a move is the main
                  client's job) and Bitwarden-only — KeePass has no orgs/collections. */}
              <Show
                when={
                  !store.editing() &&
                  store.accountKind() === 'bitwarden' &&
                  store.organizationOptions().length > 0
                }
              >
                <div class="tray-add-field">
                  <span class="tray-add-field-label">{t('tray.organization')}</span>
                  <Dropdown
                    ariaLabel={t('tray.organization')}
                    value={store.organizationId() ?? ''}
                    onChange={(v) => store.setOrganization(v || null)}
                    options={[
                      { value: '', label: t('tray.personalVault') },
                      ...store.organizationOptions().map((o) => ({
                        value: o.id,
                        label: o.name || t('tray.unnamedOrganization'),
                      })),
                    ]}
                  />
                </div>
                <Show when={store.organizationId() !== null && store.collectionOptions().length > 0}>
                  <div class="tray-add-field">
                    <span class="tray-add-field-label">{t('tray.collection')}</span>
                    <Dropdown
                      ariaLabel={t('tray.collection')}
                      value={store.collectionId() ?? ''}
                      onChange={(v) => store.setCollectionId(v || null)}
                      options={store.collectionOptions().map((c) => ({ value: c.id, label: c.name }))}
                    />
                  </div>
                </Show>
              </Show>
              {/* Favorite (both providers) + require-master-password ("reprompt",
                  a Bitwarden-only abstraction — KeePass has no per-item gate). */}
              <div class="tray-add-toggles">
                <div class="tray-add-toggle">
                  <Star size={14} />
                  <span>{t('tray.favorite')}</span>
                  <ToggleSwitch
                    checked={store.draft().favorite}
                    onChange={(v) => store.setDraft({ favorite: v })}
                    label={t('tray.favorite')}
                  />
                </div>
                <Show when={store.accountKind() === 'bitwarden'}>
                  <div class="tray-add-toggle">
                    <ShieldCheck size={14} />
                    <span>{t('tray.requireMasterPassword')}</span>
                    <ToggleSwitch
                      checked={store.draft().reprompt}
                      onChange={(v) => store.setDraft({ reprompt: v })}
                      label={t('tray.requireMasterPassword')}
                    />
                  </div>
                </Show>
              </div>
              <button
                type="submit"
                class="tray-unlock-btn"
                disabled={
                  store.saving() || !store.draft().name.trim() || store.accounts().length === 0
                }
              >
                <Show when={store.editing()} fallback={<Plus size={14} />}>
                  <Pencil size={14} />
                </Show>
                {store.saving()
                  ? t('tray.saving')
                  : store.editing()
                    ? t('tray.saveChanges')
                    : t('tray.saveLogin')}
              </button>
            </form>
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
