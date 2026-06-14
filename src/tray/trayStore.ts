// State for the tray quick-access popup: a thin session/item cache + the three
// copy actions (username / password / TOTP). Built as a FACTORY with injected
// deps (same pattern as createSecurityScans) — TrayApp constructs the production
// instance with the real ipc/clipboard; tests inject fakes.
//
// Security posture:
// - Reprompt ("require master password to view") items NEVER copy secrets here —
//   the reprompt gate lives in the main window, and its verification state is
//   per-webview, so the popup always defers to the full app (onRepromptBlocked).
// - The popup deliberately KEEPS its state (query, items, scroll, selection)
//   across hide/show — a user choice; the retained data is list metadata only
//   (names/usernames/uris, never passwords). It still fails closed: refresh()
//   runs on every show AND on the backend's `agate://session-changed`
//   broadcast (the pinned popup can be visible during a lock), dropping the
//   items the moment the session is locked.

import { createSignal } from 'solid-js';
import type { ipc as realIpc } from '../lib/ipc.ts';
import { hostOf } from '../state/favicons.ts';
import { FIELD_KIND_TO_INT, fieldStringToLabel } from '../lib/fieldKinds.ts';
import type {
  AutofillContext,
  AutofillPending,
  FieldInput,
  Folder,
  ItemDetail,
  ItemInput,
  UnlockOutcome,
  UriInput,
  VaultItem,
} from '../lib/types.ts';

/** Hard cap on rendered rows — the popup is a quick-access list, not a browser. */
export const TRAY_MAX_RESULTS = 50;

/** Exactly the IPC surface the popup touches — what tests fake. */
export type TrayIpc = Pick<
  typeof realIpc,
  | 'getSessionStatus'
  | 'listItems'
  | 'itemDetail'
  | 'itemTotp'
  | 'unlockAll'
  | 'helloUnlock'
  | 'autofillPending'
  | 'autofillFill'
  | 'autofillDismiss'
  | 'autofillAssociate'
  | 'listConnections'
  | 'listFolders'
  | 'generatePassword'
  | 'saveItem'
  | 'passwordInUse'
  | 'passwordStrength'
>;

/** A login the popup can fill into the detected target — the common shape of a
 *  ranked candidate and a search-fallback vault row. */
export interface FillTarget {
  accountEmail: string;
  itemId: string;
  reprompt: boolean;
}

/** The human label for the app/site a fill would land in: the window title, else
 *  the process name, else null when neither is known (callers substitute their
 *  own "the focused window" fallback). Shared so the fill header and the
 *  "remember here" toast name the same target. Pure. */
export function fillTargetLabel(context: AutofillContext | undefined): string | null {
  return context?.windowTitle || context?.processName || null;
}

/** A fill-mode row: a target plus the label fields the popup renders. */
export interface FillRow extends FillTarget {
  name: string;
  username: string | null;
}

// ── Fill-mode popup sizing (logical px) ─────────────────────────────────────
// The autofill picker is a compact chooser, not the full popup: it sizes to its
// candidates but never past FILL_MAX_ROWS — longer lists scroll.
const FILL_ROW_H = 42; // ~ one candidate row (name + username)
const FILL_CHROME_H = 48; // header + list padding + window borders
const FILL_NOT_FOUND_H = 120; // note + the "add login for this app" action
const FILL_MAX_ROWS = 3;

/** Window height for the autofill fill view given the candidate count. Pure. */
export function fillPopupHeight(count: number): number {
  if (count === 0) return FILL_NOT_FOUND_H;
  return FILL_CHROME_H + Math.min(count, FILL_MAX_ROWS) * FILL_ROW_H;
}

