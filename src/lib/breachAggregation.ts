// Pure breach-aggregation helpers. Given a dark-web scan's per-account breach
// lists, derive the account-relevant breach directory: the breaches your *own*
// accounts appear in, deduplicated across accounts and annotated with how many of
// your accounts each one hit. Never the full public catalogue. No IPC, no signals
// — pure functions over the report shape so they're trivially testable.

import type { AccountBreaches, BreachRecord, DarkWebReport } from './types.ts';

/** A breach plus how many of the user's own accounts appear in it. */
export interface RelevantBreach {
  breach: BreachRecord;
  accountCount: number;
}

/**
 * Deduplicate the breaches across the scanned accounts, counting how many of the
 * user's accounts each breach hit, and sort most-accounts-first. When the same
 * breach appears under several accounts, keep the record carrying the most
 * "what leaked" detail (the longest `dataClasses`).
 */
export function aggregateRelevantBreaches(accounts: AccountBreaches[]): RelevantBreach[] {
  const byName = new Map<string, RelevantBreach>();
  for (const account of accounts) {
    for (const breach of account.breaches) {
      const key = breach.name.toLowerCase();
      const existing = byName.get(key);
      if (existing) {
        existing.accountCount += 1;
        // Prefer the record carrying the most "what leaked" detail.
        if (breach.dataClasses.length > existing.breach.dataClasses.length) {
          existing.breach = breach;
        }
      } else {
        byName.set(key, { breach, accountCount: 1 });
      }
    }
  }
  return [...byName.values()].sort((a, b) => b.accountCount - a.accountCount);
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
