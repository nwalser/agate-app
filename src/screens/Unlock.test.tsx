// The main Unlock screen reacts to unlocks that run OUTSIDE it — the tray popup
// unlocked the vault while the main window sat on the Unlock screen. Two signals
// drive that: `agate://unlock-started` (show the same decrypt animation on both
// windows) and `agate://session-changed` (the unlock finished — adopt it, or drop
// the animation if it ended still locked). Both decisions are pure + unit-tested
// here so the screen wiring stays dumb. The screen's OWN flow (password / Hello /
// per-connection 2FA) must always win — a passive refresh mid-flow would unmount
// the form.

import { describe, expect, it } from 'vitest';
import { externalUnlockAction, shouldShowExternalUnlock } from './Unlock.tsx';

describe('shouldShowExternalUnlock', () => {
  const idle = { busy: false, phase: 'idle', pendingCount: 0 } as const;

  it('shows the animation when the screen is fully idle', () => {
    expect(shouldShowExternalUnlock(idle)).toBe(true);
  });

  it('never shows it while the screen runs its own unlock (busy or animating)', () => {
    expect(shouldShowExternalUnlock({ ...idle, busy: true })).toBe(false);
    expect(shouldShowExternalUnlock({ ...idle, phase: 'working' })).toBe(false);
    expect(shouldShowExternalUnlock({ ...idle, phase: 'unlocked' })).toBe(false);
  });

  it('never shows it while per-connection 2FA prompts are pending', () => {
    expect(shouldShowExternalUnlock({ ...idle, pendingCount: 1 })).toBe(false);
  });
});

describe('externalUnlockAction', () => {
  const base = {
    busy: false,
    phase: 'idle',
    pendingCount: 0,
    unlocked: true,
    externalUnlock: false,
  } as const;

  it('adopts when idle and the backend reports unlocked', () => {
    expect(externalUnlockAction(base)).toBe('adopt');
  });

  it('adopts when showing the externally-driven animation and now unlocked', () => {
    expect(externalUnlockAction({ ...base, phase: 'working', externalUnlock: true })).toBe('adopt');
  });

  it('cancels (drops the animation) when an external unlock ended still locked', () => {
    expect(
      externalUnlockAction({ ...base, phase: 'working', externalUnlock: true, unlocked: false }),
    ).toBe('cancel');
  });

  it('ignores a still-locked broadcast when no external unlock is showing', () => {
    expect(externalUnlockAction({ ...base, unlocked: false })).toBe('ignore');
  });

  it("ignores everything while the screen's own flow owns the UI", () => {
    expect(externalUnlockAction({ ...base, busy: true })).toBe('ignore');
    expect(externalUnlockAction({ ...base, pendingCount: 1 })).toBe('ignore');
    expect(externalUnlockAction({ ...base, phase: 'unlocked' })).toBe('ignore');
    // its own working flow (not externally driven) is never disturbed
    expect(externalUnlockAction({ ...base, phase: 'working', externalUnlock: false })).toBe('ignore');
  });
});