export interface TrayStoreDeps {
  ipc: TrayIpc;
  /** Secret-copy path (production: lib/clipboard.copyWithAutoClear). */
  copy: (label: string, value: string | null | undefined) => Promise<void>;
  /** A copy succeeded — the item counts as recently used. Feeds the main
   *  window's titlebar recents; the popup's own list order stays stable. */
  onUsed: (item: VaultItem) => void;
  onError: (err: unknown) => void;
  /** A copy / fill was blocked because the item requires a master-password
   *  reprompt. The item is passed for the copy path; the fill path omits it (a
   *  candidate isn't a full VaultItem) — production just shows a toast either way. */
  onRepromptBlocked: (item?: VaultItem) => void;
  /** Connections that still need 2FA after an unlock. The popup never runs the
   *  2FA flow itself (same deferral as reprompt) — the user finishes these in
   *  the main window. */
  onTwoFactorPending: (emails: string[]) => void;
  /** A "remember this login here" association succeeded — production shows a
   *  success toast naming the target (the window title / process, else a generic
   *  label). */
  onAssociated: (targetLabel: string | null) => void;
}

/** Map a key event to the copy action it requests (the popup's Enter chords):
 *  Enter = password, Shift+Enter = username, Ctrl/Cmd+Enter = TOTP. */
export type TrayCopyAction = 'password' | 'username' | 'totp';
export function copyActionForKey(
  e: Pick<KeyboardEvent, 'key' | 'shiftKey' | 'ctrlKey' | 'metaKey'>,
): TrayCopyAction | null {
  if (e.key !== 'Enter') return null;
  if (e.ctrlKey || e.metaKey) return 'totp';
  if (e.shiftKey) return 'username';
  return 'password';
}

/** Filter + rank the unified list for the popup: drop trashed items, match the
 *  query against name/username/uri, and order by match quality (name prefix >
 *  name substring > username/uri), favorites and name breaking ties. The order
 *  is deliberately STABLE — no recency ranking, because rows that jump right
 *  after a copy made the list unusable (user feedback). */
export function filterTrayItems(items: VaultItem[], query: string): VaultItem[] {
  const q = query.trim().toLowerCase();

  // Lower rank sorts first; null = no match at all.
  const rank = (it: VaultItem): number | null => {
    if (!q) return 0;
    const name = it.name.toLowerCase();
    if (name.startsWith(q)) return 0;
    if (name.includes(q)) return 1;
    if (it.username?.toLowerCase().includes(q) || it.uri?.toLowerCase().includes(q)) return 2;
    return null;
  };

  return items
    .filter((it) => !it.deleted)
    .map((it) => ({ it, r: rank(it) }))
    .filter((e): e is { it: VaultItem; r: number } => e.r !== null)
    .sort(
      (a, b) =>
        a.r - b.r ||
        Number(b.it.favorite) - Number(a.it.favorite) ||
        a.it.name.localeCompare(b.it.name),
    )
    .slice(0, TRAY_MAX_RESULTS)
    .map((e) => e.it);
}

/** The add-form's draft login. */
export interface AddDraft {
  name: string;
  username: string;
  password: string;
  uri: string;
}

const EMPTY_DRAFT: AddDraft = { name: '', username: '', password: '', uri: '' };

/** Generator options for the add-form's one-click password (same defaults as
 *  the main Generator page). */
const ADD_GEN_OPTIONS = {
  length: 16,
  uppercase: true,
  lowercase: true,
  numbers: true,
  special: true,
  avoidAmbiguous: false,
};

/** Build a lossless EDIT payload for a LOGIN from its current detail. The compact
 *  popup form exposes only four fields (name / username / password / first URI);
 *  this overrides exactly those and carries everything else through unchanged —
 *  TOTP, notes, custom fields, extra URIs, org, favorite, reprompt,
 *  autofill-on-load — so a quick edit never silently wipes the richer data the
 *  main editor owns. The destination `folderId` is explicit (the form's folder
 *  picker owns it); pass `original.folderId` to keep the item where it is. Only
 *  logins are editable here, so non-login payloads are null on a login detail and
 *  stay that way. Pure, unit-tested. */
