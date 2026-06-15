// The only place `invoke` is called. Every backend command has one typed
// wrapper here so screens never touch the raw IPC string or untyped payloads.

import { invoke as tauriInvoke } from '@tauri-apps/api/core';
import type {
  AutofillMode,
  AutofillPending,
  AutofillStatus,
  Collection,
  ConnectionSummary,
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
  UsernameGenOptions,
  VaultItem,
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

  /** Host OS UI locale (e.g. "de-DE") for first-run language detection. */
  getSystemLocale: (): Promise<string> => invoke('get_system_locale'),

  /** Hide the tray quick-access popup (Escape key; no-op elsewhere). */
  hideTrayWindow: (): Promise<void> => invoke('hide_tray_window'),

  /** Re-show + refocus the tray popup after a focus-stealing flow (the Windows
   *  Hello consent dialog) auto-hid it. No-op outside the popup window. */
  showTrayWindow: (): Promise<void> => invoke('show_tray_window'),

  /** Pin (or release) the tray popup against click-outside-to-hide. While the
   *  add/edit-login form is open the popup must NOT hide on focus loss, so a
   *  stray click can't discard a half-typed login. */
  setTrayPinned: (pinned: boolean): Promise<void> => invoke('set_tray_pinned', { pinned }),

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

  // ---- KeePass connections ----

  /** Native picker for a .kdbx database file; null when cancelled. */
  pickKeepassDatabase: (): Promise<string | null> => invoke('pick_keepass_database'),

  /** Native "save as" picker for the path of a NEW .kdbx database (defaults the
   *  name to vault.kdbx); null when cancelled. */
  pickNewKeepassDatabase: (): Promise<string | null> => invoke('pick_keepass_new_database'),

  /** Native picker for a key file (any type); null when cancelled. */
  pickKeepassKeyfile: (): Promise<string | null> => invoke('pick_keepass_keyfile'),

  /** Open + add a KeePass database as a connection. The path doubles as the
   *  connection id. `keyfile` is optional; `storeCredentials` seals the database
   *  password under the VMK so it auto-unlocks with the app. */
  addKeepassConnection: (
    path: string,
    password: string,
    keyfile: string | null,
    storeCredentials: boolean,
  ): Promise<void> =>
    invoke('add_keepass_connection', { path, password, keyfile, storeCredentials }),

  /** Create a brand-new, empty KDBX4 database at `path` and add it as a
   *  connection. Refuses to overwrite an existing file. Same sealing semantics
   *  as `addKeepassConnection` (`storeCredentials` seals the new database
   *  password under the VMK). */
  createKeepassConnection: (
    path: string,
    password: string,
    keyfile: string | null,
    storeCredentials: boolean,
  ): Promise<void> =>
    invoke('create_keepass_connection', { path, password, keyfile, storeCredentials }),

  /** Unlock one KeePass connection on demand (manual-unlock connections). The
   *  key file, when configured, is read from the connection record. */
  unlockKeepassConnection: (path: string, password: string): Promise<void> =>
    invoke('unlock_keepass_connection', { path, password }),

  // ---- pass (the standard unix password store) connections ----

  /** Native picker for a `pass` store root directory; null when cancelled. */
  pickPassStore: (): Promise<string | null> => invoke('pick_pass_store'),

  /** Native picker for an exported OpenPGP secret-key file; null when cancelled. */
  pickPassKeyfile: (): Promise<string | null> => invoke('pick_pass_keyfile'),

  /** Open + add a `pass` store as a (read-only) connection. The store root path
   *  doubles as the connection id; `keyFile` is the exported OpenPGP secret key,
   *  `passphrase` unlocks it. `storeCredentials` seals the passphrase under the
   *  VMK so it auto-unlocks with the app. */
  addPassConnection: (
    storeRoot: string,
    keyFile: string,
    passphrase: string,
    storeCredentials: boolean,
  ): Promise<void> =>
    invoke('add_pass_connection', { storeRoot, keyFile, passphrase, storeCredentials }),

  /** Unlock one `pass` connection on demand (manual-unlock connections). The key
   *  file is read from the connection record. */
  unlockPassConnection: (storeRoot: string, passphrase: string): Promise<void> =>
    invoke('unlock_pass_connection', { storeRoot, passphrase }),

  // ---- Enpass connections ----

  /** Native picker for an Enpass `vault.enpassdb` file; null when cancelled. */
  pickEnpassVault: (): Promise<string | null> => invoke('pick_enpass_vault'),

  /** Open + add an Enpass vault as a (read-only) connection. The vault path
   *  doubles as the connection id. `keyfile` is optional; `storeCredentials`
   *  seals the master password under the VMK so it auto-unlocks with the app. */
  addEnpassConnection: (
    path: string,
    password: string,
    keyfile: string | null,
    storeCredentials: boolean,
  ): Promise<void> =>
    invoke('add_enpass_connection', { path, password, keyfile, storeCredentials }),

  /** Unlock one Enpass connection on demand (manual-unlock connections). The key
   *  file, when configured, is read from the connection record. */
  unlockEnpassConnection: (path: string, password: string): Promise<void> =>
    invoke('unlock_enpass_connection', { path, password }),

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

  itemDetail: (accountEmail: string, id: string): Promise<ItemDetail> =>
    invoke('item_detail', { accountEmail, id }),

  itemTotp: (accountEmail: string, id: string): Promise<TotpCode> =>
    invoke('item_totp', { accountEmail, id }),

  generatePassword: (options: PasswordGenOptions): Promise<string> =>
    invoke('generate_password', { options }),

  /** How many existing logins (across every unlocked vault) already use this
   *  password — the tray add-form's reuse callout. Count only, never which. */
  passwordInUse: (password: string): Promise<number> =>
    invoke('password_in_use', { password }),

  /** zxcvbn strength score (0–4) for a candidate password — the tray add-form's
   *  live strength meter. `context` is the draft's non-secret fields (username /
   *  website / name) so a password equal to one of them scores low. */
  passwordStrength: (password: string, context: string[]): Promise<number> =>
    invoke('password_strength', { password, context }),

  generatePassphrase: (options: PassphraseGenOptions): Promise<string> =>
    invoke('generate_passphrase', { options }),

  generateUsername: (options: UsernameGenOptions): Promise<string> =>
    invoke('generate_username', { options }),

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

  // ---- startup (launch at login) ----

  getAutostart: (): Promise<boolean> => invoke('get_autostart'),

  setAutostart: (enabled: boolean): Promise<void> => invoke('set_autostart', { enabled }),

  // ---- Windows Hello unlock ----

  helloAvailable: (): Promise<boolean> => invoke('hello_available'),

  helloEnable: (): Promise<void> => invoke('hello_enable'),

  helloDisable: (): Promise<void> => invoke('hello_disable'),

  helloUnlock: (): Promise<UnlockOutcome[]> => invoke('hello_unlock'),

  // ---- auto-updater ----

  checkUpdate: (): Promise<string | null> => invoke('check_update'),

  runUpdate: (): Promise<void> => invoke('run_update'),

  // ---- autofill (watch other apps' login fields + fill the matching login) ----

  autofillStatus: (): Promise<AutofillStatus> => invoke('autofill_status'),

  /** Switch the detection mode (off / hotkey / always-watch). Persists + (re)starts
   *  or stops the platform watcher. */
  autofillSetMode: (mode: AutofillMode): Promise<void> => invoke('autofill_set_mode', { mode }),

  /** The current detection awaiting a pick (context + ranked candidates), or null. */
  autofillPending: (): Promise<AutofillPending | null> => invoke('autofill_pending'),

  /** Fill the chosen login into the detected target; the backend validates the
   *  one-shot token, injects the secret, and hides the popup. */
  autofillFill: (token: string, accountEmail: string, itemId: string): Promise<void> =>
    invoke('autofill_fill', { token, accountEmail, itemId }),

  /** Discard the pending detection without filling (popup dismissed). */
  autofillDismiss: (): Promise<void> => invoke('autofill_dismiss'),

  /** Press Enter to submit the form after a successful fill (user opt-in). */
  autofillSetSubmit: (submit: boolean): Promise<void> => invoke('autofill_set_submit', { submit }),

  /** Replace the per-app denylist (process stems autofill must never offer in). */
  autofillSetDenylist: (denylist: string[]): Promise<void> =>
    invoke('autofill_set_denylist', { denylist }),

  /** Remember the chosen login for the detected target (adds the detection's
   *  association URI to the login's autofill URIs) so it matches next time. */
  autofillAssociate: (accountEmail: string, itemId: string, uri: string): Promise<void> =>
    invoke('autofill_associate', { accountEmail, itemId, uri }),
};
