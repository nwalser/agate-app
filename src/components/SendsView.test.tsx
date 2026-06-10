import { describe, expect, it } from 'vitest';
import { sendMeta } from './SendsView.tsx';
import type { SendSummary } from '../lib/types.ts';

const NOW = Date.parse('2026-06-09T12:00:00Z');

function send(over: Partial<SendSummary> = {}): SendSummary {
  return {
    id: 's1',
    name: 'My share',
    sendType: 'text',
    disabled: false,
    hasPassword: false,
    accessCount: 0,
    maxAccessCount: null,
    deletionDate: '2026-07-01T00:00:00Z',
    expirationDate: null,
    accountEmail: 'a@b.com',
    accountLabel: 'a@b.com',
    ...over,
  };
}

describe('sendMeta', () => {
  it('pluralizes view counts ("1 view", not "1 views")', () => {
    expect(sendMeta(send({ accessCount: 1 }), NOW)).toBe('text · 1 view');
    expect(sendMeta(send({ accessCount: 2 }), NOW)).toBe('text · 2 views');
  });

  it('keeps "views" for capped counts', () => {
    expect(sendMeta(send({ accessCount: 1, maxAccessCount: 5 }), NOW)).toBe('text · 1/5 views');
  });

  it('renders a future expiration as "expires in …", never "just now"', () => {
    const m = sendMeta(send({ expirationDate: '2026-06-12T12:00:00Z' }), NOW);
    expect(m).toContain('expires in 3d');
    expect(m).not.toContain('just now');
  });

  it('renders a past expiration as "expired"', () => {
    expect(sendMeta(send({ expirationDate: '2026-06-08T12:00:00Z' }), NOW)).toContain('expired');
  });

  it('drops the expiry segment entirely for an unparseable date', () => {
    expect(sendMeta(send({ expirationDate: 'not-a-date' }), NOW)).toBe('text · 0 views');
  });

  it('lists password and disabled flags', () => {
    expect(sendMeta(send({ hasPassword: true, disabled: true }), NOW)).toBe(
      'text · 0 views · password · disabled',
    );
  });
});
