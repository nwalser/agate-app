---
name: agate-i18n-architecture
description: How i18n works in agate-app (themia-style locales, t/tm, reactive getters, parity test) and how to extend it
metadata:
  type: project
---

Agate i18n was added 2026-06-10, modeled on themia-app's approach (see [[agate-app-decisions]]).

- **Files:** `src/locales/{en,de,es}.ts` are nested message objects; `en.ts` is the source of
  truth and also exports `Messages`/`PartialMessages` types. `de`/`es` are `PartialMessages`
  (may omit keys → fall back to English). `src/lib/i18n.ts` flattens to dotted keys, exposes
  `t(key, params?)` (reactive, reads a `locale` signal), `tm()`, `LOCALES`, `locale`,
  `setLocale`, and `maybeInitLanguageFromSystem()`. `src/lib/i18nFormat.ts` does `{name}`
  interpolation. Locale persists in `localStorage['agate.locale']`; first run detects the OS
  language via the Rust `get_system_locale` command (sys-locale crate).
- **Keys are loose strings** (`t('ns.key')`), not a compile-checked union — matches themia.
  Safety nets: `src/locales/locales.test.ts` (no locale may have a key absent from `en`) +
  a one-time console warn for a missing key at runtime. There is **no plural engine** — use
  separate `*One`/`*Other` keys chosen by a ternary at the call site.
- **Reactivity trap (important):** never call `t()` at module top-level to build a constant
  that gets rendered — it freezes the language. For shared label maps/arrays in `lib/`+`state/`
  (item types, columns, linked fields, URI match, etc.) the pattern is **object getters**
  (`{ get label() { return t('itemType.login'); } }`) so the access shape stays the same and
  the value re-resolves on language switch. For module-level lists in components, convert to a
  function called in render (see `ShortcutsOverlay.groups()`).
- **Left intentionally English:** backend error strings passed to `toastError(err)`, brand/
  technical tokens (Agate, Bitwarden, TOTP, 2FA, SSH, URLs, region values), card brands
  (persisted identifiers in `cardBrands.ts`), and dynamic user data (item/field/folder names).
  `fieldKinds.ts` labels are logic keys (`FIELD_KIND_TO_INT`) — kept English, translated only
  at the display edge.
- **To add a language:** add the code to the `Locale` union + `LOCALES` + the regex in
  `maybeInitLanguageFromSystem` in `src/lib/i18n.ts`, create `src/locales/<code>.ts`, and import
  it into `i18n.ts`'s `dictionaries`. To add a key: put English in `en.ts` (nested), then add
  translations to `de.ts`/`es.ts` (or leave them to fall back).
