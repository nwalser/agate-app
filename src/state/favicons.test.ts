import { describe, expect, it } from 'vitest';
import { hostOf, parentHost } from './favicons.ts';

describe('hostOf', () => {
  it('extracts the host from a full URL', () => {
    expect(hostOf('https://www.github.com/login?x=1')).toBe('www.github.com');
  });

  it('assumes https when the scheme is missing', () => {
    expect(hostOf('github.com')).toBe('github.com');
    expect(hostOf('sub.example.co.uk/path')).toBe('sub.example.co.uk');
  });

  it('lowercases the host', () => {
    expect(hostOf('HTTPS://GitHub.COM')).toBe('github.com');
  });

  it('returns null for empty, null, or hostless input', () => {
    expect(hostOf(null)).toBeNull();
    expect(hostOf('')).toBeNull();
    expect(hostOf('   ')).toBeNull();
    // No dot → not a real public host (e.g. "localhost", bare words).
    expect(hostOf('localhost')).toBeNull();
    expect(hostOf('notahost')).toBeNull();
  });
});

describe('parentHost', () => {
  it('strips a subdomain to its registrable domain', () => {
    expect(parentHost('login.example.com')).toBe('example.com');
    expect(parentHost('a.b.example.com')).toBe('b.example.com');
    expect(parentHost('b.example.com')).toBe('example.com');
  });

  it('returns null at a registrable domain', () => {
    expect(parentHost('example.com')).toBeNull();
  });

  it('does not strip past a multi-label public suffix', () => {
    expect(parentHost('a.example.co.uk')).toBe('example.co.uk');
    expect(parentHost('example.co.uk')).toBeNull();
    expect(parentHost('shop.example.com.au')).toBe('example.com.au');
    expect(parentHost('example.com.au')).toBeNull();
  });
});
