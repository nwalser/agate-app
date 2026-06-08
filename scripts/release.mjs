#!/usr/bin/env node
// Cut a release: sync the version across every file that carries it, commit, and
// create the `agate-v<version>` tag that .github/workflows/release.yml listens
// for. Does NOT push — review the commit/tag, then `git push --follow-tags`.
//
//   npm run release -- 0.2.0
//
// Keeping package.json, src-tauri/tauri.conf.json, src-tauri/Cargo.toml and
// Cargo.lock in lock-step is what makes the release workflow's version guard pass.

import { readFileSync, writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const version = process.argv[2];

if (!version || !/^\d+\.\d+\.\d+(-[0-9A-Za-z.]+)?$/.test(version)) {
  console.error('Usage: npm run release -- <semver>\n  e.g. npm run release -- 0.2.0');
  process.exit(1);
}

const tag = `agate-v${version}`;

// --- update the version-bearing files ---------------------------------------

function patch(relPath, transform) {
  const path = join(root, relPath);
  const before = readFileSync(path, 'utf8');
  const after = transform(before);
  if (after === before) {
    console.warn(`! ${relPath}: version already ${version} (unchanged)`);
    return;
  }
  writeFileSync(path, after);
  console.log(`✓ ${relPath}`);
}

function bumpJson(relPath) {
  patch(relPath, (raw) => {
    const obj = JSON.parse(raw);
    obj.version = version;
    // Preserve 2-space indentation + trailing newline (matches the repo style).
    return `${JSON.stringify(obj, null, 2)}\n`;
  });
}

bumpJson('package.json');
bumpJson('src-tauri/tauri.conf.json');

// Cargo.toml: only the [package] version (the first `version = "..."`).
patch('src-tauri/Cargo.toml', (raw) =>
  raw.replace(/(^\[package\][\s\S]*?^version\s*=\s*")[^"]+(")/m, `$1${version}$2`),
);

// Cargo.lock: the agate package entry, so the locked build stays consistent.
patch('src-tauri/Cargo.lock', (raw) =>
  raw.replace(/(^name = "agate"\nversion = ")[^"]+(")/m, `$1${version}$2`),
);

// --- commit + tag ------------------------------------------------------------

const git = (...args) => execFileSync('git', args, { cwd: root, stdio: 'inherit' });

git('add', 'package.json', 'src-tauri/tauri.conf.json', 'src-tauri/Cargo.toml', 'src-tauri/Cargo.lock');
git('commit', '-m', `chore(release): ${tag}`);
git('tag', '-a', tag, '-m', `Agate v${version}`);

console.log(`\nTagged ${tag}. Review, then publish the release with:\n  git push --follow-tags\n`);
