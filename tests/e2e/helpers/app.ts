/**
 * Shared helpers for agate Tauri e2e specs.
 *
 * Model: each spec installs an in-page fake backend (`installFakeBackend`) and
 * lands the app on a known screen (`gotoSetup` / `gotoUnlock` / `gotoVault` /
 * `gotoSettings` / `gotoSecurity`). Every screen then runs its real reactive
 * flow — app-unlock, unlock-all, sync, edit — with the fake answering IPC. The
 * binary under test is the real Tauri app, so Tauri plugin APIs (clipboard,
 * window, opener) work for real; only agate's own `invoke` calls are faked.
 */
import { browser, $, $$ } from '@wdio/globals';
import { TIMEOUT, waitFor } from './wait.ts';
import {
  type FakeConfig,
  FIXTURE_EMAIL,
  FIXTURE_LABEL,
  lockedFake,
  setupFake,
  unlockedFake,
} from './fixtures.ts';

export { FIXTURE_EMAIL, FIXTURE_LABEL, lockedFake, setupFake, unlockedFake };
export type { FakeConfig };

// ── Window attach ─────────────────────────────────────────────────────────────
const APP_URLS = ['http://tauri.localhost/', 'http://localhost:5173/'];

async function mountedHere(): Promise<boolean> {
  return browser.execute(() => !!document.getElementById('app')).catch(() => false);
}

/**
 * Attach to the agate app window with a FRESH load. tauri-driver commonly
 * attaches to the app's WebView while it is parked at `about:blank`, so we
 * force-navigate to the app URL — which doubles as a per-test reset, since the
 * app keeps module + component state (search query, selection, …) across a spec
 * file's `it`s otherwise. Confirms the `#app` mount root is present.
 */
export async function attachToApp(): Promise<void> {
  const deadline = Date.now() + TIMEOUT.crawl;
  let last = '';
  while (Date.now() < deadline) {
    for (const target of APP_URLS) {
      try {
        await browser.url(target);
        await browser.waitUntil(mountedHere, { timeout: 3_000 });
        return;
      } catch { last = target; }
    }
    // Navigation may have failed because we're on a non-navigable context; pick a
    // real window handle and retry.
    const handles = await browser.getWindowHandles().catch(() => [] as string[]);
    for (const h of handles) { try { await browser.switchToWindow(h); break; } catch { /* next */ } }
    await browser.pause(300);
  }
  throw new Error(`No agate app window after ${TIMEOUT.crawl}ms (last target: ${last})`);
}

