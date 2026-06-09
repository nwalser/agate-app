// Clipboard auto-clear preference. Not a secret — a non-secret UI/privacy pref,
// so it lives in localStorage (like the theme), never the keychain. Controls how
// many seconds a copied secret (password, TOTP, …) stays on the clipboard before
// Agate wipes it. `0` means never auto-clear.

import { createSignal } from 'solid-js';

// Closed set of offered delays in seconds; `0` = never auto-clear. Picking from a
// fixed set (not a free-form number) keeps the storage trust boundary trivial to
// validate and matches the segmented picker in Settings → Security.
export const CLIPBOARD_CLEAR_OPTIONS = [10, 15, 30, 60, 0] as const;
export type ClipboardClearSeconds = (typeof CLIPBOARD_CLEAR_OPTIONS)[number];

const STORAGE_KEY = 'agate.clipboardClearSeconds';
const DEFAULT: ClipboardClearSeconds = 15;

function isValid(n: number): n is ClipboardClearSeconds {
  return (CLIPBOARD_CLEAR_OPTIONS as readonly number[]).includes(n);
}

// Validate at the storage trust boundary: anything that isn't one of the known
// options (absent key, or a corrupt/tampered value) falls back to the default.
function readStored(): ClipboardClearSeconds {
  try {
    const v = localStorage.getItem(STORAGE_KEY);
    if (v !== null) {
      const n = Number(v);
      if (Number.isFinite(n) && isValid(n)) return n;
    }
  } catch {
    // ignore: localStorage may be unavailable (private mode); use the default
  }
  return DEFAULT;
}

const [clipboardClearSeconds, setSignal] = createSignal<ClipboardClearSeconds>(readStored());

export function setClipboardClearSeconds(seconds: ClipboardClearSeconds) {
  setSignal(seconds);
  try {
    localStorage.setItem(STORAGE_KEY, String(seconds));
  } catch {
    // ignore: persistence is best-effort; the in-memory signal still applies
  }
}

export { clipboardClearSeconds };
