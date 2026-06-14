// Idle vault timeout. While the app is unlocked, lock every connection after the
// configured idle period passes with no user activity. User activity (move,
// click, key, wheel, touch) resets the idle timer. The timer is torn down
// whenever the app locks or the timeout is set to "never", so a locked app holds
// no live timer. (Lock-on-popup-hide lives in TrayApp — visibilitychange.)
//
// Pure frontend: it drives the existing lock path (TrayApp's doLock → ipc.lock).
// Mirrors the threat model in CLAUDE.md — the master password is persisted
// sealed, so a long-idle unlocked session is exactly what this bounds.

import { createEffect, onCleanup } from 'solid-js';
import { autoLockMinutes } from '../state/autolock.ts';

// Activity that counts as "the user is here". Passive listeners so scrolling and
// pointer movement stay smooth.
const ACTIVITY_EVENTS = ['mousemove', 'mousedown', 'keydown', 'wheel', 'touchstart'] as const;

// Don't re-arm the timer on every single mousemove — coalesce resets to at most
// one per this window. Far below the smallest 1-minute timeout, so accuracy is
// unaffected.
const RESET_THROTTLE_MS = 5_000;

export function useAutoLock(deps: { unlocked: () => boolean; lock: () => void }) {
  // Idle timer: armed only while unlocked with a finite timeout.
  createEffect(() => {
    const minutes = autoLockMinutes();
    if (!deps.unlocked() || minutes <= 0) return;

    const idleMs = minutes * 60_000;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let lastReset = 0;

    const arm = () => {
      if (timer) clearTimeout(timer);
      timer = setTimeout(() => deps.lock(), idleMs);
    };
    const onActivity = () => {
      const now = Date.now();
      if (now - lastReset < RESET_THROTTLE_MS) return;
      lastReset = now;
      arm();
    };

    arm();
    for (const ev of ACTIVITY_EVENTS) {
      window.addEventListener(ev, onActivity, { passive: true });
    }
    onCleanup(() => {
      if (timer) clearTimeout(timer);
      for (const ev of ACTIVITY_EVENTS) window.removeEventListener(ev, onActivity);
    });
  });
}
