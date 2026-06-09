// Custom-field kind: the closed set the editor offers, mapped to the backend
// FieldInput int codes (0=Text,1=Hidden,2=Boolean,3=Linked). String-literal
// union (CLAUDE.md), never a bare string.

export type FieldKindLabel = 'Text' | 'Hidden' | 'Boolean' | 'Linked';

export const FIELD_KIND_TO_INT: Record<FieldKindLabel, number> = {
  Text: 0,
  Hidden: 1,
  Boolean: 2,
  Linked: 3,
};

export function fieldIntToLabel(n: number): FieldKindLabel {
  if (n === 1) return 'Hidden';
  if (n === 2) return 'Boolean';
  if (n === 3) return 'Linked';
  return 'Text';
}
