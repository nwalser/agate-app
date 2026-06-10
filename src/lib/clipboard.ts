// The ONE clipboard path for copying a secret: write + success toast + auto-clear
// after the Settings → Security delay (state/clipboard.ts). Every secret copy in
// the app (vault fields, TOTP codes, the MCP bearer token) must go through this so
// no secret lingers on the clipboard past the user's chosen window. Non-secret
// copies (URLs, names) may use the plugin's writeText directly.

import { readText, writeText } from '@tauri-apps/plugin-clipboard-manager';
import { pushToast, toastError } from '../state/toast.ts';
import { clipboardClearSeconds } from '../state/clipboard.ts';

export async function copyWithAutoClear(label: string, value: string | null | undefined) {
  if (!value) return;
  try {
    await writeText(value);
    // Seconds before a copied secret is wiped from the clipboard (0 = never),
    // configurable in Settings → Security.
    const clearSeconds = clipboardClearSeconds();
    pushToast(
      'success',
      clearSeconds > 0 ? `${label} copied — clears in ${clearSeconds}s.` : `${label} copied.`,
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
