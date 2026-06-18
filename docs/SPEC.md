# Agate — Feature Specification

Authoritative inventory of every feature the app has or should have, derived from the
code itself (last full sweep: 2026-06-11). [DESIGN.md](DESIGN.md) is the historical
roadmap + SDK research; where the two disagree, this file wins.

**Status legend**

| Marker | Meaning |
|--------|---------|
| ✅ | Implemented and wired end-to-end |
| 🚧 | In progress / partially implemented (what's missing is stated) |
| 📋 | Planned, not started |
| ⚠️ | Implemented but unverified on that platform |

---

## 1. Product overview

Agate is an unofficial, open-source (GPLv3) desktop client for Bitwarden /
Vaultwarden, built with Tauri 2 (Rust) + SolidJS. It talks directly to the real
Bitwarden `identity`/`api` endpoints through Bitwarden's official Rust SDK
(`sdk-internal`, git-pinned). Headline feature: **one app password (or biometric)
unlocks every connected account at once**, and that setup survives restarts.
No Agate server exists; nothing is proxied through third-party infrastructure
except the opt-in breach checks described in §11.

## 2. Platform support matrix

| Feature | Windows | macOS | Linux |
|---------|---------|-------|-------|
| Core app (vault, sync, editing, settings) | ✅ | ✅ | ✅ |
| Biometric unlock | ✅ Windows Hello | ⚠️ Touch ID (untested) | ⚠️ polkit (untested) |
| OCR (fill from screen/image) | ✅ WinRT engine | 📋 (Vision) | 📋 (tesseract) |
| Autofill into other apps | 🚧 UIA (in progress) | 📋 (AXUIElement) | 📋 (AT-SPI) |
| Tray popup on left-click | ✅ | ✅ | menu-only (appindicator limitation) |
| Screen-capture exclusion (WDA_EXCLUDEFROMCAPTURE) | ✅ release builds | — | — |
| Code signing | local Certum cert (no CI) | unsigned (documented xattr workaround) | unsigned |

macOS/Linux biometric (`hello_unix.rs`, `robius-authentication`) compiles and fails
closed, but was written on Windows and has never been run on the target platforms.

## 3. Accounts & authentication

- ✅ **Server selection** — Bitwarden US cloud, EU cloud, or self-hosted base URL
  (https required; `http://localhost` allowed for dev). `server.rs`
- ✅ **Self-hosted prelogin proxy** — loopback proxy that rewrites the one prelogin
  path the SDK can't reach on self-hosted servers. `proxy.rs`
- ✅ **Email + master-password login** with KDF prelogin. `auth.rs`
- ✅ **Two-factor auth** — authenticator (TOTP) and email codes, on first login and
  on every cold-start re-login for 2FA-enforced accounts (SDK uses a hardcoded
  device id, so the server re-prompts; `unlock_connection_2fa` completes them).
- ✅ **Multiple connections** — any number of accounts across servers; add, edit
  (change server / re-authenticate / toggle credential storage), remove, list.
  `connections.rs`
- ✅ **Per-connection credential storage choice** — store (auto-unlock with the
  rest) or manual unlock each session.
- ✅ **Unified item list** — items from all unlocked vaults in one list, each
  stamped with its account; per-account switching via the vault switcher.
- 📋 **Organization / collection browsing** — collections are fetched and shown as
  an optional list column, but there is no sidebar filter or browse-by-collection
  UI, and no collection editing.

## 4. Unified app unlock (the security model)

Full detail in CLAUDE.md and SECURITY.md; spec summary:

- ✅ **One app password unlocks everything** — Argon2id (64 MiB / 3 iter) derives
  the App Unlock Key (AUK), which wraps a random Vault Master Key (VMK); the VMK
  seals each connection's master password into the OS keychain (`cred:<email>`,
  AES-256-GCM with AAD identity binding). Wrong password = GCM tag failure.
  `secrets/`, `appunlock.rs`
- ✅ **Master passwords ARE persisted, sealed — by design.** The pinned SDK has no
  public token restore, so surviving a restart requires re-login on unlock. Do not
  "fix" this back to in-memory-only.
- ✅ **Device binding** — a keychain-stored device pepper is mixed into AUK
  derivation; copied blobs are unusable on another machine.
- ✅ **Change app password** — atomically re-wraps the VMK; per-connection blobs
  never move.
- ✅ **Biometric unlock** — Windows Hello consent gate releases a DPAPI-protected
  VMK copy (see §2 for macOS/Linux status). Enable/disable in Settings → Unlock.
- ✅ **Per-connection unlock outcomes** — unlock-all reports
  `unlocked | twoFactorRequired | failed` per account; 2FA completed one-by-one.
- ✅ **Lock** zeroizes clients, caches, VMK. **Logout** additionally deletes all
  sealed blobs and unlock flags (connection list kept for easy re-add).
