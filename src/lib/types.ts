// IPC data shapes shared with the Rust backend.
//
// Rust is the single source of truth: every shape below is GENERATED from the
// DTOs in `src-tauri/src/dto/*.rs` (+ `src-tauri/src/error.rs`) into
// `./generated/dto.ts` by the `export_ts_types` cargo test. Do not hand-edit
// the generated file — change the Rust type and regenerate:
//
//   cargo test --manifest-path src-tauri/Cargo.toml export_ts_types
//
// This module re-exports the generated names so existing imports keep working;
// frontend-only helpers (e.g. `isAgateError`) stay hand-written here.

export type {
  // ---- auth / session / connections ----
  ServerConfig,
  TwoFactorKind,
  TwoFactorInput,
  LoginResult,
  SessionStatus,
  ConnectionSummary,
  UnlockOutcome,
  // ---- custom-titlebar window controls ----
  ControlsSide,
  WindowControl,
  WindowControlsLayout,
  // ---- security audit / dark-web monitor ----
  HealthBand,
  ItemAudit,
  VaultHealthReport,
  ExposedResult,
  BreachRecord,
  AccountBreaches,
  EmailError,
  DarkWebReport,
  // ---- vault read shapes ----
  ItemType,
  VaultItem,
  LoginUri,
  LoginDetail,
  CustomField,
  ItemDetail,
  PasskeyCredential,
  Attachment,
  SendSummary,
  Collection,
  TotpCode,
  Folder,
  ExportFormat,
  // ---- generator options ----
  PasswordGenOptions,
  PassphraseGenOptions,
  UsernameMode,
  UsernameGenOptions,
  // ---- item create/edit input ----
  UriInput,
  LoginInput,
  CardInput,
  IdentityInput,
  SshKeyInput,
  FieldInput,
  ItemInput,
  // ---- AI access (local MCP server) ----
  AiGrant,
  AiServerStatus,
  AiAuditEntry,
  // ---- typed backend error ----
  ErrorKind,
  AgateError,
} from './generated/dto.ts';

import type { AgateError } from './generated/dto.ts';

export function isAgateError(value: unknown): value is AgateError {
  return (
    typeof value === 'object' &&
    value !== null &&
    'kind' in value &&
    'message' in value
  );
}
