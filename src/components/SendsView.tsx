// Sends view — a main vault view (reached from the left rail, like Generator /
// Security) that lists the Bitwarden Sends (ephemeral shares) across every unlocked
// connection, lets you create a new text Send, and revoke ones you no longer need.
// Backed by the SDK's sends client (list + create + delete). File Sends (a separate
// upload flow) are a follow-up. Previously this lived under Settings; it now sits in
// the vault so shares are managed alongside the vault.

import { createSignal, For, onMount, Show } from 'solid-js';
import { Paperclip, Plus, Send as SendIcon, Trash2, X } from 'lucide-solid';
import { ipc } from '../lib/ipc.ts';
import type {
  ConnectionSummary,
  SendCreateInput,
  SendCreated,
  SendExpiry,
  SendFileCreateInput,
  SendSummary,
} from '../lib/types.ts';
import { relativeUntil } from '../lib/dates.ts';
import { copyWithAutoClear } from '../lib/clipboard.ts';
import CopyButton from './CopyButton.tsx';
import { t } from '../lib/i18n.ts';
import { pushToast, toastError } from '../state/toast.ts';
import { Select, Switch } from './settings/SettingsControls.tsx';
import './SendsView.css';

/** The "type · views · flags · expiry" metadata line under a Send's name. */
export function sendMeta(s: SendSummary, now: number = Date.now()): string {
  const views =
    s.maxAccessCount != null
      ? t('sends.viewsCapped', { count: s.accessCount, max: s.maxAccessCount })
      : s.accessCount === 1
        ? t('sends.viewsOne', { count: s.accessCount })
        : t('sends.viewsMany', { count: s.accessCount });
  const parts = [s.sendType, views];
  if (s.hasPassword) parts.push(t('sends.password'));
  if (s.disabled) parts.push(t('sends.disabled'));
  if (s.expirationDate) {
    const ts = Date.parse(s.expirationDate);
    // Unparseable expiry: drop the segment entirely (no dangling "expires ").
    if (!Number.isNaN(ts)) {
      parts.push(
        ts <= now
          ? t('sends.expired')
          : t('sends.expires', { when: relativeUntil(s.expirationDate, now) }),
      );
    }
  }
  return parts.join(' · ');
}

/** Whether the draft shares text or a file. */
export type SendKind = 'text' | 'file';

/** Editable state of the create form. */
export interface SendDraft {
  kind: SendKind;
  accountEmail: string;
  name: string;
  text: string;
  expiry: SendExpiry;
  /** Raw text of the "max views" input ('' = unlimited). */
  maxViews: string;
  password: string;
  hidden: boolean;
  hideEmail: boolean;
}

/** Coerce the "max views" input to a positive integer, or null (unlimited). */
function parseMaxViews(raw: string): number | null {
  const trimmed = raw.trim();
  const n = Number(trimmed);
  return trimmed !== '' && Number.isInteger(n) && n > 0 ? n : null;
}

/** A whitespace-only password means "no password", not a blank one. */
function normalizePassword(p: string): string | null {
  return p.trim() === '' ? null : p;
}

/** Map the draft onto the text-Send IPC input. Pure so the field→payload mapping
 *  is unit-tested without rendering the form. */
export function buildSendInput(d: SendDraft): SendCreateInput {
  return {
    accountEmail: d.accountEmail,
    name: d.name.trim(),
    text: d.text,
    hidden: d.hidden,
    expiry: d.expiry,
    maxAccessCount: parseMaxViews(d.maxViews),
    password: normalizePassword(d.password),
    hideEmail: d.hideEmail,
  };
}

/** Map the draft onto the file-Send IPC input (no text/hidden — the file itself
 *  is chosen by a native picker in the backend). */
export function buildFileSendInput(d: SendDraft): SendFileCreateInput {
  return {
    accountEmail: d.accountEmail,
    name: d.name.trim(),
    expiry: d.expiry,
    maxAccessCount: parseMaxViews(d.maxViews),
    password: normalizePassword(d.password),
    hideEmail: d.hideEmail,
  };
}

const emptyDraft = (accountEmail = ''): SendDraft => ({
  kind: 'text',
  accountEmail,
  name: '',
  text: '',
  expiry: 'sevenDays',
  maxViews: '',
  password: '',
  hidden: false,
  hideEmail: false,
});

