import { For } from 'solid-js';
import { CircleAlert, CircleCheck, Info, X } from 'lucide-solid';
import { dismissToast, toasts, type ToastKind } from '../state/toast.ts';
import './Toast.css';

function iconFor(kind: ToastKind) {
  if (kind === 'success') return CircleCheck;
  if (kind === 'error') return CircleAlert;
  return Info;
}

export default function ToastHost() {
  return (
    <div class="toast-host">
      <For each={toasts()}>
        {(toast) => {
          const Icon = iconFor(toast.kind);
          return (
            <div class={`toast toast-${toast.kind}`}>
              <Icon size={15} strokeWidth={1.75} />
              <span class="toast-message">{toast.message}</span>
              <button class="toast-close" onClick={() => dismissToast(toast.id)} aria-label="Dismiss">
                <X size={13} strokeWidth={1.75} />
              </button>
            </div>
          );
        }}
      </For>
    </div>
  );
}
