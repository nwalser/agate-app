import { createEffect, createMemo, createSignal, For, on, onCleanup, onMount, Show } from 'solid-js';
import {
  Copy,
  CreditCard,
  ExternalLink,
  Eye,
  EyeOff,
  File,
  KeyRound,
  Lock,
  RefreshCw,
  Search,
  Settings as SettingsIcon,
  Star,
  StickyNote,
  Terminal,
  Timer,
  UserRound,
} from 'lucide-solid';
import { writeText } from '@tauri-apps/plugin-clipboard-manager';
import { openUrl } from '@tauri-apps/plugin-opener';
import { ipc } from '../lib/ipc.ts';
import { filterItems } from '../lib/search.ts';
import type { ItemDetail, ItemType, TotpCode, VaultItem } from '../lib/types.ts';
import { pushToast, toastError } from '../state/toast.ts';
import './Vault.css';

function typeIcon(t: ItemType) {
  switch (t) {
    case 'login':
      return KeyRound;
    case 'secureNote':
      return StickyNote;
    case 'card':
      return CreditCard;
    case 'identity':
      return UserRound;
    case 'sshKey':
      return Terminal;
    default:
      return File;
  }
}

export default function Vault(props: { onLock: () => void; onOpenSettings: () => void }) {
  const [items, setItems] = createSignal<VaultItem[]>([]);
  const [query, setQuery] = createSignal('');
  const [selectedId, setSelectedId] = createSignal<string | null>(null);
  const [detail, setDetail] = createSignal<ItemDetail | null>(null);
  const [revealed, setRevealed] = createSignal(false);
  const [totp, setTotp] = createSignal<TotpCode | null>(null);
  const [syncing, setSyncing] = createSignal(false);

  const filtered = createMemo(() => filterItems(items(), query()));

  async function loadItems() {
    try {
      setItems(await ipc.listItems());
    } catch (err) {
      toastError(err);
    }
  }

  async function sync() {
    setSyncing(true);
    try {
      await ipc.syncVault(false);
      await loadItems();
      pushToast('success', 'Vault synced.');
    } catch (err) {
      toastError(err);
    } finally {
      setSyncing(false);
    }
  }

  onMount(async () => {
    // Best-effort sync on open; fall back to whatever is already cached.
    setSyncing(true);
    try {
      await ipc.syncVault(false);
    } catch (err) {
      toastError(err);
    } finally {
      setSyncing(false);
    }
    await loadItems();
  });

  async function copy(label: string, value: string | null | undefined) {
    if (!value) return;
    try {
      await writeText(value);
      pushToast('success', `${label} copied.`);
    } catch (err) {
      toastError(err);
    }
  }

  // Load detail + TOTP whenever selection changes.
  let totpTimer: ReturnType<typeof setInterval> | undefined;
  function stopTotp() {
    if (totpTimer) clearInterval(totpTimer);
    totpTimer = undefined;
    setTotp(null);
  }
  onCleanup(stopTotp);

  async function refreshTotp(id: string) {
    try {
      setTotp(await ipc.itemTotp(id));
    } catch (err) {
      toastError(err);
    }
  }

  createEffect(
    on(selectedId, async (id) => {
      stopTotp();
      setRevealed(false);
      setDetail(null);
      if (!id) return;
      try {
        const d = await ipc.itemDetail(id);
        setDetail(d);
        if (d.login?.hasTotp) {
          await refreshTotp(id);
          totpTimer = setInterval(() => {
            const current = totp();
            if (!current) return;
            if (current.remaining <= 1) {
              void refreshTotp(id);
            } else {
              setTotp({ ...current, remaining: current.remaining - 1 });
            }
          }, 1000);
        }
      } catch (err) {
        toastError(err);
      }
    }),
  );

  return (
    <div class="vault">
      <header class="vault-header">
        <div class="vault-search">
          <Search size={14} strokeWidth={1.75} />
          <input
            placeholder="Search vault…"
            value={query()}
            onInput={(e) => setQuery(e.currentTarget.value)}
          />
        </div>
        <button class="ghost icon-btn" title="Sync" disabled={syncing()} onClick={() => void sync()}>
          <RefreshCw size={15} strokeWidth={1.75} class={syncing() ? 'spin' : ''} />
        </button>
        <button class="ghost icon-btn" title="Settings" onClick={() => props.onOpenSettings()}>
          <SettingsIcon size={15} strokeWidth={1.75} />
        </button>
        <button class="ghost icon-btn" title="Lock" onClick={() => props.onLock()}>
          <Lock size={15} strokeWidth={1.75} />
        </button>
      </header>

      <div class="vault-body">
        <aside class="vault-list">
          <Show
            when={filtered().length > 0}
            fallback={<div class="vault-empty muted">{items().length === 0 ? 'Vault is empty or not synced.' : 'No matches.'}</div>}
          >
            <For each={filtered()}>
              {(item) => {
                const Icon = typeIcon(item.itemType);
                return (
                  <button
                    class="vault-row"
                    classList={{ active: selectedId() === item.id }}
                    onClick={() => setSelectedId(item.id)}
                  >
                    <Icon size={16} strokeWidth={1.6} class="vault-row-icon" />
                    <span class="vault-row-text">
                      <span class="vault-row-name">{item.name}</span>
                      <Show when={item.username}>
                        <span class="vault-row-sub">{item.username}</span>
                      </Show>
                    </span>
                    <Show when={item.favorite}>
                      <Star size={13} strokeWidth={1.75} class="vault-row-fav" />
                    </Show>
                  </button>
                );
              }}
            </For>
          </Show>
        </aside>

        <section class="vault-detail">
          <Show when={detail()} fallback={<div class="vault-detail-empty muted">Select an item to view its details.</div>}>
            {(d) => (
              <div class="detail">
                <h2 class="detail-name">{d().name}</h2>

                <Show when={d().login}>
                  {(login) => (
                    <>
                      <Show when={login().username}>
                        <Field label="Username" value={login().username} onCopy={() => void copy('Username', login().username)} />
                      </Show>
                      <Show when={login().password}>
                        <div class="detail-field">
                          <label>Password</label>
                          <div class="detail-value-row">
                            <code class="detail-value mono">
                              {revealed() ? login().password : '••••••••••••'}
                            </code>
                            <button class="ghost icon-btn" title={revealed() ? 'Hide' : 'Reveal'} onClick={() => setRevealed(!revealed())}>
                              {revealed() ? <EyeOff size={14} /> : <Eye size={14} />}
                            </button>
                            <button class="ghost icon-btn" title="Copy" onClick={() => void copy('Password', login().password)}>
                              <Copy size={14} />
                            </button>
                          </div>
                        </div>
                      </Show>

                      <Show when={totp()}>
                        {(code) => (
                          <div class="detail-field">
                            <label>
                              <Timer size={11} strokeWidth={2} /> One-time code
                            </label>
                            <div class="detail-value-row">
                              <code class="detail-value mono totp-code">{code().code}</code>
                              <span class="totp-remaining">{code().remaining}s</span>
                              <button class="ghost icon-btn" title="Copy" onClick={() => void copy('Code', code().code)}>
                                <Copy size={14} />
                              </button>
                            </div>
                          </div>
                        )}
                      </Show>

                      <For each={login().uris}>
                        {(u) => (
                          <Show when={u.uri}>
                            <div class="detail-field">
                              <label>Website</label>
                              <div class="detail-value-row">
                                <span class="detail-value truncate">{u.uri}</span>
                                <button class="ghost icon-btn" title="Open" onClick={() => u.uri && void openUrl(u.uri)}>
                                  <ExternalLink size={14} />
                                </button>
                                <button class="ghost icon-btn" title="Copy" onClick={() => void copy('URL', u.uri)}>
                                  <Copy size={14} />
                                </button>
                              </div>
                            </div>
                          </Show>
                        )}
                      </For>
                    </>
                  )}
                </Show>

                <For each={d().fields}>
                  {(f) => (
                    <Show when={f.name || f.value}>
                      <Field label={f.name ?? 'Field'} value={f.value} onCopy={() => void copy(f.name ?? 'Field', f.value)} />
                    </Show>
                  )}
                </For>

                <Show when={d().notes}>
                  <div class="detail-field">
                    <label>Notes</label>
                    <pre class="detail-notes">{d().notes}</pre>
                  </div>
                </Show>
              </div>
            )}
          </Show>
        </section>
      </div>
    </div>
  );
}

function Field(props: { label: string; value: string | null; onCopy: () => void }) {
  return (
    <div class="detail-field">
      <label>{props.label}</label>
      <div class="detail-value-row">
        <span class="detail-value truncate">{props.value}</span>
        <button class="ghost icon-btn" title="Copy" onClick={() => props.onCopy()}>
          <Copy size={14} />
        </button>
      </div>
    </div>
  );
}