export default function SendsView() {
  const [sends, setSends] = createSignal<SendSummary[]>([]);
  const [accounts, setAccounts] = createSignal<ConnectionSummary[]>([]);
  const [loading, setLoading] = createSignal(true);
  // Ids with a revoke in flight — a Set so concurrent revokes on different rows
  // don't re-enable each other's buttons (or allow a double-delete).
  const [removing, setRemoving] = createSignal<ReadonlySet<string>>(new Set());

  // Create-form state: closed unless `draft` is set; `created` holds the share
  // link to copy after a successful create (replaces the form until dismissed).
  const [draft, setDraft] = createSignal<SendDraft | null>(null);
  const [created, setCreated] = createSignal<SendCreated | null>(null);
  const [saving, setSaving] = createSignal(false);

  async function load() {
    setLoading(true);
    try {
      const [list, conns] = await Promise.all([ipc.listSends(), ipc.listConnections()]);
      setSends(list);
      setAccounts(conns.filter((c) => c.unlocked));
    } catch (err) {
      toastError(err);
    } finally {
      setLoading(false);
    }
  }
  onMount(() => void load());

  const expiryOptions = (): { value: SendExpiry; label: string }[] => [
    { value: 'oneHour', label: t('sends.exp1h') },
    { value: 'oneDay', label: t('sends.exp1d') },
    { value: 'twoDays', label: t('sends.exp2d') },
    { value: 'threeDays', label: t('sends.exp3d') },
    { value: 'sevenDays', label: t('sends.exp7d') },
    { value: 'thirtyDays', label: t('sends.exp30d') },
  ];

  function openForm() {
    setCreated(null);
    setDraft(emptyDraft(accounts()[0]?.email ?? ''));
  }

  function closeForm() {
    setDraft(null);
    setCreated(null);
  }

  // Patch one field of the open draft.
  function patch<K extends keyof SendDraft>(key: K, value: SendDraft[K]) {
    setDraft((d) => (d ? { ...d, [key]: value } : d));
  }

  const canSubmit = () => {
    const d = draft();
    if (!d || !d.accountEmail || d.name.trim() === '' || saving()) return false;
    // A file Send picks its file at create time; a text Send needs its body now.
    return d.kind === 'file' ? true : d.text !== '';
  };

  async function submit() {
    const d = draft();
    if (!d || !canSubmit()) return;
    setSaving(true);
    try {
      const result =
        d.kind === 'file'
          ? await ipc.createFileSend(buildFileSendInput(d))
          : await ipc.createSend(buildSendInput(d));
      // A file Send returns null when the user cancels the picker — keep the form
      // open so they can try again, no toast.
      if (!result) return;
      setCreated(result);
      setDraft(null);
      pushToast('success', t('sends.created'));
      await load(); // surface the new Send in the list below
    } catch (err) {
      toastError(err);
    } finally {
      setSaving(false);
    }
  }

  async function revoke(s: SendSummary) {
    if (removing().has(s.id)) return;
    setRemoving((prev) => new Set(prev).add(s.id));
    try {
      await ipc.deleteSend(s.accountEmail, s.id);
      pushToast('success', t('sends.revoked'));
      await load();
    } catch (err) {
      toastError(err);
    } finally {
      setRemoving((prev) => {
        const next = new Set(prev);
        next.delete(s.id);
        return next;
      });
    }
  }

  return (
    <div class="sends">
      <header class="sends-header">
        <SendIcon size={16} strokeWidth={1.75} />
        <h2>{t('sends.title')}</h2>
        <Show when={!loading()}>
          <span class="sends-count">
            {sends().length === 1
              ? t('sends.countOne', { count: sends().length })
              : t('sends.countMany', { count: sends().length })}
          </span>
        </Show>
        <Show when={!loading() && !draft() && !created()}>
          <button
            class="sends-new"
            disabled={accounts().length === 0}
            onClick={openForm}
          >
            <Plus size={13} strokeWidth={2} /> {t('sends.new')}
          </button>
        </Show>
      </header>

      <div class="sends-body">
        <p class="muted sends-intro">{t('sends.intro')}</p>

        {/* Created-link panel: shown after a successful create until dismissed. */}
        <Show when={created()}>
          {(c) => (
            <div class="send-created">
              <p class="send-created-msg">{t('sends.linkReady')}</p>
              <div class="send-link-row">
                <input class="send-link" type="text" readOnly value={c().url} />
                <CopyButton
                  class="primary"
                  size={13}
                  label={t('sends.copyLink')}
                  onCopy={() => copyWithAutoClear('URL', c().url)}
                />
              </div>
              <button class="send-done" onClick={closeForm}>
                {t('sends.done')}
              </button>
            </div>
          )}
        </Show>

        {/* Inline create form (no modal — inline by design). */}
        <Show when={draft()}>
          {(d) => (
            <div class="send-form">
              <div class="send-field-row">
                <label class="send-field">
                  <span>{t('sends.typeLabel')}</span>
                  <Select
                    value={d().kind}
                    options={[
                      { value: 'text', label: t('sends.typeText') },
                      { value: 'file', label: t('sends.typeFile') },
                    ]}
                    onChange={(v) => patch('kind', v)}
                    ariaLabel={t('sends.typeLabel')}
                  />
                </label>
                <Show when={accounts().length > 1}>
                  <label class="send-field">
                    <span>{t('sends.account')}</span>
                    <Select
                      value={d().accountEmail}
                      options={accounts().map((a) => ({ value: a.email, label: a.email }))}
                      onChange={(v) => patch('accountEmail', v)}
                      ariaLabel={t('sends.account')}
                    />
                  </label>
                </Show>
              </div>

              <label class="send-field">
                <span>{t('sends.nameLabel')}</span>
                <input
                  type="text"
                  value={d().name}
                  placeholder={t('sends.namePlaceholder')}
                  onInput={(e) => patch('name', e.currentTarget.value)}
                />
              </label>

              <Show when={d().kind === 'text'}>
                <label class="send-field">
                  <span>{t('sends.textLabel')}</span>
                  <textarea
                    rows={4}
                    value={d().text}
                    placeholder={t('sends.textPlaceholder')}
                    onInput={(e) => patch('text', e.currentTarget.value)}
                  />
                </label>
              </Show>

              <Show when={d().kind === 'file'}>
                <div class="send-file-note">
                  <Paperclip size={15} strokeWidth={1.75} />
                  <span class="muted">{t('sends.fileNote')}</span>
                </div>
              </Show>

              <div class="send-field-row">
                <label class="send-field">
                  <span>{t('sends.expiryLabel')}</span>
                  <Select
                    value={d().expiry}
                    options={expiryOptions()}
                    onChange={(v) => patch('expiry', v)}
                    ariaLabel={t('sends.expiryLabel')}
                  />
                </label>
                <label class="send-field">
                  <span>{t('sends.maxViewsLabel')}</span>
                  <input
                    type="number"
                    min="1"
                    inputMode="numeric"
                    value={d().maxViews}
                    placeholder={t('sends.maxViewsPlaceholder')}
                    onInput={(e) => patch('maxViews', e.currentTarget.value)}
                  />
                </label>
              </div>

              <label class="send-field">
                <span>{t('sends.passwordLabel')}</span>
                <input
                  type="password"
                  autocomplete="new-password"
                  value={d().password}
                  placeholder={t('sends.passwordPlaceholder')}
                  onInput={(e) => patch('password', e.currentTarget.value)}
                />
              </label>

              <Show when={d().kind === 'text'}>
                <div class="send-toggle">
                  <Switch
                    checked={d().hidden}
                    onChange={(v) => patch('hidden', v)}
                    label={t('sends.hideText')}
                  />
                  <span class="send-toggle-text">
                    <span>{t('sends.hideText')}</span>
                    <span class="muted">{t('sends.hideTextDesc')}</span>
                  </span>
                </div>
              </Show>

              <div class="send-toggle">
                <Switch
                  checked={d().hideEmail}
                  onChange={(v) => patch('hideEmail', v)}
                  label={t('sends.hideEmail')}
                />
                <span class="send-toggle-text">
                  <span>{t('sends.hideEmail')}</span>
                </span>
              </div>

              <div class="send-form-actions">
                <button onClick={closeForm} disabled={saving()}>
                  <X size={13} strokeWidth={1.75} /> {t('sends.cancel')}
                </button>
                <button class="primary" disabled={!canSubmit()} onClick={() => void submit()}>
                  {saving() ? t('sends.creating') : t('sends.create')}
                </button>
              </div>
            </div>
          )}
        </Show>

        <Show when={!loading()} fallback={<p class="muted">{t('common.loading')}</p>}>
          <Show when={sends().length > 0} fallback={<p class="muted">{t('sends.empty')}</p>}>
            <For each={sends()}>
              {(s) => (
                <div class="send-row">
                  <span class="send-info">
                    <span class="send-name truncate">{s.name}</span>
                    <span class="muted send-meta">{sendMeta(s)}</span>
                  </span>
                  <button class="danger" disabled={removing().has(s.id)} onClick={() => void revoke(s)}>
                    <Trash2 size={13} strokeWidth={1.75} /> {t('sends.revoke')}
                  </button>
                </div>
              )}
            </For>
          </Show>
        </Show>
      </div>
    </div>
  );
}
