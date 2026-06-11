import { describe, expect, it } from 'vitest';
import { buildSendInput, sendMeta, type SendDraft } from './SendsView.tsx';
import { makeSend } from '../testing/factories.ts';
import type { SendSummary } from '../lib/types.ts';

function draft(over: Partial<SendDraft> = {}): SendDraft {
  return {
    accountEmail: 'a@b.com',
    name: 'My share',
    text: 'secret',
    expiry: 'sevenDays',
    maxViews: '',
    password: '',
    hidden: false,
    hideEmail: false,
    ...over,
  };
}

const NOW = Date.parse('2026-06-09T12:00:00Z');

function send(over: Partial<SendSummary> = {}): SendSummary {
  return makeSend({
    id: 's1',
    name: 'My share',
    accountEmail: 'a@b.com',
    accountLabel: 'a@b.com',
    ...over,
  });
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

describe('buildSendInput', () => {
  it('trims the name but preserves the text payload verbatim', () => {
    const i = buildSendInput(draft({ name: '  hello  ', text: '  keep  spaces \n' }));
    expect(i.name).toBe('hello');
    expect(i.text).toBe('  keep  spaces \n');
  });

  it('treats a blank max-views as unlimited (null)', () => {
    expect(buildSendInput(draft({ maxViews: '' })).maxAccessCount).toBeNull();
    expect(buildSendInput(draft({ maxViews: '   ' })).maxAccessCount).toBeNull();
  });

  it('parses a positive integer max-views', () => {
    expect(buildSendInput(draft({ maxViews: '5' })).maxAccessCount).toBe(5);
  });

  it('rejects zero, negative, and non-integer max-views as unlimited', () => {
    expect(buildSendInput(draft({ maxViews: '0' })).maxAccessCount).toBeNull();
    expect(buildSendInput(draft({ maxViews: '-3' })).maxAccessCount).toBeNull();
    expect(buildSendInput(draft({ maxViews: '2.5' })).maxAccessCount).toBeNull();
    expect(buildSendInput(draft({ maxViews: 'abc' })).maxAccessCount).toBeNull();
  });

  it('maps a blank/whitespace password to no password (null)', () => {
    expect(buildSendInput(draft({ password: '' })).password).toBeNull();
    expect(buildSendInput(draft({ password: '   ' })).password).toBeNull();
  });

  it('keeps a real password as-is (not trimmed away)', () => {
    expect(buildSendInput(draft({ password: 's3cret' })).password).toBe('s3cret');
  });

  it('passes through expiry, account, and flags', () => {
    const i = buildSendInput(
      draft({ expiry: 'oneHour', accountEmail: 'x@y.com', hidden: true, hideEmail: true }),
    );
    expect(i.expiry).toBe('oneHour');
    expect(i.accountEmail).toBe('x@y.com');
    expect(i.hidden).toBe(true);
    expect(i.hideEmail).toBe(true);
  });
});
