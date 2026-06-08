/**
 * Serial e2e runner — runs each spec file in its OWN `wdio` process.
 *
 * Why: on Windows, tauri-driver + WebView2 reliably attaches msedgedriver to the
 * app's WebView only on a FRESH process; chaining many specs inside one `wdio`
 * run intermittently wedges into a blank standalone Edge (the about:blank /
 * ERR_CONNECTION_REFUSED flake). One process per spec keeps every spec on the
 * reliable single-spec path. Slower, but deterministic.
 *
 * Usage: node scripts/e2e-serial.mjs            (all specs)
 *        node scripts/e2e-serial.mjs 04 07      (only specs whose name contains a token)
 */
import { spawnSync } from 'node:child_process';
import { readdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, '..');
const SPEC_DIR = resolve(ROOT, 'tests', 'e2e', 'specs');
const CONF = resolve(ROOT, 'tests', 'e2e', 'wdio.conf.ts');

const filters = process.argv.slice(2);
const specs = readdirSync(SPEC_DIR)
  .filter((f) => f.endsWith('.spec.ts'))
  .filter((f) => filters.length === 0 || filters.some((t) => f.includes(t)))
  .sort();

const wdioBin = resolve(ROOT, 'node_modules', '@wdio', 'cli', 'bin', 'wdio.js');
const results = [];
let totalPass = 0;
let totalFail = 0;

for (const spec of specs) {
  const file = resolve(SPEC_DIR, spec);
  process.stdout.write(`\n──────── ${spec} ────────\n`);
  const out = spawnSync(process.execPath, [wdioBin, 'run', CONF, '--spec', file], {
    cwd: ROOT,
    encoding: 'utf8',
    env: process.env,
  });
  const text = `${out.stdout ?? ''}${out.stderr ?? ''}`;
  // Last "N passing" / "M failing" the spec reporter printed.
  const pass = [...text.matchAll(/(\d+) passing/g)].at(-1);
  const fail = [...text.matchAll(/(\d+) failing/g)].at(-1);
  const p = pass ? Number(pass[1]) : 0;
  const f = fail ? Number(fail[1]) : 0;
  // Surface assertion lines so failures are legible without re-running.
  for (const line of text.split(/\r?\n/)) {
    if (/✓|✖|AssertionError|No agate app|Error:|expected /.test(line) && !line.includes('WARN')) {
      process.stdout.write(`  ${line.replace(/^\[[^\]]*\]\s*/, '').trim()}\n`);
    }
  }
  totalPass += p;
  totalFail += f;
  results.push({ spec, p, f, ok: f === 0 && (p > 0 || out.status === 0) });
}

process.stdout.write('\n════════ e2e summary ════════\n');
for (const r of results) {
  process.stdout.write(`  ${r.f === 0 ? '✓' : '✖'} ${r.spec.padEnd(34)} ${r.p} passing${r.f ? `, ${r.f} failing` : ''}\n`);
}
process.stdout.write(`\n  TOTAL: ${totalPass} passing, ${totalFail} failing across ${results.length} specs\n`);
process.exit(totalFail > 0 ? 1 : 0);
