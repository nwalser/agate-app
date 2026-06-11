/**
 * WebdriverIO config for agate Tauri e2e.
 *
 * Drives the built debug binary via tauri-driver (which proxies to msedgedriver —
 * Tauri on Windows uses WebView2 = Edge).
 *
 * Prereqs (one-time):
 *   cargo install tauri-driver --locked
 *   Install Microsoft Edge Driver matching your Edge version:
 *     https://developer.microsoft.com/microsoft-edge/tools/webdriver/
 *   Place msedgedriver.exe on PATH (or set MSEDGEDRIVER env var).
 *
 * Build once:   npm run test:e2e:build
 * Run tests:    npm run test:e2e
 */
import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import { existsSync, readFileSync, writeFileSync, unlinkSync } from 'node:fs';
import { request } from 'node:http';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { browser } from '@wdio/globals';

// package.json uses "type": "module" — derive __dirname in ESM.
const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const ROOT = resolve(__dirname, '..', '..');

// agate's Cargo manifest lives under src-tauri/, so the debug binary lands in
// src-tauri/target/debug/. `tauri build --debug --no-bundle` produces it.
const APP_EXE = resolve(ROOT, 'src-tauri', 'target', 'debug', 'agate.exe');

let tauriDriver: ChildProcess | undefined;

// ── Vite dev server lifecycle ───────────────────────────────────────────────
// The debug binary loads its frontend from `devUrl` (http://localhost:5273 —
// Agate's own port; 5173 belongs to whichever other vite project, e.g. themia,
// is running), so the harness keeps a vite dev server up for the run (and the
// DEV build is where the test-only IPC seam lives — see src/lib/ipc.ts).
const VITE_PORT = 5273;
const VITE_BIN = resolve(ROOT, 'node_modules', 'vite', 'bin', 'vite.js');
const VITE_PID_FILE = resolve(__dirname, '.vite-harness.pid');

// PID of the vite the harness OWNS (started or adopted-from-leak). Never set for
// a user's own `npm run dev` server — that one we leave strictly alone.
let ownVitePid: number | undefined;

function readVitePidFile(): number | undefined {
  try {
    const n = Number(readFileSync(VITE_PID_FILE, 'utf8').trim());
    return Number.isFinite(n) && n > 0 ? n : undefined;
  } catch { return undefined; }
}
function writeVitePidFile(pid: number): void {
  try { writeFileSync(VITE_PID_FILE, String(pid), 'utf8'); } catch { /* best-effort */ }
}
function removeVitePidFile(): void {
  try { unlinkSync(VITE_PID_FILE); } catch { /* best-effort */ }
}

// The PID actually LISTENING on a TCP port (Windows `netstat`). Lets us tell a
// leaked harness vite (pidfile PID == port owner) apart from a user's dev server.
function pidOnPort(port: number): number | undefined {
  try {
    const out = spawnSync('netstat', ['-ano', '-p', 'tcp'], { encoding: 'utf8' }).stdout ?? '';
    for (const line of out.split(/\r?\n/)) {
      if (!line.includes('LISTENING')) continue;
      const cols = line.trim().split(/\s+/);
      if ((cols[1] ?? '').endsWith(`:${port}`)) {
        const pid = Number(cols[cols.length - 1]);
        if (Number.isFinite(pid) && pid > 0) return pid;
      }
    }
  } catch { /* netstat unavailable */ }
  return undefined;
}

function killPidTreeSync(pid: number): void {
  try { spawnSync('taskkill', ['/F', '/T', '/PID', String(pid)], { stdio: 'ignore' }); } catch { /* gone */ }
}

// Test-only child processes (by image name) that must never outlive the runner.
const TEST_PROC_NAMES = ['agate.exe', 'tauri-driver.exe', 'msedgedriver.exe'];
function killTestProcessesSync(): void {
  for (const name of TEST_PROC_NAMES) {
    try { spawnSync('taskkill', ['/F', '/T', '/IM', name], { stdio: 'ignore' }); } catch { /* gone */ }
  }
}

// Single shutdown path used by onComplete AND by signal/exit handlers, so the
// driver + the harness-owned vite never leak on Ctrl+C, SIGTERM, or a throw.
let shutdownDone = false;
function shutdownHarness(): void {
  if (shutdownDone) return;
  shutdownDone = true;
  try { tauriDriver?.kill('SIGKILL'); } catch { /* already dead */ }
  if (ownVitePid !== undefined) { killPidTreeSync(ownVitePid); removeVitePidFile(); }
  killTestProcessesSync();
}

process.once('SIGINT', () => { shutdownHarness(); process.exit(130); });
process.once('SIGTERM', () => { shutdownHarness(); process.exit(143); });
process.once('exit', () => { shutdownHarness(); });

async function pingViteDev(): Promise<boolean> {
  return new Promise((res) => {
    // Probe `localhost` (not 127.0.0.1): vite binds `localhost`, which on Windows
    // often resolves to IPv6 ::1, so an IPv4-only probe would never connect.
    const req = request(
      { host: 'localhost', port: VITE_PORT, path: '/', method: 'GET', timeout: 1500 },
      (r) => { r.resume(); res(true); },
    );
    req.on('error', () => res(false));
    req.on('timeout', () => { req.destroy(); res(false); });
    req.end();
  });
}