- ✅ **Auto-lock** — idle timeout (never / 1m / 5m / 10m / 15m / 30m / 1h / 4h /
  8h / 24h) + optional lock-on-minimize. `state/autolock.ts`
- 📋 **Future hardening** — when the SDK exposes token persistence: store sealed
  user key + tokens instead of the master password.

## 5. Vault browsing

- ✅ **Item list** — table or list layout; row density (compact / default /
  comfortable); optional favicons.
- ✅ **Configurable columns** — Name (always), Username, Password, TOTP, Website,
  Email, Type, Folder, Attachments, Collections, Security verdict, any custom
  field. Reorder, resize, show/hide, reset. Secret columns are masked and
  lazy-decrypted only when revealed. `state/columns.ts`, `detailCache.ts`
- ✅ **Sorting & grouping** — sort by column; group by type / folder / custom field.
- ✅ **Per-column filters** — filter row per column, toggleable.
- ✅ **Fuzzy search** — subsequence match + scoring + highlight over names,
  usernames, websites, emails; live as you type. `lib/search.ts`
- ✅ **Built-in sidebar filters** — All Items, Favorites, Trash, per-type (logins /
  cards / identities / notes / SSH keys), folder tree with counts.
- ✅ **Saved views** — persist filter + search + sort + column state under a name
  + icon; sidebar shows a dirty indicator and "save changes" bar when the live
  state diverges. `lib/sidebarConfig.ts`
- ✅ **Sidebar customization** — reorder, hide, dividers with labels, reset
  (Settings → Sidebar).
- ✅ **Command palette** — Ctrl/⌘+K, searches items and commands.
- ✅ **Keyboard navigation** — ↑/↓, Home/End, Shift-range, Ctrl+A, Alt+←/→
  history, `/` to search, `?` shortcuts overlay, Esc.
- ✅ **Selection & bulk actions** — checkbox / shift / ctrl / drag-marquee
  selection; bulk move, favorite, delete, restore. `hooks/useBulkActions.ts`
- ✅ **Drag & drop** — drag items onto folders.
- 📋 **Export selection** — bulk-export only the selected items (full-vault export
  exists, §16).

## 6. Item detail & editing

- ✅ **Detail pane** — read-only view with type-specific fields, custom fields,
  markdown notes, per-item security verdict, attachment downloads, TOTP ring,
  copy/reveal/open context menus per field.
- ✅ **Inline editor** — editing happens in the detail pane, never a modal
  (hard user preference). Create, edit, clone. `ItemEditor.tsx`
- ✅ **Item types** — Login (username, password, URIs with match types
  Domain/Host/StartsWith/Exact/Regex/Never, TOTP key), Card (brand auto-detect),
  Identity, Secure Note, SSH Key. Unknown types render read-only.
- ✅ **Common fields** — name, folder, favorite, master-password reprompt flag,
  notes, custom fields (text / hidden / boolean / linked).
- ✅ **Reprompt gate** — reprompt-flagged items require the app password before
  revealing secrets (main window only; tray popup defers). `RepromptGate.tsx`
- ✅ **Templates** — user-defined item templates (type, default notes, custom
  fields) creatable from the Add menu (Settings → Templates).
- ✅ **Attachments: download** — decrypt to the Downloads folder.
- 📋 **Attachments: upload/delete** — SDK requires manual api-api calls; no UI.
- 📋 **Password history view** — SDK exposes `PasswordHistoryView`; no UI renders it.

## 7. Vault organization & writes

- ✅ **Folders** — create, rename, delete (delete via api-api), folder tree.
- ✅ **Favorites** — toggle single + bulk.
- ✅ **Trash** — soft delete, restore, permanent delete; trash view.
- ✅ **All writes route by (account, item id)** through `mutate.rs`; a sync runs
  first so the SDK repository is populated.

## 8. TOTP

- ✅ Built-in TOTP codes with live countdown ring; one-click copy; TOTP column.
- ✅ **QR import** — scan all monitors for an `otpauth://` QR to fill the TOTP key
  (errors if multiple distinct QRs are visible — deliberate safety).

## 9. Generators

- ✅ **Password** — length 4–128, char classes, min counts, avoid-ambiguous.
- ✅ **Passphrase** — word count, separator, capitalize, include number.
- ✅ **Username** — plus-addressed (`user+tag@domain`), catch-all, random.
- ✅ **Generator page + inline popover** in the editor; session-scoped history
  (cleared on lock), restore from history.

## 10. Sends (Bitwarden Send)

- ✅ **List** sends across unlocked accounts (type, views, password flag,
  disabled, expiry); copy link; revoke/delete.
- ✅ **Create text Send** — expiry presets/custom, max views, optional password,
  hide-email, target account picker.
