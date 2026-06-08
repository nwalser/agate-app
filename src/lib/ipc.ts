// The only place `invoke` is called. Every backend command has one typed
// wrapper here so screens never touch the raw IPC string or untyped payloads.

import { invoke } from '@tauri-apps/api/core';
import type {
  AccountSummary,
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
  VaultHealthReport,
  VaultItem,
} from './types.ts';

export const ipc = {
  getSessionStatus: (): Promise<SessionStatus> => invoke('get_session_status'),

  getServerConfig: (): Promise<ServerConfig> => invoke('get_server_config'),

  setServerConfig: (server: ServerConfig): Promise<void> =>
    invoke('set_server_config', { server }),

  login: (
    server: ServerConfig,
    email: string,
    password: string,
    twoFactor?: TwoFactorInput,
  ): Promise<LoginResult> =>
    invoke('login', { server, email, password, twoFactor: twoFactor ?? null }),

  sendEmailCode: (server: ServerConfig, email: string, password: string): Promise<void> =>
    invoke('send_email_code', { server, email, password }),

  lock: (): Promise<void> => invoke('lock'),

  logout: (): Promise<void> => invoke('logout'),

  enableLocalUnlock: (localPassword: string): Promise<void> =>
    invoke('enable_local_unlock', { localPassword }),

  unlockLocal: (localPassword: string): Promise<void> =>
    invoke('unlock_local', { localPassword }),

  disableLocalUnlock: (): Promise<void> => invoke('disable_local_unlock'),

  syncVault: (force: boolean): Promise<void> => invoke('sync_vault', { force }),

  listItems: (): Promise<VaultItem[]> => invoke('list_items'),

  listFolders: (): Promise<Folder[]> => invoke('list_folders'),

  itemDetail: (id: string): Promise<ItemDetail> => invoke('item_detail', { id }),

  itemTotp: (id: string): Promise<TotpCode> => invoke('item_totp', { id }),

  generatePassword: (options: PasswordGenOptions): Promise<string> =>
    invoke('generate_password', { options }),

  generatePassphrase: (options: PassphraseGenOptions): Promise<string> =>
    invoke('generate_passphrase', { options }),

  // ---- vault write operations ----

  saveItem: (input: ItemInput): Promise<void> => invoke('save_item', { input }),

  cloneItem: (id: string): Promise<void> => invoke('clone_item', { id }),

  setFavorite: (id: string, favorite: boolean): Promise<void> =>
    invoke('set_favorite', { id, favorite }),

  moveItems: (ids: string[], folderId: string | null): Promise<void> =>
    invoke('move_items', { ids, folderId }),

  deleteItems: (ids: string[], permanent: boolean): Promise<void> =>
    invoke('delete_items', { ids, permanent }),

  restoreItems: (ids: string[]): Promise<void> => invoke('restore_items', { ids }),

  createFolder: (name: string): Promise<Folder> => invoke('create_folder', { name }),

  renameFolder: (id: string, name: string): Promise<Folder> =>
    invoke('rename_folder', { id, name }),

  // ---- security audit ----

  auditOffline: (): Promise<VaultHealthReport> => invoke('audit_offline'),

  auditExposed: (): Promise<ExposedResult[]> => invoke('audit_exposed'),

  // ---- Windows Hello unlock ----

  helloAvailable: (): Promise<boolean> => invoke('hello_available'),

  helloEnable: (): Promise<void> => invoke('hello_enable'),

  helloDisable: (): Promise<void> => invoke('hello_disable'),

  helloUnlock: (): Promise<void> => invoke('hello_unlock'),

  // ---- auto-updater ----

  checkUpdate: (): Promise<string | null> => invoke('check_update'),

  runUpdate: (): Promise<void> => invoke('run_update'),

  // ---- multiple accounts ----

  listAccounts: (): Promise<AccountSummary[]> => invoke('list_accounts'),

  switchAccount: (email: string): Promise<void> => invoke('switch_account', { email }),

  removeAccount: (email: string): Promise<void> => invoke('remove_account', { email }),
};
