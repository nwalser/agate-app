// Discovered custom-field names across every unlocked vault — the source the
// column picker offers so a custom-field column is CHOSEN, not blind-typed.
//
// Built as a FACTORY (`createCustomFields`) with its one dependency (the IPC scan)
// injected, so the load/refresh behaviour is unit-tested with a fake list and no
// module mocking. The app's singleton (bottom) wires the real `ipc.listCustomFields`
// + the toast pipeline; the Vault screen calls `refreshCustomFields()` after a sync,
// and the add-column menu triggers a refresh when it opens.

import { createSignal } from 'solid-js';
import { ipc } from '../lib/ipc.ts';
import { toastError } from './toast.ts';

export interface CustomFieldsDeps {
  /** Scan all unlocked vaults for distinct custom-field names. */
  list: () => Promise<string[]>;
  /** Surface a scan failure (the list just stays as it was). */
  onError?: (err: unknown) => void;
}

export function createCustomFields(deps: CustomFieldsDeps) {
  const [fields, setFields] = createSignal<string[]>([]);
  const [loading, setLoading] = createSignal(false);
  // Collapse overlapping refreshes: a refresh while one is in flight is ignored
  // (the in-flight one publishes the fresh result).
  let inFlight = false;

  async function refresh(): Promise<void> {
    if (inFlight) return;
    inFlight = true;
    setLoading(true);
    try {
      setFields(await deps.list());
    } catch (err) {
      deps.onError?.(err);
    } finally {
      inFlight = false;
      setLoading(false);
    }
  }

  /** Replace the known field names directly (the screen can push a scan result it
   *  already has; tests seed without IPC). */
  function setKnownFields(names: string[]) {
    setFields(names);
  }

  return { fields, loading, refresh, setKnownFields };
}

export type CustomFields = ReturnType<typeof createCustomFields>;

// ── The app's singleton, wired to the real scan + toast pipeline. ──
const store = createCustomFields({ list: ipc.listCustomFields, onError: toastError });

export const {
  fields: customFields,
  loading: customFieldsLoading,
  refresh: refreshCustomFields,
  setKnownFields: setCustomFields,
} = store;
