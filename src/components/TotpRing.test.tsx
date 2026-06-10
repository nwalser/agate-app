// Unit + render tests for the TOTP countdown ring. Covers the pure validity
// tiers (color by remaining seconds) and the arc geometry (full → empty as the
// code expires, and a safe clamp when the period is bogus).

import { cleanup, render } from '@solidjs/testing-library';
import { afterEach, describe, expect, it } from 'vitest';
import TotpRing, { totpValidity } from './TotpRing.tsx';

describe('totpValidity', () => {
  it('is ok with plenty of time left', () => {
    expect(totpValidity(30)).toBe('ok');
    expect(totpValidity(11)).toBe('ok');
  });
  it('is low in the warning window', () => {
    expect(totpValidity(10)).toBe('low');
    expect(totpValidity(6)).toBe('low');
  });
  it('is crit in the final seconds', () => {
    expect(totpValidity(5)).toBe('crit');
    expect(totpValidity(1)).toBe('crit');
    expect(totpValidity(0)).toBe('crit');
  });
});

describe('TotpRing', () => {
  afterEach(cleanup);

  const arc = () => document.querySelector('.totp-ring-arc') as SVGCircleElement;
  const ring = () => document.querySelector('.totp-ring') as SVGSVGElement;

  it('colors the ring by validity', () => {
    render(() => <TotpRing remaining={3} period={30} />);
    expect(ring().classList.contains('crit')).toBe(true);
    expect(ring().classList.contains('ok')).toBe(false);
  });

  it('empties the arc as remaining falls (dashoffset grows toward the circumference)', () => {
    const { unmount } = render(() => <TotpRing remaining={30} period={30} />);
    // Full code: the whole ring is drawn (offset 0).
    expect(Number(arc().getAttribute('stroke-dashoffset'))).toBeCloseTo(0, 5);
    unmount();

    render(() => <TotpRing remaining={0} period={30} />);
    const circ = Number(arc().getAttribute('stroke-dasharray'));
    // Expired: nothing drawn (offset == full circumference).
    expect(Number(arc().getAttribute('stroke-dashoffset'))).toBeCloseTo(circ, 5);
  });

  it('clamps a bogus period instead of dividing by zero', () => {
    render(() => <TotpRing remaining={10} period={0} />);
    const off = Number(arc().getAttribute('stroke-dashoffset'));
    expect(Number.isFinite(off)).toBe(true);
  });
});
