# Changelog

All notable changes to QueryDen are documented here. This project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html) and the format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/).

## [Unreleased]

### Fixed
- **[#28](https://github.com/openidle-dev/queryden/issues/28) — SQL autocomplete no longer collapses to empty after typing `.` on a schema-qualified table or table alias.** Monaco's default fuzzy matcher treats `.` as a member-access trigger and filters out completion labels that don't share a bare-name representation with the typed text. Two distinct cases broke from the same root cause: `SELECT * FROM app.` lost its schema-table suggestions, and `SELECT u.id FROM app.users u WHERE u.` lost its column suggestions on multi-dot lines (the legacy `tablePrefix` extractor also picked up the wrong dot on those lines). The completion provider now detects `<schema>.<typed>` and `<alias>.<typed>` contexts up-front via dedicated detectors and returns bare-name suggestions with a replacement range covering only the post-dot text, matching how DataGrip and DBeaver behave. `public.` also surfaces tables stored without an explicit schema prefix, and `<table>.` works for unaliased references like `SELECT users.id FROM app.users`. Logic extracted to `src/components/editor/completionContext.ts` and covered by 26 pure-function tests; the legacy `tablePrefix` branch is removed.

## [1.0.12] - 2026-05-14

Two long-standing SQL editor bugs fixed plus a cold-start performance pass. Selecting multiple statements in the editor and hitting Run no longer errors with "cannot insert multiple commands into a prepared statement" ([#20](https://github.com/openidle-dev/queryden/issues/20)). The Query Variables dialog stops popping up on `::cast` operators and inside dollar-quoted function bodies ([#19](https://github.com/openidle-dev/queryden/issues/19)). The entry JS bundle is ~17% smaller, and a couple of frontend memory leaks were resolved. A throwaway Postgres test database for contributors landed under `dev/test-db/`, along with the project's first Vitest pure-function suite (52 tests).

### Fixed
- **[#19](https://github.com/openidle-dev/queryden/issues/19) — Query Variables dialog now ignores `::cast`, string literals, dollar-quoted function bodies, and SQL comments.** The previous flat regex matched any colon-prefix identifier, so `value::jsonb` was prompting for a `:jsonb` variable, `CREATE FUNCTION ... $$ ... :NEW ... $$` was prompting for `:NEW`, and so on. Replaced with a small SQL-aware scanner shared by both `extractVariables` and `substituteVariables`.
- **[#20](https://github.com/openidle-dev/queryden/issues/20) — Selecting multiple statements and running them no longer errors with "cannot insert multiple commands into a prepared statement".** PostgreSQL's extended query protocol (which `tauri-plugin-sql` uses) rejects multi-statement prepared calls. QueryDen now splits selections client-side via a context-aware `splitStatements()` utility and feeds each statement to the existing run-all loop with proper per-statement gutter glyphs.
- `AppLayout` was eagerly importing `SettingsDialog` and `HelpDialog` alongside the lazy versions in `App.tsx`, pulling `react-markdown` and the settings tree into the cold-start chunk. Header buttons and search-popup CTAs now dispatch through the same window events the lazy boundary already listens for.
- `show-local-history` event listener leak in `MainContent` — `addEventListener` and `removeEventListener` used two distinct inline arrows, so cleanup never matched the registration. Handlers accumulated on every re-render of an effect that depended on frequently-recreated callbacks.
- Monaco SQL completion provider was holding the previous connection's full schema (up to 50k rows on wide DBs) past disconnect. The cache is now dropped via a `connection-disconnected` window event.

### Changed
- Cold-start bundle: eight modal dialogs (`Compare`, `Clone`, `ActivityMonitor`, `MultiQuery`, `AIAssistant`, `PsqlWindow`, `LocalHistoryDialog`, `DefinitionModal`) now load via `React.lazy` + `Suspense` and are only mounted when their open flag flips true. Three of them pull in their own Monaco instance — deferring those is the meaningful win. Entry chunk **1.01 MB → 838 KB raw (-17%), 271 KB → 234 KB gzipped (-13%)**.
- Removed the **"Allow SQL Execution"** toggle from Settings → Permissions & Rules. The setting already defaulted to `true` and the engine's defense-in-depth checks (`MainContent.tsx`, `ConnectionContext.tsx`) stay in place — but exposing the toggle was a footgun. Users can no longer accidentally disable SQL execution from the UI.

### Infrastructure
- New `dev/test-db/` directory: Docker Compose Postgres setup, schema/seed/triggers, and copy-paste SQL scripts that exercise each of the bugs fixed in this release. Documented in `dev/test-db/README.md`.
- First colocated Vitest suite under `src/`: `extractVariables` / `substituteVariables` (22 tests) and the new `splitStatements` utility (15 tests). Total frontend tests: 52. CI runs `npm test` on every PR.
- Documented the testing convention in `CLAUDE.md`: every bug fix lands with the failing test that proves it (pinned via `it.fails` if the fix can't ride along in the same PR).

### Known Issues
- [#27](https://github.com/openidle-dev/queryden/issues/27) — Result deserializer errors on `INT4[]` columns ("unsupported datatype"). The patched `tauri-plugin-sql` supports several array types but `int[]` specifically is unmapped. Workaround: cast to text in the SELECT.
- [#28](https://github.com/openidle-dev/queryden/issues/28) — Autocomplete suggestions vanish after typing `.` on a schema-qualified table name (e.g. `app.`). Monaco's filter treats the dot as a member-access trigger. Workaround: type the table name without the schema prefix.

## [1.0.11] - 2026-05-13

App icon regenerated. `src-tauri/icons/icon.ico` (and most derived PNGs/icns) still held the default Tauri "WORLD" placeholder from initial scaffolding — the source `icon.png` was swapped to the QueryDen network-graph design at some point but the derived assets were never re-emitted, so the v1.0.10 installer ended up embedding the Tauri globe as its file-explorer icon.

### Fixed
- Re-ran `npx @tauri-apps/cli icon src-tauri/icons/icon.png` to rebuild the full set: multi-resolution `icon.ico`, `icon.icns`, all derived PNGs, the Windows Store `Square*Logo` set, and the iOS/Android icon trees.

### Note
- Binary asset regen only — no code changes.

## [1.0.10] - 2026-05-13

Replaced the 740-line custom updater module with the official `tauri-plugin-updater` + `tauri-plugin-process` pair. v1.0.8 and v1.0.9 shipped a custom Windows install flow that pre-uninstalled the running version and then ran a silent `/S` install over a still-locked `queryden.exe` — leaving users with an orphaned binary, no registry entry, and no app to launch. The plugin handles this properly via NSIS Restart Manager on Windows, POSIX unlink-while-running on macOS, and AppImage in-place replacement on Linux.

### Security
- Updates are now signed against a minisign pubkey baked into the build. CI signs each artifact via the `TAURI_SIGNING_PRIVATE_KEY` and `TAURI_SIGNING_PRIVATE_KEY_PASSWORD` repo secrets, and emits a `latest.json` manifest as a release asset for the plugin to consume. Clients verify the `.sig` companion file before installing.

### Changed
- Release workflow emits `.sig` companions (via `createUpdaterArtifacts: true` in `tauri.conf.json`) alongside the existing `.sha256` files.
- Removed `src-tauri/src/updater.rs`, `src-tauri/windows/installer-hooks.nsh`, `UpdateCheckResultDto`, and the four custom updater IPC commands. The only custom updater code that survives is `get_build_info` in `lib.rs`, which surfaces the `QUERYDEN_BUILD_DATE` env var for the About dialog.
- Added `tauri-plugin-updater` + `tauri-plugin-process` (Cargo + npm), `plugins.updater.{endpoints,pubkey}` in `tauri.conf.json`, and the `updater:default` / `process:default` / `process:allow-restart` capabilities.
- Rolled back the Monaco lazy-loading from v1.0.9 in `MainContent.tsx` — the cold-start win was not worth the editor-modal startup latency.

### Fixed
- Windows: the v1.0.8/v1.0.9 broken install flow described above. The plugin's NSIS Restart Manager integration removes the need for the manual locked-file dance.
- macOS: atomic replacement via POSIX unlink-while-running.
- Linux: in-place replacement for the AppImage bundle.

### Note
- **The v1.0.9 → v1.0.10 upgrade requires a one-time manual install.** v1.0.9's broken updater cannot deliver this release cleanly. From v1.0.10 onward, in-app updates go through the signed plugin path.

## [1.0.9] - 2026-05-13

### Changed
- Monaco registration moved out of the cold-start path. Editor and editor-using modals are no longer eagerly imported in the entry bundle. *(Rolled back in v1.0.10 — see that release's notes.)*
- General codebase hygiene pass — typed IPC boundary (`src/lib/ipc.ts`), tightened CSP, normalized line endings.

### Fixed
- Linux `.deb`: pkexec policy fix so the installer no longer leaves a broken polkit action behind on uninstall.

## [1.0.8] - 2026-05-12

### Fixed
- Updater now downloads into a per-invocation random temp directory (mode 0700 on Unix) to defeat predictable-path symlink attacks.
- SHA256 verification step uses POSIX `find` for macOS bash 3.2 compatibility.

### Changed
- Aligned the Rust `tauri` crate version with `@tauri-apps/api` on npm to avoid IPC schema drift.

## [1.0.7] - 2026-05-13

### Changed
- **Windows**: cleaner in-app upgrades. The NSIS installer now silently removes the previous version before installing the new one via a preinstall hook, instead of asking the user to run the uninstaller manually. Installs are also now per-user by default (no UAC prompt) and the language selector is hidden.
- **Note for current Windows users**: the upgrade from v1.0.6 → v1.0.7 still requires a one-time UAC prompt because v1.0.6 was installed machine-wide; the hook detects and silently uninstalls the HKLM-scoped install. From v1.0.7 onward all installs are HKCU and all subsequent upgrades are fully seamless.

## [1.0.6] - 2026-05-13

No user-visible changes. Released to exercise the in-app updater end-to-end (the v1.0.5 → v1.0.6 path is the first one ever tested in production, since v1.0.5 was the very first public release).

### Changed
- README: clarified that the macOS download is Apple Silicon only and pointed Intel Mac users to [#7](https://github.com/openidle-dev/queryden/issues/7).

## [1.0.5] - 2026-05-13

First public release of QueryDen. Internal builds existed at versions 1.0.0–1.0.4 before open-sourcing but were never published; this is the first release available on the [releases page](https://github.com/openidle-dev/queryden/releases) and via the in-app updater.

QueryDen is a multi-database desktop manager built with Tauri 2, React, and TypeScript. It supports PostgreSQL, MySQL/MariaDB, SQLite, CockroachDB, and Supabase, with SSH tunneling, an encrypted credential vault, local history, saved queries, and an integrated `psql` console.

### Added
- Multi-database desktop manager: PostgreSQL, MySQL/MariaDB, SQLite, CockroachDB, Supabase.
- Per-platform bundles: Linux (`.deb`, AppImage), Windows (NSIS), macOS Apple Silicon (`.dmg`/`.app`). Intel macOS is planned for v1.0.6 as a universal-binary build; for now Intel Mac users can build from source.
- Local Monaco editor bundle — the SQL editor works offline, no runtime CDN dependency.
- Optional AI assistant supporting OpenAI, Anthropic, Google, and Ollama. Off by default. When enabled, prompts and the user's API key are sent directly from the desktop app to the configured provider — no QueryDen-operated server in the middle. See the README "Privacy & the AI assistant" section.
- Typed Tauri IPC boundary (`src/lib/ipc.ts`); no remaining `invoke<any>` call sites.

### Security
- AES-256-GCM encryption with Argon2id key derivation for connections, vault credentials, query history, saved queries, and local history.
- OS keyring storage for the master key (file fallback). Encryption refuses to proceed if neither persistence path is available — no silent degradation to known keys.
- Machine-binding: encrypted files refuse to load on a different machine.
- Brute-force protection: vault locks after 5 failed unlock attempts.
- Tauri filesystem permissions scoped to app data, downloads, documents, and desktop directories.
- Updater: SHA256 verification for every download. Fetches `<asset>.sha256` from the GitHub release before downloading the binary and refuses to install on digest mismatch.
- Updater: downloads land in a per-invocation random temp directory (mode 0700 on Unix) to defeat predictable-path symlink attacks.
- Updater: HTTPS-only — non-HTTPS update URLs are rejected.
- AI assistant `fetch()` calls use a 30-second abort timeout.

### Infrastructure
- `CONTRIBUTING.md`, `CODE_OF_CONDUCT.md`, `SECURITY.md`, plus issue and PR templates.
- CI on every push/PR: version-drift check, typecheck, Vitest unit tests, frontend build, `cargo check`, `cargo clippy -- -D warnings`, `cargo test`.
- Release workflow on tag push: cross-platform build matrix with `<asset>.sha256` companion files for the in-app updater.
- Dev-only `logger` utility so diagnostic output stays out of production builds.

[Unreleased]: https://github.com/openidle-dev/queryden/compare/v1.0.11...HEAD
[1.0.11]: https://github.com/openidle-dev/queryden/compare/v1.0.10...v1.0.11
[1.0.10]: https://github.com/openidle-dev/queryden/compare/v1.0.9...v1.0.10
[1.0.9]: https://github.com/openidle-dev/queryden/compare/v1.0.8...v1.0.9
[1.0.8]: https://github.com/openidle-dev/queryden/compare/v1.0.7...v1.0.8
[1.0.7]: https://github.com/openidle-dev/queryden/compare/v1.0.6...v1.0.7
[1.0.6]: https://github.com/openidle-dev/queryden/compare/v1.0.5...v1.0.6
[1.0.5]: https://github.com/openidle-dev/queryden/releases/tag/v1.0.5
