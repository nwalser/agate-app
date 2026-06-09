// Pure display + linked-field helpers for the item detail pane and editor (card
// expiry text, identity field rows, custom-field linked-id maps). Kept out of
// the components so they can be unit-tested without a render rig. Card-brand
// detection/formatting lives in ./cardBrands.ts and is re-exported here so the
// existing detail-pane / test import sites keep one stable entry point.
import type { CardInput, IdentityInput, ItemDetail, ItemType } from './types.ts';

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
  return [
    { label: 'Name', value: name },
    { label: 'Username', value: i.username },
    { label: 'Company', value: i.company },
    { label: 'Email', value: i.email },
    { label: 'Phone', value: i.phone },
    { label: 'SSN', value: i.ssn },
    { label: 'Passport number', value: i.passportNumber },
    { label: 'License number', value: i.licenseNumber },
    { label: 'Address', value: address },
    { label: 'City / State / ZIP', value: cityLine },
    { label: 'Country', value: i.country },
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

const LOGIN_LINKED: LinkedOption[] = [
  { id: 100, label: 'Username' },
  { id: 101, label: 'Password' },
];

const CARD_LINKED: LinkedOption[] = [
  { id: 304, label: 'Brand' },
  { id: 305, label: 'Number' },
  { id: 300, label: 'Cardholder name' },
  { id: 303, label: 'Security code' },
  { id: 301, label: 'Expiration month' },
  { id: 302, label: 'Expiration year' },
];

const IDENTITY_LINKED: LinkedOption[] = [
  { id: 418, label: 'Full name' },
  { id: 400, label: 'Title' },
  { id: 416, label: 'First name' },
  { id: 401, label: 'Middle name' },
  { id: 417, label: 'Last name' },
  { id: 413, label: 'Username' },
  { id: 409, label: 'Company' },
  { id: 412, label: 'SSN' },
  { id: 414, label: 'Passport number' },
  { id: 415, label: 'License number' },
  { id: 410, label: 'Email' },
  { id: 411, label: 'Phone' },
  { id: 402, label: 'Address 1' },
  { id: 403, label: 'Address 2' },
  { id: 404, label: 'Address 3' },
  { id: 405, label: 'City' },
  { id: 406, label: 'State' },
  { id: 407, label: 'Postal code' },
  { id: 408, label: 'Country' },
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
  if (linkedId == null) return 'Linked';
  for (const list of [LOGIN_LINKED, CARD_LINKED, IDENTITY_LINKED]) {
    const m = list.find((o) => o.id === linkedId);
    if (m) return m.label;
  }
  return 'Linked';
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
