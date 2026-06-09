// Loads the full detail (+ live TOTP) for the currently selected item and drives
// the detail pane. Re-runs whenever the selection changes: it resets the reveal
// toggle, fetches the decrypted detail, and — for logins with a TOTP — starts a
// 1s ticker that counts the code down and refetches when it expires. The ticker
// is torn down on selection change and on unmount. Also derives the per-item
// security verdict shown above a login's fields, read off the offline audit.

import { type Accessor, createEffect, createMemo, createSignal, on, onCleanup } from 'solid-js';
import { ipc } from '../lib/ipc.ts';
import type { ItemDetail, TotpCode, VaultHealthReport } from '../lib/types.ts';
import { itemAuditChips } from '../lib/audit.ts';
import { toastError } from '../state/toast.ts';

export type SelectedSecurity =
  | { kind: 'risk'; chips: { label: string; severe: boolean }[] }
  | { kind: 'ok' }
  | null;

export function useItemDetail(deps: {
  selectedId: Accessor<string | null>;
  accountFor: (id: string) => string;
  health: Accessor<VaultHealthReport | null>;
  inTrash: Accessor<boolean>;
}) {
  const [detail, setDetail] = createSignal<ItemDetail | null>(null);
  const [revealed, setRevealed] = createSignal(false);
  const [totp, setTotp] = createSignal<TotpCode | null>(null);

  // Per-item security audit for the open detail, read off the offline health
  // report (logins only). 'risk' carries the flags to show; 'ok' means audited
  // and clean; null = not a login, in trash, or not yet audited (render nothing).
  const selectedSecurity = createMemo<SelectedSecurity>(() => {
    const d = detail();
    const h = deps.health();
    if (!d || !d.login || deps.inTrash() || !h) return null;
    const audit = h.atRisk.find((x) => x.id === d.id);
    return audit ? { kind: 'risk', chips: itemAuditChips(audit) } : { kind: 'ok' };
  });

  // Load detail + TOTP whenever selection changes.
  let totpTimer: ReturnType<typeof setInterval> | undefined;
  function stopTotp() {
    if (totpTimer) clearInterval(totpTimer);
    totpTimer = undefined;
    setTotp(null);
  }
  onCleanup(stopTotp);

  async function refreshTotp(id: string) {
    try {
      setTotp(await ipc.itemTotp(deps.accountFor(id), id));
    } catch (err) {
      toastError(err);
    }
  }

  createEffect(
    on(deps.selectedId, async (id) => {
      stopTotp();
      setRevealed(false);
      setDetail(null);
      if (!id) return;
      try {
        const d = await ipc.itemDetail(deps.accountFor(id), id);
        setDetail(d);
        if (d.login?.hasTotp) {
          await refreshTotp(id);
          totpTimer = setInterval(() => {
            const current = totp();
            if (!current) return;
            if (current.remaining <= 1) {
              void refreshTotp(id);
            } else {
              setTotp({ ...current, remaining: current.remaining - 1 });
            }
          }, 1000);
        }
      } catch (err) {
        toastError(err);
      }
    }),
  );

  return { detail, setDetail, revealed, setRevealed, totp, selectedSecurity };
}

export type ItemDetailState = ReturnType<typeof useItemDetail>;
