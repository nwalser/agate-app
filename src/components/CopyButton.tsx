// The one copy *button* across the app. No text label by design: it speaks in
// motion. Click → the icon pops to a check (the copy landed) → for a secret it
// then morphs into a live countdown of the seconds left before Agate wipes the
// clipboard, reverting to the copy icon the instant the wipe lands. A non-secret
// copy (username, website, …) just flashes the check — there's nothing to clear.
//
// The countdown is read from the global copyFeedback store, so it's honest and
// shared: it shows only while THIS button's copy is still the active one. Copy
// something else and this button quietly reverts (a newer token wins).
//
// `onCopy` performs the actual copy (a copyWithAutoClear call); the button never
// touches the clipboard itself, keeping clipboard.ts the single copy path.

import { createSignal, onCleanup, Show, type JSX } from 'solid-js';
import { Check, Copy } from 'lucide-solid';
import { t } from '../lib/i18n.ts';
import { copyState } from '../state/copyFeedback.ts';
import './CopyButton.css';

// How long the green check stays before handing off to the countdown / reverting.
const CHECK_MS = 650;

export default function CopyButton(props: {
  /** Performs the copy (e.g. () => copyWithAutoClear('Password', value)). */
  onCopy: () => void | Promise<void>;
  /** Accessible name for the idle copy action (falls back to "Copy"). */
  label?: string;
  /** Extra classes merged onto the button (e.g. host-specific sizing/skin). */
  class?: string;
  /** Icon size in px (default 15). */
  size?: number;
  /** Idle-state icon (defaults to the copy glyph). Lets a host keep a meaningful
   *  glyph — the tray's user/key/clock — while still getting the check + countdown. */
  icon?: JSX.Element;
  disabled?: boolean;
}) {
  const [checking, setChecking] = createSignal(false);
  // The token this button's own copy produced; we only render the countdown while
  // the store still points at it.
  const [myToken, setMyToken] = createSignal<number | null>(null);
  let checkTimer: ReturnType<typeof setTimeout> | undefined;

  const isMine = () => myToken() !== null && copyState().token === myToken();
  const remaining = () => (isMine() ? copyState().remaining : 0);
  const counting = () => !checking() && remaining() > 0;

  async function onClick() {
    if (props.disabled) return;
    const before = copyState().token;
    await props.onCopy();
    const s = copyState();
    // Token unchanged → nothing was copied (empty value); don't flash a false check.
    if (s.token === before) return;
    setMyToken(s.token);
    setChecking(true);
    clearTimeout(checkTimer);
    checkTimer = setTimeout(() => setChecking(false), CHECK_MS);
  }

  onCleanup(() => clearTimeout(checkTimer));

  const title = () =>
    counting()
      ? t('clipboard.clearsIn', { seconds: remaining() })
      : checking()
        ? t('common.copied')
        : (props.label ?? t('common.copy'));

  const size = () => props.size ?? 15;

  return (
    <button
      type="button"
      class={`copy-btn ${props.class ?? ''}`}
      classList={{ 'is-copied': checking(), 'is-counting': counting() }}
      title={title()}
      aria-label={title()}
      disabled={props.disabled}
      onClick={() => void onClick()}
    >
      <Show
        when={counting()}
        fallback={
          <span class="copy-btn-ico">
            <Show
              when={checking()}
              fallback={props.icon ?? <Copy size={size()} strokeWidth={1.75} />}
            >
              <Check size={size()} strokeWidth={2.25} />
            </Show>
          </span>
        }
      >
        <span class="copy-btn-count" aria-hidden="true">
          {remaining()}
        </span>
      </Show>
    </button>
  );
}
