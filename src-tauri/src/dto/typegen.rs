//! Generates `src/lib/generated/dto.ts` from the Rust DTOs.
//!
//! Rust is the single source of truth for every IPC data shape: each DTO (and
//! the `AgateError` shape) derives `specta::Type` under `cfg(test)`, and this
//! test exports them all to one generated TypeScript file. `src/lib/types.ts`
//! re-exports the generated names, so every frontend import keeps working.
//!
//! The test runs in the normal `cargo test` suite: it regenerates the file
//! whenever the Rust side changed and then FAILS, so a stale committed mirror
//! can never slip through CI silently. Regenerate with:
//!
//! ```sh
//! cargo test --manifest-path src-tauri/Cargo.toml export_ts_types
//! ```

use std::path::PathBuf;

use specta::TypeCollection;
use specta_typescript::{BigIntExportBehavior, Typescript};

use super::*;
use crate::error::{AgateError, ErrorKind};

/// File-level header for the generated module. The output is lint-clean as-is
/// (types only); if a future specta version trips an eslint rule, add a
/// file-level `/* eslint-disable <rule> */` here.
const HEADER: &str = "\
// GENERATED FILE — do not edit.
// Source of truth: src-tauri/src/dto/*.rs + src-tauri/src/error.rs.
// Regenerate: cargo test --manifest-path src-tauri/Cargo.toml export_ts_types";

/// Every type that crosses the IPC boundary (both directions) plus the error
/// shape. Adding a DTO? Register it here or the frontend never sees it.
fn ipc_types() -> TypeCollection {
    let mut types = TypeCollection::default();
    types
        // auth / session / connections
        .register::<ServerConfig>()
        .register::<TwoFactorKind>()
        .register::<TwoFactorInput>()
        .register::<LoginResult>()
        .register::<ConnectionSummary>()
        .register::<UnlockStatus>()
        .register::<UnlockOutcome>()
        .register::<SessionStatus>()
        // window controls
        .register::<ControlsSide>()
        .register::<WindowControl>()
        .register::<WindowControlsLayout>()
        // security audit / dark web
        .register::<HealthBand>()
        .register::<ItemAudit>()
        .register::<VaultHealthReport>()
        .register::<ExposedResult>()
        .register::<BreachRecord>()
        .register::<AccountBreaches>()
        .register::<EmailError>()
        .register::<DarkWebReport>()
        // vault read shapes
        .register::<ItemType>()
        .register::<VaultItem>()
        .register::<LoginUri>()
        .register::<LoginDetail>()
        .register::<CustomFieldType>()
        .register::<CustomField>()
        .register::<ItemDetail>()
        .register::<PasskeyCredential>()
        .register::<Attachment>()
        .register::<SendSummary>()
        .register::<Collection>()
        .register::<TotpCode>()
        .register::<Folder>()
        .register::<ExportFormat>()
        // generator options
        .register::<PasswordGenOptions>()
        .register::<PassphraseGenOptions>()
        .register::<UsernameMode>()
        .register::<UsernameGenOptions>()
        // vault write shapes
        .register::<UriInput>()
        .register::<LoginInput>()
        .register::<CardInput>()
        .register::<IdentityInput>()
        .register::<SshKeyInput>()
        .register::<FieldInput>()
        .register::<ItemInput>()
        // AI access (local MCP server)
        .register::<AiGrant>()
        .register::<AiServerStatus>()
        .register::<AiAuditEntry>()
        // typed error surface
        .register::<ErrorKind>()
        .register::<AgateError>();
    types
}

#[test]
fn export_ts_types() {
    let ts = Typescript::new()
        .header(HEADER)
        // u64/i64/usize counts are small (item/breach counts, sizes); they
        // serialize as plain JSON numbers, so `number` is the faithful TS type.
        .bigint(BigIntExportBehavior::Number);

    // `Typescript::export` (not `export_to`) — `export_to` in 0.0.9 prepends
    // the header a second time, and we want full control of encoding anyway.
    let generated = ts
        .export(&ipc_types())
        .expect("specta TS export must succeed")
        .replace("\r\n", "\n");

    let path = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("..")
        .join("src")
        .join("lib")
        .join("generated")
        .join("dto.ts");

    // Normalize CRLF on the read side too, so a git autocrlf checkout doesn't
    // produce a spurious mismatch on Windows.
    let existing = std::fs::read_to_string(&path)
        .ok()
        .map(|s| s.replace("\r\n", "\n"));
    if existing.as_deref() == Some(generated.as_str()) {
        return; // up to date
    }

    let parent = path.parent().expect("generated dto.ts path has a parent dir");
    std::fs::create_dir_all(parent).expect("create src/lib/generated");
    // std::fs::write emits the bytes verbatim: UTF-8, no BOM, LF only.
    std::fs::write(&path, generated.as_bytes()).expect("write src/lib/generated/dto.ts");
    panic!(
        "src/lib/generated/dto.ts was stale and has been regenerated from the \
         Rust DTOs — review the diff and commit it, then re-run the test"
    );
}
