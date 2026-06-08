// Sidebar vault switcher: scope the list to one connection or merge them all.
//
// The unified list still exists ("All vaults"), but a single click swaps to any
// one connection's vault — the separation the user asked for, without losing the
// merged view. Renders compactly when the sidebar is collapsed (icon + popover).

import { createSignal, For, Show } from 'solid-js';
import { Check, ChevronsUpDown, Layers, Lock, Vault as VaultIcon } from 'lucide-solid';
import type { ConnectionSummary } from '../lib/types.ts';
import './VaultSwitcher.css';

export default function VaultSwitcher(props: {
  connections: ConnectionSummary[];
  /** null = all vaults merged; otherwise the scoped connection email. */
  active: string | null;
  collapsed: boolean;
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
    <div class="vault-switcher" classList={{ collapsed: props.collapsed }}>
      <button
        class="vault-switcher-btn"
        title={props.collapsed ? `Vault: ${label()}` : 'Switch vault'}
        onClick={() => setOpen((v) => !v)}
      >
        <Show when={props.active} fallback={<Layers size={16} strokeWidth={1.6} />}>
          <VaultIcon size={16} strokeWidth={1.6} />
        </Show>
        <Show when={!props.collapsed}>
          <span class="vault-switcher-label truncate">{label()}</span>
          <ChevronsUpDown size={14} strokeWidth={1.6} class="vault-switcher-caret" />
        </Show>
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
                    <VaultIcon size={15} strokeWidth={1.6} />
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
