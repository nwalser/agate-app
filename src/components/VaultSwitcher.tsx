// Connection (vault) switcher — lives in the window titlebar. Scopes the item
// list to one connection or merges them all ("All vaults"). Only rendered when
// there is more than one connection; with a single account there is nothing to
// switch. The unified merged view stays available as the first menu entry.

import { createSignal, For, Show } from 'solid-js';
import { Check, ChevronsUpDown, Layers, Lock } from 'lucide-solid';
import type { ConnectionSummary } from '../lib/types.ts';
import { accountColorVar } from '../lib/accountColor.ts';
import './VaultSwitcher.css';

export default function VaultSwitcher(props: {
  connections: ConnectionSummary[];
  /** null = all vaults merged; otherwise the scoped connection email. */
  active: string | null;
  onSelect: (email: string | null) => void;
}) {
  const [open, setOpen] = createSignal(false);

  const activeConn = () => props.connections.find((c) => c.email === props.active) ?? null;
  const label = () => (props.active ? activeConn()?.email ?? props.active : 'All vaults');

  function pick(email: string | null) {
    setOpen(false);
    props.onSelect(email);
  }

  return (
    <div class="vault-switcher">
      <button
        class="vault-switcher-btn"
        title={`Vault: ${label()} — switch vault`}
        aria-haspopup="menu"
        aria-expanded={open()}
        onClick={() => setOpen((v) => !v)}
      >
        <Show when={props.active} fallback={<Layers size={15} strokeWidth={1.6} />}>
          <span
            class="vault-switcher-dot"
            style={{ background: accountColorVar(props.active ?? '') }}
            aria-hidden="true"
          />
        </Show>
        <span class="vault-switcher-label truncate">{label()}</span>
        <ChevronsUpDown size={13} strokeWidth={1.6} class="vault-switcher-caret" />
      </button>

      <Show when={open()}>
        <>
          <div class="vault-menu-backdrop" onClick={() => setOpen(false)} />
          <div class="vault-switcher-menu" role="menu">
            <button class="vault-switcher-item" role="menuitem" onClick={() => pick(null)}>
              <Layers size={15} strokeWidth={1.6} />
              <span class="vault-switcher-item-text">All vaults</span>
              <Show when={props.active === null}>
                <Check size={14} strokeWidth={2} class="vault-switcher-check" />
              </Show>
            </button>
            <div class="vault-switcher-sep" />
            <For each={props.connections}>
              {(conn) => (
                <button
                  class="vault-switcher-item"
                  role="menuitem"
                  onClick={() => pick(conn.email)}
                >
                  <Show when={conn.unlocked} fallback={<Lock size={15} strokeWidth={1.6} />}>
                    <span
                      class="vault-switcher-dot"
                      style={{ background: accountColorVar(conn.email) }}
                      aria-hidden="true"
                    />
                  </Show>
                  <span class="vault-switcher-item-text">
                    <span class="truncate">{conn.email}</span>
                    <span class="muted vault-switcher-item-server">{conn.serverLabel}</span>
                  </span>
                  <Show when={props.active === conn.email}>
                    <Check size={14} strokeWidth={2} class="vault-switcher-check" />
                  </Show>
                </button>
              )}
            </For>
          </div>
        </>
      </Show>
    </div>
  );
}
