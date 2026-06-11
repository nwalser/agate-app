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

// The REAL app types + shared factories — type-only imports vanish at runtime,
// so everything still crosses the WebDriver boundary as plain JSON. Typing the
// fixtures with the app's own interfaces is what keeps them from rotting when
// a DTO grows a field (the drift that broke five specs at once).
import type {
  ConnectionSummary,
  Folder,
  ItemDetail,
  LoginResult,
  ServerConfig,
  SessionStatus,
  VaultHealthReport,
  VaultItem,
} from '../../../src/lib/types.ts';
import { makeDetail, makeItem } from '../../../src/testing/factories.ts';

export type { ConnectionSummary, Folder, ItemDetail, ServerConfig, VaultHealthReport, VaultItem };
export type Region = 'us' | 'eu' | 'selfHosted';
export type FakeStatus = SessionStatus;

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

// Thin wrappers over the SHARED factories (src/testing/factories.ts) so the
// object shape lives in exactly one place; only the e2e defaults live here.
function item(p: Partial<VaultItem> & { id: string; name: string }): VaultItem {
  return makeItem({ accountEmail: FIXTURE_EMAIL, accountLabel: FIXTURE_LABEL, ...p });
}

function loginDetail(p: Partial<ItemDetail> & { id: string; name: string }): ItemDetail {
  return makeDetail({ accountEmail: FIXTURE_EMAIL, accountLabel: FIXTURE_LABEL, ...p });
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
        passwordRevisionDate: null,
        autofillOnPageLoad: null,
        passwordHistory: [],
      },
    }),
    mail: loginDetail({
      id: 'mail', name: 'Fastmail',
      login: {
        username: 'tester@fastmail.com', password: 'hunter2hunter2', totp: null,
        uris: [{ uri: 'https://fastmail.com', matchType: null }], hasTotp: false,
        passwordRevisionDate: null, autofillOnPageLoad: null, passwordHistory: [],
      },
    }),
    card: loginDetail({ id: 'card', name: 'Visa ending 4242', itemType: 'card', login: null }),
    note: loginDetail({
      id: 'note', name: 'Recovery codes', itemType: 'secureNote', login: null, notes: 'AAAA-BBBB-CCCC',
    }),
    old: loginDetail({
      id: 'old', name: 'Old MySpace',
      login: {
        username: 'tom', password: 'pw', totp: null, uris: [], hasTotp: false,
        passwordRevisionDate: null, autofillOnPageLoad: null, passwordHistory: [],
      },
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
      appUnlockConfigured: true, unlocked: true, helloConfigured: false,
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
    connections: [
      {
        email: FIXTURE_EMAIL,
        serverLabel: FIXTURE_LABEL,
        server: { region: 'us' },
        unlocked: false,
        storeCredentials: true,
      },
    ],
    ...over,
  });
}

/** Unlocked — boots straight into the vault. */
export function unlockedFake(over: Partial<FakeConfig> = {}): FakeConfig {
  return baseConfig(over);
}