- 🚧 **Create file Send** — backend (`create_file_send`: encrypt, upload, rollback
  on failure) and UI kind-picker are written but uncommitted. Missing: commit +
  live verification against a real server.

## 11. Security Center

- ✅ **Offline audit** (no network, configurable per check in Settings → Audit):
  reused passwords (hash-grouped, threshold ≥2/3/5), weak (zxcvbn, threshold
  fair/good/strong), old (1mo–2yr), insecure `http://` URIs, missing TOTP.
- ✅ **Vault health score** 0–100 with at-risk item drill-down.
- ✅ **Exposed-password check (opt-in)** — HIBP k-anonymity: only the 5-char SHA-1
  prefix leaves the device, always with `Add-Padding`; padded zero-counts dropped.
- ✅ **Dark-web monitor (opt-in, consent enforced at the command boundary)** —
  vault emails checked against XposedOrNot (full email sent over TLS — stated in
  the UI), plus a read-only HIBP breach directory (no email sent).
- ✅ **Encrypted scan cache** — breach/exposed results sealed under the VMK in the
  keychain, restored on unlock.
- ✅ **Per-item security verdict** in list column + detail pane.
- 📋 **Active anti-phishing warning** — insecure URIs are flagged in the audit,
  but there is no warning at the moment of opening an `http://` URL.

## 12. Cleanup Center (maintenance area, separate from Security)

- 🚧 **Link health checker** — on-demand-only scan (never background; privacy note
  shown first: reveals the domain list to those servers): pings every login URI
  concurrently, classifies ok / broken / unreachable / uncertain, broad-flag rule
  (prefer false positives over silent rot), open-item per finding. Wired
  end-to-end but uncommitted. `cleanup/links.rs`, `components/cleanup/`
- 📋 **Duplicate item finder** — planned second tool.
- 📋 **Empty/stale item finder** — planned.

## 13. Autofill (fill other apps' login fields)

- 🚧 **Windows autofill engine** — opt-in, off by default; modes Off / Hotkey
  (Ctrl+Alt+\) / Watch (focus hook). UIA detects the focused password field,
  records a one-shot-token-bound pending target, the tray popup shows ranked
  candidates (`matching.rs`), the user picks, injection via `inject.rs`. Secrets
  never cross IPC; fetched at fill time and zeroized. `src-tauri/src/autofill/`
  **State: backend engine (detect / rank / fill / mode persistence) written;
  missing: `watcher.rs` (declared but absent — does not compile yet), Tauri
  command registration, settings UI, tray popup integration.**
- 📋 **macOS (AXUIElement) / Linux (AT-SPI) backends** — engine compiles there,
  reports unsupported, refuses to arm.

## 14. OCR — fill from image

- ✅ **Windows** — capture all monitors or pick an image file, recognize text
  lines (native WinRT OCR, nothing bundled), used by "fill from image" in card /
  identity / login editors. Recognized text treated as secret (never logged);
  Agate's own windows are excluded from capture in release builds.
- 📋 **macOS / Linux** — report unavailable; UI hides the buttons.

## 15. AI access (local MCP server)

- ✅ **Loopback MCP server** (`127.0.0.1:41999`) exposing the vault to a local AI
  client; off by default, fails closed (503 until enabled + unlocked).
- ✅ **Auth** — keychain-stored bearer token, constant-time compare, POST-only,
  1 MB body cap.
- ✅ **Allowlist-only** — `list_vault_items` returns metadata of granted items
  only; `get_vault_item` reveals secrets for granted items only; denied probes
  return 401 without decrypting the name. Reveal mode + allowlist are deliberate
  user choices.
- ✅ **Audit log** — every read (and denial, with item id) logged in memory
  (200-entry cap, cleared on restart), shown in Settings → AI Access.
- ✅ **Settings page** — enable toggle, URL + masked token with copy, per-item
  grant toggles with search, audit view.

## 16. Import / Export

- ✅ **Export** — full vault to cleartext JSON (Agate schema) or
  Bitwarden-compatible CSV, written to Downloads, loud cleartext warning.
- ✅ **Import** — Bitwarden-compatible CSV via native file picker into a chosen
  connection; reports imported count.
