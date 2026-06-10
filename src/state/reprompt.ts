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

// ── The one reprompt gate ─────────────────────────────────────────────────────
// Every reprompt-protected action in the app (detail pane reveals/copies, list
// cell copies, row context-menu copies) funnels through `guardReprompt`; the
// Vault screen renders a single RepromptGate for whatever is pending. One path —
// no surface can forget to gate by rolling its own modal.

export interface RepromptRequest {
  id: string;
  name: string;
  action: () => void;
}

const [pendingReprompt, setPendingReprompt] = createSignal<RepromptRequest | null>(null);

export { pendingReprompt };

/** Run `action` now unless the item is reprompt-locked; otherwise queue the gate
 *  (the Vault screen's RepromptGate resolves it). */
export function guardReprompt(
  item: { id: string; name: string; reprompt: boolean },
  action: () => void,
): void {
  if (!item.reprompt || isReprompted(item.id)) action();
  else setPendingReprompt({ id: item.id, name: item.name, action });
}

/** Resolve the pending gate: verified runs (and remembers) the action; a cancel
 *  just drops it. */
export function resolvePendingReprompt(verified: boolean): void {
  const p = pendingReprompt();
  setPendingReprompt(null);
  if (p && verified) {
    markReprompted(p.id);
    p.action();
  }
}
