/**
 * Shared helpers for agate Tauri e2e specs.
 *
 * Model: the app boots to Onboarding against the REAL (logged-out) backend, then
 * each spec installs an in-page fake backend (`installFakeBackend`) and re-derives
 * the screen (`refreshSessionInApp`). Every screen is then driven through its real
 * reactive flow — login, unlock, sync, edit — with the fake answering IPC. No live
 * Bitwarden vault, no network, fully deterministic.
 *
 * Selectors track the existing CSS classes in the app (App.tsx, screens/*, and
 * components/*). Buttons are addressed by their `title` attribute where present.
 */
import { browser, $, $$ } from '@wdio/globals';
import { TIMEOUT, waitFor } from './wait.ts';
import {
  type FakeConfig,
  FIXTURE_EMAIL,
  loggedOutFake,
  lockedFake,
  unlockedFake,
} from './fixtures.ts';

export { FIXTURE_EMAIL, loggedOutFake, lockedFake, unlockedFake };
export type { FakeConfig };

// ── Window attach ─────────────────────────────────────────────────────────────
/**
 * Switch the WebDriver session onto the agate app window. tauri-driver also
 * exposes an `about:blank` context; we pick the real app URL (tauri.localhost or
 * the dev-server localhost) and confirm the `#app` mount root is present.
 */
export async function attachToApp(): Promise<void> {
  const isAppUrl = (u: string) => !!u && u !== 'about:blank' && !u.startsWith('data:');
  const deadline = Date.now() + TIMEOUT.crawl;
  let seen: Record<string, string> = {};
  while (Date.now() < deadline) {
    const handles = await browser.getWindowHandles().catch(() => [] as string[]);
    seen = {};
    for (const h of handles) {
      try { await browser.switchToWindow(h); } catch { continue; }
      const url = await browser.getUrl().catch(() => '');
      seen[h] = url;
      if (!isAppUrl(url)) continue;
      const mounted = await browser
        .execute(() => !!document.getElementById('app'))
        .catch(() => false);
      if (mounted) return;
    }
    await browser.pause(150);
  }
  throw new Error(`No agate app window after ${TIMEOUT.crawl}ms. Seen: ${JSON.stringify(seen)}`);
}

// ── Fake backend ──────────────────────────────────────────────────────────────
/**
 * Replace the IPC transport with an in-page stateful fake that answers every
 * command the app issues. Mutations (login/lock/favorite/delete/…) update the
 * in-page state so follow-up reads (`get_session_status`, `list_items`, …) stay
 * consistent within a spec. Re-callable — a fresh call resets the fake state.
 */