- 📋 **Encrypted export** — SDK supports EncryptedJson; no UI.
- 📋 **More import formats** (other managers' CSV/JSON).

## 17. Sync

- ✅ Background sync every 5 minutes + manual "Sync now"; per-state UI (idle /
  syncing / error with retry), last-sync time, sync status sidebar view.
- ✅ Offline banner when the network is gone; cached decrypted items remain
  browsable while unlocked.

## 18. Tray & quick-access popup

- ✅ **Tray icon** — left-click toggles the popup (position clamped to the
  monitor work area, never overlaps the taskbar); right-click menu (Show / Quit).
- ✅ **Popup window** — always-on-top compact search-and-copy: fuzzy search, copy
  username / password / TOTP / URL, recent items shared with the main window,
  retains query/scroll/selection across open/close (deliberate choice — never
  revert to wipe-on-hide), reacts to lock/unlock via `agate://session-changed`,
  Esc hides, "Open Agate" raises the main window. No reprompt-gated reveals.
- ✅ **Close to tray** — optional: closing the main window hides it instead of
  quitting.
- ✅ **Start in tray** — optional: autostart launches hidden, tray icon only.

## 19. Window, startup & lifecycle

- ✅ Custom titlebar with platform-aware window controls (GNOME `button-layout`
  respected on Linux; traffic lights on macOS).
- ✅ Launch at login (tauri-plugin-autostart).
- ✅ Single instance — second launch reveals the existing window.
- ✅ Window state (size/position) persisted across restarts; tray-popup
  visibility deliberately excluded.
- ✅ Config: non-secret JSON in the platform config dir, schema-versioned, atomic
  writes with rollback via `AppState::update_config`; all secrets keychain-only.

## 20. Updates

- ✅ Signature-verified updater (tauri-plugin-updater + minisign): manual check +
  install, optional check-on-launch, optional auto-install. The vault is locked
  (VMK zeroized) before the installer runs.
- ✅ CI + release workflows (`.github/workflows/`); Windows binaries signed
  locally via the Certum/SimplySign cert (key non-exportable, so no CI signing).

## 21. Settings reference

| Page | Group | Contents |
|------|-------|----------|
| Connections | Vault | account list + unlock state, add/edit/unlock/remove, log out of everything |
| Export / Import | Vault | §16 |
| AI Access | Vault | §15 |
| Unlock | Global | change app password, device binding info, biometric toggle, per-connection storage mode |
| Security | Global | exposed-password toggle, dark-web toggle, auto-lock timeout, lock-on-minimize, clipboard auto-clear (never/10s/30s/60s) |
| Audit | Global | per-check enable + thresholds (§11), reset |
| Appearance | Global | theme (system/light/dark), language, table/list layout, density, favicons, startup section |
| Startup | Global | launch at login, start in tray, close to tray |
| Sidebar | Global | entry order/visibility, dividers, saved-view management, reset |
| Templates | Global | template CRUD (§6) |
| Updates | Global | version info, check/install, auto-check, auto-install, about |

Settings search filters pages by name/keywords. All pages use the shared
Switch/ToggleRow/Segmented/ResetButton controls — never roll a new toggle.

## 22. Localization

- ✅ English (source of truth), German, Spanish — themia-style locale modules
  (`src/locales/{en,de,es}.ts`), dotted keys, `{placeholder}` interpolation,
  `*One/*Other` plural keys, key-parity test, first-run OS-locale detection.
- 📋 Further languages — add a locale module + register it (see
  i18n architecture notes).

## 23. Clipboard

- ✅ Copy actions everywhere (fields, columns, context menus, tray, palette) with
  toast feedback.
- ✅ Auto-clear copied secrets after a configurable timeout (§21 Security).

## 24. Security invariants (non-negotiable)

- Secrets live in the OS keychain only, sealed (AES-256-GCM + AAD); never in
  config files, logs, or error messages; zeroized in memory after use.
- All security/breach checks run client-side; only the HIBP 5-char hash prefix
  (passwords, opt-in) and the plaintext email to XposedOrNot (dark-web, opt-in,
  consent-gated) ever leave the device.
- No `.unwrap()` in non-test Rust; commands never panic; typed `AgateError` set.
- IPC shapes are generated from Rust DTOs (`cargo test export_ts_types`); never
  hand-mirrored.
- TLS never weakened; no debug backdoors in release builds.
- Fail closed: any error in unlock, MCP auth, or biometric paths denies access.

## 25. Backlog summary (everything not ✅ above)

| Feature | Status | Section |
|---------|--------|---------|
| File Sends (commit + live verify) | 🚧 | §10 |
| Cleanup: link health (commit) | 🚧 | §12 |
| Autofill Windows (watcher + commands + UI) | 🚧 | §13 |
| Autofill macOS/Linux | 📋 | §13 |
| Biometric verify on macOS/Linux | ⚠️ | §2 |
| OCR macOS/Linux | 📋 | §14 |
| Org/collection browsing | 📋 | §3 |
| Password history view | 📋 | §6 |
| Attachment upload/delete | 📋 | §6 |
| Export selection | 📋 | §5 |
| Encrypted export + more import formats | 📋 | §16 |
| Active anti-phishing warning on open | 📋 | §11 |
| Cleanup: duplicate / empty item finders | 📋 | §12 |
| More languages | 📋 | §22 |
| Token persistence instead of sealed master passwords | 📋 (blocked on SDK) | §4 |