// ── Fake backend ──────────────────────────────────────────────────────────────
/**
 * Replace the IPC transport with an in-page stateful fake answering every command
 * the app issues (app-unlock model). Mutations (configure/unlock/lock/favorite/
 * delete/…) update in-page state so follow-up reads stay consistent. Re-callable.
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
      throw new Error('__agateInvoke missing — run via tauri-driver against a debug build');
    }

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    type Any = any;
    const clone = <T>(v: T): T => JSON.parse(JSON.stringify(v));
    const state = {
      status: clone(c.status),
      connections: clone(c.connections) as Any[],
      items: clone(c.items) as Any[],
      folders: clone(c.folders) as Any[],
      details: clone(c.details) as Record<string, Any>,
    };
    let seq = 1000;
    // NOTE: this runs in the PAGE context (browser.execute) — Node-scope imports
    // like FIXTURE_EMAIL/FIXTURE_LABEL are NOT in scope here. Derive defaults from
    // the (serialized) config instead.
    const fxEmail = state.connections[0]?.email ?? state.items[0]?.accountEmail ?? 'tester@example.com';
    const fxLabel = state.items[0]?.accountLabel ?? state.connections[0]?.serverLabel ?? 'Bitwarden — US';
    const findItem = (id: string) => state.items.find((x) => x.id === id);
    const outcomes = () =>
      state.connections.map((cn) => ({ email: cn.email, serverLabel: cn.serverLabel, status: 'unlocked' }));

    w.__agateInvoke.setInvoke(async (cmd, rawArgs) => {
      const a = (rawArgs ?? {}) as Record<string, Any>;
      const e = c.errors && c.errors[cmd];
      if (e) throw { kind: e.kind, message: e.message };

      switch (cmd) {
        // ── session / server ──
        case 'get_session_status': return { ...state.status };
        case 'get_server_config': return c.server;
        case 'set_server_config': return null;
        case 'window_controls_layout': return { side: 'right', buttons: ['minimize', 'maximize', 'close'] };

        // ── app unlock ──
        case 'configure_app_unlock':
          state.status.appUnlockConfigured = true;
          state.status.unlockDeviceBound = !!a.deviceBound;
          state.status.unlocked = true;
          return null;
        case 'change_app_unlock':
          state.status.unlockDeviceBound = !!a.deviceBound;
          return null;
        case 'unlock_all': {
          if (c.twoFactor && state.connections.length > 0) {
            const cn = state.connections[0];
            return [{ email: cn.email, serverLabel: cn.serverLabel, status: 'twoFactorRequired', providers: ['authenticator', 'email'] }];
          }
          state.status.unlocked = true;
          state.status.liveCount = state.connections.length;
          for (const cn of state.connections) cn.unlocked = true;
          return outcomes();
        }
        case 'unlock_connection_2fa': {
          state.status.unlocked = true;
          state.status.liveCount = state.connections.length;
          const cn = state.connections.find((x) => x.email === a.email);
          if (cn) cn.unlocked = true;
          return null;
        }
        case 'send_connection_email_code': return null;
        case 'hello_unlock':
          state.status.unlocked = true;
          state.status.liveCount = state.connections.length;
          for (const cn of state.connections) cn.unlocked = true;
          return outcomes();

        // ── connections ──
        // Return a fresh array on every read so the frontend's signal setters see
        // a new reference and re-render (the real backend deserializes anew each
        // call; returning the same ref makes Solid skip the update).
        case 'list_connections': return state.connections.map((x) => ({ ...x }));
        case 'add_connection': {
          if (c.addResult.status === 'twoFactorRequired' && !a.twoFactor) return c.addResult;
          const email = (a.email as string) ?? `new-${seq++}@example.com`;
          if (!state.connections.some((x) => x.email === email)) {
            state.connections.push({
              email, serverLabel: 'Bitwarden — US', server: a.server, unlocked: true,
              storeCredentials: a.storeCredentials !== false,
            });
            state.status.connectionCount = state.connections.length;
            state.status.liveCount = state.connections.length;
          }
          return { status: 'success' };
        }
        case 'update_connection': {
          if (c.addResult.status === 'twoFactorRequired' && a.password && !a.twoFactor) return c.addResult;
          const cn = state.connections.find((x) => x.email === a.email);
          if (cn) {
            cn.server = a.server ?? cn.server;
            cn.storeCredentials = a.storeCredentials !== false;
            if (a.password) cn.unlocked = true;
          }
          return { status: 'success' };
        }
        case 'unlock_connection': {
          if (c.addResult.status === 'twoFactorRequired' && !a.twoFactor) return c.addResult;
          const cn = state.connections.find((x) => x.email === a.email);
          if (cn) cn.unlocked = true;
          state.status.liveCount = state.connections.filter((x) => x.unlocked).length;
          return { status: 'success' };
        }
        case 'send_email_code': return null;
        case 'remove_connection': {
          state.connections = state.connections.filter((x) => x.email !== a.email);
          state.status.connectionCount = state.connections.length;
          return null;
        }
        case 'set_active_connection': return null;
        case 'lock': state.status.unlocked = false; state.status.liveCount = 0; return null;
        case 'logout':
          state.status.unlocked = false;
          state.status.appUnlockConfigured = false;
          state.status.connectionCount = 0;
          state.status.liveCount = 0;
          state.connections = [];
          return null;

        // ── vault reads ──
        case 'sync_vault': return null;
        case 'list_items': return state.items.map((x) => ({ ...x }));
        case 'list_folders': return state.folders.map((x) => ({ ...x }));
        case 'item_detail': {
          const d = state.details[a.id as string] ?? null;
          if (d) {
            const it = findItem(a.id as string);
            if (it) { d.favorite = it.favorite; d.folderId = it.folderId; }
          }
          return d;
        }
        case 'item_totp': return c.totp;

        // ── vault writes (all scoped by accountEmail) ──
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
          if (a.permanent) state.items = state.items.filter((x) => !ids.includes(x.id));
          else for (const id of ids) { const it = findItem(id); if (it) it.deleted = true; }
          return null;
        }
        case 'restore_items': {
          for (const id of (a.ids as string[]) ?? []) { const it = findItem(id); if (it) it.deleted = false; }
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
              id, accountEmail: a.accountEmail ?? fxEmail, accountLabel: fxLabel,
              name: input.name as string, itemType: input.itemType as string,
              username: input.login?.username ?? null, hasTotp: false, favorite: !!input.favorite,
              deleted: false, folderId: (input.folderId as string | null) ?? null, organizationId: null,
            });
          }
          return null;
        }
        case 'create_folder': {
          const f = { id: `f-${seq++}`, name: a.name as string, accountEmail: a.accountEmail, accountLabel: fxLabel };
          state.folders.push(f);
          return f;
        }
        case 'rename_folder': {
          const f = state.folders.find((x) => x.id === a.id);
          if (f) f.name = a.name as string;
          return f ?? { id: a.id, name: a.name, accountEmail: a.accountEmail, accountLabel: fxLabel };
        }

        // ── generators ──
        case 'generate_password': return c.generatedPassword;
        case 'generate_passphrase': return c.generatedPassphrase;

        // ── security / dark-web ──
        case 'audit_offline': return c.audit;
        case 'audit_exposed': return c.exposed;
        case 'set_darkweb_consent': return null;
        case 'darkweb_scan_email': return { email: a.email ?? '', breaches: [], exposedData: [], riskLabel: null, riskScore: null };
        case 'darkweb_scan_vault': return { accounts: [], totalBreaches: 0, clean: 0, skipped: 0 };
        case 'breach_directory': return [];

        // ── Windows Hello ──
        case 'hello_available': return c.helloAvailable;
        case 'hello_enable': state.status.helloConfigured = true; return null;
        case 'hello_disable': state.status.helloConfigured = false; return null;

        // ── updater ──
        case 'check_update': return c.updateVersion;
        case 'run_update': return null;

        default: return null;
      }
    });
  }, cfg);
}

/** Re-derive the top-level screen from the (fake) backend without a reload. */
export async function refreshSessionInApp(): Promise<void> {
  await browser.execute(async () => {
    const w = window as unknown as { __agateRefreshSession?: () => Promise<void> };
    if (w.__agateRefreshSession) await w.__agateRefreshSession();
  });
}

