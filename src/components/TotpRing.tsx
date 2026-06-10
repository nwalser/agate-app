// A small circular countdown ring for a live TOTP code: the arc empties as the
// code's `remaining` seconds tick toward 0 and recolors by validity (green while
// fresh → amber → red in the final seconds). Purely presentational — the parent
// owns the per-second countdown (state/totpCache.ts); the ring just mirrors the
// current value, so it "ticks" in lockstep with the seconds text beside it.

import type { JSX } from 'solid-js';

/** Validity tier for a TOTP's remaining seconds, used to color the ring. */
export type TotpValidity = 'ok' | 'low' | 'crit';

/**
 * Map remaining seconds to a color tier. Absolute seconds (not a fraction of the
 * period) so the final stretch always goes red regardless of the code's step:
 *  - `ok`   (> 10s) — plenty of time.
 *  - `low`  (6–10s) — running down.
 *  - `crit` (≤ 5s)  — about to roll over.
 */
export function totpValidity(remaining: number): TotpValidity {
  if (remaining <= 5) return 'crit';
  if (remaining <= 10) return 'low';
  return 'ok';
}

export default function TotpRing(props: {
  remaining: number;
  period: number;
  /** Outer diameter in px (default 14, sized for a list cell). */
  size?: number;
}): JSX.Element {
  const size = () => props.size ?? 14;
  const center = () => size() / 2;
  const stroke = () => Math.max(1.5, size() / 8);
  const radius = () => (size() - stroke()) / 2;
  const circumference = () => 2 * Math.PI * radius();
  // Fraction of the window still remaining (clamped); a bogus/zero period falls
  // back to the TOTP default of 30s rather than dividing by zero.
  const fraction = () => {
    const period = props.period > 0 ? props.period : 30;
    return Math.max(0, Math.min(1, props.remaining / period));
  };

  return (
    <svg
      class="totp-ring"
      classList={{
        ok: totpValidity(props.remaining) === 'ok',
        low: totpValidity(props.remaining) === 'low',
        crit: totpValidity(props.remaining) === 'crit',
      }}
      width={size()}
      height={size()}
      viewBox={`0 0 ${size()} ${size()}`}
      aria-hidden="true"
    >
      <circle
        class="totp-ring-track"
        cx={center()}
        cy={center()}
        r={radius()}
        fill="none"
        stroke-width={stroke()}
      />
      <circle
        class="totp-ring-arc"
        cx={center()}
        cy={center()}
        r={radius()}
        fill="none"
        stroke-width={stroke()}
        stroke-linecap="round"
        stroke-dasharray={`${circumference()}`}
        stroke-dashoffset={`${circumference() * (1 - fraction())}`}
        transform={`rotate(-90 ${center()} ${center()})`}
      />
    </svg>
  );
}
