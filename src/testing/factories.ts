// Shared test-data factories — THE one place test objects get their shape.
// Used by unit tests AND the e2e fixtures, all typed against the real
// `lib/types.ts` interfaces, so adding a field to a DTO is a one-file change
// here instead of N stale copies (the drift that broke the e2e suite when
// `ItemDetail` grew passkeys/attachments).
//
// Defaults are deliberately neutral; a test that depends on specific values
// passes them explicitly (or keeps a thin local wrapper with its own defaults).

import type {
  ConnectionSummary,
  ItemAudit,
  ItemDetail,
  LoginDetail,
  SendSummary,
  VaultHealthReport,
  VaultItem,
} from '../lib/types.ts';

export function makeConnection(
  over: Partial<ConnectionSummary> & { email: string },
): ConnectionSummary {
  return {
    serverLabel: 'Test server',
    server: { region: 'us' },
    unlocked: true,
    storeCredentials: true,
    ...over,
  };
}

export function makeLoginDetail(over: Partial<LoginDetail> = {}): LoginDetail {
  return {
    username: null,
    password: null,
    totp: null,
    uris: [],
    hasTotp: false,
    passwordRevisionDate: null,
    autofillOnPageLoad: null,
    passwordHistory: [],
    ...over,
  };
}

export function makeItem(over: Partial<VaultItem> & { id: string; name: string }): VaultItem {
  return {
    accountEmail: 'tester@example.com',
    accountLabel: 'Test vault',
    itemType: 'login',
    username: null,
    uri: null,
    hasTotp: false,
    hasPasskey: false,
    reprompt: false,
    favorite: false,
    deleted: false,
    folderId: null,
    organizationId: null,
    ...over,
  };
}

export function makeDetail(over: Partial<ItemDetail> & { id: string; name: string }): ItemDetail {
  return {
    accountEmail: 'tester@example.com',
    accountLabel: 'Test vault',
    itemType: 'login',
    favorite: false,
    reprompt: false,
    notes: null,
    login: makeLoginDetail(),
    card: null,
    identity: null,
    sshKey: null,
    fields: [],
    folderId: null,
    organizationId: null,
    collectionIds: [],
    revisionDate: '2026-01-01T00:00:00Z',
    creationDate: '2026-01-01T00:00:00Z',
    attachments: [],
    passkeys: [],
    ...over,
  };
}

export function makeAudit(over: Partial<ItemAudit> = {}): ItemAudit {
  return {
    id: 'i1',
    name: 'Example',
    reused: false,
    weak: false,
    weakScore: null,
    old: false,
    insecureUri: false,
    noTotp: false,
    ...over,
  };
}

export function makeReport(
  atRisk: ItemAudit[] = [],
  over: Partial<VaultHealthReport> = {},
): VaultHealthReport {
  return {
    score: 100,
    band: 'excellent',
    totalLogins: atRisk.length,
    reused: 0,
    weak: 0,
    old: 0,
    insecure: 0,
    noTotp: 0,
    atRisk,
    ...over,
  };
}

export function makeSend(over: Partial<SendSummary> & { id: string; name: string }): SendSummary {
  return {
    sendType: 'text',
    disabled: false,
    hasPassword: false,
    accessCount: 0,
    maxAccessCount: null,
    deletionDate: '2026-07-01T00:00:00Z',
    expirationDate: null,
    accountEmail: 'tester@example.com',
    accountLabel: 'Test vault',
    ...over,
  };
}
