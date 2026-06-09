/**
 * Fixtures for the in-page fake backend (see helpers/app.ts `installFakeBackend`).
 *
 * The agate frontend talks to Rust exclusively through the typed `invoke`
 * wrappers in `src/lib/ipc.ts`, routed through a swappable transport the e2e
 * seam (`window.__agateInvoke`) replaces — so every screen runs its real
 * reactive flow without a live Bitwarden vault. Everything here crosses the
 * WebDriver boundary, so keep it plain, JSON-serializable data.
 *
 * Model (post app-unlock redesign): one app password unlocks every connection.
 *   setup  → no app-unlock configured yet (AppUnlockSetup)
 *   unlock → configured but locked (Unlock — "unlock all")
 *   vault  → unlocked
 * Vault items/folders/details are scoped to an owning connection (accountEmail).
 */

export type Region = 'us' | 'eu' | 'selfHosted';
export type ServerConfig = { region: 'us' } | { region: 'eu' } | { region: 'selfHosted'; baseUrl: string };
export type ItemType = 'login' | 'secureNote' | 'card' | 'identity' | 'sshKey' | 'unknown';
export type TwoFactorKind = 'authenticator' | 'email';
export type LoginResult = { status: 'success' } | { status: 'twoFactorRequired'; providers: TwoFactorKind[] };

export interface FakeStatus {
  appUnlockConfigured: boolean;
  /** Optional in fixtures; the app treats an absent value as false. */
  unlockDeviceBound?: boolean;
  unlocked: boolean;
  helloConfigured: boolean;
  darkwebConsent: boolean;
  connectionCount: number;
  liveCount: number;
}

export interface ConnectionSummary {
  email: string;
  serverLabel: string;
  server: ServerConfig;
  unlocked: boolean;
  /** Optional in fixtures; the app treats an absent value as false (manual). */
  storeCredentials?: boolean;
}

export interface VaultItem {
  id: string;
  accountEmail: string;
  accountLabel: string;
  name: string;
  itemType: ItemType;
  username: string | null;
  hasTotp: boolean;
  favorite: boolean;
  deleted: boolean;
  folderId: string | null;
  organizationId: string | null;
}

export interface Folder {
  id: string | null;
  name: string;
  accountEmail: string;
  accountLabel: string;
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
  login: {
    username: string | null;
    password: string | null;
    totp: string | null;
    uris: { uri: string | null; matchType: number | null }[];
    hasTotp: boolean;
  } | null;
  card: unknown | null;
  identity: unknown | null;
  sshKey: unknown | null;
  fields: { name: string | null; value: string | null; fieldType: string }[];
  folderId: string | null;
  organizationId: string | null;
}

export interface VaultHealthReport {
  score: number;
  band: 'critical' | 'poor' | 'fair' | 'good' | 'excellent';
  totalLogins: number;
  reused: number;
  weak: number;
  old: number;
  insecure: number;
  noTotp: number;
  atRisk: unknown[];
}

/** The full config the fake router answers from. */
export interface FakeConfig {
  status: FakeStatus;
  server: ServerConfig;
  connections: ConnectionSummary[];
  items: VaultItem[];
  folders: Folder[];
  details: Record<string, ItemDetail>;
  totp: { code: string; period: number; remaining: number };
  /** When true, `unlock_all` reports the first connection as needing 2FA. */
  twoFactor: boolean;
  /** Result `add_connection` returns (success or twoFactorRequired). */
  addResult: LoginResult;
  helloAvailable: boolean;
  audit: VaultHealthReport;
  exposed: { id: string; name: string; count: number }[];
  generatedPassword: string;
  generatedPassphrase: string;
  updateVersion: string | null;
  /** Commands listed here reject with the given typed AgateError (toast path). */
  errors: Record<string, { kind: string; message: string }>;
}

export const FIXTURE_EMAIL = 'tester@example.com';
export const FIXTURE_LABEL = 'Bitwarden — US';

function item(p: Partial<VaultItem> & { id: string; name: string }): VaultItem {
  return {
    accountEmail: FIXTURE_EMAIL,
    accountLabel: FIXTURE_LABEL,
    itemType: 'login',
    username: null,
    hasTotp: false,
    favorite: false,
    deleted: false,
    folderId: null,
    organizationId: null,
    ...p,
  };
}

function loginDetail(p: Partial<ItemDetail> & { id: string; name: string }): ItemDetail {
  return {
    accountEmail: FIXTURE_EMAIL,
    accountLabel: FIXTURE_LABEL,
    itemType: 'login',
    favorite: false,
    reprompt: false,
    notes: null,
    login: { username: null, password: null, totp: null, uris: [], hasTotp: false },
    card: null,
    identity: null,
    sshKey: null,
    fields: [],
    folderId: null,
    organizationId: null,
    ...p,
  };
}

