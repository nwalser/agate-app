import { describe, expect, it } from 'vitest';
import { mapOcrToIdentity, mapOcrToLogin } from './ocrFill.ts';

describe('mapOcrToLogin', () => {
  it('maps an email line to the username and a URL line to the uri', () => {
    const m = mapOcrToLogin(['Account: alice@example.com', 'https://portal.example.com/login']);
    expect(m.username).toBe('alice@example.com');
    expect(m.uri).toBe('https://portal.example.com/login');
  });

  it('recognizes bare domains as uris', () => {
    expect(mapOcrToLogin(['portal.example.com']).uri).toBe('portal.example.com');
  });

  it('returns an empty map for unrelated text', () => {
    expect(mapOcrToLogin(['Quarterly report', 'Page 3'])).toEqual({});
  });
});

describe('mapOcrToIdentity', () => {
  it('maps email, phone, and a name line', () => {
    const m = mapOcrToIdentity(['Alice Example', 'alice@example.com', '+41 79 123 45 67']);
    expect(m.email).toBe('alice@example.com');
    expect(m.phone).toBe('+41 79 123 45 67');
    expect(m.firstName).toBe('Alice');
    expect(m.lastName).toBe('Example');
  });

  it('keeps a multi-part last name together', () => {
    const m = mapOcrToIdentity(['Maria de la Cruz']);
    expect(m.firstName).toBe('Maria');
    expect(m.lastName).toBe('de la Cruz');
  });

  it('returns an empty map for unrelated text', () => {
    expect(mapOcrToIdentity(['4111 1111 1111 1111'])).toEqual({});
  });
});
