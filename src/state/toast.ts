// Tiny toast pipeline. Errors and confirmations surface here rather than via
// alert()/console. Auto-dismiss after a timeout.

import { createSignal } from 'solid-js';
import { isAgateError } from '../lib/types.ts';

export type ToastKind = 'info' | 'success' | 'error';

export interface Toast {
  id: number;
  kind: ToastKind;
  message: string;
}

const [toasts, setToasts] = createSignal<Toast[]>([]);
let nextId = 1;

export { toasts };

export function pushToast(kind: ToastKind, message: string, ttlMs = 4000): void {
  const id = nextId++;
  setToasts((prev) => [...prev, { id, kind, message }]);
  if (ttlMs > 0) {
    setTimeout(() => dismissToast(id), ttlMs);
  }
}

export function dismissToast(id: number): void {
  setToasts((prev) => prev.filter((t) => t.id !== id));
}

/** Surface an unknown error (typed AgateError or otherwise) as an error toast. */
export function toastError(err: unknown): void {
  if (isAgateError(err)) {
    pushToast('error', err.message);
  } else if (err instanceof Error) {
    pushToast('error', err.message);
  } else {
    pushToast('error', String(err));
  }
}