/** Favorite TOTP login, plain login, card, note, and one trashed item. */
export function sampleItems(): VaultItem[] {
  return [
    item({ id: 'gh', name: 'GitHub', username: 'octocat', hasTotp: true, favorite: true }),
    item({ id: 'mail', name: 'Fastmail', username: 'tester@fastmail.com' }),
    item({ id: 'card', name: 'Visa ending 4242', itemType: 'card' }),
    item({ id: 'note', name: 'Recovery codes', itemType: 'secureNote' }),
    item({ id: 'old', name: 'Old MySpace', username: 'tom', deleted: true }),
  ];
}

export function sampleDetails(): Record<string, ItemDetail> {
  return {
    gh: loginDetail({
      id: 'gh', name: 'GitHub', favorite: true, notes: 'work account',
      login: {
        username: 'octocat',
        password: 'correct-horse-battery-staple',
        totp: 'otpauth://totp/GitHub:octocat?secret=JBSWY3DPEHPK3PXP',
        uris: [{ uri: 'https://github.com', matchType: null }],
        hasTotp: true,
      },
    }),
    mail: loginDetail({
      id: 'mail', name: 'Fastmail',
      login: {
        username: 'tester@fastmail.com', password: 'hunter2hunter2', totp: null,
        uris: [{ uri: 'https://fastmail.com', matchType: null }], hasTotp: false,
      },
    }),
    card: loginDetail({ id: 'card', name: 'Visa ending 4242', itemType: 'card', login: null }),
    note: loginDetail({
      id: 'note', name: 'Recovery codes', itemType: 'secureNote', login: null, notes: 'AAAA-BBBB-CCCC',
    }),
    old: loginDetail({
      id: 'old', name: 'Old MySpace',
      login: { username: 'tom', password: 'pw', totp: null, uris: [], hasTotp: false },
    }),
  };
}

export function sampleConnections(): ConnectionSummary[] {
  return [
    {
      email: FIXTURE_EMAIL,
      serverLabel: FIXTURE_LABEL,
      server: { region: 'us' },
      unlocked: true,
      storeCredentials: true,
    },
  ];
}

function baseConfig(over: Partial<FakeConfig>): FakeConfig {
  return {
    status: {
      appUnlockConfigured: true, unlockDeviceBound: true, unlocked: true, helloConfigured: false,
      darkwebConsent: false, connectionCount: 1, liveCount: 1,
    },
    server: { region: 'us' },
    connections: sampleConnections(),
    items: sampleItems(),
    folders: [
      { id: null, name: 'No folder', accountEmail: FIXTURE_EMAIL, accountLabel: FIXTURE_LABEL },
      { id: 'f1', name: 'Personal', accountEmail: FIXTURE_EMAIL, accountLabel: FIXTURE_LABEL },
      { id: 'f2', name: 'Work', accountEmail: FIXTURE_EMAIL, accountLabel: FIXTURE_LABEL },
    ],
    details: sampleDetails(),
    totp: { code: '123456', period: 30, remaining: 25 },
    twoFactor: false,
    addResult: { status: 'success' },
    helloAvailable: false,
    audit: {
      score: 72, band: 'fair', totalLogins: 3, reused: 1, weak: 1, old: 0, insecure: 0, noTotp: 2, atRisk: [],
    },
    exposed: [{ id: 'mail', name: 'Fastmail', count: 1242 }],
    generatedPassword: 'Xq7!vPz2@Lm9',
    generatedPassphrase: 'amber-tractor-vivid-9',
    updateVersion: null,
    errors: {},
    ...over,
  };
}

/** First run — no app-unlock configured. Boots to AppUnlockSetup. */
export function setupFake(over: Partial<FakeConfig> = {}): FakeConfig {
  return baseConfig({
    status: {
      appUnlockConfigured: false, unlocked: false, helloConfigured: false,
      darkwebConsent: false, connectionCount: 0, liveCount: 0,
    },
    connections: [],
    items: [],
    ...over,
  });
}

/** Configured but locked. Boots to the Unlock ("unlock all") screen. */
export function lockedFake(over: Partial<FakeConfig> = {}): FakeConfig {
  return baseConfig({
    status: {
      appUnlockConfigured: true, unlocked: false, helloConfigured: false,
      darkwebConsent: false, connectionCount: 1, liveCount: 0,
    },
    connections: [{ email: FIXTURE_EMAIL, serverLabel: FIXTURE_LABEL, server: { region: 'us' }, unlocked: false }],
    ...over,
  });
}

/** Unlocked — boots straight into the vault. */
export function unlockedFake(over: Partial<FakeConfig> = {}): FakeConfig {
  return baseConfig(over);
}
