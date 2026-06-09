# Agate end-to-end tests

WebdriverIO + tauri-driver integration tests that drive the **real** debug binary
through WebView2 (Edge), exercising every screen — app-unlock setup, unlock
(unlock-all + per-connection 2FA), the vault list/search/filters, item detail
(reveal/copy/TOTP), the item editor, bulk operations, settings, the security
center, the command palette, connections, and the generator page.

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
  gate so a spec can re-derive the top-level screen after swapping the fake.
* `helpers/app.ts` installs the fake (`installFakeBackend`) and lands the app on a
  known screen (`gotoSetup` / `gotoUnlock` / `gotoVault` / `gotoSettings` /
  `gotoSecurity`). `attachToApp` force-navigates to the app URL, which also resets
  per-test state (the app keeps module/component state across a spec file's `it`s).
* `helpers/fixtures.ts` holds the JSON-serializable fake config + a sample vault.

Two facts the fake must honor (both bit us): list reads (`list_items`, …) return
**fresh object copies** each call so Solid's signals/`<For>` actually re-render
after a mutation; and the fake router runs in the **page** context, so it can't
reference Node-scope imports (use values from the serialized config).

## Prerequisites (one-time)

```bash
cargo install tauri-driver --locked        # needs tauri-driver >= 2.0.6
# Install Microsoft Edge Driver whose version MATCHES the installed WebView2
# runtime (a mismatched major fails to attach):
#   https://developer.microsoft.com/microsoft-edge/tools/webdriver/
# Put msedgedriver.exe on PATH.
```

Check the runtime version under
`C:\Program Files (x86)\Microsoft\EdgeWebView\Application\` and grab the matching
`msedgedriver` build from `https://msedgedriver.microsoft.com/<version>/edgedriver_win64.zip`.

## Run

Close any running `npm run dev` / agate window first — the harness force-kills
`agate.exe`, and a running app also locks the binary so the build can't replace it.

```bash
npm run test:e2e:build      # tauri build --debug --no-bundle (embeds the test-hooks frontend)
npm run test:e2e            # run all specs (serial runner — see below)
npm run test:e2e:all        # build + run
npm run test:e2e:spec -- tests/e2e/specs/00-smoke.spec.ts   # one spec via wdio
node scripts/e2e-serial.mjs 06-item 07-bulk                 # only specs matching a token
```

### Why a serial runner (`scripts/e2e-serial.mjs`)

On Windows, tauri-driver attaches msedgedriver to the app's WebView reliably only
on a **fresh** driver process. Chaining all specs inside one `wdio` run
intermittently wedges into a blank standalone Edge (`about:blank` /
`ERR_CONNECTION_REFUSED`). `scripts/e2e-serial.mjs` runs **one `wdio` process per
spec**, which keeps every spec on the reliable single-spec path, then aggregates
the results. That's what `npm run test:e2e` uses. The single-process variant is
still available as `npm run test:e2e:wdio` (faster, but flaky here).
