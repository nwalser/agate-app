import { describe, expect, it } from 'vitest';
import { detectCardBrand, formatCardNumber, maskCardNumber } from './cardBrands.ts';

describe('detectCardBrand — IIN prefix rules', () => {
  it.each([
    ['4111111111111111', 'Visa'],
    ['378282246310005', 'Amex'], // 37
    ['340000000000009', 'Amex'], // 34
    ['30000000000004', 'Diners Club'], // 300–305
    ['36000000000008', 'Diners Club'], // 36
    ['38520000023237', 'Diners Club'], // 38
    ['3530111333300000', 'JCB'], // 35 (after Amex/Diners)
    ['5018000000000000', 'Maestro'], // 50.. beats Mastercard
    ['5610000000000000', 'Maestro'], // 56
    ['6304000000000000', 'Maestro'], // 6304 beats Discover
    ['5105105105105100', 'Mastercard'], // 51–55
    ['2221000000000009', 'Mastercard'], // 2221 (2-series)
    ['2720990000000000', 'Mastercard'], // 2720 upper bound
    ['6011000990139424', 'Discover'], // 6011
    ['6500000000000002', 'Discover'], // 65
    ['6440000000000000', 'Discover'], // 644
    ['6200000000000005', 'UnionPay'], // 62
  ] as const)('detects %s as %s', (num, brand) => {
    expect(detectCardBrand(num)).toBe(brand);
  });

  it('ignores spaces and dashes in the input', () => {
    expect(detectCardBrand('4111 1111-1111 1111')).toBe('Visa');
  });

  it('returns null for an empty or unrecognised prefix', () => {
    expect(detectCardBrand('')).toBeNull();
    expect(detectCardBrand('   ')).toBeNull();
    expect(detectCardBrand('9999000000000000')).toBeNull();
  });
});

describe('formatCardNumber', () => {
  it('groups Amex as 4-6-5', () => {
    expect(formatCardNumber('378282246310005')).toBe('3782 822463 10005');
  });

  it('respects an explicit Amex brand even if the number prefix is partial', () => {
    expect(formatCardNumber('3782822', 'Amex')).toBe('3782 822');
  });

  it('groups every other brand in fours', () => {
    expect(formatCardNumber('4111111111111111')).toBe('4111 1111 1111 1111');
  });

  it('strips non-digits and returns empty for none', () => {
    expect(formatCardNumber('4111-1111')).toBe('4111 1111');
    expect(formatCardNumber('abc')).toBe('');
  });
});

describe('maskCardNumber', () => {
  it('shows only the last four digits', () => {
    expect(maskCardNumber('4111111111111111')).toBe('•••• •••• •••• 1111');
  });

  it('returns short numbers (<= 4 digits) unmasked', () => {
    expect(maskCardNumber('123')).toBe('123');
    expect(maskCardNumber('1234')).toBe('1234');
  });
});
