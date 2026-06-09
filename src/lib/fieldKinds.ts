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

// Read side: CustomField.fieldType arrives from the backend as a lowercase
// string ('text'|'hidden'|'boolean'|'linked'), NOT an int — map it straight to
// the editor's label. (Number('hidden') is NaN, which would silently collapse
// every existing field to Text.)
export function fieldStringToLabel(s: 'text' | 'hidden' | 'boolean' | 'linked'): FieldKindLabel {
  if (s === 'hidden') return 'Hidden';
  if (s === 'boolean') return 'Boolean';
  if (s === 'linked') return 'Linked';
  return 'Text';
}
