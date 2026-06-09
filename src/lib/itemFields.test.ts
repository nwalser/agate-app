import { describe, expect, it } from 'vitest';
import {
  cardExpiry,
  detectCardBrand,
  formatCardNumber,
  identityFields,
  isLinkedSecret,
  linkedLabel,
  linkedOptionsFor,
  maskCardNumber,
  resolveLinkedValue,
} from './itemFields.ts';
import type { CardInput, IdentityInput, ItemDetail } from './types.ts';

function card(partial: Partial<CardInput>): CardInput {
  return { cardholderName: null, number: null, brand: null, expMonth: null, expYear: null, code: null, ...partial };
}

function identity(partial: Partial<IdentityInput>): IdentityInput {
  return {
    title: null, firstName: null, middleName: null, lastName: null, username: null, company: null,
    ssn: null, passportNumber: null, licenseNumber: null, email: null, phone: null,
    address1: null, address2: null, address3: null, city: null, state: null, postalCode: null, country: null,
    ...partial,
  };
}

describe('cardExpiry', () => {
  it('zero-pads the month and joins with the year', () => {
    expect(cardExpiry(card({ expMonth: '3', expYear: '2027' }))).toBe('03/2027');
  });

  it('leaves a two-digit month untouched', () => {
    expect(cardExpiry(card({ expMonth: '12', expYear: '2030' }))).toBe('12/2030');
  });

  it('returns the lone part when only one is present', () => {
    expect(cardExpiry(card({ expMonth: '7' }))).toBe('07');
    expect(cardExpiry(card({ expYear: '2031' }))).toBe('2031');
  });

  it('is empty when both parts are absent', () => {
    expect(cardExpiry(card({}))).toBe('');
  });
});

describe('identityFields', () => {
  it('composes the full name from title + name parts, skipping blanks', () => {
    const rows = identityFields(identity({ title: 'Dr', firstName: 'Ada', lastName: 'Lovelace' }));
    expect(rows.find((r) => r.label === 'Name')?.value).toBe('Dr Ada Lovelace');
  });

  it('joins the city line and leaves it null when empty', () => {
    const withCity = identityFields(identity({ city: 'London', state: 'ENG', postalCode: 'EC1' }));
    expect(withCity.find((r) => r.label === 'City / State / ZIP')?.value).toBe('London, ENG, EC1');
    const empty = identityFields(identity({}));
    expect(empty.find((r) => r.label === 'City / State / ZIP')?.value).toBeNull();
  });

  it('passes through scalar fields', () => {
    const rows = identityFields(identity({ email: 'ada@example.com', ssn: '123' }));
    expect(rows.find((r) => r.label === 'Email')?.value).toBe('ada@example.com');
    expect(rows.find((r) => r.label === 'SSN')?.value).toBe('123');
  });
});

describe('detectCardBrand', () => {
  it('maps common IIN prefixes to brands', () => {
    expect(detectCardBrand('4111 1111 1111 1111')).toBe('Visa');
    expect(detectCardBrand('5500000000000004')).toBe('Mastercard');
    expect(detectCardBrand('2221000000000009')).toBe('Mastercard');
    expect(detectCardBrand('378282246310005')).toBe('Amex');
    expect(detectCardBrand('6011111111111117')).toBe('Discover');
    expect(detectCardBrand('30000000000004')).toBe('Diners Club');
    expect(detectCardBrand('3530111333300000')).toBe('JCB');
    expect(detectCardBrand('6200000000000005')).toBe('UnionPay');
    expect(detectCardBrand('5018000000000009')).toBe('Maestro');
  });

  it('returns null for empty or unrecognized prefixes', () => {
    expect(detectCardBrand('')).toBeNull();
    expect(detectCardBrand('1234')).toBeNull();
  });
});

describe('formatCardNumber', () => {
  it('groups most numbers in fours', () => {
    expect(formatCardNumber('4111111111111111')).toBe('4111 1111 1111 1111');
  });

  it('groups Amex as 4-6-5', () => {
    expect(formatCardNumber('378282246310005', 'Amex')).toBe('3782 822463 10005');
  });

  it('strips non-digits and is empty when blank', () => {
    expect(formatCardNumber('4111-1111')).toBe('4111 1111');
    expect(formatCardNumber('')).toBe('');
  });
});

describe('maskCardNumber', () => {
  it('keeps only the last four', () => {
    expect(maskCardNumber('4111111111111111')).toBe('•••• •••• •••• 1111');
  });

  it('returns short inputs unmasked', () => {
    expect(maskCardNumber('123')).toBe('123');
  });
});

describe('linked fields', () => {
  it('offers the linkable properties per item type', () => {
    expect(linkedOptionsFor('login').map((o) => o.id)).toEqual([100, 101]);
    expect(linkedOptionsFor('card').length).toBeGreaterThan(0);
    expect(linkedOptionsFor('secureNote')).toEqual([]);
    expect(linkedOptionsFor('sshKey')).toEqual([]);
  });

  it('labels ids across every type and falls back', () => {
    expect(linkedLabel(101)).toBe('Password');
    expect(linkedLabel(305)).toBe('Number');
    expect(linkedLabel(418)).toBe('Full name');
    expect(linkedLabel(null)).toBe('Linked');
    expect(linkedLabel(9999)).toBe('Linked');
  });

  it('flags secret-valued linked targets', () => {
    expect(isLinkedSecret(101)).toBe(true);
    expect(isLinkedSecret(303)).toBe(true);
    expect(isLinkedSecret(100)).toBe(false);
    expect(isLinkedSecret(null)).toBe(false);
  });

  it('resolves a linked value from its own item', () => {
    const d = {
      login: { username: 'ada', password: 's3cret', totp: null, uris: [], hasTotp: false },
      card: null,
      identity: { firstName: 'Ada', middleName: null, lastName: 'Lovelace' },
    } as unknown as ItemDetail;
    expect(resolveLinkedValue(d, 100)).toBe('ada');
    expect(resolveLinkedValue(d, 101)).toBe('s3cret');
    expect(resolveLinkedValue(d, 418)).toBe('Ada Lovelace');
    expect(resolveLinkedValue(d, null)).toBeNull();
    expect(resolveLinkedValue(d, 305)).toBeNull();
  });
});
