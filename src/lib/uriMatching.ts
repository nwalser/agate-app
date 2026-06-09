// Login URI match-detection options: the closed set of match types the editor's
// per-URI dropdown offers, mapped to the backend UriInput.matchType int
// (0=Domain,1=Host,2=StartsWith,3=Exact,4=Regex,5=Never; null=default).

export type MatchLabel =
  | 'Default'
  | 'Domain'
  | 'Host'
  | 'Starts with'
  | 'Exact'
  | 'Regex'
  | 'Never';

export const MATCH_OPTIONS: { label: MatchLabel; value: number | null }[] = [
  { label: 'Default', value: null },
  { label: 'Domain', value: 0 },
  { label: 'Host', value: 1 },
  { label: 'Starts with', value: 2 },
  { label: 'Exact', value: 3 },
  { label: 'Regex', value: 4 },
  { label: 'Never', value: 5 },
];
