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
  email: string | null;
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
