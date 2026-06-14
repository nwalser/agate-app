// Loads the full detail (+ live TOTP) for the currently selected item and drives
// the detail pane. Re-runs whenever the selection changes: it resets the reveal
// toggle, fetches the decrypted detail, and — for logins with a TOTP — starts a
// 1s ticker that counts the code down and refetches when it expires. The ticker
// is torn down on selection change and on unmount.

import { type Accessor, createEffect, createSignal, on, onCleanup } from 'solid-js';
import { ipc } from '../lib/ipc.ts';
import type { ItemDetail, TotpCode } from '../lib/types.ts';
import { toastError } from '../state/toast.ts';

export function useItemDetail(deps: {
  selectedId: Accessor<string | null>;
  accountFor: (id: string) => string;
}) {
  const [detail, setDetail] = createSignal<ItemDetail | null>(null);
  const [revealed, setRevealed] = createSignal(false);
  const [totp, setTotp] = createSignal<TotpCode | null>(null);

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

  return { detail, setDetail, revealed, setRevealed, totp };
}

export type ItemDetailState = ReturnType<typeof useItemDetail>;
