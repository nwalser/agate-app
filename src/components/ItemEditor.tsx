import { createMemo, createSignal, For, Match, onCleanup, onMount, Show, Switch } from 'solid-js';
import {
  CreditCard,
  Dices,
  Eye,
  EyeOff,
  Link as LinkIcon,
  Plus,
  Star,
  Trash2,
  X,
} from 'lucide-solid';
import { ipc } from '../lib/ipc.ts';
import type {
  CardInput,
  Folder,
  IdentityInput,
  ItemDetail,
  ItemInput,
  ItemType,
  LoginInput,
  SshKeyInput,
  UriInput,
} from '../lib/types.ts';
import {
  CARD_BRANDS,
  detectCardBrand,
  formatCardNumber,
  linkedOptionsFor,
} from '../lib/itemFields.ts';
import { toastError } from '../state/toast.ts';
import './ItemEditor.css';

// Closed sets as string-literal unions (CLAUDE.md), mapped to backend ints.
type FieldKindLabel = 'Text' | 'Hidden' | 'Boolean' | 'Linked';
const FIELD_KIND_TO_INT: Record<FieldKindLabel, number> = {
  Text: 0,
  Hidden: 1,
  Boolean: 2,
  Linked: 3,
};
function fieldIntToLabel(n: number): FieldKindLabel {
  if (n === 1) return 'Hidden';
  if (n === 2) return 'Boolean';
  if (n === 3) return 'Linked';
  return 'Text';
}

type MatchLabel =
  | 'Default'
  | 'Domain'
  | 'Host'
  | 'Starts with'
  | 'Exact'
  | 'Regex'
  | 'Never';
const MATCH_OPTIONS: { label: MatchLabel; value: number | null }[] = [
  { label: 'Default', value: null },
  { label: 'Domain', value: 0 },
  { label: 'Host', value: 1 },
  { label: 'Starts with', value: 2 },
  { label: 'Exact', value: 3 },
  { label: 'Regex', value: 4 },
  { label: 'Never', value: 5 },
];

// Month dropdown for card expiry. Values are the bare month number (Bitwarden
// stores expMonth as "1".."12"); the labels stay human.
const MONTHS = [
  'January',
  'February',
  'March',
  'April',
  'May',
  'June',
  'July',
  'August',
  'September',
  'October',
  'November',
  'December',
].map((label, idx) => ({
  value: String(idx + 1),
  label: `${String(idx + 1).padStart(2, '0')} — ${label}`,
}));

type GenMode = 'password' | 'passphrase';

interface FieldRow {
  name: string;
  value: string;
  kind: FieldKindLabel;
  /** For Linked rows: the numeric LinkedIdType target. */
  linkedId: number | null;
}

interface UriRow {
  uri: string;
  matchType: number | null;
}

// Map a UI string to a nullable backend string (empty → null).
function orNull(s: string): string | null {
  const t = s.trim();
  return t.length > 0 ? t : null;
}

// Lightweight password-strength heuristic (0–4) for the login editor's meter.
// Not a security control — just feedback while typing.
function passwordStrength(pw: string): { score: number; label: string } {
  if (!pw) return { score: 0, label: '' };
  let score = 0;
  if (pw.length >= 8) score++;
  if (pw.length >= 14) score++;
  const classes = [/[a-z]/, /[A-Z]/, /\d/, /[^A-Za-z0-9]/].filter((re) => re.test(pw)).length;
  if (classes >= 2) score++;
  if (classes >= 3 && pw.length >= 10) score++;
  score = Math.min(score, 4);
  return { score, label: ['', 'Weak', 'Fair', 'Good', 'Strong'][score] };
}

const TYPE_LABELS: Record<ItemType, string> = {
  login: 'Login',
  secureNote: 'Secure note',
  card: 'Card',
  identity: 'Identity',
  sshKey: 'SSH key',
  unknown: 'Item',
};

