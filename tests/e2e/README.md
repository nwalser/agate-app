# Agate end-to-end tests

WebdriverIO + tauri-driver integration tests that drive the **real** debug binary
through WebView2 (Edge), exercising every screen — onboarding/login, 2FA, unlock,
vault list/search/filters, item detail (reveal/copy/TOTP), the item editor, bulk
operations, settings, the security report, the command palette, and multi-account
switching.

The approach mirrors the `themia-app` e2e suite: instead of talking to a live
Bitwarden vault, each spec installs an **in-page fake backend** that answers the
typed IPC commands, then drives the app through its real reactive flow.

## How it works

* `src/lib/ipc.ts` routes every `invoke` through a swappable transport. Under a
  Tauri **debug** build (`__AGATE_TEST_HOOKS__`) **and** WebDriver
  (`navigator.webdriver`), it exposes `window.__agateInvoke.setInvoke(fn)`.
  Both gates are false in a real release build, so the seam is dead-code-
  eliminated and never ships.
* `src/state/session.ts` exposes `window.__agateRefreshSession()` under the same
  gate so a spec can re-derive the top-level screen after swapping the fake
  (a page reload would wipe the in-page fake).
* `helpers/app.ts` installs the fake (`installFakeBackend`) and lands the app on
  a known screen (`gotoOnboarding` / `gotoUnlock` / `gotoVault` / `gotoSettings`).
* `helpers/fixtures.ts` holds the JSON-serializable fake config + a small sample
  vault.

## Prerequisites (one-time)

```bash
cargo install tauri-driver --locked
# Install Microsoft Edge Driver matching your installed Edge version:
#   https://developer.microsoft.com/microsoft-edge/tools/webdriver/
# Put msedgedriver.exe on PATH.
```

## Run

The harness force-kills `agate.exe` between specs, so **close any running
`npm run dev` / agate window first** — otherwise the build can't replace the
binary and the suite would kill your dev session.

```bash
npm run test:e2e:build           # tauri build --debug --no-bundle (embeds the test-hooks frontend)
npm run test:e2e                 # run all specs
npm run test:e2e:spec -- tests/e2e/specs/00-smoke.spec.ts   # one spec
npm run test:e2e:all             # build + run
```

The config (`wdio.conf.ts`) keeps a vite dev server up, spawns tauri-driver, and
cleans up all child processes on every exit path.
