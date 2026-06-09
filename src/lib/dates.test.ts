import { describe, expect, it } from 'vitest';
import { absoluteDate, relativeFromNow } from './dates.ts';

const NOW = Date.parse('2026-06-09T12:00:00Z');

describe('relativeFromNow', () => {
  it('reports recent times as "just now"', () => {
    expect(relativeFromNow('2026-06-09T11:59:30Z', NOW)).toBe('just now');
  });

  it('reports minutes, hours, and days', () => {
    expect(relativeFromNow('2026-06-09T11:30:00Z', NOW)).toBe('30m ago');
    expect(relativeFromNow('2026-06-09T09:00:00Z', NOW)).toBe('3h ago');
    expect(relativeFromNow('2026-06-04T12:00:00Z', NOW)).toBe('5d ago');
  });

  it('reports months and years for older dates', () => {
    expect(relativeFromNow('2026-04-09T12:00:00Z', NOW)).toBe('2mo ago');
    expect(relativeFromNow('2024-06-09T12:00:00Z', NOW)).toBe('2y ago');
  });

  it('returns empty string for an unparseable date', () => {
    expect(relativeFromNow('not-a-date', NOW)).toBe('');
  });
});

describe('absoluteDate', () => {
  it('returns empty string for an unparseable date', () => {
    expect(absoluteDate('nope')).toBe('');
  });

  it('formats a valid date to a non-empty string', () => {
    expect(absoluteDate('2026-06-09T12:00:00Z').length).toBeGreaterThan(0);
  });
});
