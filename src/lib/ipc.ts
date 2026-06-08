// The only place `invoke` is called. Every backend command has one typed
// wrapper here so screens never touch the raw IPC string or untyped payloads.

import { invoke as tauriInvoke } from '@tauri-apps/api/core';
import type {
  AccountBreaches,
  BreachRecord,
  ConnectionSummary,
  DarkWebReport,
  ExposedResult,
  Folder,
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
  VaultHealthReport,
  VaultItem,
  WindowControlsLayout,
} from './types.ts';

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

  setServerConfig: (server: ServerConfig): Promise<void> =>
    invoke('set_server_config', { server }),

  // ---- app unlock (one secret unlocks every connection) ----

  configureAppUnlock: (appPassword: string, deviceBound: boolean): Promise<void> =>
    invoke('configure_app_unlock', { appPassword, deviceBound }),

  changeAppUnlock: (newPassword: string, deviceBound: boolean): Promise<void> =>
    invoke('change_app_unlock', { newPassword, deviceBound }),

  unlockAll: (appPassword: string): Promise<UnlockOutcome[]> =>
    invoke('unlock_all', { appPassword }),

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
    twoFactor?: TwoFactorInput,
  ): Promise<LoginResult> =>
    invoke('add_connection', { server, email, password, twoFactor: twoFactor ?? null }),

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

  itemDetail: (accountEmail: string, id: string): Promise<ItemDetail> =>
    invoke('item_detail', { accountEmail, id }),

  itemTotp: (accountEmail: string, id: string): Promise<TotpCode> =>
    invoke('item_totp', { accountEmail, id }),

  generatePassword: (options: PasswordGenOptions): Promise<string> =>
    invoke('generate_password', { options }),

  generatePassphrase: (options: PassphraseGenOptions): Promise<string> =>
    invoke('generate_passphrase', { options }),

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

  // ---- window chrome ----

  windowControlsLayout: (): Promise<WindowControlsLayout> => invoke('window_controls_layout'),

  // ---- security audit ----

  auditOffline: (): Promise<VaultHealthReport> => invoke('audit_offline'),

  auditExposed: (): Promise<ExposedResult[]> => invoke('audit_exposed'),

  // ---- dark-web / breach monitor ----

  setDarkwebConsent: (enabled: boolean): Promise<void> =>
    invoke('set_darkweb_consent', { enabled }),

  darkwebScanEmail: (email: string): Promise<AccountBreaches> =>
    invoke('darkweb_scan_email', { email }),

  darkwebScanVault: (): Promise<DarkWebReport> => invoke('darkweb_scan_vault'),

  breachDirectory: (): Promise<BreachRecord[]> => invoke('breach_directory'),

  // ---- Windows Hello unlock ----

  helloAvailable: (): Promise<boolean> => invoke('hello_available'),

  helloEnable: (): Promise<void> => invoke('hello_enable'),

  helloDisable: (): Promise<void> => invoke('hello_disable'),

  helloUnlock: (): Promise<UnlockOutcome[]> => invoke('hello_unlock'),

  // ---- auto-updater ----

  checkUpdate: (): Promise<string | null> => invoke('check_update'),

  runUpdate: (): Promise<void> => invoke('run_update'),
};