export async function installFakeBackend(cfg: FakeConfig): Promise<void> {
  await browser.execute((c: FakeConfig) => {
    const w = window as unknown as {
      __agateInvoke?: {
        setInvoke: (
          fn: ((cmd: string, args?: Record<string, unknown>) => Promise<unknown>) | null,
        ) => void;
      };
    };
    if (!w.__agateInvoke) {
      throw new Error(
        '__agateInvoke missing — run via tauri-driver (navigator.webdriver) against a DEV build',
      );
    }

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const clone = <T>(v: T): T => JSON.parse(JSON.stringify(v));
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    type Any = any;
    const state = {
      status: clone(c.status),
      items: clone(c.items) as Any[],
      folders: clone(c.folders) as Any[],
      accounts: clone(c.accounts) as Any[],
      details: clone(c.details) as Record<string, Any>,
    };
    let seq = 1000;

    const findItem = (id: string) => state.items.find((x) => x.id === id);

    w.__agateInvoke.setInvoke(async (cmd, rawArgs) => {
      const a = (rawArgs ?? {}) as Record<string, Any>;
      const e = c.errors && c.errors[cmd];
      if (e) throw { kind: e.kind, message: e.message };

      switch (cmd) {
        // ── session / server ──
        case 'get_session_status': return { ...state.status };
        case 'get_server_config': return c.server;
        case 'set_server_config': return null;
        case 'list_accounts': return state.accounts;

        // ── auth ──
        case 'login': {
          if (c.loginResult.status === 'twoFactorRequired' && !a.twoFactor) {
            return c.loginResult;
          }
          state.status.loggedIn = true;
          state.status.unlocked = true;
          state.status.email = (a.email as string) ?? state.status.email;
          return { status: 'success' };
        }
        case 'send_email_code': return null;
        case 'unlock_local': state.status.unlocked = true; return null;
        case 'hello_unlock': state.status.unlocked = true; return null;
        case 'lock': state.status.unlocked = false; return null;
        case 'logout':
          state.status.loggedIn = false;
          state.status.unlocked = false;
          state.status.email = null;
          return null;
        case 'enable_local_unlock': state.status.localUnlockConfigured = true; return null;
        case 'disable_local_unlock': state.status.localUnlockConfigured = false; return null;

        // ── vault reads ──
        case 'sync_vault': return null;
        case 'list_items': return state.items;
        case 'list_folders': return state.folders;
        case 'item_detail': {
          const d = state.details[a.id as string] ?? null;
          if (d) {
            const it = findItem(a.id as string);
            if (it) { d.favorite = it.favorite; d.folderId = it.folderId; }
          }
          return d;
        }
        case 'item_totp': return c.totp;

        // ── vault writes ──
        case 'set_favorite': {
          const it = findItem(a.id as string);
          if (it) it.favorite = !!a.favorite;
          return null;
        }
        case 'move_items': {
          for (const id of (a.ids as string[]) ?? []) {
            const it = findItem(id);
            if (it) it.folderId = (a.folderId as string | null) ?? null;
          }
          return null;
        }
        case 'delete_items': {
          const ids: string[] = (a.ids as string[]) ?? [];
          if (a.permanent) {
            state.items = state.items.filter((x) => !ids.includes(x.id));
          } else {
            for (const id of ids) { const it = findItem(id); if (it) it.deleted = true; }
          }
          return null;
        }
        case 'restore_items': {
          for (const id of (a.ids as string[]) ?? []) {
            const it = findItem(id);
            if (it) it.deleted = false;
          }
          return null;
        }
        case 'clone_item': {
          const src = findItem(a.id as string);
          if (src) {
            const id = `clone-${seq++}`;
            state.items.push({ ...src, id, name: `${src.name} (clone)`, favorite: false });
            state.details[id] = { ...(state.details[src.id] ?? {}), id, name: `${src.name} (clone)` };
          }
          return null;
        }
        case 'save_item': {
          const input = (a.input ?? {}) as Record<string, Any>;
          if (input.id) {
            const it = findItem(input.id as string);
            if (it) it.name = input.name as string;
          } else {
            const id = `new-${seq++}`;
            state.items.push({
              id, name: input.name as string, itemType: input.itemType as string,
              username: input.login?.username ?? null, hasTotp: false, favorite: !!input.favorite,
              deleted: false, folderId: (input.folderId as string | null) ?? null, organizationId: null,
            });
          }
          return null;
        }
        case 'create_folder': {
          const f = { id: `f-${seq++}`, name: a.name as string };
          state.folders.push(f);
          return f;
        }
        case 'rename_folder': {
          const f = state.folders.find((x) => x.id === a.id);
          if (f) f.name = a.name as string;
          return f ?? { id: a.id, name: a.name };
        }

        // ── generators ──
        case 'generate_password': return c.generatedPassword;
        case 'generate_passphrase': return c.generatedPassphrase;

        // ── security audit ──
        case 'audit_offline': return c.audit;
        case 'audit_exposed': return c.exposed;

        // ── dark-web / breach monitor (defaults — extend per-spec via cfg) ──
        case 'set_darkweb_consent': return null;
        case 'darkweb_scan_email': return { email: a.email ?? '', breaches: [] };
        case 'darkweb_scan_vault': return { accounts: [], scannedAt: 0 };
        case 'breach_directory': return [];

        // ── Windows Hello ──
        case 'hello_available': return c.helloAvailable;
        case 'hello_enable': state.status.helloConfigured = true; return null;
        case 'hello_disable': state.status.helloConfigured = false; return null;

        // ── updater ──
        case 'check_update': return c.updateVersion;
        case 'run_update': return null;

        // ── accounts ──
        case 'switch_account': {
          // Mirrors the real backend: switching clears the live session, so the
          // app routes to the target account's unlock/login.
          state.status.email = a.email as string;
          state.status.unlocked = false;
          for (const acc of state.accounts) acc.active = acc.email === a.email;
          return null;
        }
        case 'remove_account': {
          state.accounts = state.accounts.filter((x) => x.email !== a.email);
          return null;
        }

        default: return null;
      }
    });
  }, cfg);
}

/** Re-derive the top-level screen from the (fake) backend without a page reload
 *  — a reload would wipe the in-page fake. Uses the gated `__agateRefreshSession`
 *  hook in session.ts. */
