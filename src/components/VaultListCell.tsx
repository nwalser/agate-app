// Renders one vault-list cell from the pure `CellContent` descriptor produced by
// lib/cellRendering.ts. This is the only piece that knows the cell markup/classes;
// all the masked-vs-revealed and detail-lookup decisions are made upstream. Reuses
// the existing .vault-cell* classes from VaultList.css (imported by the parent).

import { For, Show, type JSX } from 'solid-js';
import { ShieldCheck } from 'lucide-solid';
import type { CellContent } from '../lib/cellRendering.ts';

export default function VaultListCell(props: { content: CellContent }): JSX.Element {
  const c = props.content;
  switch (c.kind) {
    case 'blank':
      return <span class="vault-cell" />;
    case 'text':
      return (
        <span
          class="vault-cell"
          classList={{
            truncate: c.truncate,
            muted: c.muted,
            mono: c.mono,
            'vault-type-badge': c.badge,
          }}
        >
          {c.value}
        </span>
      );
    case 'secret':
      return <span class="vault-cell vault-secret">{c.mask}</span>;
    case 'totp':
      return (
        <span class="vault-cell mono totp-code">
          {c.code ? c.code.code : '…'}
          <Show when={c.code}>
            <small class="totp-remaining">{c.code!.remaining}s</small>
          </Show>
        </span>
      );
    case 'secOk':
      return (
        <span class="vault-cell vault-sec-ok" title="No known security issues">
          <ShieldCheck size={13} strokeWidth={1.75} />
        </span>
      );
    case 'secChips':
      return (
        <span class="vault-cell vault-sec-cell" title={c.chips.map((x) => x.label).join(', ')}>
          <For each={c.chips}>
            {(x) => <span class="vault-sec-chip" classList={{ severe: x.severe }}>{x.label}</span>}
          </For>
        </span>
      );
  }
}
