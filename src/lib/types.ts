// DTOs shared with the Rust backend. Mirror `src-tauri/src/dto.rs` exactly.
// Closed sets are string-literal unions, not bare `string`.

export type ServerConfig =
  | { region: 'us' }
  | { region: 'eu' }
  | { region: 'selfHosted'; baseUrl: string };

export type TwoFactorKind = 'authenticator' | 'email';

export interface TwoFactorInput {
  provider: TwoFactorKind;
  token: string;
  remember: boolean;
}

export type LoginResult =
  | { status: 'success' }
  | { status: 'twoFactorRequired'; providers: TwoFactorKind[] };

export interface SessionStatus {
  loggedIn: boolean;
  unlocked: boolean;
  localUnlockConfigured: boolean;
  helloConfigured: boolean;
  email: string | null;
}

export type HealthBand = 'critical' | 'poor' | 'fair' | 'good' | 'excellent';

export interface ItemAudit {
  id: string;
  name: string;
  reused: boolean;
  weak: boolean;
  weakScore: number | null;
  old: boolean;
  insecureUri: boolean;
  noTotp: boolean;
}

export interface VaultHealthReport {
  score: number;
  band: HealthBand;
  totalLogins: number;
  reused: number;
  weak: number;
  old: number;
  insecure: number;
  noTotp: number;
  atRisk: ItemAudit[];
}

export interface ExposedResult {
  id: string;
  name: string;
  count: number;
}

export type ItemType =
  | 'login'
  | 'secureNote'
  | 'card'
  | 'identity'
  | 'sshKey'
  | 'unknown';

export interface VaultItem {
  id: string;
  name: string;
  itemType: ItemType;
  username: string | null;
  hasTotp: boolean;
  favorite: boolean;
  folderId: string | null;
  organizationId: string | null;
}

export interface LoginUri {
  uri: string | null;
}

export interface LoginDetail {
  username: string | null;
  password: string | null;
  uris: LoginUri[];
  hasTotp: boolean;
}

export interface CustomField {
  name: string | null;
  value: string | null;
  fieldType: string;
}

export interface ItemDetail {
  id: string;
  name: string;
  itemType: ItemType;
  favorite: boolean;
  notes: string | null;
  login: LoginDetail | null;
  fields: CustomField[];
  folderId: string | null;
  organizationId: string | null;
}

export interface TotpCode {
  code: string;
  period: number;
  remaining: number;
}

export interface Folder {
  id: string | null;
  name: string;
}

export interface PasswordGenOptions {
  length: number;
  uppercase: boolean;
  lowercase: boolean;
  numbers: boolean;
  special: boolean;
  avoidAmbiguous?: boolean;
  minNumber?: number | null;
  minSpecial?: number | null;
}

export interface PassphraseGenOptions {
  numWords: number;
  wordSeparator: string;
  capitalize: boolean;
  includeNumber: boolean;
}

// ---- Item create/edit input (mirrors src-tauri/src/dto.rs ItemInput) ----

export interface UriInput {
  uri: string | null;
  /** 0=Domain,1=Host,2=StartsWith,3=Exact,4=Regex,5=Never; null=default */
  matchType: number | null;
}

export interface LoginInput {
  username: string | null;
  password: string | null;
  totp: string | null;
  uris: UriInput[];
}

export interface CardInput {
  cardholderName: string | null;
  number: string | null;
  brand: string | null;
  expMonth: string | null;
  expYear: string | null;
  code: string | null;
}

export interface IdentityInput {
  title: string | null;
  firstName: string | null;
  middleName: string | null;
  lastName: string | null;
  username: string | null;
  company: string | null;
  ssn: string | null;
  passportNumber: string | null;
  licenseNumber: string | null;
  email: string | null;
  phone: string | null;
  address1: string | null;
  address2: string | null;
  address3: string | null;
  city: string | null;
  state: string | null;
  postalCode: string | null;
  country: string | null;
}

export interface SshKeyInput {
  privateKey: string;
  publicKey: string;
  fingerprint: string;
}

export interface FieldInput {
  name: string | null;
  value: string | null;
  /** 0=Text,1=Hidden,2=Boolean,3=Linked */
  fieldType: number;
}

export interface ItemInput {
  /** present → edit; absent → create */
  id: string | null;
  itemType: ItemType;
  name: string;
  folderId: string | null;
  organizationId: string | null;
  favorite: boolean;
  reprompt: boolean;
  notes: string | null;
  login: LoginInput | null;
  card: CardInput | null;
  identity: IdentityInput | null;
  sshKey: SshKeyInput | null;
  fields: FieldInput[];
}

// Typed shape of the backend error (mirror `error.rs`).
export type ErrorKind =
  | 'notAuthenticated'
  | 'locked'
  | 'invalidCredentials'
  | 'twoFactorRequired'
  | 'localUnlock'
  | 'network'
  | 'keychain'
  | 'crypto'
  | 'badRequest'
  | 'internal';

export interface AgateError {
  kind: ErrorKind;
  message: string;
}

export function isAgateError(value: unknown): value is AgateError {
  return (
    typeof value === 'object' &&
    value !== null &&
    'kind' in value &&
    'message' in value
  );
}
