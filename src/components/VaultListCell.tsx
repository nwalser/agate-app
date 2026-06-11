// Renders one vault-list cell from the pure `CellContent` descriptor produced by
// lib/cellRendering.ts. This is the only piece that knows the cell markup/classes;
// all the masked-vs-revealed and detail-lookup decisions are made upstream. Reuses
// the existing .vault-cell* classes from VaultList.css (imported by the parent).
//
// A value cell (text / masked secret / TOTP) becomes a click-to-copy target when
// the parent passes `onCopy` — the WHOLE cell is clickable (matching the detail
// pane's `.copyable` values: pointer cursor + hover tint, no icon). The click
// stops propagation so copying never also selects/opens the row. The parent
// decides which columns are copyable and what each copies (the real secret,
// fetched if need be — see VaultList).

import { Show, type JSX } from 'solid-js';
import { Dynamic } from 'solid-js/web';
import { KeyRound, ShieldAlert, ShieldCheck, ShieldX } from 'lucide-solid';
import type { CellContent } from '../lib/cellRendering.ts';
import TotpRing from './TotpRing.tsx';
import { t } from '../lib/i18n.ts';

const SEC_ICON = { ok: ShieldCheck, warn: ShieldAlert, risk: ShieldX } as const;

export default function VaultListCell(props: {
  content: CellContent;
  onCopy?: () => void;
  onOpen?: () => void;
}): JSX.Element {
  // Read props.content INSIDE a reactive boundary (the JSX `{}` getter), not into a
  // `const` at component-init — a Solid component runs once, so a captured const
  // never updates when the descriptor changes (e.g. the offline-health report loads
  // after first render). Without this the Security badge stays stuck on its first
  // value (the "always green" bug).
  return <>{renderCell(props.content, props.onCopy, props.onOpen)}</>;
}

function renderCell(c: CellContent, onCopy?: () => void, onOpen?: () => void): JSX.Element {
  switch (c.kind) {
    case 'blank':
      return <span class="vault-cell" />;
    case 'text': {
      // A text cell is interactive when the parent wires either action. `onOpen`
      // (the website column → open the site) wins over `onCopy`; the whole cell is
      // the target either way.
      const interactive = !!onCopy || !!onOpen;
      return (
        <span
          class="vault-cell"
          classList={{
            muted: c.muted,
            mono: c.mono,
            'vault-type-badge': c.badge,
            'vault-cell-copyable': interactive,
            copyable: interactive,
            'vault-cell-link': !!onOpen,
          }}
          {...actionHandlers(onCopy, onOpen)}
        >
          <span class="vault-cell-val" classList={{ truncate: c.truncate }}>
            {c.value}
          </span>
        </span>
      );
    }
    case 'secret':
      return (
        <span
          class="vault-cell vault-secret"
          classList={{ 'vault-cell-copyable': !!onCopy, copyable: !!onCopy }}
          {...actionHandlers(onCopy)}
        >
          <span class="vault-cell-val">{c.mask}</span>
        </span>
      );
    case 'totp':
      return (
        <span
          class="vault-cell mono totp-code"
          classList={{ 'vault-cell-copyable': !!onCopy, copyable: !!onCopy }}
          {...actionHandlers(onCopy)}
        >
          <span class="vault-cell-val">{c.code ? c.code.code : '…'}</span>
          <Show when={c.code}>
            {(code) => <TotpRing remaining={code().remaining} period={code().period} />}
          </Show>
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
        <span class="vault-cell vault-passkey" title={t('vault.passkeySaved')}>
          <KeyRound size={14} strokeWidth={1.75} />
        </span>
      );
  }
}

// Interactive props that turn a value cell into a click target. `onOpen` (open the
// website) takes precedence over `onCopy`; clicking anywhere in the cell fires it
// and stops propagation so it never bubbles to the row's click (which would
// select/open the item). Empty when neither is wired, leaving the cell inert.
function actionHandlers(
  onCopy?: () => void,
  onOpen?: () => void,
): { title: string; onClick: (e: MouseEvent) => void } | object {
  const action = onOpen ?? onCopy;
  if (!action) return {};
  return {
    title: onOpen ? t('menu.openWebsite') : t('common.copy'),
    onClick: (e: MouseEvent) => {
      e.stopPropagation();
      action();
    },
  };
}
