// Read-only detail render for a selected vault item, for every item type: the
// header action row (favorite/edit/clone/trash, or restore/delete in trash), the
// type-specific fields (login + live TOTP, card face, identity rows, SSH keys),
// custom fields, notes, and the per-item security verdict pinned at the bottom.
// Pure presentation
// — every mutation + clipboard copy is a callback the screen wires to its hooks.
// The reveal toggle for the login password is driven by the screen's signal so it
// resets on selection change; per-field secrets manage their own local toggle.

import { For, Match, Show, Switch, createSignal, onMount } from 'solid-js';
import {
  Check,
  Copy,
  CreditCard,
  Download,
  ExternalLink,
  Eye,
  EyeOff,
  KeyRound,
  Link as LinkIcon,
  Paperclip,
  Pencil,
  RotateCcw,
  ShieldAlert,
  ShieldCheck,
  Star,
  Timer,
  Trash2,
} from 'lucide-solid';
import { openUrl } from '@tauri-apps/plugin-opener';
import type { Attachment, BreachRecord, CardInput, CustomField, ItemDetail, TotpCode } from '../lib/types.ts';
import { ipc } from '../lib/ipc.ts';
import { pushToast, toastError } from '../state/toast.ts';
import {
  cardExpiry,
  detectCardBrand,
  formatCardNumber,
  identityFields,
  isLinkedSecret,
  linkedLabel,
  maskCardNumber,
  resolveLinkedValue,
} from '../lib/itemFields.ts';
import type { SelectedSecurity } from '../hooks/useItemDetail.ts';
import NotesView from './NotesView.tsx';
import TotpRing from './TotpRing.tsx';
import RepromptGate from './RepromptGate.tsx';
import { isReprompted, markReprompted } from '../state/reprompt.ts';
import { collectionNamesFor, loadCollections } from '../state/collections.ts';
import { absoluteDate, relativeFromNow } from '../lib/dates.ts';
import { ContextMenu, CtxItem, CtxSep, CtxTitle } from './ContextMenu.tsx';

// Right-click payload for a single field row: its label, a copy action, an
// optional reveal toggle (secrets) and an optional website to open.
interface FieldMenuPayload {
  label: string;
  copy: () => void;
  reveal?: { shown: boolean; toggle: () => void };
  openUrl?: string;
}
type OnFieldCtx = (e: MouseEvent, payload: FieldMenuPayload) => void;

