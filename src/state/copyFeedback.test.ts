import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { copyState, noteCopied, endCopy } from './copyFeedback.ts';

// The store drives the "just copied" pop + the live clipboard-wipe countdown that
// CopyButton renders. It's a tiny global pipeline (like the toast store), so it's
// tested directly with fake timers rather than an injected clock.
describe('copyFeedback', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    // Reset any lingering countdown from a previous case.
    endCopy(copyState().token);
  });
  afterEach(() => vi.useRealTimers());

  it('records a secret copy and counts the remaining seconds down to zero', () => {
    const token = noteCopied(15);
    expect(copyState().token).toBe(token);
    expect(copyState().clearSeconds).toBe(15);
    expect(copyState().remaining).toBe(15);

    vi.advanceTimersByTime(1000);
    expect(copyState().remaining).toBe(14);

    vi.advanceTimersByTime(14_000);
    expect(copyState().remaining).toBe(0);

    // Stays at zero — the ticker stopped, not kept decrementing negative.
    vi.advanceTimersByTime(5000);
    expect(copyState().remaining).toBe(0);
  });

  it('bumps the token on every copy so a button can tell its copy from a newer one', () => {
    const a = noteCopied(15);
    const b = noteCopied(15);
    expect(b).toBeGreaterThan(a);
    expect(copyState().token).toBe(b);
    // The newer copy resets the countdown.
    expect(copyState().remaining).toBe(15);
  });

  it('treats a non-secret copy (0s) as no countdown at all', () => {
    noteCopied(0);
    expect(copyState().clearSeconds).toBe(0);
    expect(copyState().remaining).toBe(0);
    vi.advanceTimersByTime(5000);
    expect(copyState().remaining).toBe(0);
  });

  it('endCopy zeroes the active copy (clipboard wiped early)', () => {
    const token = noteCopied(15);
    vi.advanceTimersByTime(2000);
    expect(copyState().remaining).toBe(13);
    endCopy(token);
    expect(copyState().remaining).toBe(0);
  });

  it('endCopy for a stale token is a no-op (a newer copy already took over)', () => {
    const stale = noteCopied(15);
    const fresh = noteCopied(30);
    endCopy(stale);
    // The fresh copy's countdown is untouched.
    expect(copyState().token).toBe(fresh);
    expect(copyState().remaining).toBe(30);
  });
});
