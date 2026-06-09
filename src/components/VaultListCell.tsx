// Renders one vault-list cell from the pure `CellContent` descriptor produced by
// lib/cellRendering.ts. This is the only piece that knows the cell markup/classes;
// all the masked-vs-revealed and detail-lookup decisions are made upstream. Reuses
// the existing .vault-cell* classes from VaultList.css (imported by the parent).
//
// A value cell (text / masked secret / TOTP) gets a hover-revealed copy button
// when the parent passes `onCopy`; the parent decides which columns are copyable
// and what each one copies (the real secret, fetched if need be — see VaultList).

import { Show, type JSX } from 'solid-js';
import { Dynamic } from 'solid-js/web';
import { Copy, KeyRound, ShieldAlert, ShieldCheck, ShieldX } from 'lucide-solid';
import type { CellContent } from '../lib/cellRendering.ts';

const SEC_ICON = { ok: ShieldCheck, warn: ShieldAlert, risk: ShieldX } as const;

export default function VaultListCell(props: { content: CellContent; onCopy?: () => void }): JSX.Element {
  // Read props.content INSIDE a reactive boundary (the JSX `{}` getter), not into a
  // `const` at component-init — a Solid component runs once, so a captured const
  // never updates when the descriptor changes (e.g. the offline-health report loads
  // after first render). Without this the Security badge stays stuck on its first
  // value (the "always green" bug).
  return <>{renderCell(props.content, props.onCopy)}</>;
}

function renderCell(c: CellContent, onCopy?: () => void): JSX.Element {
  switch (c.kind) {
    case 'blank':
      return <span class="vault-cell" />;
    case 'text':
      return (
        <span
          class="vault-cell"
          classList={{
            muted: c.muted,
            mono: c.mono,
            'vault-type-badge': c.badge,
            'vault-cell-copyable': !!onCopy,
          }}
        >
          <span class="vault-cell-val" classList={{ truncate: c.truncate }}>
            {c.value}
          </span>
          <CopyButton onCopy={onCopy} />
        </span>
      );
    case 'secret':
      return (
        <span class="vault-cell vault-secret" classList={{ 'vault-cell-copyable': !!onCopy }}>
          <span class="vault-cell-val">{c.mask}</span>
          <CopyButton onCopy={onCopy} />
        </span>
      );
    case 'totp':
      return (
        <span class="vault-cell mono totp-code" classList={{ 'vault-cell-copyable': !!onCopy }}>
          <span class="vault-cell-val">{c.code ? c.code.code : '…'}</span>
          <Show when={c.code}>
            <small class="totp-remaining">{c.code!.remaining}s</small>
          </Show>
          <CopyButton onCopy={onCopy} />
        </span>
      );
    case 'secBadge':
      return (
        <span
          class="vault-cell vault-sec-badge"
          classList={{ ok: c.status === 'ok', warn: c.status === 'warn', risk: c.status === 'risk' }}
          title={c.tooltip}
        >
          <Dynamic component={SEC_ICON[c.status]} size={14} strokeWidth={1.75} />
        </span>
      );
    case 'passkey':
      return (
        <span class="vault-cell vault-passkey" title="Passkey saved">
          <KeyRound size={14} strokeWidth={1.75} />
        </span>
      );
  }
}

// Hover-revealed per-cell copy button. Renders nothing when the cell isn't
// copyable. Stops propagation so copying never triggers the row's click/select.
function CopyButton(props: { onCopy?: () => void }): JSX.Element {
  return (
    <Show when={props.onCopy}>
      {(onCopy) => (
        <button
          class="ghost icon-btn cell-copy"
          title="Copy"
          onClick={(e) => {
            e.stopPropagation();
            onCopy()();
          }}
        >
          <Copy size={12} />
        </button>
      )}
    </Show>
  );
}