export default function VaultDetailPane(props: {
  detail: ItemDetail;
  inTrash: boolean;
  revealed: boolean;
  setRevealed: (v: boolean) => void;
  totp: TotpCode | null;
  selectedSecurity: SelectedSecurity;
  /** Known data breaches this item's email(s) appear in (latest dark-web scan). */
  selectedBreaches: BreachRecord[];
  copy: (label: string, value: string | null | undefined) => void;
  onFavorite: (d: ItemDetail) => void;
  onEdit: (d: ItemDetail) => void;
  onClone: (id: string) => void;
  onDelete: (id: string, permanent: boolean) => void;
  onRestore: (id: string) => void;
}) {
  const d = () => props.detail;

  // Right-click menus: the header (mirrors the action buttons) and a per-field
  // menu (copy / reveal / open) shared by every field row via `openFieldCtx`.
  const [headerMenu, setHeaderMenu] = createSignal<{ x: number; y: number } | null>(null);
  const [fieldMenu, setFieldMenu] = createSignal<({ x: number; y: number } & FieldMenuPayload) | null>(
    null,
  );
  const openHeaderMenu = (e: MouseEvent) => {
    e.preventDefault();
    setHeaderMenu({ x: e.clientX, y: e.clientY });
  };
  const openFieldCtx: OnFieldCtx = (e, payload) => {
    e.preventDefault();
    e.stopPropagation();
    setFieldMenu({ x: e.clientX, y: e.clientY, ...payload });
  };

  // Reprompt gate: a reprompt-protected item's secrets stay masked until the user
  // re-enters the app password. `guard` runs the action immediately for normal
  // items (or already-verified ones), else defers it behind the gate modal.
  const [gate, setGate] = createSignal<{ run: () => void } | null>(null);
  const repromptLocked = () => props.detail.reprompt && !isReprompted(props.detail.id);
  function guard(action: () => void) {
    if (repromptLocked()) setGate({ run: action });
    else action();
  }

  // Resolve this item's collection IDs to names (loaded lazily once).
  onMount(() => void loadCollections());
  const collectionNames = () => collectionNamesFor(props.detail.collectionIds);

  // Attachment download (fetch + decrypt in the backend, saved to Downloads).
  // Reprompt-gated like the password reveal.
  const [downloading, setDownloading] = createSignal<string | null>(null);
  async function downloadAttachment(att: Attachment) {
    setDownloading(att.id);
    try {
      const path = await ipc.downloadAttachment(props.detail.accountEmail, props.detail.id, att.id);
      pushToast('success', `Saved ${att.fileName ?? 'attachment'} to ${path}`);
    } catch (err) {
      toastError(err);
    } finally {
      setDownloading(null);
    }
  }

  return (
    <div class="detail">
      <div class="detail-head" onContextMenu={openHeaderMenu}>
        <h2 class="detail-name">{d().name}</h2>
        <span class="spacer" />
        <div class="detail-actions">
          <Show
            when={!props.inTrash}
            fallback={
              <>
                <button class="ghost icon-btn" title="Restore" onClick={() => props.onRestore(d().id)}>
                  <RotateCcw size={15} strokeWidth={1.6} />
                </button>
                <button
                  class="ghost icon-btn detail-del"
                  title="Delete permanently"
                  onClick={() => props.onDelete(d().id, true)}
                >
                  <Trash2 size={15} strokeWidth={1.6} />
                </button>
              </>
            }
          >
            <button
              class="ghost icon-btn"
              title={d().favorite ? 'Unfavorite' : 'Favorite'}
              onClick={() => props.onFavorite(d())}
            >
              <Star size={15} strokeWidth={1.6} class={d().favorite ? 'vault-row-fav' : ''} />
            </button>
            <button class="ghost icon-btn" title="Edit" onClick={() => props.onEdit(d())}>
              <Pencil size={15} strokeWidth={1.6} />
            </button>
            <button class="ghost icon-btn" title="Clone" onClick={() => props.onClone(d().id)}>
              <Copy size={15} strokeWidth={1.6} />
            </button>
            <button
              class="ghost icon-btn detail-del"
              title="Move to trash"
              onClick={() => props.onDelete(d().id, false)}
            >
              <Trash2 size={15} strokeWidth={1.6} />
            </button>
          </Show>
        </div>
      </div>

      <Show when={d().login}>
        {(login) => (
          <>
            <Show when={login().username}>
              <Field
                label="Username"
                value={login().username}
                onCopy={() => props.copy('Username', login().username)}
                onCtx={openFieldCtx}
              />
            </Show>
            <Show when={login().password}>
              {(() => {
                // Masked unless explicitly revealed AND (not reprompt-locked).
                const pwShown = () => props.revealed && !repromptLocked();
                return (
                  <div
                    class="detail-field"
                    onContextMenu={(e) =>
                      openFieldCtx(e, {
                        label: 'Password',
                        copy: () => guard(() => props.copy('Password', login().password)),
                        reveal: {
                          shown: pwShown(),
                          toggle: () => guard(() => props.setRevealed(!props.revealed)),
                        },
                      })
                    }
                  >
                    <label>Password</label>
                    <div class="detail-value-row">
                      <code
                        class="detail-value mono copyable"
                        title="Copy"
                        onClick={() => guard(() => props.copy('Password', login().password))}
                      >
                        {pwShown() ? login().password : '••••••••••••'}
                      </code>
                      <button
                        class="ghost icon-btn"
                        title={pwShown() ? 'Hide' : 'Reveal'}
                        onClick={() => guard(() => props.setRevealed(!props.revealed))}
                      >
                        {pwShown() ? <EyeOff size={14} /> : <Eye size={14} />}
                      </button>
                    </div>
                  </div>
                );
              })()}
            </Show>

            <Show when={props.totp}>
              {(code) => (
                <div
                  class="detail-field"
                  onContextMenu={(e) =>
                    openFieldCtx(e, { label: 'One-time code', copy: () => props.copy('Code', code().code) })
                  }
                >
                  <label>
                    <Timer size={11} strokeWidth={2} /> One-time code
                  </label>
                  <div class="detail-value-row">
                    <code
                      class="detail-value mono totp-code copyable"
                      title="Copy"
                      onClick={() => props.copy('Code', code().code)}
                    >
                      {code().code}
                    </code>
                    <TotpRing remaining={code().remaining} period={code().period} size={16} />
                  </div>
                </div>
              )}
            </Show>

            <For each={login().uris}>
              {(u) => (
                <Show when={u.uri}>
                  <div
                    class="detail-field"
                    onContextMenu={(e) =>
                      openFieldCtx(e, {
                        label: 'Website',
                        copy: () => props.copy('URL', u.uri),
                        openUrl: u.uri ?? undefined,
                      })
                    }
                  >
                    <label>Website</label>
                    <div class="detail-value-row">
                      <span
                        class="detail-value truncate copyable"
                        title="Copy"
                        onClick={() => props.copy('URL', u.uri)}
                      >
                        {u.uri}
                      </span>
                      <button class="ghost icon-btn" title="Open" onClick={() => u.uri && void openUrl(u.uri)}>
                        <ExternalLink size={14} />
                      </button>
                    </div>
                  </div>
                </Show>
              )}
            </For>
          </>
        )}
      </Show>

      <Show when={d().card}>{(card) => <CardVisual card={card()} onCopy={props.copy} onCtx={openFieldCtx} />}</Show>

      <Show when={d().identity}>
        {(id) => (
          <For each={identityFields(id())}>
            {(f) => (
              <Show when={f.value}>
                <Field
                  label={f.label}
                  value={f.value}
                  onCopy={() => props.copy(f.label, f.value)}
                  onCtx={openFieldCtx}
                />
              </Show>
            )}
          </For>
        )}
      </Show>

      <Show when={d().sshKey}>
        {(key) => (
          <>
            <Show when={key().publicKey}>
              <Field
                label="Public key"
                value={key().publicKey}
                onCopy={() => props.copy('Public key', key().publicKey)}
                onCtx={openFieldCtx}
              />
            </Show>
            <Show when={key().fingerprint}>
              <Field
                label="Fingerprint"
                value={key().fingerprint}
                onCopy={() => props.copy('Fingerprint', key().fingerprint)}
                onCtx={openFieldCtx}
              />
            </Show>
            <Show when={key().privateKey}>
              <SecretField
                label="Private key"
                value={key().privateKey}
                onCopy={() => props.copy('Private key', key().privateKey)}
                onCtx={openFieldCtx}
              />
            </Show>
          </>
        )}
      </Show>

      <For each={d().fields}>
        {(f) => (
          <Show when={f.name || f.value || f.fieldType === 'linked'}>
            <CustomFieldView
              field={f}
              detail={d()}
              onCopy={(label, value) => props.copy(label, value)}
              onCtx={openFieldCtx}
            />
          </Show>
        )}
      </For>

      <Show when={d().notes}>
        {(notes) => <NotesView notes={notes()} />}
      </Show>

      {/* Security audit verdict + breach affection, pinned to the bottom of the
          item view. Shows when there's an offline verdict (logins) or the item's
          email turns up in a known breach. */}
      <Show when={props.selectedSecurity || props.selectedBreaches.length > 0}>
        <div class="detail-sec-section">
          <label class="detail-sec-heading">Security</label>

          {/* The offline verdict. Suppress the clean "no issues" line when the item
              is in a breach — the breach block below is the real verdict then. */}
          <Show
            when={
              props.selectedSecurity &&
              (props.selectedSecurity.kind === 'risk' || props.selectedBreaches.length === 0)
                ? props.selectedSecurity
                : null
            }
          >
            {(sec) => {
              const s = sec();
              return (
                <div class="detail-sec" classList={{ risk: s.kind === 'risk' }}>
                  <Show
                    when={s.kind === 'risk' ? s : null}
                    fallback={
                      <>
                        <ShieldCheck size={14} strokeWidth={1.75} />
                        <span class="detail-sec-label">No known security issues</span>
                      </>
                    }
                  >
                    {(risk) => (
                      <>
                        <ShieldAlert size={14} strokeWidth={1.75} />
                        <div class="detail-sec-chips">
                          <For each={risk().chips}>
                            {(c) => (
                              <span class="detail-sec-chip" classList={{ severe: c.severe }}>
                                {c.label}
                              </span>
                            )}
                          </For>
                        </div>
                      </>
                    )}
                  </Show>
                </div>
              );
            }}
          </Show>

          <Show when={props.selectedBreaches.length > 0}>
            <div class="detail-sec breach">
              <ShieldAlert size={14} strokeWidth={1.75} />
              <div class="detail-sec-breach-body">
                <span class="detail-sec-breach-title">
                  Found in {props.selectedBreaches.length} data breach
                  {props.selectedBreaches.length === 1 ? '' : 'es'}
                </span>
                <div class="detail-sec-chips">
                  <For each={props.selectedBreaches}>
                    {(b) => <span class="detail-sec-chip severe">{b.name}</span>}
                  </For>
                </div>
              </div>
            </div>
          </Show>
        </div>
      </Show>

      {/* Stored passkeys (FIDO2) — read-only display; use needs a browser extension. */}
      <Show when={d().passkeys.length > 0}>
        <div class="detail-field">
          <label>Passkeys</label>
          <For each={d().passkeys}>
            {(pk) => (
              <div class="detail-passkey">
                <KeyRound size={14} strokeWidth={1.6} />
                <span class="detail-passkey-info">
                  <span class="detail-passkey-rp truncate">{pk.rpName || pk.rpId}</span>
                  <Show when={pk.userName}>
                    <span class="muted detail-passkey-user truncate">{pk.userName}</span>
                  </Show>
                </span>
              </div>
            )}
          </For>
        </div>
      </Show>

      {/* File attachments — download fetches + decrypts to the Downloads folder. */}
      <Show when={d().attachments.length > 0}>
        <div class="detail-field">
          <label>Attachments</label>
          <For each={d().attachments}>
            {(att) => (
              <div class="detail-attachment">
                <Paperclip size={14} strokeWidth={1.6} />
                <span class="detail-attachment-name truncate">{att.fileName ?? 'attachment'}</span>
                <Show when={att.sizeName}>
                  <span class="detail-attachment-size muted">{att.sizeName}</span>
                </Show>
                <button
                  class="ghost icon-btn"
                  title="Download"
                  disabled={downloading() === att.id}
                  onClick={() => guard(() => void downloadAttachment(att))}
                >
                  <Download size={14} />
                </button>
              </div>
            )}
          </For>
        </div>
      </Show>

      {/* Collections this item belongs to (read-only). */}
      <Show when={collectionNames().length > 0}>
        <div class="detail-field">
          <label>Collections</label>
          <div class="detail-collections">
            <For each={collectionNames()}>
              {(name) => <span class="detail-collection-chip">{name}</span>}
            </For>
          </div>
        </div>
      </Show>

      {/* Created / updated timestamps, pinned to the very bottom. */}
      <div class="detail-meta muted">
        <span title={absoluteDate(d().creationDate)}>Created {relativeFromNow(d().creationDate)}</span>
        <span title={absoluteDate(d().revisionDate)}>Updated {relativeFromNow(d().revisionDate)}</span>
      </div>

      {/* Reprompt gate: re-verify the app password, then run the deferred action. */}
      <Show when={gate()}>
        {(g) => (
          <RepromptGate
            itemName={d().name}
            onVerified={() => {
              markReprompted(d().id);
              const action = g().run;
              setGate(null);
              action();
            }}
            onClose={() => setGate(null)}
          />
        )}
      </Show>

      {/* Right-click the header → the same actions as the buttons above. */}
      <Show when={headerMenu()}>
        {(m) => {
          const close = () => setHeaderMenu(null);
          const act = (fn: () => void) => () => {
            fn();
            close();
          };
          return (
            <ContextMenu x={m().x} y={m().y} onClose={close}>
              <CtxTitle>{d().name}</CtxTitle>
              <CtxSep />
              <Show
                when={!props.inTrash}
                fallback={
                  <>
                    <CtxItem onClick={act(() => props.onRestore(d().id))}>
                      <RotateCcw size={14} /> Restore
                    </CtxItem>
                    <CtxItem danger onClick={act(() => props.onDelete(d().id, true))}>
                      <Trash2 size={14} /> Delete permanently
                    </CtxItem>
                  </>
                }
              >
                <CtxItem onClick={act(() => props.onFavorite(d()))}>
                  <Star size={14} /> {d().favorite ? 'Unfavorite' : 'Favorite'}
                </CtxItem>
                <CtxItem onClick={act(() => props.onEdit(d()))}>
                  <Pencil size={14} /> Edit
                </CtxItem>
                <CtxItem onClick={act(() => props.onClone(d().id))}>
                  <Copy size={14} /> Clone
                </CtxItem>
                <CtxSep />
                <CtxItem danger onClick={act(() => props.onDelete(d().id, false))}>
                  <Trash2 size={14} /> Move to trash
                </CtxItem>
              </Show>
            </ContextMenu>
          );
        }}
      </Show>

      {/* Right-click any field row → copy / reveal / open. */}
      <Show when={fieldMenu()}>
        {(m) => {
          const close = () => setFieldMenu(null);
          return (
            <ContextMenu x={m().x} y={m().y} onClose={close}>
              <CtxItem
                onClick={() => {
                  m().copy();
                  close();
                }}
              >
                <Copy size={14} /> Copy {m().label.toLowerCase()}
              </CtxItem>
              <Show when={m().reveal}>
                {(r) => (
                  <CtxItem
                    onClick={() => {
                      r().toggle();
                      close();
                    }}
                  >
                    <Show when={r().shown} fallback={<Eye size={14} />}>
                      <EyeOff size={14} />
                    </Show>{' '}
                    {r().shown ? 'Hide' : 'Reveal'}
                  </CtxItem>
                )}
              </Show>
              <Show when={m().openUrl}>
                {(url) => (
                  <CtxItem
                    onClick={() => {
                      void openUrl(url());
                      close();
                    }}
                  >
                    <ExternalLink size={14} /> Open website
                  </CtxItem>
                )}
              </Show>
            </ContextMenu>
          );
        }}
      </Show>
    </div>
  );
}

