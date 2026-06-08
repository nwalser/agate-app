// The only place `invoke` is called. Every backend command has one typed
// wrapper here so screens never touch the raw IPC string or untyped payloads.

import { invoke } from '@tauri-apps/api/core';
import type {
  Folder,
  ItemDetail,
  LoginResult,
  PasswordGenOptions,
  ServerConfig,
  SessionStatus,
  TotpCode,
  TwoFactorInput,
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
};
