// Settings › AI Access — run a local MCP server that exposes a NARROW, explicitly
// allowlisted slice of the vault to an AI client (e.g. Claude). The user enables
// the server, copies the connection URL + bearer token into their MCP client, then
// ticks exactly which items the assistant may read. Reveal mode: a granted item's
// secrets are returned to the assistant; everything else is denied. Every read is
// recorded in the session audit log below.

import { createMemo, createSignal, For, onMount, Show } from 'solid-js';
import { Bot, Eye, EyeOff, RefreshCw, ShieldAlert } from 'lucide-solid';
import { ipc } from '../../lib/ipc.ts';
import { t } from '../../lib/i18n.ts';
import type { AiAuditEntry, AiGrant, AiServerStatus, VaultItem } from '../../lib/types.ts';
import { copyWithAutoClear } from '../../lib/clipboard.ts';
import CopyButton from '../../components/CopyButton.tsx';
import { pushToast, toastError } from '../../state/toast.ts';
import { ResetButton, Switch, ToggleRow } from '../../components/settings/SettingsControls.tsx';
import './AiAccessSettings.css';

// Placeholder shown for the bearer token until the user reveals it.
const TOKEN_MASK = '••••••••••••••••••••••••';

// `\0` can't appear in an email or a cipher id, so it's a safe key separator.
const grantKey = (accountEmail: string, itemId: string) => `${accountEmail}\u0000${itemId}`;

