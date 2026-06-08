# Signing, releases & auto-update

Agate is a $0-budget open-source project, so signing is split into three
independent pieces.

## 1. Updater signing (free, required for auto-update)

Tauri's updater verifies each download against an embedded **minisign** public
key. This is separate from OS code signing and costs nothing.

- A keypair was generated with `npm run tauri signer generate -- -w <path>`.
- The **public** key is committed in `src-tauri/tauri.conf.json` →
  `plugins.updater.pubkey`.
- The **private** key + its password are **not** in the repo. Set them as GitHub
  Actions secrets so `release.yml` can sign:
  - `TAURI_SIGNING_PRIVATE_KEY` — the contents of the private key file
  - `TAURI_SIGNING_PRIVATE_KEY_PASSWORD` — its password
- ⚠️ The private key is irreplaceable: if lost, already-installed users can never
  be updated. Back it up offline. To rotate, you must ship a one-time
  re-keyed build to existing users.

`bundle.createUpdaterArtifacts: true` makes `tauri build` emit a `.sig` next to
each updater artifact; `tauri-action` assembles `latest.json` on the GitHub
Release, which the in-app updater (Settings → Check for updates) reads.

## 2. Windows code signing (free for OSS via SignPath Foundation)

Unsigned Windows installers run but trigger a SmartScreen "unknown publisher"
warning. For free signing:

1. After the first public GitHub Release exists, apply to
   [SignPath Foundation](https://signpath.org/apply) (free OV certificate for OSS).
2. Add the required attribution (already in the README) and a Code Signing Policy.
3. Wire SignPath's "Trusted Build System" GitHub Actions integration to sign the
   release artifact on their HSM.

Note: an OV certificate does **not** instantly clear SmartScreen — reputation
builds over downloads/time. (As of 2024, even EV no longer bypasses it instantly.)

Interim: publish SHA-256 checksums and tell users to click **More info → Run
anyway**.

Azure Trusted/Artifact Signing ($9.99/mo) is a cheap upgrade path but is **not**
free (requires a paid Azure subscription; individual identity is US/CA only).

## 3. macOS signing & notarization (paid only)

There is **no free** macOS notarization — it requires a paid Apple Developer ID
($99/yr). Without it, downloaded builds are quarantined by Gatekeeper.

Until then, ship unsigned `.dmg` and document the first-launch workaround:

```sh
xattr -dr com.apple.quarantine /Applications/Agate.app
```

(or right-click the app → Open → Open on older macOS). To enable the paid path
later, set `APPLE_CERTIFICATE`, `APPLE_CERTIFICATE_PASSWORD`,
`APPLE_SIGNING_IDENTITY`, `APPLE_ID`, `APPLE_PASSWORD`, `APPLE_TEAM_ID` as
secrets — `release.yml` already consumes them.

## 4. Linux

No OS signing required for `.AppImage` / `.deb`. Publish SHA-256 checksums; an
optional detached GPG signature can be added. Only the `.AppImage` is
auto-updatable.

## Cutting a release

1. Bump the version in `src-tauri/tauri.conf.json` and `src-tauri/Cargo.toml`.
2. Commit, then push a tag: `git tag agate-v0.2.0 && git push --tags`.
3. `release.yml` builds all platforms, signs the updater artifacts, and creates a
   **draft** Release. Review it, then publish so the
   `releases/latest/download/latest.json` endpoint resolves for the updater.