async function ensureViteDev(): Promise<void> {
  if (await pingViteDev()) {
    // Port taken. Adopt ONLY if the pidfile's PID is exactly the listener (a
    // leaked harness vite); otherwise it's a user's dev server — reuse, don't own.
    const filePid = readVitePidFile();
    const portPid = pidOnPort(VITE_PORT);
    if (filePid !== undefined && portPid !== undefined && filePid === portPid) {
      ownVitePid = portPid;
    } else {
      console.warn(`[e2e] :${VITE_PORT} already in use by pid ${portPid ?? '?'}; reusing without ownership.`);
    }
    return;
  }
  removeVitePidFile(); // nothing listening — a pidfile here is stale

  // Spawn vite DIRECTLY via node so the handle PID is the real server PID (a
  // shell wrapper would orphan the node child on kill and leak the port).
  const proc = spawn(process.execPath, [VITE_BIN], { cwd: ROOT, stdio: 'ignore' });
  proc.on('error', (e) => console.error('vite:dev failed to start:', e));
  ownVitePid = proc.pid;
  if (ownVitePid !== undefined) writeVitePidFile(ownVitePid);

  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    if (await pingViteDev()) return;
    await new Promise((r) => setTimeout(r, 300));
  }
  if (ownVitePid !== undefined) { killPidTreeSync(ownVitePid); removeVitePidFile(); ownVitePid = undefined; }
  throw new Error('vite:dev did not come up within 30s');
}

function spawnTauriDriver(): ChildProcess {
  const proc = spawn('tauri-driver', [], { stdio: [null, process.stdout, process.stderr], shell: true });
  proc.on('error', (e) => console.error('tauri-driver failed to start:', e));
  return proc;
}

async function pingTauriDriver(): Promise<boolean> {
  return new Promise((res) => {
    const req = request(
      { host: '127.0.0.1', port: 4444, path: '/status', method: 'GET', timeout: 1500 },
      (r) => { r.resume(); res(true); },
    );
    req.on('error', () => res(false));
    req.on('timeout', () => { req.destroy(); res(false); });
    req.end();
  });
}

function killProcesses(names: string[]): Promise<void> {
  return new Promise((res) => {
    if (names.length === 0) { res(); return; }
    let pending = names.length;
    for (const t of names) {
      const p = spawn('taskkill', ['/F', '/IM', t, '/T'], { stdio: 'ignore', shell: true });
      p.on('close', () => { if (--pending === 0) res(); });
      p.on('error', () => { if (--pending === 0) res(); });
    }
  });
}

/** Forced respawn before each session — cheaper (~1s) than recovering from a
 *  wedged msedgedriver child mid-suite, and immune to the cascade failures seen
 *  when reusing the driver across specs. */
async function respawnTauriDriver(): Promise<void> {
  if (tauriDriver) { try { tauriDriver.kill('SIGKILL'); } catch { /* already dead */ } }
  await killProcesses(['agate.exe', 'tauri-driver.exe', 'msedgedriver.exe']);
  // WebView2 needs a beat to fully release between specs — too short a settle and
  // the next session's msedgedriver attaches to a blank standalone Edge.
  await new Promise((r) => setTimeout(r, 2_000));
  tauriDriver = spawnTauriDriver();
  const deadline = Date.now() + 8_000;
  while (Date.now() < deadline) {
    if (await pingTauriDriver()) return;
    await new Promise((r) => setTimeout(r, 80));
  }
  throw new Error('tauri-driver did not come up after restart');
}

// WDIO v9 auto-detects `tsx` for .ts config + specs. Point spec files at the test
// tsconfig (with wdio types included).
process.env.TSCONFIG_PATH = resolve(__dirname, 'tsconfig.json');

export const config: WebdriverIO.Config = {
  runner: 'local',
  specs: [resolve(__dirname, 'specs', '**', '*.spec.ts')],
  maxInstances: 1, // Tauri windows don't parallelise cleanly
  capabilities: [{
    browserName: 'wry',
    // Vendor-specific capability for tauri-driver; not in wdio types.
    'tauri:options': { application: APP_EXE },
  } as WebdriverIO.Capabilities],
  logLevel: 'warn',
  bail: 0,
  baseUrl: '',
  waitforTimeout: 10_000,
  connectionRetryTimeout: 120_000,
  connectionRetryCount: 3,
  framework: 'mocha',
  reporters: ['spec'],
  mochaOpts: { ui: 'bdd', timeout: 60_000 },

  // tauri-driver listens on 4444; msedgedriver is spawned as its native driver.
  port: 4444,
  hostname: '127.0.0.1',

  async onPrepare(): Promise<void> {
    if (!existsSync(APP_EXE)) {
      throw new Error(`App binary not found: ${APP_EXE}\nRun 'npm run test:e2e:build' first.`);
    }
    await ensureViteDev();
    tauriDriver = spawnTauriDriver();
  },

  // Edge/WebView2 `getText()` intermittently returns '' for elements that are
  // demonstrably rendered. Fall back to `textContent` when empty so specs read
  // the real content (a genuinely-empty element returns '' from textContent too,
  // so this only recovers the driver quirk).
  before() {
    browser.overwriteCommand('getText', async function (this: WebdriverIO.Element, origGetText: () => Promise<string>) {
      const t = await origGetText();
      if (t && t.trim() !== '') return t;
      const tc = await this.getProperty('textContent');
      return typeof tc === 'string' ? tc : t;
    }, true);
  },

  async beforeSession(): Promise<void> {
    // A FRESH tauri-driver per spec is what reliably attaches msedgedriver to the
    // app's WebView; a reused/idle driver attaches to a blank standalone Edge
    // (the about:blank flake). The settle inside respawnTauriDriver gives WebView2
    // time to release between specs.
    await respawnTauriDriver();
  },

  // Force-kill agate.exe before wdio's session DELETE so a slow WebView2 shutdown
  // can't stall teardown (we've seen UND_ERR_HEADERS_TIMEOUT when it wedges).
  async afterSession(): Promise<void> {
    await killProcesses(['agate.exe']).catch(() => { /* already gone */ });
  },

  onComplete(): void {
    shutdownHarness();
  },
};