export async function refreshSessionInApp(): Promise<void> {
  await browser.execute(async () => {
    const w = window as unknown as { __agateRefreshSession?: () => Promise<void> };
    if (w.__agateRefreshSession) await w.__agateRefreshSession();
  });
}

// ── Navigation: land on a known screen ────────────────────────────────────────
export async function gotoOnboarding(cfg: FakeConfig = loggedOutFake()): Promise<void> {
  await attachToApp();
  await installFakeBackend(cfg);
  await refreshSessionInApp();
  await $('.onboarding').waitForExist({ timeout: TIMEOUT.normal });
}

export async function gotoUnlock(cfg: FakeConfig = lockedFake()): Promise<void> {
  await attachToApp();
  await installFakeBackend(cfg);
  await refreshSessionInApp();
  await $('.unlock').waitForExist({ timeout: TIMEOUT.normal });
}

export async function gotoVault(cfg: FakeConfig = unlockedFake()): Promise<void> {
  await attachToApp();
  await installFakeBackend(cfg);
  await refreshSessionInApp();
  await $('.vault').waitForExist({ timeout: TIMEOUT.normal });
  await waitForVaultLoaded();
}

export async function gotoSettings(cfg: FakeConfig = unlockedFake()): Promise<void> {
  await gotoVault(cfg);
  await domClickByTitle('Settings');
  await $('.settings').waitForExist({ timeout: TIMEOUT.normal });
}

/** Vault's first background sync populates the list; wait for either rows or the
 *  empty-state to settle so assertions don't race the initial load. */
export async function waitForVaultLoaded(): Promise<void> {
  await waitFor(
    async () => (await $$('.vault-row').length) > 0 || (await $$('.vault-empty').length) > 0,
    'vault list did not load (no rows, no empty-state)',
    TIMEOUT.slow,
  );
}

// ── Onboarding helpers ────────────────────────────────────────────────────────
export async function fillLogin(email: string, password: string): Promise<void> {
  await $('.onboarding input[type="email"]').setValue(email);
  await $('.onboarding input[type="password"]').setValue(password);
}

export async function submitLogin(): Promise<void> {
  await $('.onboarding .primary.full').click();
}

export async function loginFromOnboarding(
  email = FIXTURE_EMAIL,
  password = 'master-pw',
): Promise<void> {
  await fillLogin(email, password);
  await submitLogin();
}

// ── DOM helpers ───────────────────────────────────────────────────────────────
/**
 * Click an element by its `title` via DOM `.click()`. Many buttons wrap an inline
 * lucide-solid `<svg>` that swallows WebDriver's geometric click ("element click
 * intercepted"); a DOM click bypasses hit-testing.
 */
export async function domClickByTitle(title: string): Promise<void> {
  const ok = await browser.execute((t: string) => {
    const el = document.querySelector<HTMLElement>(`[title="${t}"]`);
    if (el) { el.click(); return true; }
    return false;
  }, title);
  if (!ok) throw new Error(`no element with title="${title}"`);
}

/** Click the first button whose visible text equals `text`. */
export async function clickButtonByText(text: string): Promise<void> {
  const ok = await browser.execute((t: string) => {
    for (const b of Array.from(document.querySelectorAll('button'))) {
      if ((b.textContent ?? '').trim() === t) { (b as HTMLButtonElement).click(); return true; }
    }
    return false;
  }, text);
  if (!ok) throw new Error(`no button with text "${text}"`);
}

export async function rowNames(): Promise<string[]> {
  return browser.execute(() =>
    Array.from(document.querySelectorAll('.vault-row .vault-row-name')).map(
      (e) => e.textContent ?? '',
    ),
  );
}

/** Click a vault row by its visible name. */
export async function clickRow(name: string): Promise<void> {
  const ok = await browser.execute((n: string) => {
    for (const row of Array.from(document.querySelectorAll('.vault-row'))) {
      const label = row.querySelector('.vault-row-name')?.textContent ?? '';
      if (label === n) { (row as HTMLElement).click(); return true; }
    }
    return false;
  }, name);
  if (!ok) throw new Error(`no vault row named "${name}"`);
}

// ── Toasts ────────────────────────────────────────────────────────────────────
export async function toastMessages(): Promise<string[]> {
  return browser.execute(() =>
    Array.from(document.querySelectorAll('.toast-message')).map((e) => e.textContent ?? ''),
  );
}

export async function waitForToast(substr: string): Promise<void> {
  await waitFor(
    async () => (await toastMessages()).some((m) => m.includes(substr)),
    `toast containing "${substr}" never appeared`,
    TIMEOUT.normal,
  );
}
