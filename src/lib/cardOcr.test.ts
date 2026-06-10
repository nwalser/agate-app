import { describe, expect, it } from 'vitest';
import { luhnValid, parseCardFromOcr } from './cardOcr.ts';

describe('luhnValid', () => {
  it('accepts known-good test numbers', () => {
    expect(luhnValid('4111111111111111')).toBe(true); // Visa
    expect(luhnValid('378282246310005')).toBe(true); // Amex
    expect(luhnValid('5555555555554444')).toBe(true); // Mastercard
  });
  it('rejects altered or too-short digit runs', () => {
    expect(luhnValid('4111111111111112')).toBe(false);
    expect(luhnValid('1234')).toBe(false);
    expect(luhnValid('')).toBe(false);
  });
});

describe('parseCardFromOcr', () => {
  it('parses a typical front-of-card OCR layout', () => {
    const p = parseCardFromOcr([
      'MYBANK',
      '4111 1111 1111 1111',
      'VALID THRU 12/27',
      'ALICE EXAMPLE',
    ]);
    expect(p.confidence).toBe('number');
    expect(p.number).toBe('4111111111111111');
    expect(p.brand).toBe('Visa');
    expect(p.expMonth).toBe('12');
    expect(p.expYear).toBe('2027');
    expect(p.cardholderName).toBe('ALICE EXAMPLE');
  });

  it('handles the Amex 4-6-5 grouping', () => {
    const p = parseCardFromOcr(['3782 822463 10005', 'AMERICAN EXPRESS']);
    expect(p.number).toBe('378282246310005');
    expect(p.brand).toBe('Amex');
    // The brand line must never be mistaken for the cardholder.
    expect(p.cardholderName).toBeUndefined();
  });

  it('rejects digit runs that fail Luhn (never silently fills a bad number)', () => {
    const p = parseCardFromOcr(['4111 1111 1111 1112', 'BOB BOGUS']);
    expect(p.number).toBeUndefined();
    expect(p.confidence).toBe('partial'); // name still recognized
  });

  it('takes the LATER date when valid-from and thru are both printed', () => {
    const p = parseCardFromOcr(['4111111111111111', 'VALID FROM 01/22', 'THRU 05/27']);
    expect(p.expMonth).toBe('5');
    expect(p.expYear).toBe('2027');
  });

  it('returns confidence none for an image with no card content', () => {
    const p = parseCardFromOcr(['Quarterly report', 'Page 3 of 12']);
    expect(p.confidence).toBe('none');
    expect(p.number).toBeUndefined();
    expect(p.cardholderName).toBeUndefined();
  });

  it('never parses a CVV', () => {
    const p = parseCardFromOcr(['4111111111111111', 'CVV 123']);
    expect('code' in p).toBe(false);
  });
});