// ── Navigation: land on a known screen ────────────────────────────────────────
export async function gotoSetup(cfg: FakeConfig = setupFake()): Promise<void> {
  await attachToApp();
  await installFakeBackend(cfg);
  await refreshSessionInApp();
  await waitFor(
    async () => (await buttonExists('Set app password')),
    'AppUnlockSetup screen did not render',
    TIMEOUT.normal,
  );
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

export async function gotoSecurity(cfg: FakeConfig = unlockedFake()): Promise<void> {
  await gotoVault(cfg);
  await clickButtonByText('Security'); // rail FilterButton
  await $('.sec-header').waitForExist({ timeout: TIMEOUT.slow });
}

/** Vault's first background sync populates the list; wait for rows or empty-state. */
export async function waitForVaultLoaded(): Promise<void> {
  await waitFor(
    async () => (await $$('.vault-row').length) > 0 || (await $$('.vault-empty').length) > 0,
    'vault list did not load (no rows, no empty-state)',
    TIMEOUT.slow,
  );
}

// ── Auth-screen helpers ───────────────────────────────────────────────────────
export async function setAppPassword(pw: string): Promise<void> {
  const inputs = await $$('.onboarding input[type="password"]');
  await inputs[0].setValue(pw);
  await inputs[1].setValue(pw);
  await clickButtonByText('Set app password');
}

export async function unlockAll(appPassword: string): Promise<void> {
  await $('.unlock-field input[type="password"]').setValue(appPassword);
  await $('.unlock .primary.full').click();
}

/** Fill + submit the add-connection (Onboarding) form. */
export async function addConnection(email = 'new@example.com', password = 'master-pw'): Promise<void> {
  await $('.onboarding input[type="email"]').setValue(email);
  await $('.onboarding input[type="password"]').setValue(password);
  await clickButtonByText('Add connection');
}

// ── DOM helpers ───────────────────────────────────────────────────────────────
/** Click an element by `title` via DOM `.click()` (bypasses SVG hit-test intercepts). */
export async function domClickByTitle(title: string): Promise<void> {
  const ok = await browser.execute((t: string) => {
    const el = document.querySelector<HTMLElement>(`[title="${t}"]`);
    if (el) { el.click(); return true; }
    return false;
  }, title);
  if (!ok) throw new Error(`no element with title="${title}"`);
}

async function buttonExists(text: string): Promise<boolean> {
  return browser.execute(
    (t: string) =>
      Array.from(document.querySelectorAll('button')).some((b) => (b.textContent ?? '').trim() === t),
    text,
  );
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
    Array.from(document.querySelectorAll('.vault-row .vault-row-name')).map((e) => e.textContent ?? ''),
  );
}

export async function clickRow(name: string): Promise<void> {
  const ok = await browser.execute((n: string) => {
    for (const row of Array.from(document.querySelectorAll('.vault-row'))) {
      if ((row.querySelector('.vault-row-name')?.textContent ?? '') === n) {
        (row as HTMLElement).click(); return true;
      }
    }
    return false;
  }, name);
  if (!ok) throw new Error(`no vault row named "${name}"`);
}

export async function checkRow(name: string): Promise<void> {
  const ok = await browser.execute((n: string) => {
    for (const row of Array.from(document.querySelectorAll('.vault-row'))) {
      if ((row.querySelector('.vault-row-name')?.textContent ?? '') === n) {
        const cb = row.querySelector<HTMLInputElement>('.vault-row-check input[type="checkbox"]');
        if (cb) { cb.click(); return true; }
      }
    }
    return false;
  }, name);
  if (!ok) throw new Error(`no vault row named "${name}"`);
}

/** Type into the vault search (lives in the titlebar). */
export async function setSearch(value: string): Promise<void> {
  await $('.titlebar-search input').setValue(value);
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
