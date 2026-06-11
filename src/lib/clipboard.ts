// The ONE clipboard copy path: write + success toast + (for secrets) auto-clear
// after the Settings → Security delay (state/clipboard.ts). Every copy in the app
// (vault fields, TOTP codes, the MCP bearer token, usernames, websites) goes
// through this so no secret lingers on the clipboard past the user's chosen window.
// Only *secret* values auto-clear; non-secret values (username, website, …) stay
// until the user replaces them — see NON_SECRET_LABELS.

import { readText, writeText } from '@tauri-apps/plugin-clipboard-manager';
import { pushToast, toastError } from '../state/toast.ts';
import { clipboardClearSeconds } from '../state/clipboard.ts';
import { t } from './i18n.ts';

// Callers pass a stable ENGLISH label (also asserted in tests + used as an
// identifier). Map the known ones to a localized display string for the toast;
// anything not in the map (a custom-field name, an already-localized label) is
// shown verbatim.
const LABEL_KEYS: Record<string, string> = {
  Username: 'clipboard.labels.username',
  Password: 'clipboard.labels.password',
  'TOTP code': 'clipboard.labels.totpCode',
  Website: 'clipboard.labels.website',
  Folder: 'clipboard.labels.folder',
  Token: 'clipboard.labels.token',
  Command: 'clipboard.labels.command',
  Code: 'clipboard.labels.code',
  URL: 'clipboard.labels.url',
  'Public key': 'clipboard.labels.publicKey',
  Fingerprint: 'clipboard.labels.fingerprint',
  'Private key': 'clipboard.labels.privateKey',
  Number: 'clipboard.labels.number',
  Cardholder: 'clipboard.labels.cardholder',
  'Security code': 'clipboard.labels.securityCode',
};

function displayLabel(label: string): string {
  const key = LABEL_KEYS[label];
  return key ? t(key) : label;
}

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
    const dl = displayLabel(label);
    pushToast(
      'success',
      clearSeconds > 0
        ? t('clipboard.copiedClears', { label: dl, seconds: clearSeconds })
        : t('clipboard.copied', { label: dl }),
    );
    if (clearSeconds <= 0) return;
    const copied = value;
    // Auto-clear, but only if the clipboard still holds what we wrote (don't
    // clobber something the user copied afterwards).
    setTimeout(() => {
      void (async () => {
        try {
          if ((await readText()) === copied) await writeText('');
        } catch {
          // ignore: clipboard may be unavailable or hold non-text content
        }
      })();
    }, clearSeconds * 1000);
  } catch (err) {
    toastError(err);
  }
}
