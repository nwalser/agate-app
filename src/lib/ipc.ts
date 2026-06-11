// The only place `invoke` is called. Every backend command has one typed
// wrapper here so screens never touch the raw IPC string or untyped payloads.

import { invoke as tauriInvoke } from '@tauri-apps/api/core';
import type {
  AccountBreaches,
  AiAuditEntry,
  AiGrant,
  AiServerStatus,
  BreachRecord,
  Collection,
  ConnectionSummary,
  DarkWebReport,
  ExportFormat,
  ExposedResult,
  Folder,
  SendSummary,
  SendCreateInput,
  SendCreated,
  ItemDetail,
  ItemInput,
  LoginResult,
  PassphraseGenOptions,
  PasswordGenOptions,
  ServerConfig,
  SessionStatus,
  TotpCode,
  TwoFactorInput,
  UnlockOutcome,
  UsernameGenOptions,
  VaultHealthReport,
  VaultItem,
  WindowControlsLayout,
} from './types.ts';
import { auditConfigPayload } from '../state/auditConfig.ts';

// ── Test-only IPC seam (webdriver e2e) ───────────────────────────────────────
// Every wrapper below calls the local `invoke`, which routes through a swappable
// transport. e2e specs replace it (via `window.__agateInvoke.setInvoke`) so the
// SolidJS UI can be driven through every screen without a live Bitwarden backend
// — the same pattern as the official clients' tests, mirroring themia-app.
//
// Hard-gated so it NEVER ships in a release: the hook is only installed when
// BOTH `__AGATE_TEST_HOOKS__` (a build-time constant — false for `tauri build`,
// so the whole block is dead-code-eliminated from production bundles) AND
// `navigator.webdriver` are true. A normally-launched release app has neither,
// so there is no backdoor.
type RawInvoke = (cmd: string, args?: Record<string, unknown>) => Promise<unknown>;

const defaultInvoke: RawInvoke = (cmd, args) => tauriInvoke(cmd, args);
let invokeImpl: RawInvoke = defaultInvoke;

/** Typed `invoke` routed through the swappable transport. The return type is the
 *  command's Ok value (the promise rejects on a Rust `Err`). */
function invoke<T>(cmd: string, args?: Record<string, unknown>): Promise<T> {
  return invokeImpl(cmd, args) as Promise<T>;
}

declare global {
  interface Window {
    /** Test-only hook (webdriver): swap the transport every typed `invoke` uses. */
    __agateInvoke?: { setInvoke: (fn: RawInvoke | null) => void };
  }
}

if (__AGATE_TEST_HOOKS__ && typeof window !== 'undefined' && navigator.webdriver) {
  window.__agateInvoke = {
    setInvoke: (fn: RawInvoke | null) => {
      invokeImpl = fn ?? defaultInvoke;
    },
  };
}

