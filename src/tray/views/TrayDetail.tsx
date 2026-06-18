// Tray-popup item detail view: the full read-only detail of one vault item
// inside the 380px quick-access popup — a compact port of
// components/VaultDetailPane.tsx (which it eventually replaces). Field coverage
// per type: login (username / masked password / live TOTP / website links),
// card (masked number + CVV, expiry), identity rows, SSH key, secure note,
// custom fields (text / hidden / boolean / linked), and the
// account + updated-ago footer.
//
// Reprompt: a reprompt-protected item is NOT fetched until the user re-enters
// the app password (components/RepromptGate.tsx → ipc.verifyAppPassword);
// verification holds for this mount only. The fetch + 1s TOTP ticker reuse
// hooks/useItemDetail.ts; every copy goes through copyWithAutoClear (the ONE
// clipboard path) so secrets wipe on the user's timer; errors via toastError.

import { createSignal, For, Match, Show, Switch, type JSX } from 'solid-js';
import { Dynamic } from 'solid-js/web';
import {
  ArrowLeft,
  Check,
  ExternalLink,
  Eye,
  EyeOff,
  Link as LinkIcon,
  Pencil,
  RotateCcw,
  Star,
  Timer,
  Trash2,
} from 'lucide-solid';
import { openUrl } from '@tauri-apps/plugin-opener';
import type { CustomField, ItemDetail, VaultItem } from '../../lib/types.ts';
import { ipc } from '../../lib/ipc.ts';
import { t } from '../../lib/i18n.ts';
import { copyWithAutoClear } from '../../lib/clipboard.ts';
import { copyPop } from '../../lib/copyPop.ts';
import { absoluteDate, relativeFromNow } from '../../lib/dates.ts';
import { accountColorVar } from '../../lib/accountColor.ts';
import { typeIcon } from '../../lib/vaultIcons.ts';
import {
  cardExpiry,
  detectCardBrand,
  formatCardNumber,
  identityFields,
  isLinkedSecret,
  linkedLabel,
  maskCardNumber,
  resolveLinkedValue,
} from '../../lib/itemFields.ts';
import { toastError } from '../../state/toast.ts';
import { useItemDetail } from '../../hooks/useItemDetail.ts';
import CopyButton from '../../components/CopyButton.tsx';
import TotpRing from '../../components/TotpRing.tsx';
import NotesView from '../../components/NotesView.tsx';
import RepromptGate from '../../components/RepromptGate.tsx';
import './TrayDetail.css';

/** The one copy path: label routes the auto-clear policy (see clipboard.ts —
 *  labels are the stable English constants, NOT translated strings). */
const copy = (label: string, value: string | null | undefined) =>
  copyWithAutoClear(label, value);

