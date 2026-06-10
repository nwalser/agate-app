// Clipboard auto-clear preference. Not a secret — a non-secret UI/privacy pref,
// so it lives in localStorage (like the theme), never the keychain. Controls how
// many seconds a copied secret (password, TOTP, …) stays on the clipboard before
// Agate wipes it. `0` means never auto-clear.

import { createPersistedStore, parseOneOf } from './persisted.ts';

// Closed set of offered delays in seconds; `0` = never auto-clear. Picking from a
// fixed set (not a free-form number) keeps the storage trust boundary trivial to
// validate and matches the picker in Settings → Security.
export const CLIPBOARD_CLEAR_OPTIONS = [10, 15, 30, 60, 0] as const;
export type ClipboardClearSeconds = (typeof CLIPBOARD_CLEAR_OPTIONS)[number];

const store = createPersistedStore<ClipboardClearSeconds>({
  key: 'agate.clipboardClearSeconds',
  parse: parseOneOf(CLIPBOARD_CLEAR_OPTIONS),
  fallback: () => 15,
  raw: true, // legacy format: the bare number as a string
});

export const clipboardClearSeconds = store.value;

export function setClipboardClearSeconds(seconds: ClipboardClearSeconds) {
  store.set(seconds);
}
