// Pure display + linked-field helpers for the item detail pane and editor (card
// expiry text, identity field rows, custom-field linked-id maps). Kept out of
// the components so they can be unit-tested without a render rig. Card-brand
// detection/formatting lives in ./cardBrands.ts and is re-exported here so the
// existing detail-pane / test import sites keep one stable entry point.
import type { CardInput, IdentityInput, ItemDetail, ItemType } from './types.ts';
import { t } from './i18n.ts';

export {
  CARD_BRANDS,
  detectCardBrand,
  formatCardNumber,
  maskCardNumber,
} from './cardBrands.ts';
export type { CardBrand } from './cardBrands.ts';

// "MM/YYYY" from a card's expiry parts (either may be absent).
export function cardExpiry(c: CardInput): string {
  const m = c.expMonth ? c.expMonth.padStart(2, '0') : '';
  const y = c.expYear ?? '';
  return m && y ? `${m}/${y}` : m || y;
}

// Flatten an identity into ordered label/value rows; empty rows are hidden by the caller.
export function identityFields(i: IdentityInput): { label: string; value: string | null }[] {
  const name = [i.title, i.firstName, i.middleName, i.lastName].filter(Boolean).join(' ') || null;
  const address = [i.address1, i.address2, i.address3].filter(Boolean).join('\n') || null;
  const cityLine = [i.city, i.state, i.postalCode].filter(Boolean).join(', ') || null;
  // Labels resolve via t() at call time (the detail pane calls identityFields in
  // its render), so they track the active language.
  return [
    { label: t('identityField.name'), value: name },
    { label: t('identityField.username'), value: i.username },
    { label: t('identityField.company'), value: i.company },
    { label: t('identityField.email'), value: i.email },
    { label: t('identityField.phone'), value: i.phone },
    { label: t('identityField.ssn'), value: i.ssn },
    { label: t('identityField.passportNumber'), value: i.passportNumber },
    { label: t('identityField.licenseNumber'), value: i.licenseNumber },
    { label: t('identityField.address'), value: address },
    { label: t('identityField.cityStateZip'), value: cityLine },
    { label: t('identityField.country'), value: i.country },
  ];
}

// ---- Linked custom fields ------------------------------------------------
// A linked field references one property of its own cipher by a numeric id
// (Bitwarden LinkedIdType). The maps below mirror the SDK enum values
// (crates/bitwarden-vault/src/cipher/linked_id.rs).
export interface LinkedOption {
  id: number;
  label: string;
}

// `label` is a getter so it resolves through t() each time it's read (in the
// editor's "Linked" dropdown and linkedLabel), tracking the active language; the
// numeric `id` stays the stable identifier.
const LOGIN_LINKED: LinkedOption[] = [
  { id: 100, get label() { return t('linkedField.username'); } },
  { id: 101, get label() { return t('linkedField.password'); } },
];

const CARD_LINKED: LinkedOption[] = [
  { id: 304, get label() { return t('linkedField.brand'); } },
  { id: 305, get label() { return t('linkedField.number'); } },
  { id: 300, get label() { return t('linkedField.cardholderName'); } },
  { id: 303, get label() { return t('linkedField.securityCode'); } },
  { id: 301, get label() { return t('linkedField.expirationMonth'); } },
  { id: 302, get label() { return t('linkedField.expirationYear'); } },
];

const IDENTITY_LINKED: LinkedOption[] = [
  { id: 418, get label() { return t('linkedField.fullName'); } },
  { id: 400, get label() { return t('linkedField.title'); } },
  { id: 416, get label() { return t('linkedField.firstName'); } },
  { id: 401, get label() { return t('linkedField.middleName'); } },
  { id: 417, get label() { return t('linkedField.lastName'); } },
  { id: 413, get label() { return t('linkedField.username'); } },
  { id: 409, get label() { return t('linkedField.company'); } },
  { id: 412, get label() { return t('linkedField.ssn'); } },
  { id: 414, get label() { return t('linkedField.passportNumber'); } },
  { id: 415, get label() { return t('linkedField.licenseNumber'); } },
  { id: 410, get label() { return t('linkedField.email'); } },
  { id: 411, get label() { return t('linkedField.phone'); } },
  { id: 402, get label() { return t('linkedField.address1'); } },
  { id: 403, get label() { return t('linkedField.address2'); } },
  { id: 404, get label() { return t('linkedField.address3'); } },
  { id: 405, get label() { return t('linkedField.city'); } },
  { id: 406, get label() { return t('linkedField.state'); } },
  { id: 407, get label() { return t('linkedField.postalCode'); } },
  { id: 408, get label() { return t('linkedField.country'); } },
];

// The linkable properties for an item type. Empty for types with no linkable
// fields (secure note, SSH key) — the editor hides the "Linked" option there.
export function linkedOptionsFor(itemType: ItemType): LinkedOption[] {
  switch (itemType) {
    case 'login':
      return LOGIN_LINKED;
    case 'card':
      return CARD_LINKED;
    case 'identity':
      return IDENTITY_LINKED;
    default:
      return [];
  }
}

// Human label for a linked-field target id (across every item type).
export function linkedLabel(linkedId: number | null): string {
  if (linkedId == null) return t('linkedField.fallback');
  for (const list of [LOGIN_LINKED, CARD_LINKED, IDENTITY_LINKED]) {
    const m = list.find((o) => o.id === linkedId);
    if (m) return m.label;
  }
  return t('linkedField.fallback');
}

// Linked targets whose resolved value is a secret (mask in the detail pane).
const SECRET_LINKED_IDS = new Set([101, 303, 412]);
export function isLinkedSecret(linkedId: number | null): boolean {
  return linkedId != null && SECRET_LINKED_IDS.has(linkedId);
}

// Resolve a linked field's live value from its own item, so the detail pane can
// show/copy what the field points at (the field itself stores no value).
export function resolveLinkedValue(d: ItemDetail, linkedId: number | null): string | null {
  if (linkedId == null) return null;
  const c = d.card;
  const i = d.identity;
  switch (linkedId) {
    case 100:
      return d.login?.username ?? null;
    case 101:
      return d.login?.password ?? null;
    case 300:
      return c?.cardholderName ?? null;
    case 301:
      return c?.expMonth ?? null;
    case 302:
      return c?.expYear ?? null;
    case 303:
      return c?.code ?? null;
    case 304:
      return c?.brand ?? null;
    case 305:
      return c?.number ?? null;
    case 400:
      return i?.title ?? null;
    case 401:
      return i?.middleName ?? null;
    case 402:
      return i?.address1 ?? null;
    case 403:
      return i?.address2 ?? null;
    case 404:
      return i?.address3 ?? null;
    case 405:
      return i?.city ?? null;
    case 406:
      return i?.state ?? null;
    case 407:
      return i?.postalCode ?? null;
    case 408:
      return i?.country ?? null;
    case 409:
      return i?.company ?? null;
    case 410:
      return i?.email ?? null;
    case 411:
      return i?.phone ?? null;
    case 412:
      return i?.ssn ?? null;
    case 413:
      return i?.username ?? null;
    case 414:
      return i?.passportNumber ?? null;
    case 415:
      return i?.licenseNumber ?? null;
    case 416:
      return i?.firstName ?? null;
    case 417:
      return i?.lastName ?? null;
    case 418:
      return [i?.firstName, i?.middleName, i?.lastName].filter(Boolean).join(' ') || null;
    default:
      return null;
  }
}
