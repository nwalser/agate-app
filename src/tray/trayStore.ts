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
  Collection,
  ConnectionKind,
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
  | 'listCollections'
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
  /** The login carries a TOTP secret. After a username/password fill, its current
   *  code is copied to the clipboard so the user can paste it on the (usually later)
   *  one-time-code step. Optional: omit (falsy) for targets with no TOTP. */
  hasTotp?: boolean;
}

/** The human label for the app/site a fill would land in: the window title, else
 *  the process name, else null when neither is known (callers substitute their
 *  own "the focused window" fallback). Shared so the fill header and the
 *  "remember here" toast name the same target. Pure. */
export function fillTargetLabel(context: AutofillContext | undefined): string | null {
  return context?.windowTitle || context?.processName || null;
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
  /** The user's pinned default destination vault (a connection id), or '' for
   *  none. The add form preselects it when it's an available destination, else
   *  falls back to the first writable connection. Reactive accessor (production:
   *  state/defaultAccount). */
  defaultAccount: () => string;
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

/** Filter + rank the unified list for the popup: show the live items (or, in
 *  trash mode, only the trashed ones), match the query against name/username/uri,
 *  and order by match quality (name prefix > name substring > username/uri),
 *  favorites and name breaking ties. The order is deliberately STABLE — no
 *  recency ranking, because rows that jump right after a copy made the list
 *  unusable (user feedback). */
export function filterTrayItems(
  items: VaultItem[],
  query: string,
  showTrash = false,
): VaultItem[] {
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
    .filter((it) => (showTrash ? it.deleted : !it.deleted))
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

/** The add/edit-form's draft login. The form now owns every field common to both
 *  writable providers (Bitwarden + KeePass): the four quick-capture fields plus
 *  TOTP, notes, and the favorite/reprompt flags. `reprompt` is a Bitwarden-only
 *  abstraction (KeePass has no per-item master-password gate) — the view hides its
 *  toggle for KeePass, and the KeePass provider ignores the flag on write. */
export interface AddDraft {
  name: string;
  username: string;
  password: string;
  uri: string;
  totp: string;
  notes: string;
  favorite: boolean;
  reprompt: boolean;
}

const EMPTY_DRAFT: AddDraft = {
  name: '',
  username: '',
  password: '',
  uri: '',
  totp: '',
  notes: '',
  favorite: false,
  reprompt: false,
};

/** The writable providers: only these can back a created/edited item, so only
 *  these appear in the create form's destination picker. pass / Enpass / Proton
 *  are read-only in Agate (see `mutate::route_for`). */
export function isWritableKind(kind: ConnectionKind): boolean {
  return kind === 'bitwarden' || kind === 'keepass';
}

/** Last path segment of a file path (either separator). */
function fileNameOf(path: string): string {
  const i = Math.max(path.lastIndexOf('/'), path.lastIndexOf('\\'));
  return i >= 0 ? path.slice(i + 1) : path;
}

/** A connection's underlying identity for display: the file name for file-based
 *  providers (KeePass / pass / Enpass), else the id (the account email). */
export function connectionIdentity(c: { kind: ConnectionKind; email: string }): string {
  const local = c.kind === 'keepass' || c.kind === 'pass' || c.kind === 'enpass';
  return local ? fileNameOf(c.email) : c.email;
}

/** A connection's display label: the user-given name when set, else the
 *  underlying identity. THE single source for how a connection is named in the
 *  UI (the Vaults list + the new-item destination picker). */
export function connectionLabel(c: {
  kind: ConnectionKind;
  email: string;
  name: string | null;
}): string {
  const name = c.name?.trim();
  return name ? name : connectionIdentity(c);
}

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

/** Build a lossless EDIT payload for a LOGIN from its current detail. The form
 *  exposes name / username / password / first URI / TOTP / notes / favorite /
 *  reprompt and overrides exactly those from the `draft`; everything it can't
 *  touch — custom fields, extra URIs, org, autofill-on-load — carries through
 *  unchanged so a quick edit never silently wipes the richer data the main editor
 *  owns. The destination `folderId` is explicit (the form's folder picker owns
 *  it); pass `original.folderId` to keep the item where it is. Only logins are
 *  editable here, so non-login payloads are null on a login detail and stay that
 *  way. Pure, unit-tested. */
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
    // Collection membership is preserved as-is; the backend ignores it on edit
    // (changing collections is a heavier "move" the main client owns).
    collectionIds: original.collectionIds,
    favorite: draft.favorite,
    reprompt: draft.reprompt,
    notes: draft.notes.trim() || null,
    login: {
      username: draft.username.trim() || null,
      password: draft.password || null,
      // The form owns TOTP now: a cleared field clears the secret (the backend no
      // longer restores the previous TOTP — see mutate::writes save_item).
      totp: draft.totp.trim() || null,
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
  const host = (raw
    .replace(/^[a-z][a-z0-9+.-]*:\/\//i, '')
    .split(/[/?#]/)[0] ?? '')
    .toLowerCase();
  if (!host) return '';
  const labels = host.split('.').filter(Boolean);
  if (labels[0] === 'www') labels.shift();
  // The registrable label: second-to-last when there's a TLD, else the only one.
  const label = labels.length >= 2 ? labels[labels.length - 2] : labels[0];
  if (!label) return '';
  return label.charAt(0).toUpperCase() + label.slice(1);
}

/** The bare website host of a URL: scheme, path, query, port, userinfo and a
 *  leading `www.` stripped, lowercased — `https://www.passwordmonster.com/x` →
 *  `passwordmonster.com`. Mirrors the backend matcher's host normalization so a
 *  recommended/searched URI lines up with what autofill matches on. Empty when
 *  there's no host-like part (e.g. a synthetic `app://` association). Pure. */
export function domainOf(uri: string): string {
  const raw = uri.trim();
  if (!raw) return '';
  const afterScheme = raw.replace(/^[a-z][a-z0-9+.-]*:\/\//i, '');
  const authority = afterScheme.split(/[/?#]/)[0] ?? '';
  const host = ((authority.split('@').pop() ?? authority).split(':')[0] ?? '').toLowerCase();
  const bare = host.startsWith('www.') ? host.slice(4) : host;
  return bare.includes('.') ? bare : '';
}

/** Seed an add-login draft from a detected autofill target. For a real website the
 *  recommended URI is just its domain (no scheme/path), so the saved login lines up
 *  with how autofill matches; a synthetic `app://<process>` association is kept
 *  verbatim (it has no host) so the login matches this app next time. The name is
 *  guessed from the site, falling back to the process name. The username is the
 *  text the backend read from the target's username/email box (best-effort), so a
 *  brand-new login captures what the user just typed. The user can still edit any
 *  field. Only the fields we can fill are returned. Pure. */
export function draftFromContext(ctx: AutofillContext | null | undefined): Partial<AddDraft> {
  if (!ctx) return {};
  const uri = ctx.url ? domainOf(ctx.url) || ctx.url.trim() : (ctx.associateUri ?? '').trim();
  const name = loginNameFromUri(ctx.url || ctx.associateUri || '') || (ctx.processName ?? '').trim();
  const username = (ctx.typedUsername ?? '').trim();
  const patch: Partial<AddDraft> = {};
  if (name) patch.name = name;
  if (uri) patch.uri = uri;
  if (username) patch.username = username;
  return patch;
}

/** The search filter to pre-apply when the popup opens for a detected autofill
 *  target: the site's DOMAIN (from the real URL) so the list filters by URL, not by
 *  a guessed name, else the process name for a native app. The popup shows the
 *  normal list filtered by this — the matching login surfaces first, but the search
 *  box stays editable so the user can type to reach any other item. Empty string
 *  when the context yields nothing usable (the list then shows everything). Pure. */
export function fillQueryFromContext(ctx: AutofillContext | null | undefined): string {
  if (!ctx) return '';
  return domainOf(ctx.url ?? '') || (ctx.processName ?? '').trim();
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
  // Trash mode: the same ranked list, but over the trashed items (the only way
  // to reach a soft-deleted item to restore or permanently delete it).
  const [showTrash, setShowTrash] = createSignal(false);
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

  /** The detected-target filter for fill mode — the site domain (or app), derived
   *  from the pending context. NOT shown in the search box: in fill mode the list
   *  filters by this "secretly" so the user sees a clean fill chooser, not a
   *  pre-typed search. '' (matches everything) outside fill mode. */
  const fillContextQuery = () => fillQueryFromContext(pending()?.context);

  // Fill mode: filter by the user's own query when they've typed one (they're
  // reaching past the auto-matched logins), else by the secret context filter; trash
  // is never offered for a fill. Normal mode: the user's query, trash-toggle aware.
  const filtered = () =>
    fillMode()
      ? filterTrayItems(items(), query().trim() || fillContextQuery())
      : filterTrayItems(items(), query(), showTrash());

  /** How many items are in the trash — gates the Trash entry (hidden at 0). */
  const trashCount = () => items().filter((it) => it.deleted).length;

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
   *  pending, so a normal open reconciles to off here. A fresh detection starts with
   *  an EMPTY search box — the list still filters to the detected target via the
   *  secret `fillContextQuery()`, so the user sees a clean fill chooser, not a
   *  pre-typed search. The box stays editable: typing reaches any other login. */
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

  /** The URI `fill(remember)` stores on the chosen login so it auto-matches this
   *  target next time: the site DOMAIN for a browser (per the domain-only matching
   *  rule), else the synthetic `app://` association for a native app. Null when the
   *  detection exposed neither — nothing to remember. */
  const associationUri = (): string | null => {
    const ctx = pending()?.context;
    if (!ctx) return null;
    return (ctx.url ? domainOf(ctx.url) : '') || ctx.associateUri || null;
  };

  /** Whether the detected target can be remembered for a login (something to store).
   *  Drives the "remember this site?" prompt on a manual pick. */
  const canRemember = (): boolean => associationUri() !== null;

  /** In fill mode the user has typed their own query — i.e. they reached past the
   *  auto-matched logins for a different one. Picking such a login offers to remember
   *  this target for it (it presumably doesn't match the site yet). */
  const userSearchedInFill = (): boolean => fillMode() && query().trim() !== '';

  /** Leave fill mode and tell the backend to drop the detection (popup dismissed
   *  or Escape). */
  function exitFill(): void {
    setFillMode(false);
    setPending(null);
    void deps.ipc.autofillDismiss().catch(deps.onError);
  }

  /** Fill the chosen login into the detected target. When `remember` is set (the
   *  user reached this login via their own search, then chose to remember the site),
   *  the target's association URI is first added to the login so it auto-matches next
   *  time — best-effort: a failed remember surfaces an error but never blocks the
   *  fill the user asked for. Reprompt-protected items are deferred to the main
   *  window (never filled here), mirroring the copy path.
   *
   *  After a username/password fill, a login that ALSO has a TOTP gets its current
   *  code copied to the clipboard (via the auto-clear secret path), so the user can
   *  paste it on the one-time-code step that usually follows. Skipped when the filled
   *  field WAS the one-time-code box (the injector already typed it). Best-effort. */
  async function fill(target: FillTarget, remember = false): Promise<void> {
    const p = pending();
    if (!p) return;
    if (target.reprompt) {
      deps.onRepromptBlocked();
      return;
    }
    setFilling(true);
    try {
      if (remember) {
        const uri = associationUri();
        if (uri) {
          // Best-effort: don't let a failed association abort the fill.
          await deps.ipc
            .autofillAssociate(target.accountEmail, target.itemId, uri)
            .catch(deps.onError);
        }
      }
      await deps.ipc.autofillFill(p.token, target.accountEmail, target.itemId);
      // The backend hides the popup on success; just leave fill mode locally.
      setFillMode(false);
      setPending(null);
      if (target.hasTotp && p.context.field !== 'totp') {
        await copyTotpForFill(target);
      }
    } catch (err) {
      deps.onError(err);
    } finally {
      setFilling(false);
    }
  }

  /** Copy the target login's current TOTP code to the clipboard after a fill, so the
   *  user can paste it on the next step. Best-effort and isolated: a TOTP failure
   *  must never look like the fill itself failed (the password is already typed). */
  async function copyTotpForFill(target: FillTarget): Promise<void> {
    try {
      const totp = await deps.ipc.itemTotp(target.accountEmail, target.itemId);
      await deps.copy('TOTP code', totp.code);
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
  // Provider kind per selectable account, so the form can render provider-specific
  // fields (e.g. the Bitwarden-only reprompt toggle, the folder-vs-group label).
  const [accountKinds, setAccountKinds] = createSignal<Map<string, ConnectionKind>>(new Map());
  // Display label per selectable account (the user-given connection name, else the
  // derived identity) so the destination picker reads as named vaults, not raw
  // emails / .kdbx paths. Keyed by the same account id as `accounts`.
  const [accountLabels, setAccountLabels] = createSignal<Map<string, string>>(new Map());
  // Destination folder/group for the new (or moved) item, scoped to `account`.
  // null = the vault root ("no folder"). Folders are per-connection, so every
  // unlocked vault's folders are loaded together and filtered by account below.
  const [folders, setFolders] = createSignal<Folder[]>([]);
  const [folderId, setFolderId] = createSignal<string | null>(null);
  // Bitwarden collections (org-shared groupings) of the unlocked vaults. The
  // create form can file a NEW item directly into one collection (→ an org
  // cipher); null = the personal vault. Account-scoped, like folders. Collections
  // are a Bitwarden-only concept, so this stays empty for KeePass.
  const [collections, setCollections] = createSignal<Collection[]>([]);
  // Where a Bitwarden item is filed: the chosen organization (null = the user's
  // personal vault) and, within it, the collection. An org cipher MUST belong to
  // a collection, so picking an org auto-selects its first collection.
  const [organizationId, setOrganizationId] = createSignal<string | null>(null);
  const [collectionId, setCollectionId] = createSignal<string | null>(null);
  const [saving, setSaving] = createSignal(false);
  const [reuseCount, setReuseCount] = createSignal(0);
  // zxcvbn strength of the draft password (0–4), null when the field is empty.
  const [strength, setStrength] = createSignal<number | null>(null);

  /** The provider backing the selected destination vault, or null when unknown
   *  (no account, or the connection list couldn't be read). Drives provider-
   *  specific form chrome (reprompt toggle, folder-vs-group label, collections). */
  const accountKind = (): ConnectionKind | null => accountKinds().get(account()) ?? null;

  /** Display label for a selectable account id — its connection name when set,
   *  else the derived identity. Falls back to the raw id if unknown. */
  const accountLabel = (email: string): string => accountLabels().get(email) ?? email;

  /** Folders (Bitwarden) / groups (KeePass) of the selected destination vault,
   *  name-sorted — the form's "store in" options. A folder id is account-scoped,
   *  so this MUST follow `account()`. */
  const folderOptions = (): Folder[] =>
    folders()
      .filter((f) => f.accountEmail === account() && f.id != null)
      .sort((a, b) => a.name.localeCompare(b.name));

  /** Organizations the selected account can file into — derived from its
   *  collections (you can only store into an org where you hold a collection), so
   *  each org appears once, name-sorted. Empty for a personal-only account
   *  (or KeePass), which hides the org picker. */
  const organizationOptions = (): { id: string; name: string }[] => {
    const byId = new Map<string, string>();
    for (const c of collections()) {
      if (c.accountEmail === account()) byId.set(c.organizationId, c.organizationName);
    }
    return [...byId.entries()]
      .map(([id, name]) => ({ id, name }))
      .sort((a, b) => a.name.localeCompare(b.name));
  };

  /** Bitwarden collections of the SELECTED organization, name-sorted — the create
   *  form's "save into" options once an org is chosen. Account- and org-scoped, so
   *  this MUST follow `account()` and `organizationId()`. Empty for the personal
   *  vault and for KeePass (no collections). */
  const collectionOptions = (): Collection[] =>
    collections()
      .filter((c) => c.accountEmail === account() && c.organizationId === organizationId())
      .sort((a, b) => a.name.localeCompare(b.name));

  /** Pick the destination organization (null = personal vault). An org cipher must
   *  belong to a collection, so selecting an org defaults to its first collection;
   *  personal clears the collection. */
  function setOrganization(orgId: string | null): void {
    setOrganizationId(orgId);
    if (orgId === null) {
      setCollectionId(null);
      return;
    }
    const first = collections()
      .filter((c) => c.accountEmail === account() && c.organizationId === orgId)
      .sort((a, b) => a.name.localeCompare(b.name))[0];
    setCollectionId(first?.id ?? null);
  }

  /** Pick the destination vault. Org/folder/collection ids are per-vault, so
   *  switching vaults drops any chosen org/folder/collection back to the default —
   *  an id from the old vault would be meaningless (or, worse, a real one) in the
   *  new one. */
  function setAccount(email: string): void {
    setAccountSignal(email);
    setFolderId(null);
    setOrganizationId(null);
    setCollectionId(null);
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

  /** Load every unlocked vault's Bitwarden collections for the create form's
   *  picker. Advisory: a failure leaves it empty (personal vault only), never
   *  blocks the form. */
  async function loadCollections(): Promise<void> {
    try {
      setCollections(await deps.ipc.listCollections());
    } catch (err) {
      setCollections([]);
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
    setCollections([]);
    setAddMode(true);
    try {
      // Only unlocked, WRITABLE connections can take a new item — pass / Enpass /
      // Proton are read-only, so they never appear as a create destination.
      const cons = await deps.ipc.listConnections();
      const writable = cons.filter((c) => c.unlocked && isWritableKind(c.kind));
      setAccountKinds(new Map(writable.map((c) => [c.email, c.kind])));
      setAccountLabels(new Map(writable.map((c) => [c.email, connectionLabel(c)])));
      const emails = writable.map((c) => c.email);
      setAccounts(emails);
      // Preselect the pinned default when it's an available destination (unlocked
      // + writable); otherwise the first writable connection.
      const preferred = deps.defaultAccount();
      setAccount(emails.includes(preferred) ? preferred : (emails[0] ?? ''));
    } catch (err) {
      deps.onError(err);
      setAccountKinds(new Map());
      setAccountLabels(new Map());
      setAccounts([]);
      setAccount('');
    }
    await Promise.all([loadFolders(), loadCollections()]);
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
        totp: detail.login?.totp ?? '',
        notes: detail.notes ?? '',
        favorite: detail.favorite,
        reprompt: detail.reprompt,
      });
      setAccounts([item.accountEmail]);
      setAccount(item.accountEmail);
      // Learn the edited item's provider so the form renders the right fields.
      // Advisory: a failed lookup just leaves provider chrome at its neutral
      // default (no reprompt toggle), never blocks the edit.
      try {
        const cons = await deps.ipc.listConnections();
        const con = cons.find((c) => c.email === item.accountEmail);
        setAccountKinds(con ? new Map([[item.accountEmail, con.kind]]) : new Map());
        setAccountLabels(con ? new Map([[item.accountEmail, connectionLabel(con)]]) : new Map());
      } catch {
        setAccountKinds(new Map());
        setAccountLabels(new Map());
      }
      setFolders([]);
      // Collections aren't editable in the compact form (a collection move is a
      // heavier op the main client owns), so the edit form never loads them.
      setCollections([]);
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
    setCollections([]);
    setOrganizationId(null);
    setCollectionId(null);
    setAccountKinds(new Map());
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
    // A chosen Bitwarden collection makes this an ORG cipher: it carries the
    // collection's organization + the collection id. No collection → a personal
    // cipher (no org). KeePass has no collections, so this is always null there.
    const collection = collectionOptions().find((c) => c.id === collectionId());
    const input: ItemInput = {
      id: null,
      itemType: 'login',
      name,
      folderId: folderId(),
      organizationId: collection?.organizationId ?? null,
      collectionIds: collection ? [collection.id] : [],
      favorite: d.favorite,
      reprompt: d.reprompt,
      notes: d.notes.trim() || null,
      login: {
        username: d.username.trim() || null,
        password: d.password || null,
        totp: d.totp.trim() || null,
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

  return {
    ready,
    unlocked,
    appUnlockConfigured,
    helloConfigured,
    unlocking,
    query,
    setQuery,
    filtered,
    showTrash,
    setShowTrash,
    trashCount,
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
    canRemember,
    userSearchedInFill,
    // add / edit form
    addMode,
    editing,
    draft,
    setDraft,
    account,
    setAccount,
    accounts,
    accountKind,
    accountLabel,
    folderOptions,
    folderId,
    setFolderId,
    organizationOptions,
    organizationId,
    setOrganization,
    collectionOptions,
    collectionId,
    setCollectionId,
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