export default function TrayDetail(props: {
  /** List row — id + accountEmail route the detail fetch. */
  item: VaultItem;
  onBack: () => void;
  /** Opens the popup's login edit form (logins only). */
  onEdit: (item: VaultItem) => void;
  /** Called after favorite / delete / restore so the shell refreshes its list. */
  onChanged: () => void;
}): JSX.Element {
  // Reprompt gate: hold the fetch behind app-password re-entry. Per-mount —
  // leaving the detail and coming back re-prompts.
  const [verified, setVerified] = createSignal(!props.item.reprompt);

  // Detail + live TOTP (1s ticker, refetch on rollover) — the same hook the
  // main window's detail pane uses. selectedId stays null until verified, so
  // nothing is fetched (or decrypted into this webview) before the gate passes.
  const { detail, setDetail, totp } = useItemDetail({
    selectedId: () => (verified() ? props.item.id : null),
    accountFor: () => props.item.accountEmail,
  });

  const [busy, setBusy] = createSignal(false);
  const [confirmingDelete, setConfirmingDelete] = createSignal(false);

  async function toggleFavorite() {
    const d = detail();
    if (!d || busy()) return;
    setBusy(true);
    try {
      await ipc.setFavorite(d.accountEmail, d.id, !d.favorite);
      setDetail({ ...d, favorite: !d.favorite });
      props.onChanged();
    } catch (err) {
      toastError(err);
    } finally {
      setBusy(false);
    }
  }

  /** Trash (reversible, no confirm) or delete permanently (inline-confirmed). */
  async function remove(permanent: boolean) {
    if (busy()) return;
    setBusy(true);
    try {
      await ipc.deleteItems(props.item.accountEmail, [props.item.id], permanent);
      props.onChanged();
      props.onBack();
    } catch (err) {
      toastError(err);
    } finally {
      setBusy(false);
    }
  }

  async function restore() {
    if (busy()) return;
    setBusy(true);
    try {
      await ipc.restoreItems(props.item.accountEmail, [props.item.id]);
      props.onChanged();
      props.onBack();
    } catch (err) {
      toastError(err);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div class="tray-detail">
      <div class="tray-detail-head">
        <button class="tray-detail-back" title={t('common.back')} onClick={() => props.onBack()}>
          <ArrowLeft size={15} />
        </button>
        <span class="tray-detail-type-icon">
          <Dynamic component={typeIcon(props.item.itemType)} size={14} />
        </span>
        <span class="tray-detail-title" title={props.item.name}>
          {props.item.name}
        </span>
        <span class="tray-detail-actions">
          <Show when={detail()}>
            {(d) => (
              <Show
                when={!props.item.deleted}
                fallback={
                  <>
                    <button
                      title={t('detail.restore')}
                      disabled={busy()}
                      onClick={() => void restore()}
                    >
                      <RotateCcw size={14} />
                    </button>
                    <button
                      class="tray-detail-del"
                      title={t('detail.deletePermanently')}
                      disabled={busy()}
                      onClick={() => setConfirmingDelete(true)}
                    >
                      <Trash2 size={14} />
                    </button>
                  </>
                }
              >
                <button
                  title={d().favorite ? t('detail.unfavorite') : t('detail.favorite')}
                  disabled={busy()}
                  onClick={() => void toggleFavorite()}
                >
                  <Star size={14} class={d().favorite ? 'tray-detail-fav' : ''} />
                </button>
                <Show when={d().itemType === 'login'}>
                  <button title={t('common.edit')} onClick={() => props.onEdit(props.item)}>
                    <Pencil size={14} />
                  </button>
                </Show>
                <button
                  class="tray-detail-del"
                  title={t('detail.moveToTrash')}
                  disabled={busy()}
                  onClick={() => void remove(false)}
                >
                  <Trash2 size={14} />
                </button>
              </Show>
            )}
          </Show>
        </span>
      </div>

      <Show
        when={verified()}
        fallback={
          <>
            <div class="tray-detail-status">{t('reprompt.title')}</div>
            <RepromptGate
              itemName={props.item.name}
              onVerified={() => setVerified(true)}
              onClose={() => props.onBack()}
            />
          </>
        }
      >
        <Show when={detail()} fallback={<div class="tray-detail-status">{t('common.loading')}</div>}>
          {(d) => (
            <div class="tray-detail-body">
              <Show when={d().login}>
                {(login) => (
                  <>
                    <Show when={login().username}>
                      {(u) => <PlainRow label={t('common.username')} copyLabel="Username" value={u()} />}
                    </Show>
                    <Show when={login().password}>
                      {(pw) => <SecretRow label={t('common.password')} copyLabel="Password" value={pw()} />}
                    </Show>
                    <Show when={totp()}>
                      {(code) => (
                        <div class="tray-detail-field">
                          <label>
                            <Timer size={11} strokeWidth={2} /> {t('detail.oneTimeCode')}
                          </label>
                          <div class="tray-detail-value-row">
                            <code
                              class="tray-detail-value mono copyable"
                              title={t('common.copy')}
                              onClick={(e) => {
                                copyPop(e.currentTarget);
                                void copy('Code', code().code);
                              }}
                            >
                              {code().code}
                            </code>
                            <TotpRing remaining={code().remaining} period={code().period} size={15} />
                            <CopyButton
                              size={13}
                              class="tray-detail-iconbtn"
                              label={t('tray.copyTotp')}
                              onCopy={() => copy('Code', code().code)}
                            />
                          </div>
                        </div>
                      )}
                    </Show>
                    <For each={login().uris}>
                      {(u) => (
                        <Show when={u.uri}>
                          {(uri) => (
                            <PlainRow
                              label={t('detail.website')}
                              copyLabel="URL"
                              value={uri()}
                              openUrl={uri()}
                            />
                          )}
                        </Show>
                      )}
                    </For>
                  </>
                )}
              </Show>

              <Show when={d().card}>
                {(card) => {
                  const number = () => card().number ?? '';
                  const brand = () =>
                    card().brand || detectCardBrand(number()) || t('detail.cardBrandFallback');
                  return (
                    <>
                      <Show when={card().brand || number()}>
                        <InfoRow label={t('detail.cardBrandFallback')} value={brand()} />
                      </Show>
                      <Show when={card().cardholderName}>
                        {(holder) => (
                          <PlainRow label={t('detail.cardholder')} copyLabel="Cardholder" value={holder()} />
                        )}
                      </Show>
                      <Show when={number()}>
                        <SecretRow
                          label={t('detail.number')}
                          copyLabel="Number"
                          value={number()}
                          shown={formatCardNumber(number(), brand())}
                          hidden={maskCardNumber(number())}
                        />
                      </Show>
                      <Show when={card().expMonth || card().expYear}>
                        <InfoRow label={t('detail.expires')} value={cardExpiry(card())} />
                      </Show>
                      <Show when={card().code}>
                        {(cvv) => (
                          <SecretRow
                            label={t('detail.cvv')}
                            copyLabel="Security code"
                            value={cvv()}
                            hidden="•••"
                          />
                        )}
                      </Show>
                    </>
                  );
                }}
              </Show>

              <Show when={d().identity}>
                {(id) => (
                  <For each={identityFields(id())}>
                    {(f) => (
                      <Show when={f.value}>
                        {(v) => <PlainRow label={f.label} copyLabel={f.label} value={v()} />}
                      </Show>
                    )}
                  </For>
                )}
              </Show>

              <Show when={d().sshKey}>
                {(key) => (
                  <>
                    <Show when={key().publicKey}>
                      <PlainRow
                        label={t('detail.publicKey')}
                        copyLabel="Public key"
                        value={key().publicKey}
                      />
                    </Show>
                    <Show when={key().fingerprint}>
                      <PlainRow
                        label={t('detail.fingerprint')}
                        copyLabel="Fingerprint"
                        value={key().fingerprint}
                      />
                    </Show>
                    <Show when={key().privateKey}>
                      <SecretRow
                        label={t('detail.privateKey')}
                        copyLabel="Private key"
                        value={key().privateKey}
                      />
                    </Show>
                  </>
                )}
              </Show>

              <For each={d().fields}>
                {(f) => (
                  <Show when={f.name || f.value || f.fieldType === 'linked'}>
                    <CustomFieldRow field={f} detail={d()} />
                  </Show>
                )}
              </For>

              <Show when={d().notes}>{(notes) => <NotesView notes={notes()} />}</Show>

              {/* Owning account + last update, pinned to the bottom of the scroll. */}
              <div class="tray-detail-meta">
                <span
                  class="tray-detail-account"
                  title={`${d().accountLabel} · ${d().accountEmail}`}
                >
                  <span
                    class="tray-detail-account-dot"
                    style={{ background: accountColorVar(d().accountEmail) }}
                  />
                  <span class="tray-detail-trunc">{d().accountLabel}</span>
                </span>
                <span title={absoluteDate(d().revisionDate)}>
                  {t('detail.updated', { date: relativeFromNow(d().revisionDate) })}
                </span>
              </div>
            </div>
          )}
        </Show>
      </Show>

      {/* Inline confirm for the irreversible delete (trash view only). */}
      <Show when={confirmingDelete()}>
        <div class="tray-detail-confirm">
          <span class="tray-detail-confirm-text">{t('trayDetail.confirmDelete')}</span>
          <button
            class="tray-detail-confirm-del"
            disabled={busy()}
            onClick={() => void remove(true)}
          >
            {t('common.delete')}
          </button>
          <button disabled={busy()} onClick={() => setConfirmingDelete(false)}>
            {t('common.cancel')}
          </button>
        </div>
      </Show>
    </div>
  );
}

/** Label + value with no copy affordance (brand, expiry). */
function InfoRow(props: { label: string; value: string }): JSX.Element {
  return (
    <div class="tray-detail-field">
      <label>{props.label}</label>
      <div class="tray-detail-value-row">
        <span class="tray-detail-value tray-detail-trunc">{props.value}</span>
      </div>
    </div>
  );
}

/** Copyable non-secret row: click the value (pop animation) or the copy button;
 *  an optional website link opens in the system browser. */
function PlainRow(props: {
  label: string;
  /** Stable English label for clipboard.ts's auto-clear policy. */
  copyLabel: string;
  value: string;
  openUrl?: string;
}): JSX.Element {
  return (
    <div class="tray-detail-field">
      <label>{props.label}</label>
      <div class="tray-detail-value-row">
        <span
          class="tray-detail-value tray-detail-trunc copyable"
          title={t('common.copy')}
          onClick={(e) => {
            copyPop(e.currentTarget);
            void copy(props.copyLabel, props.value);
          }}
        >
          {props.value}
        </span>
        <Show when={props.openUrl}>
          {(url) => (
            <button
              class="tray-detail-iconbtn"
              title={t('common.open')}
              onClick={() => void openUrl(url())}
            >
              <ExternalLink size={13} />
            </button>
          )}
        </Show>
        <CopyButton
          size={13}
          class="tray-detail-iconbtn"
          label={t('detail.copyField', { label: props.label.toLowerCase() })}
          onCopy={() => copy(props.copyLabel, props.value)}
        />
      </div>
    </div>
  );
}

/** Masked secret row with a local reveal toggle + auto-clearing copy. */
function SecretRow(props: {
  label: string;
  /** Stable English label for clipboard.ts's auto-clear policy. */
  copyLabel: string;
  value: string;
  /** Display when revealed (defaults to the raw value, e.g. a formatted PAN). */
  shown?: string;
  /** Mask when hidden (defaults to twelve dots). */
  hidden?: string;
}): JSX.Element {
  const [show, setShow] = createSignal(false);
  return (
    <div class="tray-detail-field">
      <label>{props.label}</label>
      <div class="tray-detail-value-row">
        <code
          class="tray-detail-value mono copyable"
          title={t('common.copy')}
          onClick={(e) => {
            copyPop(e.currentTarget);
            void copy(props.copyLabel, props.value);
          }}
        >
          {show() ? (props.shown ?? props.value) : (props.hidden ?? '••••••••••••')}
        </code>
        <button
          class="tray-detail-iconbtn"
          title={show() ? t('common.hide') : t('detail.reveal')}
          onClick={() => setShow((s) => !s)}
        >
          {show() ? <EyeOff size={13} /> : <Eye size={13} />}
        </button>
        <CopyButton
          size={13}
          class="tray-detail-iconbtn"
          label={t('detail.copyField', { label: props.label.toLowerCase() })}
          onCopy={() => copy(props.copyLabel, props.value)}
        />
      </div>
    </div>
  );
}

/** One custom field by type: boolean chip / hidden secret / linked target /
 *  plain text — the compact mirror of VaultDetailPane's CustomFieldView. */
function CustomFieldRow(props: { field: CustomField; detail: ItemDetail }): JSX.Element {
  const f = () => props.field;
  const label = () => f().name ?? t('detail.fieldFallback');
  return (
    <Switch
      fallback={
        <Show when={f().value}>
          {(v) => <PlainRow label={label()} copyLabel={label()} value={v()} />}
        </Show>
      }
    >
      <Match when={f().fieldType === 'boolean'}>
        <div class="tray-detail-field">
          <label>{label()}</label>
          <div class="tray-detail-bool" classList={{ on: f().value === 'true' }}>
            <Show when={f().value === 'true'} fallback={<span>{t('detail.off')}</span>}>
              <Check size={13} strokeWidth={2.25} /> {t('detail.on')}
            </Show>
          </div>
        </div>
      </Match>
      <Match when={f().fieldType === 'hidden'}>
        <Show when={f().value}>
          {(v) => <SecretRow label={label()} copyLabel={label()} value={v()} />}
        </Show>
      </Match>
      <Match when={f().fieldType === 'linked'}>
        {(() => {
          const lbl = () => `${label()} → ${linkedLabel(f().linkedId)}`;
          const value = () => resolveLinkedValue(props.detail, f().linkedId);
          return (
            <Show
              when={value()}
              fallback={
                <div class="tray-detail-field">
                  <label>
                    <LinkIcon size={11} strokeWidth={2} /> {lbl()}
                  </label>
                  <div class="tray-detail-value-row">
                    <span class="tray-detail-value muted">{t('detail.linkedFieldEmpty')}</span>
                  </div>
                </div>
              }
            >
              {(v) => (
                <Show
                  when={isLinkedSecret(f().linkedId)}
                  fallback={<PlainRow label={lbl()} copyLabel={label()} value={v()} />}
                >
                  <SecretRow label={lbl()} copyLabel={label()} value={v()} />
                </Show>
              )}
            </Show>
          );
        })()}
      </Match>
    </Switch>
  );
}