export default function ItemEditor(props: {
  item?: ItemDetail | null;
  createType?: ItemType;
  /** Which connection this item belongs to / is created in. */
  accountEmail: string;
  folders: Folder[];
  onSaved: () => void;
  onClose: () => void;
}) {
  const editing = createMemo(() => !!props.item);
  const itemType = createMemo<ItemType>(
    () => props.item?.itemType ?? props.createType ?? 'login',
  );
  // Linkable properties for this item type (empty for note / SSH key).
  const linkOptions = createMemo(() => linkedOptionsFor(itemType()));

  // ---- common fields ----
  const [name, setName] = createSignal(props.item?.name ?? '');
  const [folderId, setFolderId] = createSignal<string | null>(
    props.item?.folderId ?? null,
  );
  const [favorite, setFavorite] = createSignal(props.item?.favorite ?? false);
  const [reprompt, setReprompt] = createSignal(props.item?.reprompt ?? false);
  const [notes, setNotes] = createSignal(props.item?.notes ?? '');
  const [fields, setFields] = createSignal<FieldRow[]>(
    (props.item?.fields ?? []).map((f) => ({
      name: f.name ?? '',
      value: f.value ?? '',
      kind: fieldIntToLabel(Number(f.fieldType)),
      linkedId: f.linkedId ?? null,
    })),
  );

  // ---- login ----
  const [username, setUsername] = createSignal(props.item?.login?.username ?? '');
  const [password, setPassword] = createSignal(props.item?.login?.password ?? '');
  const [revealPw, setRevealPw] = createSignal(false);
  // Prefill the real TOTP secret so an edit preserves it (backend also guards).
  const [totp, setTotp] = createSignal(props.item?.login?.totp ?? '');
  const [uris, setUris] = createSignal<UriRow[]>(
    (props.item?.login?.uris ?? []).map((u) => ({
      uri: u.uri ?? '',
      matchType: u.matchType ?? null,
    })),
  );
  const strength = createMemo(() => passwordStrength(password()));

  // ---- card (prefilled from ItemDetail.card so edits don't wipe it) ----
  const c = () => props.item?.card ?? null;
  const [cardholderName, setCardholderName] = createSignal(c()?.cardholderName ?? '');
  const [cardNumber, setCardNumber] = createSignal(c()?.number ?? '');
  const [cardBrand, setCardBrand] = createSignal(c()?.brand ?? '');
  const [expMonth, setExpMonth] = createSignal(c()?.expMonth ?? '');
  const [expYear, setExpYear] = createSignal(c()?.expYear ?? '');
  const [cardCode, setCardCode] = createSignal(c()?.code ?? '');
  const [revealCode, setRevealCode] = createSignal(false);
  // Effective brand for the preview: the chosen brand, else a live guess.
  const previewBrand = createMemo(() => cardBrand() || detectCardBrand(cardNumber()) || '');

  // Set the card number and auto-fill the brand when it's still blank, so a
  // pasted number picks its own brand without clobbering a manual choice.
  function onCardNumberInput(v: string) {
    setCardNumber(v);
    if (!cardBrand()) {
      const guess = detectCardBrand(v);
      if (guess) setCardBrand(guess);
    }
  }

  // ---- identity (prefilled from ItemDetail.identity) ----
  const idd = () => props.item?.identity ?? null;
  const [idTitle, setIdTitle] = createSignal(idd()?.title ?? '');
  const [firstName, setFirstName] = createSignal(idd()?.firstName ?? '');
  const [middleName, setMiddleName] = createSignal(idd()?.middleName ?? '');
  const [lastName, setLastName] = createSignal(idd()?.lastName ?? '');
  const [idUsername, setIdUsername] = createSignal(idd()?.username ?? '');
  const [company, setCompany] = createSignal(idd()?.company ?? '');
  const [ssn, setSsn] = createSignal(idd()?.ssn ?? '');
  const [passportNumber, setPassportNumber] = createSignal(idd()?.passportNumber ?? '');
  const [licenseNumber, setLicenseNumber] = createSignal(idd()?.licenseNumber ?? '');
  const [email, setEmail] = createSignal(idd()?.email ?? '');
  const [phone, setPhone] = createSignal(idd()?.phone ?? '');
  const [address1, setAddress1] = createSignal(idd()?.address1 ?? '');
  const [address2, setAddress2] = createSignal(idd()?.address2 ?? '');
  const [address3, setAddress3] = createSignal(idd()?.address3 ?? '');
  const [city, setCity] = createSignal(idd()?.city ?? '');
  const [stateRegion, setStateRegion] = createSignal(idd()?.state ?? '');
  const [postalCode, setPostalCode] = createSignal(idd()?.postalCode ?? '');
  const [country, setCountry] = createSignal(idd()?.country ?? '');

  // ---- ssh key (prefilled from ItemDetail.sshKey) ----
  const sk = () => props.item?.sshKey ?? null;
  const [privateKey, setPrivateKey] = createSignal(sk()?.privateKey ?? '');
  const [publicKey, setPublicKey] = createSignal(sk()?.publicKey ?? '');
  const [fingerprint, setFingerprint] = createSignal(sk()?.fingerprint ?? '');

  // ---- generator popover ----
  const [genOpen, setGenOpen] = createSignal(false);
  const [genMode, setGenMode] = createSignal<GenMode>('password');
  const [genLength, setGenLength] = createSignal(16);
  const [genUpper, setGenUpper] = createSignal(true);
  const [genLower, setGenLower] = createSignal(true);
  const [genNumbers, setGenNumbers] = createSignal(true);
  const [genSpecial, setGenSpecial] = createSignal(true);
  const [genWords, setGenWords] = createSignal(4);
  const [genSeparator, setGenSeparator] = createSignal('-');
  const [genCapitalize, setGenCapitalize] = createSignal(true);
  const [genWordNumber, setGenWordNumber] = createSignal(true);

  const [saving, setSaving] = createSignal(false);

  function onKeyDown(e: KeyboardEvent) {
    if (e.key === 'Escape') {
      e.preventDefault();
      props.onClose();
    }
  }
  onMount(() => document.addEventListener('keydown', onKeyDown));
  onCleanup(() => document.removeEventListener('keydown', onKeyDown));

  // ---- custom field rows ----
  function addField() {
    setFields((prev) => [...prev, { name: '', value: '', kind: 'Text', linkedId: null }]);
  }
  function removeField(index: number) {
    setFields((prev) => prev.filter((_, i) => i !== index));
  }
  function updateField(index: number, patch: Partial<FieldRow>) {
    setFields((prev) => prev.map((f, i) => (i === index ? { ...f, ...patch } : f)));
  }
  // Switching a row's kind: seed a default linked target / boolean value so the
  // row is immediately valid.
  function changeFieldKind(index: number, kind: FieldKindLabel, current: FieldRow) {
    const patch: Partial<FieldRow> = { kind };
    if (kind === 'Linked' && current.linkedId == null) {
      patch.linkedId = linkOptions()[0]?.id ?? null;
    }
    if (kind === 'Boolean' && current.value !== 'true' && current.value !== 'false') {
      patch.value = 'false';
    }
    updateField(index, patch);
  }

  // ---- uri rows ----
  function addUri() {
    setUris((prev) => [...prev, { uri: '', matchType: null }]);
  }
  function removeUri(index: number) {
    setUris((prev) => prev.filter((_, i) => i !== index));
  }
  function updateUri(index: number, patch: Partial<UriRow>) {
    setUris((prev) => prev.map((u, i) => (i === index ? { ...u, ...patch } : u)));
  }

  async function generate() {
    try {
      let result: string;
      if (genMode() === 'passphrase') {
        result = await ipc.generatePassphrase({
          numWords: genWords(),
          wordSeparator: genSeparator() || '-',
          capitalize: genCapitalize(),
          includeNumber: genWordNumber(),
        });
      } else {
        result = await ipc.generatePassword({
          length: genLength(),
          uppercase: genUpper(),
          lowercase: genLower(),
          numbers: genNumbers(),
          special: genSpecial(),
          avoidAmbiguous: true,
        });
      }
      setPassword(result);
      setRevealPw(true);
      setGenOpen(false);
    } catch (err) {
      toastError(err);
    }
  }

  function buildLogin(): LoginInput {
    const uriInputs: UriInput[] = uris()
      .filter((u) => u.uri.trim().length > 0)
      .map((u) => ({ uri: orNull(u.uri), matchType: u.matchType }));
    return {
      username: orNull(username()),
      password: orNull(password()),
      totp: orNull(totp()),
      uris: uriInputs,
    };
  }

  function buildCard(): CardInput {
    return {
      cardholderName: orNull(cardholderName()),
      number: orNull(cardNumber()),
      brand: orNull(cardBrand()),
      expMonth: orNull(expMonth()),
      expYear: orNull(expYear()),
      code: orNull(cardCode()),
    };
  }

  function buildIdentity(): IdentityInput {
    return {
      title: orNull(idTitle()),
      firstName: orNull(firstName()),
      middleName: orNull(middleName()),
      lastName: orNull(lastName()),
      username: orNull(idUsername()),
      company: orNull(company()),
      ssn: orNull(ssn()),
      passportNumber: orNull(passportNumber()),
      licenseNumber: orNull(licenseNumber()),
      email: orNull(email()),
      phone: orNull(phone()),
      address1: orNull(address1()),
      address2: orNull(address2()),
      address3: orNull(address3()),
      city: orNull(city()),
      state: orNull(stateRegion()),
      postalCode: orNull(postalCode()),
      country: orNull(country()),
    };
  }

  function buildSshKey(): SshKeyInput {
    return {
      privateKey: privateKey(),
      publicKey: publicKey(),
      fingerprint: fingerprint(),
    };
  }

  // A linked row carries no value (the target id is the payload); other rows
  // carry no linkedId. Drop rows that are entirely empty / incomplete.
  function buildFields() {
    return fields()
      .filter((f) =>
        f.kind === 'Linked'
          ? f.name.trim().length > 0 && f.linkedId != null
          : f.name.trim().length > 0 || f.value.trim().length > 0,
      )
      .map((f) => ({
        name: orNull(f.name),
        value: f.kind === 'Linked' ? null : orNull(f.value),
        fieldType: FIELD_KIND_TO_INT[f.kind],
        linkedId: f.kind === 'Linked' ? f.linkedId : null,
      }));
  }

  async function save() {
    if (name().trim().length === 0) {
      toastError(new Error('Name is required.'));
      return;
    }
    const t = itemType();
    const input: ItemInput = {
      id: props.item?.id ?? null,
      itemType: t,
      name: name().trim(),
      folderId: folderId(),
      organizationId: props.item?.organizationId ?? null,
      favorite: favorite(),
      reprompt: reprompt(),
      notes: orNull(notes()),
      login: t === 'login' ? buildLogin() : null,
      card: t === 'card' ? buildCard() : null,
      identity: t === 'identity' ? buildIdentity() : null,
      sshKey: t === 'sshKey' ? buildSshKey() : null,
      fields: buildFields(),
    };

    setSaving(true);
    try {
      await ipc.saveItem(props.accountEmail, input);
      props.onSaved();
    } catch (err) {
      toastError(err);
    } finally {
      setSaving(false);
    }
  }

  const heading = createMemo(
    () => `${editing() ? 'Edit' : 'New'} ${TYPE_LABELS[itemType()].toLowerCase()}`,
  );

  return (
    <div class="item-editor">
        <header class="ie-header">
          <h2 class="ie-title">{heading()}</h2>
          <button class="ghost icon-btn" title="Cancel" onClick={() => props.onClose()}>
            <X size={16} strokeWidth={1.75} />
          </button>
        </header>

        <div class="ie-body">
          {/* ---- common ---- */}
          <div class="ie-section">
            <div class="field">
              <label>Name</label>
              <input
                value={name()}
                onInput={(e) => setName(e.currentTarget.value)}
                placeholder="Name"
                autofocus
              />
            </div>

            <div class="field">
              <label>Folder</label>
              <select
                value={folderId() ?? ''}
                onChange={(e) =>
                  setFolderId(e.currentTarget.value === '' ? null : e.currentTarget.value)
                }
              >
                <option value="">No folder</option>
                <For each={props.folders.filter((f) => f.id !== null && f.accountEmail === props.accountEmail)}>
                  {(f) => <option value={f.id ?? ''}>{f.name}</option>}
                </For>
              </select>
            </div>
          </div>

          {/* ---- login ---- */}
          <Show when={itemType() === 'login'}>
            <div class="ie-section">
              <div class="ie-section-title">Login credentials</div>
              <div class="field">
                <label>Username</label>
                <input
                  value={username()}
                  onInput={(e) => setUsername(e.currentTarget.value)}
                  autocomplete="off"
                />
              </div>

              <div class="field">
                <label>Password</label>
                <div class="row ie-pw-row">
                  <input
                    class="ie-grow ie-mono"
                    type={revealPw() ? 'text' : 'password'}
                    value={password()}
                    onInput={(e) => setPassword(e.currentTarget.value)}
                    autocomplete="off"
                  />
                  <button
                    class="ghost icon-btn"
                    title={revealPw() ? 'Hide' : 'Reveal'}
                    onClick={() => setRevealPw(!revealPw())}
                  >
                    {revealPw() ? <EyeOff size={14} /> : <Eye size={14} />}
                  </button>
                  <div class="ie-gen-anchor">
                    <button
                      class="ghost icon-btn"
                      title="Generate"
                      onClick={() => setGenOpen(!genOpen())}
                    >
                      <Dices size={14} />
                    </button>
                    <Show when={genOpen()}>
                      <div class="ie-gen-popover">
                        <div class="ie-gen-tabs">
                          <button
                            classList={{ active: genMode() === 'password' }}
                            onClick={() => setGenMode('password')}
                          >
                            Password
                          </button>
                          <button
                            classList={{ active: genMode() === 'passphrase' }}
                            onClick={() => setGenMode('passphrase')}
                          >
                            Passphrase
                          </button>
                        </div>

                        <Show
                          when={genMode() === 'password'}
                          fallback={
                            <div class="ie-gen-opts">
                              <div class="field">
                                <label>Words: {genWords()}</label>
                                <input
                                  type="range"
                                  min="3"
                                  max="10"
                                  value={genWords()}
                                  onInput={(e) =>
                                    setGenWords(Number(e.currentTarget.value))
                                  }
                                />
                              </div>
                              <div class="field">
                                <label>Separator</label>
                                <input
                                  value={genSeparator()}
                                  maxlength="1"
                                  onInput={(e) => setGenSeparator(e.currentTarget.value)}
                                />
                              </div>
                              <label class="ie-check">
                                <input
                                  type="checkbox"
                                  checked={genCapitalize()}
                                  onChange={(e) =>
                                    setGenCapitalize(e.currentTarget.checked)
                                  }
                                />
                                Capitalize
                              </label>
                              <label class="ie-check">
                                <input
                                  type="checkbox"
                                  checked={genWordNumber()}
                                  onChange={(e) =>
                                    setGenWordNumber(e.currentTarget.checked)
                                  }
                                />
                                Include number
                              </label>
                            </div>
                          }
                        >
                          <div class="ie-gen-opts">
                            <div class="field">
                              <label>Length: {genLength()}</label>
                              <input
                                type="range"
                                min="8"
                                max="64"
                                value={genLength()}
                                onInput={(e) => setGenLength(Number(e.currentTarget.value))}
                              />
                            </div>
                            <label class="ie-check">
                              <input
                                type="checkbox"
                                checked={genUpper()}
                                onChange={(e) => setGenUpper(e.currentTarget.checked)}
                              />
                              A–Z
                            </label>
                            <label class="ie-check">
                              <input
                                type="checkbox"
                                checked={genLower()}
                                onChange={(e) => setGenLower(e.currentTarget.checked)}
                              />
                              a–z
                            </label>
                            <label class="ie-check">
                              <input
                                type="checkbox"
                                checked={genNumbers()}
                                onChange={(e) => setGenNumbers(e.currentTarget.checked)}
                              />
                              0–9
                            </label>
                            <label class="ie-check">
                              <input
                                type="checkbox"
                                checked={genSpecial()}
                                onChange={(e) => setGenSpecial(e.currentTarget.checked)}
                              />
                              !@#$
                            </label>
                          </div>
                        </Show>

                        <button class="primary ie-gen-go" onClick={() => void generate()}>
                          Generate &amp; use
                        </button>
                      </div>
                    </Show>
                  </div>
                </div>
                <Show when={password().length > 0}>
                  <div class="ie-strength" data-score={strength().score}>
                    <div class="ie-strength-bar">
                      <span />
                      <span />
                      <span />
                      <span />
                    </div>
                    <span class="ie-strength-label">{strength().label}</span>
                  </div>
                </Show>
              </div>

              <div class="field">
                <label>Authenticator key (TOTP)</label>
                <input
                  value={totp()}
                  onInput={(e) => setTotp(e.currentTarget.value)}
                  placeholder="otpauth:// or secret"
                  autocomplete="off"
                />
              </div>

              <div class="field">
                <div class="ie-section-head">
                  <label>URIs</label>
                  <button class="ghost ie-add" onClick={addUri}>
                    <Plus size={13} strokeWidth={1.75} /> Add URI
                  </button>
                </div>
                <For each={uris()}>
                  {(u, i) => (
                    <div class="row ie-multi-row">
                      <input
                        class="ie-grow"
                        value={u.uri}
                        placeholder="https://example.com"
                        onInput={(e) => updateUri(i(), { uri: e.currentTarget.value })}
                      />
                      <select
                        class="ie-match"
                        value={String(u.matchType)}
                        onChange={(e) => {
                          const v = e.currentTarget.value;
                          updateUri(i(), { matchType: v === 'null' ? null : Number(v) });
                        }}
                      >
                        <For each={MATCH_OPTIONS}>
                          {(opt) => (
                            <option value={opt.value === null ? 'null' : String(opt.value)}>
                              {opt.label}
                            </option>
                          )}
                        </For>
                      </select>
                      <button
                        class="ghost icon-btn"
                        title="Remove"
                        onClick={() => removeUri(i())}
                      >
                        <Trash2 size={14} />
                      </button>
                    </div>
                  )}
                </For>
              </div>
            </div>
          </Show>

          {/* ---- card ---- */}
          <Show when={itemType() === 'card'}>
            <div class="ie-section">
              {/* Live preview of the card as it's typed. */}
              <div class="ie-card-preview">
                <div class="ie-card-row-top">
                  <CreditCard size={22} strokeWidth={1.5} />
                  <span class="ie-card-brand">{previewBrand() || 'Card'}</span>
                </div>
                <div class="ie-card-number mono">
                  {formatCardNumber(cardNumber(), previewBrand()) || '•••• •••• •••• ••••'}
                </div>
                <div class="ie-card-row-bottom">
                  <div class="ie-card-meta">
                    <span class="ie-card-cap">Cardholder</span>
                    <span class="ie-card-val">{cardholderName() || '—'}</span>
                  </div>
                  <div class="ie-card-meta">
                    <span class="ie-card-cap">Expires</span>
                    <span class="ie-card-val">
                      {expMonth() ? String(expMonth()).padStart(2, '0') : 'MM'}/
                      {expYear() ? String(expYear()).slice(-2) : 'YY'}
                    </span>
                  </div>
                </div>
              </div>

              <div class="field">
                <label>Cardholder name</label>
                <input
                  value={cardholderName()}
                  onInput={(e) => setCardholderName(e.currentTarget.value)}
                  placeholder="Name on card"
                />
              </div>
              <div class="field">
                <label>Card number</label>
                <input
                  class="ie-mono"
                  value={cardNumber()}
                  onInput={(e) => onCardNumberInput(e.currentTarget.value)}
                  placeholder="0000 0000 0000 0000"
                  inputmode="numeric"
                  autocomplete="off"
                />
              </div>
              <div class="ie-grid-2">
                <div class="field">
                  <label>Brand</label>
                  <select value={cardBrand()} onChange={(e) => setCardBrand(e.currentTarget.value)}>
                    <option value="">Auto-detect</option>
                    <For each={CARD_BRANDS}>{(b) => <option value={b}>{b}</option>}</For>
                  </select>
                </div>
                <div class="field">
                  <label>Security code (CVV)</label>
                  <div class="row ie-pw-row">
                    <input
                      class="ie-grow ie-mono"
                      type={revealCode() ? 'text' : 'password'}
                      value={cardCode()}
                      onInput={(e) => setCardCode(e.currentTarget.value)}
                      placeholder="•••"
                      inputmode="numeric"
                      autocomplete="off"
                    />
                    <button
                      class="ghost icon-btn"
                      title={revealCode() ? 'Hide' : 'Reveal'}
                      onClick={() => setRevealCode(!revealCode())}
                    >
                      {revealCode() ? <EyeOff size={14} /> : <Eye size={14} />}
                    </button>
                  </div>
                </div>
              </div>
              <div class="ie-grid-2">
                <div class="field">
                  <label>Expiration month</label>
                  <select
                    value={expMonth() ? String(Number(expMonth())) : ''}
                    onChange={(e) => setExpMonth(e.currentTarget.value)}
                  >
                    <option value="">—</option>
                    <For each={MONTHS}>{(m) => <option value={m.value}>{m.label}</option>}</For>
                  </select>
                </div>
                <div class="field">
                  <label>Expiration year</label>
                  <input
                    value={expYear()}
                    onInput={(e) => setExpYear(e.currentTarget.value)}
                    placeholder="YYYY"
                    inputmode="numeric"
                  />
                </div>
              </div>
            </div>
          </Show>

          {/* ---- identity ---- */}
          <Show when={itemType() === 'identity'}>
            <div class="ie-section">
              <div class="ie-section-title">Personal details</div>
              <div class="ie-grid-3">
                <div class="field">
                  <label>Title</label>
                  <input value={idTitle()} onInput={(e) => setIdTitle(e.currentTarget.value)} />
                </div>
                <div class="field">
                  <label>First name</label>
                  <input value={firstName()} onInput={(e) => setFirstName(e.currentTarget.value)} />
                </div>
                <div class="field">
                  <label>Middle name</label>
                  <input value={middleName()} onInput={(e) => setMiddleName(e.currentTarget.value)} />
                </div>
              </div>
              <div class="field">
                <label>Last name</label>
                <input value={lastName()} onInput={(e) => setLastName(e.currentTarget.value)} />
              </div>
              <div class="ie-grid-2">
                <div class="field">
                  <label>Username</label>
                  <input value={idUsername()} onInput={(e) => setIdUsername(e.currentTarget.value)} />
                </div>
                <div class="field">
                  <label>Company</label>
                  <input value={company()} onInput={(e) => setCompany(e.currentTarget.value)} />
                </div>
              </div>
              <div class="ie-grid-2">
                <div class="field">
                  <label>Email</label>
                  <input value={email()} onInput={(e) => setEmail(e.currentTarget.value)} />
                </div>
                <div class="field">
                  <label>Phone</label>
                  <input value={phone()} onInput={(e) => setPhone(e.currentTarget.value)} />
                </div>
              </div>
              <div class="ie-grid-3">
                <div class="field">
                  <label>SSN</label>
                  <input value={ssn()} onInput={(e) => setSsn(e.currentTarget.value)} autocomplete="off" />
                </div>
                <div class="field">
                  <label>Passport no.</label>
                  <input
                    value={passportNumber()}
                    onInput={(e) => setPassportNumber(e.currentTarget.value)}
                    autocomplete="off"
                  />
                </div>
                <div class="field">
                  <label>License no.</label>
                  <input
                    value={licenseNumber()}
                    onInput={(e) => setLicenseNumber(e.currentTarget.value)}
                    autocomplete="off"
                  />
                </div>
              </div>
            </div>
            <div class="ie-section">
              <div class="ie-section-title">Address</div>
              <div class="field">
                <label>Address line 1</label>
                <input value={address1()} onInput={(e) => setAddress1(e.currentTarget.value)} />
              </div>
              <div class="field">
                <label>Address line 2</label>
                <input value={address2()} onInput={(e) => setAddress2(e.currentTarget.value)} />
              </div>
              <div class="field">
                <label>Address line 3</label>
                <input value={address3()} onInput={(e) => setAddress3(e.currentTarget.value)} />
              </div>
              <div class="ie-grid-2">
                <div class="field">
                  <label>City</label>
                  <input value={city()} onInput={(e) => setCity(e.currentTarget.value)} />
                </div>
                <div class="field">
                  <label>State / region</label>
                  <input value={stateRegion()} onInput={(e) => setStateRegion(e.currentTarget.value)} />
                </div>
              </div>
              <div class="ie-grid-2">
                <div class="field">
                  <label>Postal code</label>
                  <input value={postalCode()} onInput={(e) => setPostalCode(e.currentTarget.value)} />
                </div>
                <div class="field">
                  <label>Country</label>
                  <input value={country()} onInput={(e) => setCountry(e.currentTarget.value)} />
                </div>
              </div>
            </div>
          </Show>

          {/* ---- ssh key ---- */}
          <Show when={itemType() === 'sshKey'}>
            <div class="ie-section">
              <div class="field">
                <label>Private key</label>
                <textarea
                  class="ie-textarea ie-mono"
                  value={privateKey()}
                  onInput={(e) => setPrivateKey(e.currentTarget.value)}
                  rows="5"
                  autocomplete="off"
                />
              </div>
              <div class="field">
                <label>Public key</label>
                <textarea
                  class="ie-textarea ie-mono"
                  value={publicKey()}
                  onInput={(e) => setPublicKey(e.currentTarget.value)}
                  rows="3"
                />
              </div>
              <div class="field">
                <label>Fingerprint</label>
                <input
                  class="ie-mono"
                  value={fingerprint()}
                  onInput={(e) => setFingerprint(e.currentTarget.value)}
                />
              </div>
            </div>
          </Show>

          {/* ---- notes (all types) ---- */}
          <div class="ie-section">
            <div class="field">
              <label>Notes</label>
              <textarea
                class="ie-textarea"
                value={notes()}
                onInput={(e) => setNotes(e.currentTarget.value)}
                rows="4"
              />
            </div>
          </div>

          {/* ---- custom fields (all types) ---- */}
          <div class="ie-section">
            <div class="ie-section-head">
              <label>Custom fields</label>
              <button class="ghost ie-add" onClick={addField}>
                <Plus size={13} strokeWidth={1.75} /> Add field
              </button>
            </div>
            <Show when={fields().length === 0}>
              <p class="ie-empty-hint">No custom fields. Add text, hidden, boolean, or linked fields.</p>
            </Show>
            <For each={fields()}>
              {(f, i) => (
                <div class="ie-field-row">
                  <input
                    class="ie-field-name"
                    value={f.name}
                    placeholder="Field name"
                    onInput={(e) => updateField(i(), { name: e.currentTarget.value })}
                  />
                  <Switch>
                    <Match when={f.kind === 'Boolean'}>
                      <label class="ie-check ie-field-val">
                        <input
                          type="checkbox"
                          checked={f.value === 'true'}
                          onChange={(e) =>
                            updateField(i(), {
                              value: e.currentTarget.checked ? 'true' : 'false',
                            })
                          }
                        />
                        {f.value === 'true' ? 'True' : 'False'}
                      </label>
                    </Match>
                    <Match when={f.kind === 'Linked'}>
                      <div class="ie-field-val ie-linked-val">
                        <LinkIcon size={13} strokeWidth={1.75} class="ie-linked-icon" />
                        <select
                          class="ie-grow"
                          value={f.linkedId ?? ''}
                          onChange={(e) =>
                            updateField(i(), { linkedId: Number(e.currentTarget.value) })
                          }
                        >
                          <For each={linkOptions()}>
                            {(opt) => <option value={opt.id}>{opt.label}</option>}
                          </For>
                        </select>
                      </div>
                    </Match>
                    <Match when={true}>
                      <input
                        class="ie-field-val"
                        type={f.kind === 'Hidden' ? 'password' : 'text'}
                        value={f.value}
                        placeholder="Value"
                        autocomplete="off"
                        onInput={(e) => updateField(i(), { value: e.currentTarget.value })}
                      />
                    </Match>
                  </Switch>
                  <select
                    class="ie-fieldkind"
                    value={f.kind}
                    onChange={(e) =>
                      changeFieldKind(i(), e.currentTarget.value as FieldKindLabel, f)
                    }
                  >
                    <option value="Text">Text</option>
                    <option value="Hidden">Hidden</option>
                    <option value="Boolean">Boolean</option>
                    <Show when={linkOptions().length > 0}>
                      <option value="Linked">Linked</option>
                    </Show>
                  </select>
                  <button
                    class="ghost icon-btn"
                    title="Remove"
                    onClick={() => removeField(i())}
                  >
                    <Trash2 size={14} />
                  </button>
                </div>
              )}
            </For>
          </div>

          {/* ---- toggles (all types) ---- */}
          <div class="ie-toggles">
            <button
              class="ghost ie-toggle"
              classList={{ active: favorite() }}
              onClick={() => setFavorite(!favorite())}
            >
              <Star size={14} strokeWidth={1.75} class={favorite() ? 'ie-star-on' : ''} />
              Favorite
            </button>
            <label class="ie-check">
              <input
                type="checkbox"
                checked={reprompt()}
                onChange={(e) => setReprompt(e.currentTarget.checked)}
              />
              Require master password to view
            </label>
          </div>
        </div>

        <footer class="ie-footer">
          <button class="ghost" onClick={() => props.onClose()}>
            Cancel
          </button>
          <button class="primary" disabled={saving()} onClick={() => void save()}>
            {saving() ? 'Saving…' : 'Save'}
          </button>
        </footer>
    </div>
  );
}