function Field(props: { label: string; value: string | null; onCopy: () => void; onCtx?: OnFieldCtx }) {
  return (
    <div
      class="detail-field"
      onContextMenu={(e) => props.onCtx?.(e, { label: props.label, copy: props.onCopy })}
    >
      <label>{props.label}</label>
      <div class="detail-value-row">
        <span class="detail-value truncate copyable" title="Copy" onClick={() => props.onCopy()}>
          {props.value}
        </span>
      </div>
    </div>
  );
}

// Masked value with a per-field reveal toggle (card number/CVV, SSH private key).
function SecretField(props: { label: string; value: string | null; onCopy: () => void; onCtx?: OnFieldCtx }) {
  const [show, setShow] = createSignal(false);
  return (
    <div
      class="detail-field"
      onContextMenu={(e) =>
        props.onCtx?.(e, {
          label: props.label,
          copy: props.onCopy,
          reveal: { shown: show(), toggle: () => setShow((s) => !s) },
        })
      }
    >
      <label>{props.label}</label>
      <div class="detail-value-row">
        <code class="detail-value mono copyable" title="Copy" onClick={() => props.onCopy()}>
          {show() ? props.value : '••••••••••••'}
        </code>
        <button class="ghost icon-btn" title={show() ? 'Hide' : 'Reveal'} onClick={() => setShow(!show())}>
          {show() ? <EyeOff size={14} /> : <Eye size={14} />}
        </button>
      </div>
    </div>
  );
}