export function buildEditInput(
  original: ItemDetail,
  draft: AddDraft,
  folderId: string | null,
): ItemInput {
  const login = original.login;
  const restUris: UriInput[] = (login?.uris ?? [])
    .slice(1)
    .map((u) => ({ uri: u.uri, matchType: u.matchType }));
  const firstUri = draft.uri.trim();
  // Replace the first URI in place (keeping its match type) when one is given;
  // an emptied field drops just the first URI, never the rest.
  const uris: UriInput[] = firstUri
    ? [{ uri: firstUri, matchType: login?.uris[0]?.matchType ?? null }, ...restUris]
    : restUris;
  // CustomField.fieldType is a lowercase string on the read side; map it back to
  // the FieldInput int code (Number('hidden') would be NaN → silent data loss).
  const fields: FieldInput[] = original.fields.map((f) => ({
    name: f.name,
    value: f.value,
    fieldType: FIELD_KIND_TO_INT[fieldStringToLabel(f.fieldType)],
    linkedId: f.linkedId,
  }));
  return {
    id: original.id,
    itemType: 'login',
    name: draft.name.trim(),
    folderId,
    organizationId: original.organizationId,
    favorite: original.favorite,
    reprompt: original.reprompt,
    notes: original.notes,
    login: {
      username: draft.username.trim() || null,
      password: draft.password || null,
      totp: login?.totp ?? null,
      uris,
      autofillOnPageLoad: login?.autofillOnPageLoad ?? null,
    },
    card: original.card,
    identity: original.identity,
    sshKey: original.sshKey,
    fields,
  };
}

/** Existing logins that look like the draft — same website host (strongest),
 *  exact name, or a name containing/contained by the draft's (fragments under
 *  3 chars are ignored as noise). Top 3, host matches first. Powers the
 *  add-form's "you may already have this" callout. Pure, unit-tested. */
export function findSimilarLogins(
  items: VaultItem[],
  draft: { name: string; uri: string },
): VaultItem[] {
  const host = hostOf(draft.uri);
  const name = draft.name.trim().toLowerCase();

  const score = (it: VaultItem): number | null => {
    if (it.deleted || it.itemType !== 'login') return null;
    let s = 0;
    if (host && hostOf(it.uri) === host) s += 4;
    const n = it.name.trim().toLowerCase();
    if (name && n === name) s += 2;
    else if (name.length >= 3 && n.length >= 3 && (n.includes(name) || name.includes(n))) s += 1;
    return s > 0 ? s : null;
  };

  return items
    .map((it) => ({ it, s: score(it) }))
    .filter((e): e is { it: VaultItem; s: number } => e.s !== null)
    .sort((a, b) => b.s - a.s || a.it.name.localeCompare(b.it.name))
    .slice(0, 3)
    .map((e) => e.it);
}

/** A human login name guessed from a website/URI for the add-form: the
 *  registrable label, capitalized — `https://login.github.com/x` → "Github",
 *  `app://outlook` (an autofill app-association URI) → "Outlook". Empty string
 *  when nothing usable. Pure. */
