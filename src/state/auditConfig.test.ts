import { beforeEach, describe, expect, it, vi } from 'vitest';

// Fresh module per case so the import-time localStorage read sees seeded state.
async function fresh(seed?: unknown) {
  vi.resetModules();
  localStorage.clear();
  if (seed !== undefined) localStorage.setItem('agate.auditConfig', JSON.stringify(seed));
  return import('./auditConfig.ts');
}

describe('audit config', () => {
  beforeEach(() => localStorage.clear());

  it('defaults to all checks on with default thresholds', async () => {
    const m = await fresh();
    const c = m.auditConfig();
    expect(c.reused && c.weak && c.old && c.insecureUri && c.noTotp).toBe(true);
    expect(c.weakMaxScore).toBe(3);
    expect(c.oldDays).toBe(365);
    expect(c.reuseMin).toBe(2);
  });

  it('setAuditOption persists a change', async () => {
    const m = await fresh();
    m.setAuditOption('weak', false);
    m.setAuditOption('oldDays', 90);
    expect(m.auditConfig().weak).toBe(false);
    expect(m.auditConfig().oldDays).toBe(90);
    const raw = JSON.parse(localStorage.getItem('agate.auditConfig') ?? '{}');
    expect(raw.weak).toBe(false);
    expect(raw.oldDays).toBe(90);
  });

  it('clamps + sanitizes corrupt persisted values', async () => {
    const m = await fresh({ weak: 'nope', weakMaxScore: 99, oldDays: -5, reuseMin: 1 });
    const c = m.auditConfig();
    expect(c.weak).toBe(true); // invalid bool → default
    expect(c.weakMaxScore).toBe(4); // clamped to max
    expect(c.oldDays).toBe(1); // clamped to min
    expect(c.reuseMin).toBe(2); // clamped to min
  });

  it('clamps the opposite bounds', async () => {
    const m = await fresh({ weakMaxScore: 1, oldDays: 9999, reuseMin: 999 });
    const c = m.auditConfig();
    expect(c.weakMaxScore).toBe(2); // below min → clamp up
    expect(c.oldDays).toBe(3650); // above max → clamp down
    expect(c.reuseMin).toBe(100); // above max → clamp down
  });

  it('falls back on non-finite / non-number values', async () => {
    // JSON can't hold Infinity (serializes to null); strings/null hit the fallback.
    const m = await fresh({ weakMaxScore: null, oldDays: 'x', reuseMin: Infinity });
    const c = m.auditConfig();
    expect(c.weakMaxScore).toBe(3);
    expect(c.oldDays).toBe(365);
    expect(c.reuseMin).toBe(2);
  });

  it('clamps out-of-range writes via setAuditOption', async () => {
    const m = await fresh();
    m.setAuditOption('oldDays', 99999);
    expect(m.auditConfig().oldDays).toBe(3650);
    m.setAuditOption('weakMaxScore', 0);
    expect(m.auditConfig().weakMaxScore).toBe(2);
  });

  it('round-trips a persisted numeric value on a cold load', async () => {
    const m1 = await fresh();
    m1.setAuditOption('oldDays', 90);
    // Re-import WITHOUT clearing storage so read() re-parses the persisted value.
    vi.resetModules();
    const m2 = await import('./auditConfig.ts');
    expect(m2.auditConfig().oldDays).toBe(90);
  });

  it('resetAuditConfig restores defaults', async () => {
    const m = await fresh();
    m.setAuditOption('reused', false);
    m.resetAuditConfig();
    expect(m.auditConfig().reused).toBe(true);
  });

  it('auditConfigPayload reflects the current config', async () => {
    const m = await fresh();
    m.setAuditOption('noTotp', false);
    expect(m.auditConfigPayload().noTotp).toBe(false);
  });
});
