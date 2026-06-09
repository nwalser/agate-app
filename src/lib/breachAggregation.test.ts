// Tests for the pure breach-aggregation helpers: dedup-with-affected-accounts,
// per-email breach matching, and item→email extraction.

import { describe, expect, it } from 'vitest';
import {
  aggregateRelevantBreaches,
  breachesForEmails,
  itemEmails,
} from './breachAggregation.ts';
import type { AccountBreaches, BreachRecord, ItemDetail } from './types.ts';

function breach(p: Partial<BreachRecord> & { name: string }): BreachRecord {
  return {
    domain: '',
    breachDate: null,
    pwnCount: null,
    dataClasses: [],
    description: null,
    logo: null,
    verified: false,
    passwordRisk: null,
    ...p,
  };
}

function account(email: string, breaches: BreachRecord[]): AccountBreaches {
  return { email, breaches, exposedData: [], riskLabel: null, riskScore: null };
}

function detail(p: Partial<ItemDetail>): ItemDetail {
  return {
    id: 'x',
    accountEmail: 'a@b.com',
    accountLabel: 'Acct',
    name: 'Item',
    itemType: 'login',
    favorite: false,
    reprompt: false,
    notes: null,
    login: null,
    card: null,
    identity: null,
    sshKey: null,
    fields: [],
    folderId: null,
    organizationId: null,
    revisionDate: '2020-01-01T00:00:00Z',
    creationDate: '2020-01-01T00:00:00Z',
    collectionIds: [],
    attachments: [],
    passkeys: [],
    ...p,
  };
}

describe('aggregateRelevantBreaches', () => {
  it('dedupes a breach across accounts and lists which accounts it hit', () => {
    const accounts = [
      account('alice@example.com', [breach({ name: 'Acme' })]),
      account('bob@example.com', [breach({ name: 'Acme' }), breach({ name: 'Solo' })]),
    ];
    const out = aggregateRelevantBreaches(accounts);
    const acme = out.find((e) => e.breach.name === 'Acme');
    const solo = out.find((e) => e.breach.name === 'Solo');
    expect(acme?.accounts).to.deep.equal(['alice@example.com', 'bob@example.com']);
    expect(solo?.accounts).to.deep.equal(['bob@example.com']);
  });

  it('sorts most-affected-accounts first', () => {
    const out = aggregateRelevantBreaches([
      account('a@x.com', [breach({ name: 'Big' }), breach({ name: 'Small' })]),
      account('b@x.com', [breach({ name: 'Big' })]),
    ]);
    expect(out.map((e) => e.breach.name)).to.deep.equal(['Big', 'Small']);
  });

  it('keeps the record carrying the most "what leaked" detail', () => {
    const out = aggregateRelevantBreaches([
      account('a@x.com', [breach({ name: 'Acme', dataClasses: ['Emails'] })]),
      account('b@x.com', [breach({ name: 'Acme', dataClasses: ['Emails', 'Passwords'] })]),
    ]);
    expect(out[0].breach.dataClasses).to.deep.equal(['Emails', 'Passwords']);
  });
});

describe('breachesForEmails', () => {
  const accounts = [
    account('alice@example.com', [breach({ name: 'Acme' })]),
    account('bob@example.com', [breach({ name: 'Solo' })]),
  ];

  it('matches case-insensitively and returns the matched breaches', () => {
    const out = breachesForEmails(accounts, ['ALICE@example.com']);
    expect(out.map((b) => b.name)).to.deep.equal(['Acme']);
  });

  it('returns nothing for an unknown or empty email set', () => {
    expect(breachesForEmails(accounts, ['nobody@x.com'])).to.deep.equal([]);
    expect(breachesForEmails(accounts, [])).to.deep.equal([]);
  });

  it('dedupes by breach name across matched accounts', () => {
    const shared = [
      account('a@x.com', [breach({ name: 'Acme', dataClasses: ['Emails'] })]),
      account('b@x.com', [breach({ name: 'Acme', dataClasses: ['Emails', 'Passwords'] })]),
    ];
    const out = breachesForEmails(shared, ['a@x.com', 'b@x.com']);
    expect(out).to.have.length(1);
    expect(out[0].dataClasses).to.deep.equal(['Emails', 'Passwords']);
  });
});

describe('itemEmails', () => {
  it('takes a login username that is an email', () => {
    const d = detail({ login: { username: 'me@site.com', password: null, totp: null, uris: [], hasTotp: false } });
    expect(itemEmails(d)).to.deep.equal(['me@site.com']);
  });

  it('ignores a non-email username', () => {
    const d = detail({ login: { username: 'octocat', password: null, totp: null, uris: [], hasTotp: false } });
    expect(itemEmails(d)).to.deep.equal([]);
  });

  it('takes an identity email', () => {
    const d = detail({
      identity: {
        title: null, firstName: null, middleName: null, lastName: null, username: null,
        company: null, ssn: null, passportNumber: null, licenseNumber: null,
        email: 'id@site.com', phone: null, address1: null, address2: null, address3: null,
        city: null, state: null, postalCode: null, country: null,
      },
    });
    expect(itemEmails(d)).to.deep.equal(['id@site.com']);
  });
});
