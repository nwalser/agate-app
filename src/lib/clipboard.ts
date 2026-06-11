// The ONE clipboard copy path: write + record copy feedback + (for secrets) auto-clear
// after the Settings → Security delay (state/clipboard.ts). Every copy in the app
// (vault fields, TOTP codes, the MCP bearer token, usernames, websites) goes
// through this so no secret lingers on the clipboard past the user's chosen window.
// Only *secret* values auto-clear; non-secret values (username, website, …) stay
// until the user replaces them — see NON_SECRET_LABELS.
//
// Success is shown by animation, not a toast: noteCopied feeds the copyFeedback
// store, which drives the value-pop + the live clipboard-wipe countdown on copy
// buttons (state/copyFeedback.ts). Only errors still surface as a toast.

import { readText, writeText } from '@tauri-apps/plugin-clipboard-manager';
import { toastError } from '../state/toast.ts';
import { clipboardClearSeconds } from '../state/clipboard.ts';
import { noteCopied, endCopy } from '../state/copyFeedback.ts';

// Labels whose values are NOT secret — copying them must never auto-clear (a
// username or website you copied should stay until you replace it). Everything
// else clears: the default is to wipe, so an unknown label (e.g. a hidden custom
// field, the card PAN/CVV, a token) errs on the side of clearing.
const NON_SECRET_LABELS = new Set<string>([
  'Username',
  'Website',
  'URL',
  'Folder',
  'Public key',
  'Fingerprint',
  'Cardholder',
]);

export async function copyWithAutoClear(label: string, value: string | null | undefined) {
  if (!value) return;
  try {
    await writeText(value);
    // Seconds before a copied secret is wiped from the clipboard (0 = never),
    // configurable in Settings → Security. Non-secret values never auto-clear.
    const clearSeconds = NON_SECRET_LABELS.has(label) ? 0 : clipboardClearSeconds();
    const token = noteCopied(clearSeconds);
    if (clearSeconds <= 0) return;
    const copied = value;
    // Auto-clear, but only if the clipboard still holds what we wrote (don't
    // clobber something the user copied afterwards). Either way, end this copy's
    // countdown so the UI reverts the moment the wipe lands.
    setTimeout(() => {
      void (async () => {
        try {
          if ((await readText()) === copied) await writeText('');
        } catch {
          // ignore: clipboard may be unavailable or hold non-text content
        }
        endCopy(token);
      })();
    }, clearSeconds * 1000);
  } catch (err) {
    toastError(err);
  }
}
