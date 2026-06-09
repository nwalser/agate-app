// Tracks which reprompt ("require master password to view") items the user has
// re-verified during THIS session, so a verified item stays open until the app
// locks. In-memory only — never persisted, and cleared on lock (App.lock), like
// the decrypted vault and the generator history.

import { createSignal } from 'solid-js';

const [verifiedIds, setVerifiedIds] = createSignal<Set<string>>(new Set());

/** Whether this reprompt item has already been re-verified this session. */
export function isReprompted(id: string): boolean {
  return verifiedIds().has(id);
}

/** Mark a reprompt item as verified (reveal/copy allowed until lock). */
export function markReprompted(id: string): void {
  setVerifiedIds((prev) => {
    const next = new Set(prev);
    next.add(id);
    return next;
  });
}

/** Forget all reprompt verifications — call on lock. */
export function clearReprompted(): void {
  setVerifiedIds(new Set<string>());
}
