import { describe, expect, it } from 'vitest';
import { hostOf } from './favicons.ts';

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
