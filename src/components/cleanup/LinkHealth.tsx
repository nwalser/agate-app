// "Link health" tool of the Vault Cleanup center: pings every login URL and lists
// the dead ones so the item can be updated. Reads the on-demand scan state from
// state/linkHealth.ts and triggers a run via runScan. Reuses the .clean-* classes
// from CleanupCenter.css (imported by the parent).
//
// ON-DEMAND ONLY: the scan reaches out to every website saved in the vault, so it
// runs solely when the user clicks "Scan now" — never in the background. The lead
// note states this before anything is sent.

import { For, Show, createMemo } from 'solid-js';
import { AlertTriangle, CircleCheck, Link2Off, RefreshCw, Unlink } from 'lucide-solid';
import { busy, report, runScan } from '../../state/linkHealth.ts';
import type { LinkHealthItem, LinkStatus } from '../../lib/types.ts';
import { t } from '../../lib/i18n.ts';

const isBroken = (l: LinkStatus): boolean => l.kind === 'broken' || l.kind === 'unreachable';

/** Short status label for one problem link (the response code, or a word when the
 *  host never answered). */
function statusLabel(l: LinkStatus): string {
  if (l.httpStatus !== null) return String(l.httpStatus);
  if (l.kind === 'unreachable') return t('cleanup.statusUnreachable');
  return t('cleanup.statusTimeout');
}

/** One vault item with its problematic links, as a clickable row that opens it. */
function ItemRow(props: { item: LinkHealthItem; broken: boolean; onOpen: (id: string) => void }) {
  const links = () => props.item.links.filter((l) => (props.broken ? isBroken(l) : l.kind === 'uncertain'));
  return (
    <li>
      <button class="clean-row" onClick={() => props.onOpen(props.item.id)} title={t('cleanup.openItem')}>
        <Show when={props.broken} fallback={<AlertTriangle size={14} strokeWidth={1.75} class="clean-row-warn" />}>
          <Link2Off size={14} strokeWidth={1.75} class="clean-row-danger" />
        </Show>
        <span class="clean-row-body">
          <span class="clean-row-name truncate">{props.item.name}</span>
          <For each={links()}>
            {(l) => (
              <span class="clean-row-link">
                <span class="clean-link-url truncate">{l.url}</span>
                <span class="clean-link-badge" classList={{ bad: props.broken }}>{statusLabel(l)}</span>
              </span>
            )}
          </For>
        </span>
      </button>
    </li>
  );
}

export default function LinkHealth(props: { onOpenItem: (id: string) => void }) {
  const brokenItems = createMemo(() => report()?.items.filter((it) => it.links.some(isBroken)) ?? []);
  const uncertainItems = createMemo(
    () => report()?.items.filter((it) => !it.links.some(isBroken) && it.links.some((l) => l.kind === 'uncertain')) ?? [],
  );
  const needsUpdate = createMemo(() => (report()?.broken ?? 0) + (report()?.unreachable ?? 0));

  return (
    <section class="clean-card">
      <div class="clean-card-head">
        <h3><Unlink size={14} strokeWidth={1.75} /> {t('cleanup.linkHealth')}</h3>
        <span class="spacer" />
        <button class="clean-run-btn" disabled={busy()} onClick={() => void runScan()}>
          <RefreshCw size={13} strokeWidth={1.75} class={busy() ? 'spin' : ''} /> {t('cleanup.scanNow')}
        </button>
      </div>

      <p class="clean-help">{t('cleanup.privacyNote')}</p>

      <Show when={busy() && !report()}>
        <p class="clean-loading muted">{t('cleanup.scanning')}</p>
      </Show>

      <Show when={report()}>
        {(r) => (
          <>
            <div class="clean-summary">
              <span>{t('cleanup.scannedCount', { count: r().scanned })}</span>
              <Show when={needsUpdate() > 0}>
                <span class="clean-summary-bad">
                  <strong>{t('cleanup.brokenCount', { count: needsUpdate() })}</strong>
                </span>
              </Show>
              <Show when={r().uncertain > 0}>
                <span class="clean-summary-warn">
                  <strong>{t('cleanup.uncertainCount', { count: r().uncertain })}</strong>
                </span>
              </Show>
            </div>

            <Show when={r().items.length === 0}>
              <p class="clean-clean">
                <CircleCheck size={14} strokeWidth={1.75} /> {t('cleanup.allReachable')}
              </p>
            </Show>

            <Show when={brokenItems().length > 0}>
              <div class="clean-group-label">{t('cleanup.needsUpdate')}</div>
              <ul class="clean-list">
                <For each={brokenItems()}>
                  {(it) => <ItemRow item={it} broken onOpen={props.onOpenItem} />}
                </For>
              </ul>
            </Show>

            <Show when={uncertainItems().length > 0}>
              <div class="clean-group-label warn">{t('cleanup.couldNotReach')}</div>
              <p class="clean-group-hint muted">{t('cleanup.couldNotReachHint')}</p>
              <ul class="clean-list">
                <For each={uncertainItems()}>
                  {(it) => <ItemRow item={it} broken={false} onOpen={props.onOpenItem} />}
                </For>
              </ul>
            </Show>
          </>
        )}
      </Show>
    </section>
  );
}
