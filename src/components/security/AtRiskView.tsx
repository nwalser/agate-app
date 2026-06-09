// Dedicated "At-risk items" view, reached from the Vault-health reference on the
// security dashboard. The dashboard itself only shows the per-flag counts; the
// full at-risk list (with its per-item flag chips) lives here so the dashboard
// stays a glanceable overview. Render-only: the audit report + loading state are
// owned by SecurityCenter and passed down. Reuses the .sec-* classes from
// SecurityCenter.css (imported by the parent).

import { For, Show } from 'solid-js';
import { AlertTriangle, ArrowLeft } from 'lucide-solid';
import type { VaultHealthReport } from '../../lib/types.ts';
import { chipsFor } from './shared.tsx';

export default function AtRiskView(props: {
  report: VaultHealthReport | null;
  loading: boolean;
  onOpenItem: (id: string) => void;
  onBack: () => void;
}) {
  const items = () => props.report?.atRisk ?? [];
  return (
    <>
      <header class="sec-header">
        <button class="sec-back" onClick={() => props.onBack()} title="Back to vault security">
          <ArrowLeft size={16} strokeWidth={1.75} />
        </button>
        <AlertTriangle size={16} strokeWidth={1.75} />
        <h2>At-risk items</h2>
      </header>

      <div class="sec-body">
        <Show when={!props.loading} fallback={<p class="sec-loading muted">Analysing your vault…</p>}>
          <Show
            when={items().length > 0}
            fallback={<p class="muted sec-empty">No at-risk items. Nicely done.</p>}
          >
            <ul class="sec-list sec-list-full">
              <For each={items()}>
                {(item) => (
                  <li>
                    <button class="sec-row" onClick={() => props.onOpenItem(item.id)} title="Open item">
                      <span class="sec-row-name truncate">{item.name}</span>
                      <span class="sec-chips">
                        <For each={chipsFor(item)}>{(c) => <span class="sec-chip">{c}</span>}</For>
                      </span>
                    </button>
                  </li>
                )}
              </For>
            </ul>
          </Show>
        </Show>
      </div>
    </>
  );
}
