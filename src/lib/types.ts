// DTOs shared with the Rust backend. Mirror `src-tauri/src/dto.rs` exactly.
// Closed sets are string-literal unions, not bare `string`.

export type ServerConfig =
  | { region: 'us' }
  | { region: 'eu' }
  | { region: 'selfHosted'; baseUrl: string };

export type TwoFactorKind = 'authenticator' | 'email';

// Custom-titlebar window controls. `side` mirrors the host (Linux reads the
// desktop button-layout; Windows/fallback = right). `buttons` is the order to
// render, restricted to the controls the host exposes.
export type ControlsSide = 'left' | 'right';
export type WindowControl = 'minimize' | 'maximize' | 'close';

export interface WindowControlsLayout {
  side: ControlsSide;
  buttons: WindowControl[];
}

export interface TwoFactorInput {
  provider: TwoFactorKind;
  token: string;
  remember: boolean;
}

export type LoginResult =
  | { status: 'success' }
  | { status: 'twoFactorRequired'; providers: TwoFactorKind[] };

export interface SessionStatus {
  /** An app-unlock password has been configured (the unified unlock secret). */
  appUnlockConfigured: boolean;
  /** The app unlock is bound to this machine (device pepper mixed into the AUK). */
  unlockDeviceBound: boolean;
  /** The app is unlocked (the VMK is held; the vault is visible). */
  unlocked: boolean;
  helloConfigured: boolean;
  darkwebConsent: boolean;
  /** Number of configured connections (whether or not currently unlocked). */
  connectionCount: number;
  /** Number of connections currently unlocked this session. */
  liveCount: number;
}

/** One configured connection (server + email), for the unlock screen + settings. */
export interface ConnectionSummary {
  email: string;
  serverLabel: string;
  server: ServerConfig;
  unlocked: boolean;
}

/** Per-connection result of an `unlockAll`. */
export type UnlockOutcome = { email: string; serverLabel: string } & (
  | { status: 'unlocked' }
  | { status: 'twoFactorRequired'; providers: TwoFactorKind[] }
  | { status: 'failed'; message: string }
);

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

// ---- Dark-web / breach monitor (mirror src-tauri/src/dto.rs) ----

export interface BreachRecord {
  name: string;
  domain: string;
  breachDate: string | null;
  pwnCount: number | null;
  /** What personal data leaked: "Email addresses", "Passwords", … */
  dataClasses: string[];
  description: string | null;
  logo: string | null;
  verified: boolean;
  passwordRisk: string | null;
}

export interface AccountBreaches {
  email: string;
  breaches: BreachRecord[];
  /** Union of every data class across this email's breaches. */
  exposedData: string[];
  riskLabel: string | null;
  riskScore: number | null;
}

export interface DarkWebReport {
  accounts: AccountBreaches[];
  totalBreaches: number;
  clean: number;
  /** Vault emails found but not scanned this run (per-run cap / rate limit). */
  skipped: number;
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
  /** Owning connection (account email) — routes per-item ops in the unified list. */
  accountEmail: string;
  /** Label for the owning connection's server (list badge). */
  accountLabel: string;
  name: string;
  itemType: ItemType;
  username: string | null;
  /** First login URI (not secret) — website column + favicon host. */
  uri: string | null;
  hasTotp: boolean;
  favorite: boolean;
  deleted: boolean;
  folderId: string | null;
  organizationId: string | null;
}

export interface LoginUri {
  uri: string | null;
  matchType: number | null;
}

export interface LoginDetail {
  username: string | null;
  password: string | null;
  totp: string | null;
  uris: LoginUri[];
  hasTotp: boolean;
}

export interface CustomField {
  name: string | null;
  value: string | null;
  /** "text" | "hidden" | "boolean" | "linked" */
  fieldType: string;
  /** For linked fields: the numeric LinkedIdType target (null otherwise). */
  linkedId: number | null;
}

export interface ItemDetail {
  id: string;
  accountEmail: string;
  accountLabel: string;
  name: string;
  itemType: ItemType;
  favorite: boolean;
  reprompt: boolean;
  notes: string | null;
  login: LoginDetail | null;
  card: CardInput | null;
  identity: IdentityInput | null;
  sshKey: SshKeyInput | null;
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
  /** Owning connection; folders are per-account in the unified view. */
  accountEmail: string;
  accountLabel: string;
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
  /** For linked fields: the numeric LinkedIdType target (null otherwise). */
  linkedId: number | null;
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
