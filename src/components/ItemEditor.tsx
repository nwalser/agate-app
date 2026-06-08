import { createMemo, createSignal, For, onCleanup, onMount, Show } from 'solid-js';
import {
  Dices,
  Eye,
  EyeOff,
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
import { toastError } from '../state/toast.ts';
import './ItemEditor.css';

// Closed sets as string-literal unions (CLAUDE.md), mapped to backend ints.
type FieldKindLabel = 'Text' | 'Hidden' | 'Boolean';
const FIELD_KIND_TO_INT: Record<FieldKindLabel, number> = {
  Text: 0,
  Hidden: 1,
  Boolean: 2,
};
function fieldIntToLabel(n: number): FieldKindLabel {
  if (n === 1) return 'Hidden';
  if (n === 2) return 'Boolean';
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

type GenMode = 'password' | 'passphrase';

interface FieldRow {
  name: string;
  value: string;
  kind: FieldKindLabel;
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
  folders: Folder[];
  onSaved: () => void;
  onClose: () => void;
}) {
  const editing = createMemo(() => !!props.item);
  const itemType = createMemo<ItemType>(
    () => props.item?.itemType ?? props.createType ?? 'login',
  );

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

  // ---- card (prefilled from ItemDetail.card so edits don't wipe it) ----
  const c = () => props.item?.card ?? null;
  const [cardholderName, setCardholderName] = createSignal(c()?.cardholderName ?? '');
  const [cardNumber, setCardNumber] = createSignal(c()?.number ?? '');
  const [cardBrand, setCardBrand] = createSignal(c()?.brand ?? '');
  const [expMonth, setExpMonth] = createSignal(c()?.expMonth ?? '');
  const [expYear, setExpYear] = createSignal(c()?.expYear ?? '');
  const [cardCode, setCardCode] = createSignal(c()?.code ?? '');

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
    setFields((prev) => [...prev, { name: '', value: '', kind: 'Text' }]);
  }
  function removeField(index: number) {
    setFields((prev) => prev.filter((_, i) => i !== index));
  }
  function updateField(index: number, patch: Partial<FieldRow>) {
    setFields((prev) => prev.map((f, i) => (i === index ? { ...f, ...patch } : f)));
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
      fields: fields()
        .filter((f) => f.name.trim().length > 0 || f.value.trim().length > 0)
        .map((f) => ({
          name: orNull(f.name),
          value: orNull(f.value),
          fieldType: FIELD_KIND_TO_INT[f.kind],
        })),
    };

    setSaving(true);
    try {
      await ipc.saveItem(input);
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
    <div class="item-editor-overlay" onClick={() => props.onClose()}>
      <div
        class="item-editor"
        role="dialog"
        aria-modal="true"
        onClick={(e) => e.stopPropagation()}
      >
        <header class="ie-header">
          <h2 class="ie-title">{heading()}</h2>
          <button class="ghost icon-btn" title="Close" onClick={() => props.onClose()}>
            <X size={16} strokeWidth={1.75} />
          </button>
        </header>

        <div class="ie-body">
          {/* ---- common ---- */}
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
              <For each={props.folders.filter((f) => f.id !== null)}>
                {(f) => <option value={f.id ?? ''}>{f.name}</option>}
              </For>
            </select>
          </div>

          {/* ---- login ---- */}
          <Show when={itemType() === 'login'}>
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
                  class="ie-grow"
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
          </Show>

          {/* ---- card ---- */}
          <Show when={itemType() === 'card'}>
            <div class="field">
              <label>Cardholder name</label>
              <input
                value={cardholderName()}
                onInput={(e) => setCardholderName(e.currentTarget.value)}
              />
            </div>
            <div class="field">
              <label>Number</label>
              <input
                value={cardNumber()}
                onInput={(e) => setCardNumber(e.currentTarget.value)}
                autocomplete="off"
              />
            </div>
            <div class="field">
              <label>Brand</label>
              <input
                value={cardBrand()}
                onInput={(e) => setCardBrand(e.currentTarget.value)}
                placeholder="Visa, Mastercard…"
              />
            </div>
            <div class="ie-grid-3">
              <div class="field">
                <label>Exp. month</label>
                <input
                  value={expMonth()}
                  onInput={(e) => setExpMonth(e.currentTarget.value)}
                  placeholder="MM"
                />
              </div>
              <div class="field">
                <label>Exp. year</label>
                <input
                  value={expYear()}
                  onInput={(e) => setExpYear(e.currentTarget.value)}
                  placeholder="YYYY"
                />
              </div>
              <div class="field">
                <label>Security code</label>
                <input
                  value={cardCode()}
                  onInput={(e) => setCardCode(e.currentTarget.value)}
                  autocomplete="off"
                />
              </div>
            </div>
          </Show>

          {/* ---- identity ---- */}
          <Show when={itemType() === 'identity'}>
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
          </Show>

          {/* ---- ssh key ---- */}
          <Show when={itemType() === 'sshKey'}>
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
          </Show>

          {/* ---- notes (all types) ---- */}
          <div class="field">
            <label>Notes</label>
            <textarea
              class="ie-textarea"
              value={notes()}
              onInput={(e) => setNotes(e.currentTarget.value)}
              rows="4"
            />
          </div>

          {/* ---- custom fields (all types) ---- */}
          <div class="field">
            <div class="ie-section-head">
              <label>Custom fields</label>
              <button class="ghost ie-add" onClick={addField}>
                <Plus size={13} strokeWidth={1.75} /> Add field
              </button>
            </div>
            <For each={fields()}>
              {(f, i) => (
                <div class="row ie-multi-row">
                  <input
                    class="ie-grow"
                    value={f.name}
                    placeholder="Name"
                    onInput={(e) => updateField(i(), { name: e.currentTarget.value })}
                  />
                  <Show
                    when={f.kind === 'Boolean'}
                    fallback={
                      <input
                        class="ie-grow"
                        type={f.kind === 'Hidden' ? 'password' : 'text'}
                        value={f.value}
                        placeholder="Value"
                        autocomplete="off"
                        onInput={(e) => updateField(i(), { value: e.currentTarget.value })}
                      />
                    }
                  >
                    <label class="ie-check ie-grow">
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
                  </Show>
                  <select
                    class="ie-fieldkind"
                    value={f.kind}
                    onChange={(e) =>
                      updateField(i(), { kind: e.currentTarget.value as FieldKindLabel })
                    }
                  >
                    <option value="Text">Text</option>
                    <option value="Hidden">Hidden</option>
                    <option value="Boolean">Boolean</option>
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
    </div>
  );
}
