import { describe, expect, it } from 'vitest';
import { columnKey, columnLabel, parseColumnConfig, type ColumnSpec } from './columnConfig.ts';

describe('custom column label + icon', () => {
  it('columnLabel uses the label override, falling back to the field', () => {
    expect(columnLabel({ kind: 'custom', field: 'env' })).toBe('env');
    expect(columnLabel({ kind: 'custom', field: 'env', label: 'Environment' })).toBe('Environment');
    expect(columnLabel({ kind: 'custom', field: 'env', label: '   ' })).toBe('env'); // blank ignored
  });

  it('columnKey ignores label/icon (identity stays the field)', () => {
    const a: ColumnSpec = { kind: 'custom', field: 'env' };
    const b: ColumnSpec = { kind: 'custom', field: 'env', label: 'Environment', icon: 'tag' };
    expect(columnKey(a)).toBe(columnKey(b));
    expect(columnKey(b)).toBe('custom:env');
  });

  it('parse round-trips a valid label + known icon (label trimmed)', () => {
    const cfg = parseColumnConfig({
      columns: [{ kind: 'custom', field: 'env', label: ' Environment ', icon: 'tag' }],
    });
    expect(cfg.columns[0]).toEqual({ kind: 'custom', field: 'env', label: 'Environment', icon: 'tag' });
  });

  it('parse drops an unknown icon + a blank label but keeps the column', () => {
    const cfg = parseColumnConfig({
      columns: [{ kind: 'custom', field: 'env', label: '   ', icon: 'not-an-icon' }],
    });
    expect(cfg.columns[0]).toEqual({ kind: 'custom', field: 'env' });
  });
});
