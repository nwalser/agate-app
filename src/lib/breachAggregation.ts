// Pure breach-aggregation helpers. Given a dark-web scan's per-account breach
// lists, derive the account-relevant breach directory: the breaches your *own*
// accounts appear in, deduplicated across accounts and annotated with how many of
// your accounts each one hit. Never the full public catalogue. No IPC, no signals
// — pure functions over the report shape so they're trivially testable.

import type { AccountBreaches, BreachRecord, DarkWebReport, ItemDetail } from './types.ts';

// Loose email shape — mirrors the backend harvester's `is_email` intent: enough to
// avoid matching raw usernames, not a full RFC validator.
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;

/**
 * The email addresses tied to an item: a login username that looks like an email,
 * and an identity's email field. These are exactly the strings the backend harvests
 * for the dark-web scan, so matching them against the scan report tells us which
 * breaches an item is caught up in.
 */
export function itemEmails(detail: ItemDetail): string[] {
  const out: string[] = [];
  const username = detail.login?.username?.trim();
  if (username && EMAIL_RE.test(username)) out.push(username);
  const email = detail.identity?.email?.trim();
  if (email && EMAIL_RE.test(email)) out.push(email);
  return out;
}

/** A breach plus which of the user's own accounts (emails) appear in it. */
export interface RelevantBreach {
  breach: BreachRecord;
  /** Affected account emails, in original casing, deduplicated and sorted. */
  accounts: string[];
}

/**
 * Deduplicate the breaches across the scanned accounts, collecting which of the
 * user's account emails each breach hit, and sort most-accounts-first. When the
 * same breach appears under several accounts, keep the record carrying the most
 * "what leaked" detail (the longest `dataClasses`).
 */
export function aggregateRelevantBreaches(accounts: AccountBreaches[]): RelevantBreach[] {
  const byName = new Map<string, { breach: BreachRecord; accounts: Set<string> }>();
  for (const account of accounts) {
    for (const breach of account.breaches) {
      const key = breach.name.toLowerCase();
      const existing = byName.get(key);
      if (existing) {
        existing.accounts.add(account.email);
        // Prefer the record carrying the most "what leaked" detail.
        if (breach.dataClasses.length > existing.breach.dataClasses.length) {
          existing.breach = breach;
        }
      } else {
        byName.set(key, { breach, accounts: new Set([account.email]) });
      }
    }
  }
  return [...byName.values()]
    .map((e) => ({ breach: e.breach, accounts: [...e.accounts].sort() }))
    .sort((a, b) => b.accounts.length - a.accounts.length);
}

/**
 * The breaches affecting a specific set of the user's emails (lower-cased for the
 * match), as seen in the latest dark-web scan. Used by the item detail pane to
 * flag a login/identity whose email turns up in a known breach. Returns the
 * matched breach records, deduplicated by name, most-detailed record kept.
 */
export function breachesForEmails(
  accounts: AccountBreaches[],
  emails: string[],
): BreachRecord[] {
  const wanted = new Set(emails.map((e) => e.trim().toLowerCase()).filter(Boolean));
  if (wanted.size === 0) return [];
  const byName = new Map<string, BreachRecord>();
  for (const account of accounts) {
    if (!wanted.has(account.email.trim().toLowerCase())) continue;
    for (const breach of account.breaches) {
      const key = breach.name.toLowerCase();
      const existing = byName.get(key);
      if (!existing || breach.dataClasses.length > existing.dataClasses.length) {
        byName.set(key, breach);
      }
    }
  }
  return [...byName.values()];
}

/**
 * Merge a fresh scan run's window into the running per-email accumulator (latest
 * result per email wins), then build the merged `DarkWebReport`: every account
 * checked so far, this run's errors, and the still-pending emails minus anything
 * already covered by an earlier run's window. Mutates `accumulator` in place.
 */
export function mergeScanRun(
  accumulator: Map<string, AccountBreaches>,
  run: DarkWebReport,
): DarkWebReport {
  for (const acct of run.accounts) accumulator.set(acct.email, acct);
  const accounts = [...accumulator.values()];
  // Drop from "pending" anything already checked in an earlier run's window.
  const checked = new Set(accumulator.keys());
  const pending = run.pending.filter((e) => !checked.has(e));
  return {
    accounts,
    errored: run.errored,
    pending,
    lockedConnections: run.lockedConnections,
    totalBreaches: accounts.reduce((n, a) => n + a.breaches.length, 0),
    clean: accounts.filter((a) => a.breaches.length === 0).length,
  };
}