export const ipc = {
  getSessionStatus: (): Promise<SessionStatus> => invoke('get_session_status'),

  getServerConfig: (): Promise<ServerConfig> => invoke('get_server_config'),

  /** Host OS UI locale (e.g. "de-DE") for first-run language detection. */
  getSystemLocale: (): Promise<string> => invoke('get_system_locale'),

  /** Reveal + focus the main window (tray popup's "Open Agate" button). */
  showMainWindow: (): Promise<void> => invoke('show_main_window'),

  /** Hide the tray quick-access popup (Escape key; no-op elsewhere). */
  hideTrayWindow: (): Promise<void> => invoke('hide_tray_window'),

  setServerConfig: (server: ServerConfig): Promise<void> =>
    invoke('set_server_config', { server }),

  // ---- app unlock (one secret unlocks every connection) ----

  configureAppUnlock: (appPassword: string): Promise<void> =>
    invoke('configure_app_unlock', { appPassword }),

  changeAppUnlock: (newPassword: string): Promise<void> =>
    invoke('change_app_unlock', { newPassword }),

  unlockAll: (appPassword: string): Promise<UnlockOutcome[]> =>
    invoke('unlock_all', { appPassword }),

  /** Verify the app password without unlocking — gates reprompt-protected items. */
  verifyAppPassword: (password: string): Promise<boolean> =>
    invoke('verify_app_password', { password }),

  unlockConnection2fa: (email: string, twoFactor: TwoFactorInput): Promise<void> =>
    invoke('unlock_connection_2fa', { email, twoFactor }),

  sendConnectionEmailCode: (email: string): Promise<void> =>
    invoke('send_connection_email_code', { email }),

  // ---- connections ----

  listConnections: (): Promise<ConnectionSummary[]> => invoke('list_connections'),

  addConnection: (
    server: ServerConfig,
    email: string,
    password: string,
    storeCredentials: boolean,
    twoFactor?: TwoFactorInput,
  ): Promise<LoginResult> =>
    invoke('add_connection', {
      server,
      email,
      password,
      storeCredentials,
      twoFactor: twoFactor ?? null,
    }),

  updateConnection: (
    email: string,
    server: ServerConfig,
    storeCredentials: boolean,
    password?: string,
    twoFactor?: TwoFactorInput,
  ): Promise<LoginResult> =>
    invoke('update_connection', {
      email,
      server,
      storeCredentials,
      password: password ?? null,
      twoFactor: twoFactor ?? null,
    }),

  unlockConnection: (
    email: string,
    password: string,
    twoFactor?: TwoFactorInput,
  ): Promise<LoginResult> =>
    invoke('unlock_connection', { email, password, twoFactor: twoFactor ?? null }),

  sendEmailCode: (server: ServerConfig, email: string, password: string): Promise<void> =>
    invoke('send_email_code', { server, email, password }),

  removeConnection: (email: string): Promise<void> => invoke('remove_connection', { email }),

  setActiveConnection: (email: string): Promise<void> =>
    invoke('set_active_connection', { email }),

  lock: (): Promise<void> => invoke('lock'),

  logout: (): Promise<void> => invoke('logout'),

  syncVault: (force: boolean): Promise<void> => invoke('sync_vault', { force }),

  listItems: (): Promise<VaultItem[]> => invoke('list_items'),

  listFolders: (): Promise<Folder[]> => invoke('list_folders'),

  listCollections: (): Promise<Collection[]> => invoke('list_collections'),

  /** Distinct custom-field names across every unlocked vault, for the column
   *  picker (so a custom-field column is chosen, not blind-typed). */
  listCustomFields: (): Promise<string[]> => invoke('list_custom_field_names'),

  /** List Bitwarden Sends (ephemeral shares) across all unlocked connections. */
  listSends: (): Promise<SendSummary[]> => invoke('list_sends'),

  /** Create a text Send and return its public share link. */
  createSend: (input: SendCreateInput): Promise<SendCreated> =>
    invoke('create_send', { input }),

  /** Revoke (delete) one Send. */
  deleteSend: (accountEmail: string, sendId: string): Promise<void> =>
    invoke('delete_send', { accountEmail, sendId }),

  /** Download + decrypt one attachment to the Downloads folder; returns the path. */
  downloadAttachment: (accountEmail: string, itemId: string, attachmentId: string): Promise<string> =>
    invoke('download_attachment', { accountEmail, itemId, attachmentId }),

  itemDetail: (accountEmail: string, id: string): Promise<ItemDetail> =>
    invoke('item_detail', { accountEmail, id }),

  itemTotp: (accountEmail: string, id: string): Promise<TotpCode> =>
    invoke('item_totp', { accountEmail, id }),

  /** Capture the screen and decode a TOTP setup QR into its otpauth:// URI. */
  scanTotpQr: (): Promise<string> => invoke('scan_totp_qr'),

  /** Whether OCR (scan card / fill from image) is available on this platform. */
  ocrAvailable: (): Promise<boolean> => invoke('ocr_available'),
  /** Capture every monitor and return the recognized text lines (may contain
   *  secrets — never log them). */
  ocrCaptureScreen: (): Promise<string[]> => invoke('ocr_capture_screen'),
  /** Pick an image file and return its recognized text lines (null = cancelled). */
  ocrCaptureFile: (): Promise<string[] | null> => invoke('ocr_capture_file'),

  generatePassword: (options: PasswordGenOptions): Promise<string> =>
    invoke('generate_password', { options }),

  generatePassphrase: (options: PassphraseGenOptions): Promise<string> =>
    invoke('generate_passphrase', { options }),

  generateUsername: (options: UsernameGenOptions): Promise<string> =>
    invoke('generate_username', { options }),

  /** Export all unlocked vaults to a JSON/CSV file in Downloads; returns the path. */
  exportVault: (format: ExportFormat): Promise<string> =>
    invoke('export_vault', { format }),

  /** Import items from a user-picked CSV into a connection; returns the count created. */
  importVault: (accountEmail: string | null): Promise<number> =>
    invoke('import_vault', { accountEmail }),

  // ---- vault write operations ----

  saveItem: (accountEmail: string, input: ItemInput): Promise<void> =>
    invoke('save_item', { accountEmail, input }),

  cloneItem: (accountEmail: string, id: string): Promise<void> =>
    invoke('clone_item', { accountEmail, id }),

  setFavorite: (accountEmail: string, id: string, favorite: boolean): Promise<void> =>
    invoke('set_favorite', { accountEmail, id, favorite }),

  moveItems: (accountEmail: string, ids: string[], folderId: string | null): Promise<void> =>
    invoke('move_items', { accountEmail, ids, folderId }),

  deleteItems: (accountEmail: string, ids: string[], permanent: boolean): Promise<void> =>
    invoke('delete_items', { accountEmail, ids, permanent }),

  restoreItems: (accountEmail: string, ids: string[]): Promise<void> =>
    invoke('restore_items', { accountEmail, ids }),

  createFolder: (accountEmail: string, name: string): Promise<Folder> =>
    invoke('create_folder', { accountEmail, name }),

  renameFolder: (accountEmail: string, id: string, name: string): Promise<Folder> =>
    invoke('rename_folder', { accountEmail, id, name }),

  deleteFolder: (accountEmail: string, id: string): Promise<void> =>
    invoke('delete_folder', { accountEmail, id }),

  // ---- window chrome ----

  windowControlsLayout: (): Promise<WindowControlsLayout> => invoke('window_controls_layout'),

  // ---- startup (launch at login) ----

  /** Whether closing the main window keeps Agate running in the tray. */
  getCloseToTray: (): Promise<boolean> => invoke('get_close_to_tray'),

  setCloseToTray: (enabled: boolean): Promise<void> => invoke('set_close_to_tray', { enabled }),

  getAutostart: (): Promise<boolean> => invoke('get_autostart'),

  setAutostart: (enabled: boolean): Promise<void> => invoke('set_autostart', { enabled }),

  // ---- security audit ----

  // Always sends the current audit config so every audit surface (Security
  // center, the list's Security column, the sidebar badge) honours which checks
  // are enabled + their thresholds, without each caller threading it through.
  auditOffline: (): Promise<VaultHealthReport> =>
    invoke('audit_offline', { config: auditConfigPayload() }),

  auditExposed: (): Promise<ExposedResult[]> => invoke('audit_exposed'),

  // ---- dark-web / breach monitor ----

  setDarkwebConsent: (enabled: boolean): Promise<void> =>
    invoke('set_darkweb_consent', { enabled }),

  darkwebScanEmail: (email: string): Promise<AccountBreaches> =>
    invoke('darkweb_scan_email', { email }),

  darkwebScanVault: (): Promise<DarkWebReport> => invoke('darkweb_scan_vault'),

  breachDirectory: (): Promise<BreachRecord[]> => invoke('breach_directory'),

  // Encrypted scan-result cache (sealed under the VMK in the keychain — see
  // src-tauri/src/scancache.rs). `payload` is an opaque JSON string owned by
  // state/securityScans.ts; load returns null when there's no (openable) cache.
  cacheSecurityScans: (payload: string): Promise<void> =>
    invoke('cache_security_scans', { payload }),

  loadSecurityScans: (): Promise<string | null> => invoke('load_security_scans'),

  // ---- Windows Hello unlock ----

  helloAvailable: (): Promise<boolean> => invoke('hello_available'),

  helloEnable: (): Promise<void> => invoke('hello_enable'),

  helloDisable: (): Promise<void> => invoke('hello_disable'),

  helloUnlock: (): Promise<UnlockOutcome[]> => invoke('hello_unlock'),

  // ---- auto-updater ----

  checkUpdate: (): Promise<string | null> => invoke('check_update'),

  runUpdate: (): Promise<void> => invoke('run_update'),

  // ---- AI access (local MCP server) ----

  aiServerStatus: (): Promise<AiServerStatus> => invoke('ai_server_status'),

  aiSetServerEnabled: (enabled: boolean): Promise<AiServerStatus> =>
    invoke('ai_set_server_enabled', { enabled }),

  aiListGrants: (): Promise<AiGrant[]> => invoke('ai_list_grants'),

  aiSetGrant: (accountEmail: string, itemId: string, granted: boolean): Promise<void> =>
    invoke('ai_set_grant', { accountEmail, itemId, granted }),

  aiClearGrants: (): Promise<void> => invoke('ai_clear_grants'),

  aiAuditLog: (): Promise<AiAuditEntry[]> => invoke('ai_audit_log'),
};