// Read-only card "face" for the detail pane: brand, masked number, holder, expiry.
function CardVisual(props: {
  card: CardInput;
  onCopy: (label: string, value: string | null) => void;
  onCtx?: OnFieldCtx;
}) {
  const [revealed, setRevealed] = createSignal(false);
  const reveal = () => ({ shown: revealed(), toggle: () => setRevealed((r) => !r) });
  const brand = () => props.card.brand || detectCardBrand(props.card.number ?? '') || 'Card';
  const number = () => props.card.number ?? '';
  const numberText = () =>
    number()
      ? revealed()
        ? formatCardNumber(number(), brand())
        : maskCardNumber(number())
      : '•••• •••• •••• ••••';
  return (
    <div class="card-visual">
      <div class="card-visual-top">
        <CreditCard size={22} strokeWidth={1.5} />
        <span class="card-visual-brand">{brand()}</span>
      </div>
      <div
        class="card-visual-number-row"
        onContextMenu={(e) =>
          number() &&
          props.onCtx?.(e, { label: 'Number', copy: () => props.onCopy('Number', number()), reveal: reveal() })
        }
      >
        <span
          class="card-visual-number mono"
          classList={{ copyable: !!number() }}
          title={number() ? 'Copy' : undefined}
          onClick={() => number() && props.onCopy('Number', number())}
        >
          {numberText()}
        </span>
        <Show when={number()}>
          <button
            class="ghost icon-btn"
            title={revealed() ? 'Hide' : 'Reveal'}
            onClick={() => setRevealed(!revealed())}
          >
            {revealed() ? <EyeOff size={14} /> : <Eye size={14} />}
          </button>
        </Show>
      </div>
      <div class="card-visual-bottom">
        <div class="card-visual-meta">
          <span class="card-visual-cap">Cardholder</span>
          <span class="card-visual-val">{props.card.cardholderName || '—'}</span>
        </div>
        <Show when={props.card.expMonth || props.card.expYear}>
          <div class="card-visual-meta">
            <span class="card-visual-cap">Expires</span>
            <span class="card-visual-val">{cardExpiry(props.card)}</span>
          </div>
        </Show>
        <Show when={props.card.code}>
          <div class="card-visual-meta">
            <span class="card-visual-cap">CVV</span>
            <span
              class="card-visual-cvv"
              onContextMenu={(e) =>
                props.onCtx?.(e, {
                  label: 'Security code',
                  copy: () => props.onCopy('Security code', props.card.code),
                  reveal: reveal(),
                })
              }
            >
              <span
                class="card-visual-val copyable"
                title="Copy"
                onClick={() => props.onCopy('Security code', props.card.code)}
              >
                {revealed() ? props.card.code : '•••'}
              </span>
            </span>
          </div>
        </Show>
      </div>
    </div>
  );
}

