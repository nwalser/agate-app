/**
 * Fixtures for the in-page fake backend (see helpers/app.ts `installFakeBackend`).
 *
 * The agate frontend talks to Rust exclusively through the typed `invoke`
 * wrappers in `src/lib/ipc.ts`. Those route through a swappable transport that
 * the e2e seam (`window.__agateInvoke`) lets us replace, so every screen can be
 * driven through its real reactive flow without a live Bitwarden vault. This
 * file holds the JSON-serializable config that the fake router answers from —
 * everything here crosses the WebDriver boundary, so keep it plain data.
 *
 * Shapes mirror `src/lib/types.ts`; kept as local interfaces (not imported) so
 * the e2e tsconfig stays independent of the app's bundler-resolution setup.
 */

export type Region = 'us' | 'eu' | 'selfHosted';
export type ServerConfig = { region: 'us' } | { region: 'eu' } | { region: 'selfHosted'; baseUrl: string };
export type ItemType = 'login' | 'secureNote' | 'card' | 'identity' | 'sshKey' | 'unknown';
export type TwoFactorKind = 'authenticator' | 'email';
export type LoginResult = { status: 'success' } | { status: 'twoFactorRequired'; providers: TwoFactorKind[] };

export interface FakeStatus {
  loggedIn: boolean;
  unlocked: boolean;
  localUnlockConfigured: boolean;
  helloConfigured: boolean;
  darkwebConsent: boolean;
  email: string | null;
}

export interface VaultItem {
  id: string;
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
}

export interface AccountSummary {
  email: string;
  serverLabel: string;
  server: ServerConfig;
  active: boolean;
}

export interface ItemDetail {
  id: string;
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
  accounts: AccountSummary[];
  items: VaultItem[];
  folders: Folder[];
  details: Record<string, ItemDetail>;
  totp: { code: string; period: number; remaining: number };
  /** Result `login` returns — set to twoFactorRequired to exercise the 2FA step. */
  loginResult: LoginResult;
  helloAvailable: boolean;
  audit: VaultHealthReport;
  exposed: { id: string; name: string; count: number }[];
  generatedPassword: string;
  generatedPassphrase: string;
  updateVersion: string | null;
  /** Commands listed here reject with the given typed AgateError (drives the
   *  toast pipeline) instead of returning — used by error-path specs. */
  errors: Record<string, { kind: string; message: string }>;
}

const LOGGED_OUT: FakeStatus = {
  loggedIn: false,
  unlocked: false,
  localUnlockConfigured: false,
  helloConfigured: false,
  darkwebConsent: false,
  email: null,
};

function item(p: Partial<VaultItem> & { id: string; name: string }): VaultItem {
  return {
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

export const FIXTURE_EMAIL = 'tester@example.com';

/** A small but representative vault: favorite TOTP login, plain login, card,
 *  note, and one trashed item — enough to exercise list / search / filters /
 *  detail / copy / TOTP / trash. */
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
      id: 'gh',
      name: 'GitHub',
      favorite: true,
      notes: 'work account',
      login: {
        username: 'octocat',
        password: 'correct-horse-battery-staple',
        totp: 'otpauth://totp/GitHub:octocat?secret=JBSWY3DPEHPK3PXP',
        uris: [{ uri: 'https://github.com', matchType: null }],
        hasTotp: true,
      },
    }),
    mail: loginDetail({
      id: 'mail',
      name: 'Fastmail',
      login: {
        username: 'tester@fastmail.com',
        password: 'hunter2hunter2',
        totp: null,
        uris: [{ uri: 'https://fastmail.com', matchType: null }],
        hasTotp: false,
      },
    }),
    card: loginDetail({ id: 'card', name: 'Visa ending 4242', itemType: 'card', login: null }),
    note: loginDetail({
      id: 'note',
      name: 'Recovery codes',
      itemType: 'secureNote',
      login: null,
      notes: 'AAAA-BBBB-CCCC',
    }),
    old: loginDetail({
      id: 'old',
      name: 'Old MySpace',
      login: { username: 'tom', password: 'pw', totp: null, uris: [], hasTotp: false },
    }),
  };
}

/** Logged-out config — the app boots straight to Onboarding from this. */
export function loggedOutFake(over: Partial<FakeConfig> = {}): FakeConfig {
  return {
    status: { ...LOGGED_OUT },
    server: { region: 'us' },
    accounts: [],
    items: sampleItems(),
    folders: [{ id: null, name: 'No folder' }, { id: 'f1', name: 'Personal' }, { id: 'f2', name: 'Work' }],
    details: sampleDetails(),
    totp: { code: '123456', period: 30, remaining: 25 },
    loginResult: { status: 'success' },
    helloAvailable: false,
    audit: {
      score: 72, band: 'fair', totalLogins: 3, reused: 1, weak: 1, old: 0, insecure: 0, noTotp: 2, atRisk: [],
    },
    exposed: [{ id: 'mail', name: 'Fastmail', count: 1242 }],
    generatedPassword: 'Xq7!vPz2@Lm9',
    generatedPassphrase: 'amber-tractor-vivid-9',
    updateVersion: null,
    ...over,
  };
}

/** Config where the app boots straight into an unlocked Vault. */
export function unlockedFake(over: Partial<FakeConfig> = {}): FakeConfig {
  return loggedOutFake({
    status: {
      loggedIn: true, unlocked: true, localUnlockConfigured: true, helloConfigured: false,
      darkwebConsent: false, email: FIXTURE_EMAIL,
    },
    accounts: [
      { email: FIXTURE_EMAIL, serverLabel: 'Bitwarden — US', server: { region: 'us' }, active: true },
    ],
    ...over,
  });
}

/** Config where the app boots into the locked Unlock screen (local unlock set). */
export function lockedFake(over: Partial<FakeConfig> = {}): FakeConfig {
  return unlockedFake({
    status: {
      loggedIn: true, unlocked: false, localUnlockConfigured: true, helloConfigured: false,
      darkwebConsent: false, email: FIXTURE_EMAIL,
    },
    ...over,
  });
}
