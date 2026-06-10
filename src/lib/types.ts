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
  /** Whether the master password is stored (auto-unlock) vs. manual-unlock only. */
  storeCredentials: boolean;
}

/** Per-connection result of an `unlockAll`. */
export type UnlockOutcome = { email: string; serverLabel: string } & (
  | { status: 'unlocked' }
  | { status: 'twoFactorRequired'; providers: TwoFactorKind[] }
  | { status: 'manualUnlock' }
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

/** One email whose breach lookup failed this run (retried next run). */
export interface EmailError {
  email: string;
  error: string;
}

export interface DarkWebReport {
  /** Every email checked this run (or, in the merged store view, ever checked). */
  accounts: AccountBreaches[];
  /** Emails whose lookup failed; retried next run. */
  errored: EmailError[];
  /** Emails harvested but not yet checked (rotated into a later run). */
  pending: string[];
  /** Configured connections not unlocked, so their vault items weren't read. */
  lockedConnections: string[];
  totalBreaches: number;
  clean: number;
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
  /** Whether the login has at least one stored passkey (FIDO2 credential). */
  hasPasskey: boolean;
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
  fieldType: 'text' | 'hidden' | 'boolean' | 'linked';
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
  /** Last-modified timestamp (RFC 3339) — shown as "updated X ago" in the pane. */
  revisionDate: string;
  /** Creation timestamp (RFC 3339). */
  creationDate: string;
  /** Collections this item belongs to (IDs; resolve to names via listCollections). */
  collectionIds: string[];
  /** File attachments (metadata; download via downloadAttachment). */
  attachments: Attachment[];
  /** Stored passkeys (FIDO2 credentials) on this login — display metadata only. */
  passkeys: PasskeyCredential[];
}

/** A stored passkey (FIDO2 credential). Mirrors src-tauri dto PasskeyCredential. */
export interface PasskeyCredential {
  rpId: string;
  rpName: string | null;
  userName: string | null;
  userDisplayName: string | null;
  keyAlgorithm: string;
  creationDate: string;
}

/** One file attachment on an item (metadata only). Mirrors src-tauri dto Attachment. */
export interface Attachment {
  id: string;
  fileName: string | null;
  sizeName: string | null;
}

/** A Bitwarden Send summary (ephemeral share). Mirrors src-tauri dto SendSummary. */
export interface SendSummary {
  id: string;
  name: string;
  /** 'text' or 'file'. */
  sendType: string;
  disabled: boolean;
  hasPassword: boolean;
  accessCount: number;
  maxAccessCount: number | null;
  deletionDate: string;
  expirationDate: string | null;
  accountEmail: string;
  accountLabel: string;
}

/** A decrypted collection (shared-vault grouping). Mirrors src-tauri dto Collection. */
export interface Collection {
  id: string;
  name: string;
  organizationId: string;
  accountEmail: string;
  accountLabel: string;
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

/** Vault-export file format (closed set). */
export type ExportFormat = 'json' | 'csv';

/** Username-generator mode (closed set; no forwarded-alias services). */
export type UsernameMode = 'plusAddressed' | 'catchAll' | 'random';

export interface UsernameGenOptions {
  mode: UsernameMode;
  /** Base email for plus-addressing (mode = 'plusAddressed'). */
  email?: string | null;
  /** Domain for catch-all addressing (mode = 'catchAll'). */
  domain?: string | null;
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

// ---- AI access (local MCP server) — mirror src-tauri/src/dto/ai.rs ----

/** One allowlist entry: a single item (in one connection) the AI may read. */
export interface AiGrant {
  accountEmail: string;
  itemId: string;
}

/** Status of the local MCP server. `url`/`token` are populated only when enabled. */
export interface AiServerStatus {
  enabled: boolean;
  running: boolean;
  /** `http://127.0.0.1:<port>/mcp`, when enabled. */
  url: string | null;
  /** Bearer token the MCP client must send, when enabled. */
  token: string | null;
}

/** One line in the session-only MCP access audit log. */
export interface AiAuditEntry {
  /** RFC 3339 timestamp. */
  timestamp: string;
  /** The MCP tool invoked (e.g. `get_vault_item`). */
  action: string;
  itemName: string | null;
  accountEmail: string | null;
  /** Whether the access was permitted (allowlisted + unlocked) or denied. */
  allowed: boolean;
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