export function loginNameFromUri(uri: string): string {
  const raw = uri.trim();
  if (!raw) return '';
  // Drop the scheme, then keep only the authority up to the first path/query.
  const host = raw
    .replace(/^[a-z][a-z0-9+.-]*:\/\//i, '')
    .split(/[/?#]/)[0]
    .toLowerCase();
  if (!host) return '';
  const labels = host.split('.').filter(Boolean);
  if (labels[0] === 'www') labels.shift();
  // The registrable label: second-to-last when there's a TLD, else the only one.
  const label = labels.length >= 2 ? labels[labels.length - 2] : labels[0];
  if (!label) return '';
  return label.charAt(0).toUpperCase() + label.slice(1);
}

/** Seed an add-login draft from a detected autofill target: the website is the
 *  real URL when the field exposed one, else the synthetic `app://<process>`
 *  association so the saved login matches this app next time (per the
 *  AutofillContext docs). The name is guessed from that URI, falling back to the
 *  process name. Only the fields we can fill are returned. Pure. */
export function draftFromContext(ctx: AutofillContext | null | undefined): Partial<AddDraft> {
  if (!ctx) return {};
  const uri = (ctx.url || ctx.associateUri || '').trim();
  const name = loginNameFromUri(uri) || (ctx.processName ?? '').trim();
  const patch: Partial<AddDraft> = {};
  if (name) patch.name = name;
  if (uri) patch.uri = uri;
  return patch;
}

/** Whether two list entries are field-for-field identical (VaultItem is a flat
 *  all-primitive shape, so shallow comparison is exact). */
function sameItem(a: VaultItem, b: VaultItem): boolean {
  const keys = new Set([...Object.keys(a), ...Object.keys(b)]) as Set<keyof VaultItem>;
  for (const k of keys) {
    if (a[k] !== b[k]) return false;
  }
  return true;
}

/** Adopt the fresh list but keep the previous object for every unchanged item,
 *  so <For> reuses its DOM rows and the list's scroll position survives the
 *  refresh-on-show. */
function reconcileById(prev: VaultItem[], next: VaultItem[]): VaultItem[] {
  const byId = new Map(prev.map((i) => [i.id, i]));
  return next.map((n) => {
    const old = byId.get(n.id);
    return old && sameItem(old, n) ? old : n;
  });
}

export function createTrayStore(deps: TrayStoreDeps) {
  const [ready, setReady] = createSignal(false);
  const [unlocked, setUnlocked] = createSignal(false);
  const [appUnlockConfigured, setAppUnlockConfigured] = createSignal(false);
  const [helloConfigured, setHelloConfigured] = createSignal(false);
  const [unlocking, setUnlocking] = createSignal(false);
  const [items, setItems] = createSignal<VaultItem[]>([]);
  const [query, setQuery] = createSignal('');
  // Autofill fill-mode: a detection in another app is awaiting a pick. `pending`
  // carries the one-shot token + the detected context + ranked candidates.
  const [fillMode, setFillMode] = createSignal(false);
  const [pending, setPending] = createSignal<AutofillPending | null>(null);
  const [filling, setFilling] = createSignal(false);

  /** Re-read session + items. Called on mount and every time the popup shows,
   *  so a lock/sync in the main window is reflected on the next open. The query
   *  is never touched here — popup state survives open/close on purpose. */
  async function refresh(): Promise<void> {
    try {
      const status = await deps.ipc.getSessionStatus();
      setUnlocked(status.unlocked);
      setAppUnlockConfigured(status.appUnlockConfigured);
      setHelloConfigured(status.helloConfigured);
      const fresh = status.unlocked ? await deps.ipc.listItems() : [];
      setItems((prev) => reconcileById(prev, fresh));
    } catch (err) {
      // Treat an unreadable session as locked — the popup must fail closed.
      // The configured flags keep their last value: they only pick which
      // locked view renders, and an unlock attempt would surface the error.
      setUnlocked(false);
      setItems([]);
      deps.onError(err);
    } finally {
      setReady(true);
    }
  }

  /** Shared tail of both unlock paths: surface per-connection failures, flag
   *  2FA-pending connections, then re-read session + items. */
  async function applyOutcomes(outcomes: UnlockOutcome[]): Promise<void> {
    for (const o of outcomes) {
      if (o.status === 'failed') deps.onError(new Error(`${o.email}: ${o.message}`));
    }
    const pending = outcomes.filter((o) => o.status === 'twoFactorRequired').map((o) => o.email);
    if (pending.length > 0) deps.onTwoFactorPending(pending);
    await refresh();
  }

  /** Unlock every connection with the app password. Resolves true when the
   *  call went through (so the form can clear the field) — a wrong password
   *  rejects the whole call (failed GCM tag) and resolves false. */
  async function unlock(appPassword: string): Promise<boolean> {
    if (!appPassword) return false;
    setUnlocking(true);
    try {
      await applyOutcomes(await deps.ipc.unlockAll(appPassword));
      return true;
    } catch (err) {
      deps.onError(err);
      return false;
    } finally {
      setUnlocking(false);
    }
  }

  /** Unlock every connection via the platform consent gate (Windows Hello). */
  async function unlockHello(): Promise<void> {
    setUnlocking(true);
    try {
      await applyOutcomes(await deps.ipc.helloUnlock());
    } catch (err) {
      deps.onError(err);
    } finally {
      setUnlocking(false);
    }
  }

  const filtered = () => filterTrayItems(items(), query());

  /** More than one connection in the list — rows then show an account dot. */
  const multiAccount = () => new Set(items().map((i) => i.accountEmail)).size > 1;

  /** False (and defers to the full app) when the item is reprompt-protected. */
  function passReprompt(item: VaultItem): boolean {
    if (!item.reprompt) return true;
    deps.onRepromptBlocked(item);
    return false;
  }

  async function copyUsername(item: VaultItem): Promise<void> {
    await deps.copy('Username', item.username);
    if (item.username) deps.onUsed(item);
  }

  async function copyPassword(item: VaultItem): Promise<void> {
    if (!passReprompt(item)) return;
    try {
      const detail = await deps.ipc.itemDetail(item.accountEmail, item.id);
      await deps.copy('Password', detail.login?.password);
      deps.onUsed(item);
    } catch (err) {
      deps.onError(err);
    }
  }

  async function copyTotp(item: VaultItem): Promise<void> {
    if (!passReprompt(item)) return;
    try {
      const totp = await deps.ipc.itemTotp(item.accountEmail, item.id);
      await deps.copy('TOTP code', totp.code);
      deps.onUsed(item);
    } catch (err) {
      deps.onError(err);
    }
  }

  // ── Autofill fill-mode ──────────────────────────────────────────────────────

  /** Reconcile fill mode with the backend, which is the single source of truth
   *  for "is a detection awaiting a pick". Called on every show/focus and on the
   *  `autofill://detected` event (and after an unlock, so candidates are computed
   *  against the now-unlocked vault). The tray-icon open path clears the backend
   *  pending, so a normal open reconciles to off here. A fresh detection resets the
   *  query so the candidate list — not a stale search — shows first. */
  async function syncFill(): Promise<void> {
    try {
      const p = await deps.ipc.autofillPending();
      const wasOff = !fillMode();
      setPending(p);
      setFillMode(p !== null);
      if (p && wasOff) setQuery('');
    } catch (err) {
      deps.onError(err);
      setFillMode(false);
      setPending(null);
    }
  }

  /** Leave fill mode and tell the backend to drop the detection (popup dismissed
   *  or Escape). */
  function exitFill(): void {
    setFillMode(false);
    setPending(null);
    void deps.ipc.autofillDismiss().catch(deps.onError);
  }

  /** Fill the chosen login into the detected target. Reprompt-protected items are
   *  deferred to the main window (never filled here), mirroring the copy path. */
  async function fill(target: FillTarget): Promise<void> {
    const p = pending();
    if (!p) return;
    if (target.reprompt) {
      deps.onRepromptBlocked();
      return;
    }
    setFilling(true);
    try {
      await deps.ipc.autofillFill(p.token, target.accountEmail, target.itemId);
      // The backend hides the popup on success; just leave fill mode locally.
      setFillMode(false);
      setPending(null);
    } catch (err) {
      deps.onError(err);
    } finally {
      setFilling(false);
    }
  }

  /** "Use here": remember THIS login for THIS detected app/site so it matches
   *  next time. Adds the detection's association URI to the login's autofill
   *  URIs, then re-syncs so the now-matching login shows as a candidate. A no-op
   *  when the detection exposed no association URI (the affordance is hidden in
   *  that case, but guard defensively). Does NOT fill. */
  async function associate(target: FillTarget): Promise<void> {
    const p = pending();
    const uri = p?.context.associateUri;
    if (!uri) return;
    try {
      await deps.ipc.autofillAssociate(target.accountEmail, target.itemId, uri);
      deps.onAssociated(fillTargetLabel(p?.context));
      await syncFill();
    } catch (err) {
      deps.onError(err);
    }
  }

  // ── Add-login form ──────────────────────────────────────────────────────────

  const [addMode, setAddMode] = createSignal(false);
  // The item being edited (its full detail), or null when the form is a fresh
  // "add". Drives the edit-vs-create branch in save() and the form's labels.
  const [editing, setEditing] = createSignal<ItemDetail | null>(null);
  const [draft, setDraftSignal] = createSignal<AddDraft>(EMPTY_DRAFT);
  const [account, setAccountSignal] = createSignal('');
  const [accounts, setAccounts] = createSignal<string[]>([]);
  // Destination folder/group for the new (or moved) item, scoped to `account`.
  // null = the vault root ("no folder"). Folders are per-connection, so every
  // unlocked vault's folders are loaded together and filtered by account below.
  const [folders, setFolders] = createSignal<Folder[]>([]);
  const [folderId, setFolderId] = createSignal<string | null>(null);
  const [saving, setSaving] = createSignal(false);
  const [reuseCount, setReuseCount] = createSignal(0);
  // zxcvbn strength of the draft password (0–4), null when the field is empty.
  const [strength, setStrength] = createSignal<number | null>(null);

  /** Folders (Bitwarden) / groups (KeePass) of the selected destination vault,
   *  name-sorted — the form's "store in" options. A folder id is account-scoped,
   *  so this MUST follow `account()`. */
  const folderOptions = (): Folder[] =>
    folders()
      .filter((f) => f.accountEmail === account() && f.id != null)
      .sort((a, b) => a.name.localeCompare(b.name));

  /** Pick the destination vault. Folder ids are per-vault, so switching vaults
   *  drops any chosen folder back to the root — an id from the old vault would be
   *  meaningless (or, worse, a real folder) in the new one. */
  function setAccount(email: string): void {
    setAccountSignal(email);
    setFolderId(null);
  }

  function setDraft(patch: Partial<AddDraft>): void {
    setDraftSignal((d) => ({ ...d, ...patch }));
  }

  /** Load every unlocked vault's folders for the form's picker. Advisory: a
   *  failure leaves the picker empty (root only), never blocks the form. */
  async function loadFolders(): Promise<void> {
    try {
      setFolders(await deps.ipc.listFolders());
    } catch (err) {
      setFolders([]);
      deps.onError(err);
    }
  }

  /** Open the add form. Default prefill is the name from the current query (the
   *  user was probably searching for the thing that doesn't exist yet); callers
   *  can override with a richer `prefill` — e.g. `draftFromContext` when the
   *  form is opened from a detected-but-unmatched autofill target. */
  async function enterAdd(prefill?: Partial<AddDraft>): Promise<void> {
    setEditing(null);
    setDraftSignal({ ...EMPTY_DRAFT, name: query().trim(), ...prefill });
    setReuseCount(0);
    setStrength(null);
    setFolders([]);
    setAddMode(true);
    try {
      const cons = await deps.ipc.listConnections();
      const emails = cons.filter((c) => c.unlocked).map((c) => c.email);
      setAccounts(emails);
      setAccount(emails[0] ?? '');
    } catch (err) {
      deps.onError(err);
      setAccounts([]);
      setAccount('');
    }
    await loadFolders();
  }

  /** Open the form to EDIT an existing login: fetch its detail, seed the draft
   *  from it, and pin the account to the item's owner (no account picker on an
   *  edit). Only logins are editable in the compact form — other types, and
   *  reprompt-protected items (the popup never bypasses the master-password
   *  gate, same as the copy path), defer to the main window. */
  async function enterEdit(item: VaultItem): Promise<void> {
    if (item.itemType !== 'login') return;
    if (!passReprompt(item)) return;
    try {
      const detail = await deps.ipc.itemDetail(item.accountEmail, item.id);
      setEditing(detail);
      setDraftSignal({
        name: detail.name,
        username: detail.login?.username ?? '',
        password: detail.login?.password ?? '',
        uri: detail.login?.uris[0]?.uri ?? '',
      });
      setAccounts([item.accountEmail]);
      setAccount(item.accountEmail);
      setFolders([]);
      setReuseCount(0);
      setStrength(null);
      setAddMode(true);
      await loadFolders();
      // After setAccount cleared it, restore the item's current folder so the
      // picker opens on where the item lives (and an unchanged save keeps it).
      setFolderId(detail.folderId);
    } catch (err) {
      deps.onError(err);
    }
  }

  function exitAdd(): void {
    setAddMode(false);
    setEditing(null);
    setDraftSignal(EMPTY_DRAFT);
    setFolders([]);
    setFolderId(null);
    setReuseCount(0);
    setStrength(null);
  }

  /** One-click password from the generator into the draft. */
  async function generateDraftPassword(): Promise<void> {
    try {
      setDraft({ password: await deps.ipc.generatePassword(ADD_GEN_OPTIONS) });
    } catch (err) {
      deps.onError(err);
    }
  }

  /** Existing logins resembling the draft (host / name) — the dedupe callout. */
  const similar = () => findSimilarLogins(items(), draft());

  /** Ask the backend for the draft password's hygiene: how many logins already
   *  use it (count only — plaintext never comes back) and its zxcvbn strength.
   *  Both are advisory and computed independently, so one failing doesn't void
   *  the other. The caller debounces. */
  async function checkReuse(): Promise<void> {
    const d = draft();
    const pw = d.password;
    if (!pw) {
      setReuseCount(0);
      setStrength(null);
      return;
    }
    try {
      setReuseCount(await deps.ipc.passwordInUse(pw));
    } catch (err) {
      // Reuse info is advisory — never block the form on it.
      setReuseCount(0);
      deps.onError(err);
    }
    try {
      // The non-secret draft fields seed zxcvbn so e.g. password==username
      // scores at the floor, matching the offline audit.
      const context = [d.username, d.uri, d.name].filter((s) => s.trim().length > 0);
      setStrength(await deps.ipc.passwordStrength(pw, context));
    } catch (err) {
      setStrength(null);
      deps.onError(err);
    }
  }

  /** Create the login on the selected account, refresh, close the form. */
  async function saveNew(): Promise<boolean> {
    const d = draft();
    const name = d.name.trim();
    if (!name || !account()) return false;
    const input: ItemInput = {
      id: null,
      itemType: 'login',
      name,
      folderId: folderId(),
      organizationId: null,
      favorite: false,
      reprompt: false,
      notes: null,
      login: {
        username: d.username.trim() || null,
        password: d.password || null,
        totp: null,
        uris: d.uri.trim() ? [{ uri: d.uri.trim(), matchType: null }] : [],
        autofillOnPageLoad: null,
      },
      card: null,
      identity: null,
      sshKey: null,
      fields: [],
    };
    setSaving(true);
    try {
      await deps.ipc.saveItem(account(), input);
      await refresh();
      exitAdd();
      return true;
    } catch (err) {
      deps.onError(err);
      return false;
    } finally {
      setSaving(false);
    }
  }

  /** Persist edits to the login currently being edited, preserving every field
   *  the compact form can't touch (see buildEditInput). Writes back to the
   *  item's owning account, then refreshes and closes the form. */
  async function saveEdit(): Promise<boolean> {
    const original = editing();
    const d = draft();
    if (!original || !d.name.trim()) return false;
    setSaving(true);
    try {
      await deps.ipc.saveItem(original.accountEmail, buildEditInput(original, d, folderId()));
      await refresh();
      exitAdd();
      return true;
    } catch (err) {
      deps.onError(err);
      return false;
    } finally {
      setSaving(false);
    }
  }

  /** Submit the form: route to the edit or create path by whether an item is
   *  being edited. The single entry point the view calls. */
  function save(): Promise<boolean> {
    return editing() ? saveEdit() : saveNew();
  }

  /** The fill-mode rows: the ranked candidates for the detected target. Empty when
   *  nothing matched — the popup then shows a brief "no password found" message
   *  rather than the full vault. */
  function fillRows(): FillRow[] {
    return (pending()?.candidates ?? []).map((c) => ({
      accountEmail: c.accountEmail,
      itemId: c.itemId,
      reprompt: c.reprompt,
      name: c.name,
      username: c.username,
    }));
  }

  return {
    ready,
    unlocked,
    appUnlockConfigured,
    helloConfigured,
    unlocking,
    query,
    setQuery,
    filtered,
    multiAccount,
    refresh,
    unlock,
    unlockHello,
    copyUsername,
    copyPassword,
    copyTotp,
    // autofill fill-mode
    fillMode,
    pending,
    filling,
    syncFill,
    exitFill,
    fill,
    associate,
    fillRows,
    // add / edit form
    addMode,
    editing,
    draft,
    setDraft,
    account,
    setAccount,
    accounts,
    folderOptions,
    folderId,
    setFolderId,
    saving,
    reuseCount,
    strength,
    enterAdd,
    enterEdit,
    exitAdd,
    generateDraftPassword,
    similar,
    checkReuse,
    saveNew,
    saveEdit,
    save,
  };
}

export type TrayStore = ReturnType<typeof createTrayStore>;