export default function AiAccessSettings() {
  const [status, setStatus] = createSignal<AiServerStatus | null>(null);
  const [items, setItems] = createSignal<VaultItem[]>([]);
  const [grants, setGrants] = createSignal<AiGrant[]>([]);
  const [audit, setAudit] = createSignal<AiAuditEntry[]>([]);
  const [filter, setFilter] = createSignal('');
  const [busy, setBusy] = createSignal(false);
  const [tokenShown, setTokenShown] = createSignal(false);
  // Grant keys with a toggle in flight — disables that row's Switch so a
  // double-click can't race two writes (the later reload would win with stale data).
  const [pendingGrants, setPendingGrants] = createSignal<ReadonlySet<string>>(new Set());

  const grantedSet = createMemo(
    () => new Set(grants().map((g) => grantKey(g.accountEmail, g.itemId))),
  );
  const isGranted = (it: VaultItem) => grantedSet().has(grantKey(it.accountEmail, it.id));

  async function loadStatus() {
    try {
      setStatus(await ipc.aiServerStatus());
    } catch (e) {
      toastError(e);
    }
  }
  async function loadGrants() {
    try {
      setGrants(await ipc.aiListGrants());
    } catch (e) {
      toastError(e);
    }
  }
  async function loadItems() {
    try {
      // Browse-able items only — trashed items can't be granted.
      setItems((await ipc.listItems()).filter((it) => !it.deleted));
    } catch (e) {
      toastError(e);
    }
  }
  async function loadAudit() {
    try {
      setAudit(await ipc.aiAuditLog());
    } catch (e) {
      toastError(e);
    }
  }

  onMount(() => {
    void loadStatus();
    void loadGrants();
    void loadItems();
    void loadAudit();
  });

  async function toggleServer(enabled: boolean) {
    setBusy(true);
    try {
      setStatus(await ipc.aiSetServerEnabled(enabled));
      pushToast('success', enabled ? t('ai.serverEnabled') : t('ai.serverDisabled'));
    } catch (e) {
      toastError(e);
    } finally {
      setBusy(false);
    }
  }

  async function toggleGrant(it: VaultItem, granted: boolean) {
    const key = grantKey(it.accountEmail, it.id);
    if (pendingGrants().has(key)) return;
    setPendingGrants((prev) => new Set(prev).add(key));
    try {
      await ipc.aiSetGrant(it.accountEmail, it.id, granted);
      await loadGrants();
    } catch (e) {
      toastError(e);
    } finally {
      setPendingGrants((prev) => {
        const next = new Set(prev);
        next.delete(key);
        return next;
      });
    }
  }

  async function revokeAll() {
    try {
      await ipc.aiClearGrants();
      await loadGrants();
      pushToast('success', t('ai.revokedAll'));
    } catch (e) {
      toastError(e);
    }
  }

  const shownItems = createMemo(() => {
    const q = filter().trim().toLowerCase();
    const list = items();
    if (!q) return list;
    return list.filter(
      (it) =>
        it.name.toLowerCase().includes(q) ||
        (it.username ?? '').toLowerCase().includes(q) ||
        (it.uri ?? '').toLowerCase().includes(q),
    );
  });

  const grantedCount = createMemo(() => grants().length);

  // The one-liner the user runs to register Agate with Claude Code's MCP client.
  const mcpCommand = createMemo(() => {
    const s = status();
    if (!s?.url || !s?.token) return '';
    return `claude mcp add --transport http agate ${s.url} --header "Authorization: Bearer ${s.token}"`;
  });

  // Rendered variants keep the token masked until revealed (shoulder-surf /
  // screen-share protection); the copy buttons always copy the real value.
  const shownToken = () => (tokenShown() ? (status()?.token ?? '') : TOKEN_MASK);
  const shownCommand = () => {
    const token = status()?.token;
    const cmd = mcpCommand();
    if (tokenShown() || !token || !cmd) return cmd;
    return cmd.replace(token, TOKEN_MASK);
  };

  return (
    <div class="settings-page ai-access">
      <section class="settings-section">
        <h3>
          <Bot size={16} strokeWidth={1.7} /> {t('ai.title')}
        </h3>
        <p class="muted settings-help">{t('ai.help')}</p>

        <div class="ai-warn">
          <ShieldAlert size={16} strokeWidth={1.75} />
          <span>{t('ai.warning')}</span>
        </div>

        <ToggleRow
          label={t('ai.enableServer')}
          desc={
            <Show
              when={status()?.enabled && status()?.running}
              fallback={t('ai.serverOff')}
            >
              {t('ai.listeningOn', { url: status()?.url ?? '' })}
            </Show>
          }
          checked={status()?.enabled ?? false}
          onChange={(v) => void toggleServer(v)}
          disabled={busy()}
        />

        <Show when={status()?.enabled && status()?.url && status()?.token}>
          <div class="ai-conn">
            <label class="ai-conn-label">{t('ai.serverUrl')}</label>
            <div class="ai-code-row">
              <code class="ai-code">{status()?.url}</code>
              <CopyButton
                class="ghost icon-btn"
                size={14}
                label={t('ai.copyUrl')}
                onCopy={() => copyWithAutoClear('URL', status()?.url)}
              />
            </div>

            <label class="ai-conn-label">{t('ai.bearerToken')}</label>
            <div class="ai-code-row">
              <code class="ai-code ai-token">{shownToken()}</code>
              <button
                class="ghost icon-btn"
                title={tokenShown() ? t('ai.hideToken') : t('ai.revealToken')}
                onClick={() => setTokenShown(!tokenShown())}
              >
                {tokenShown() ? <EyeOff size={14} /> : <Eye size={14} />}
              </button>
              <CopyButton
                class="ghost icon-btn"
                size={14}
                label={t('ai.copyToken')}
                onCopy={() => copyWithAutoClear('Token', status()?.token)}
              />
            </div>

            <label class="ai-conn-label">{t('ai.connectClaudeCode')}</label>
            <div class="ai-code-row">
              <code class="ai-code ai-cmd">{shownCommand()}</code>
              <CopyButton
                class="ghost icon-btn"
                size={14}
                label={t('ai.copyCommand')}
                onCopy={() => copyWithAutoClear('Command', mcpCommand())}
              />
            </div>
            <p class="muted settings-help">{t('ai.connectHelp')}</p>
          </div>
        </Show>
      </section>

      <section class="settings-section">
        <h3>{t('ai.allowedItems')}</h3>
        <p class="muted settings-help">
          {t('ai.allowlistHelp')}{' '}
          {grantedCount() === 1
            ? t('ai.itemGrantedOne', { count: grantedCount() })
            : t('ai.itemsGrantedMany', { count: grantedCount() })}
        </p>

        <Show
          when={items().length > 0}
          fallback={
            <p class="muted settings-help">{t('ai.unlockToShare')}</p>
          }
        >
          <input
            class="ai-search"
            type="text"
            placeholder={t('ai.searchItems')}
            value={filter()}
            onInput={(e) => setFilter(e.currentTarget.value)}
          />
          <div class="ai-item-list">
            <For each={shownItems()}>
              {(it) => (
                <div class="ai-item" classList={{ granted: isGranted(it) }}>
                  <span class="ai-item-text">
                    <span class="ai-item-name">{it.name}</span>
                    <span class="ai-item-sub muted">
                      {it.username ?? '—'} · {it.accountLabel}
                    </span>
                  </span>
                  <Switch
                    checked={isGranted(it)}
                    onChange={(v) => void toggleGrant(it, v)}
                    label={t('ai.allowAccessTo', { name: it.name })}
                    disabled={pendingGrants().has(grantKey(it.accountEmail, it.id))}
                  />
                </div>
              )}
            </For>
            <Show when={shownItems().length === 0}>
              <p class="muted settings-help">{t('ai.noItemsMatch')}</p>
            </Show>
          </div>
          <Show when={grantedCount() > 0}>
            <ResetButton label={t('ai.revokeAll')} onClick={() => void revokeAll()} />
          </Show>
        </Show>
      </section>

      <section class="settings-section">
        <h3 class="ai-audit-head">
          {t('ai.accessLog')}
          <button class="ghost icon-btn" title={t('ai.refresh')} onClick={() => void loadAudit()}>
            <RefreshCw size={14} />
          </button>
        </h3>
        <p class="muted settings-help">{t('ai.accessLogHelp')}</p>
        <Show
          when={audit().length > 0}
          fallback={<p class="muted settings-help">{t('ai.noAccessesYet')}</p>}
        >
          <div class="ai-audit-list">
            <For each={audit().slice().reverse()}>
              {(e) => (
                <div class="ai-audit-row" classList={{ denied: !e.allowed }}>
                  <span class="ai-audit-action">{e.action}</span>
                  <span class="ai-audit-item muted">
                    {e.itemName ?? e.itemId ?? e.accountEmail ?? '—'}
                  </span>
                  <span class="ai-audit-when muted">{new Date(e.timestamp).toLocaleTimeString()}</span>
                  <span class="ai-audit-verdict" classList={{ denied: !e.allowed }}>
                    {e.allowed ? t('ai.verdictAllowed') : t('ai.verdictDenied')}
                  </span>
                </div>
              )}
            </For>
          </div>
        </Show>
      </section>
    </div>
  );
}
