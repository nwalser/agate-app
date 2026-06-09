import { describe, expect, it } from 'vitest';
import { FIELD_KIND_TO_INT, fieldStringToLabel, type FieldKindLabel } from './fieldKinds.ts';

describe('fieldStringToLabel', () => {
  it('maps each backend wire string to its editor label', () => {
    expect(fieldStringToLabel('text')).toBe('Text');
    expect(fieldStringToLabel('hidden')).toBe('Hidden');
    expect(fieldStringToLabel('boolean')).toBe('Boolean');
    expect(fieldStringToLabel('linked')).toBe('Linked');
  });

  it('round-trips label -> int -> ... matches the write-side codes', () => {
    // The labels produced on the read side must be valid keys for the write side.
    const labels: FieldKindLabel[] = ['Text', 'Hidden', 'Boolean', 'Linked'];
    for (const label of labels) {
      expect(FIELD_KIND_TO_INT[label]).toBeTypeOf('number');
    }
  });
});
