// Login URI match-detection options: the closed set of match types the editor's
// per-URI dropdown offers, mapped to the backend UriInput.matchType int
// (0=Domain,1=Host,2=StartsWith,3=Exact,4=Regex,5=Never; null=default).
import { t } from './i18n.ts';

// `value` (the int) is the stable identifier; `label` is a getter so it resolves
// through t() when the dropdown reads it, tracking the active language.
export const MATCH_OPTIONS: { label: string; value: number | null }[] = [
  { get label() { return t('uriMatch.default'); }, value: null },
  { get label() { return t('uriMatch.domain'); }, value: 0 },
  { get label() { return t('uriMatch.host'); }, value: 1 },
  { get label() { return t('uriMatch.startsWith'); }, value: 2 },
  { get label() { return t('uriMatch.exact'); }, value: 3 },
  { get label() { return t('uriMatch.regex'); }, value: 4 },
  { get label() { return t('uriMatch.never'); }, value: 5 },
];