// One custom field, rendered by its type: boolean as an on/off chip, hidden as a
// masked secret, linked as its resolved target value (masked if secret), text as
// a plain copyable row.
function CustomFieldView(props: {
  field: CustomField;
  detail: ItemDetail;
  onCopy: (label: string, value: string | null) => void;
  onCtx?: OnFieldCtx;
}) {
  const f = () => props.field;
  const label = () => f().name ?? 'Field';
  return (
    <Switch
      fallback={
        <Field
          label={label()}
          value={f().value}
          onCopy={() => props.onCopy(label(), f().value)}
          onCtx={props.onCtx}
        />
      }
    >
      <Match when={f().fieldType === 'boolean'}>
        <div class="detail-field">
          <label>{label()}</label>
          <div class="detail-bool" classList={{ on: f().value === 'true' }}>
            <Show when={f().value === 'true'} fallback={<span>Off</span>}>
              <Check size={14} strokeWidth={2.25} /> On
            </Show>
          </div>
        </div>
      </Match>
      <Match when={f().fieldType === 'hidden'}>
        <SecretField
          label={label()}
          value={f().value}
          onCopy={() => props.onCopy(label(), f().value)}
          onCtx={props.onCtx}
        />
      </Match>
      <Match when={f().fieldType === 'linked'}>
        {(() => {
          const target = linkedLabel(f().linkedId);
          const value = resolveLinkedValue(props.detail, f().linkedId);
          const lbl = `${label()} → ${target}`;
          if (value === null) {
            return (
              <div class="detail-field">
                <label>
                  <LinkIcon size={11} strokeWidth={2} /> {lbl}
                </label>
                <div class="detail-value-row">
                  <span class="detail-value muted">Linked field (empty)</span>
                </div>
              </div>
            );
          }
          if (isLinkedSecret(f().linkedId)) {
            return (
              <SecretField
                label={lbl}
                value={value}
                onCopy={() => props.onCopy(label(), value)}
                onCtx={props.onCtx}
              />
            );
          }
          return (
            <div class="detail-field">
              <label>
                <LinkIcon size={11} strokeWidth={2} /> {lbl}
              </label>
              <div class="detail-value-row">
                <span
                  class="detail-value truncate copyable"
                  title="Copy"
                  onClick={() => props.onCopy(label(), value)}
                >
                  {value}
                </span>
              </div>
            </div>
          );
        })()}
      </Match>
    </Switch>
  );
}
