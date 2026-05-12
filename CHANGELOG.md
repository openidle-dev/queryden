# Changelog

All notable changes to QueryDen are documented here. This project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html) and the format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/).

## [Unreleased]

## [1.0.5] - 2026-05-13

This is the first OSS launch release. It rolls up a pre-launch audit pass covering security, runtime correctness, documentation, and the basic OSS-baseline files needed for outside contributors.

### Added
- Local Monaco editor bundle (no runtime CDN dependency); editor works offline.
- macOS `app` and `dmg` bundle targets.
- SHA256 verification for in-app updates. The updater fetches `<asset>.sha256` from the release before downloading the binary and refuses to install on digest mismatch.
- Privacy disclosure in README covering the optional AI assistant data flow.
- Dev-only logger utility (`src/utils/logger.ts`) so diagnostic output is silent in production builds.
- `CONTRIBUTING.md`, `CODE_OF_CONDUCT.md`, `SECURITY.md`, issue and PR templates, CI and release workflows, `.editorconfig`.

### Changed
- `storage.rs` encryption key derivation now propagates errors instead of silently falling back to a hardcoded sentinel key. Legacy decrypt paths are preserved so existing user data still loads.
- `encrypt()` returns `Result` and no longer writes plaintext when AES encryption fails.
- Tauri `fs:allow-write-text-file` and `fs:allow-write-file` capabilities are now scoped to app data, downloads, documents, and desktop directories (no longer unbounded).
- Updater downloads now land in a per-invocation random temp directory (0700 on Unix) instead of a predictable path.
- AI assistant `fetch()` calls use a 30 s timeout.

### Removed
- `pnpm-lock.yaml` (npm + `package-lock.json` is canonical).
- Tracked backup file `CompareDialog.tsx.backup`.
- Dead `public/loader.js.map` and `scripts/doc-gen.js`.

### Fixed
- Developer-machine path leak in `BUILD_WINDOWS.md`.
- Stale version reference in Windows build docs.
- CSP / script-src mismatch — Monaco was loaded from `cdnjs.cloudflare.com` while CSP only allowed `cdn.jsdelivr.net`.

## [1.0.4] - 2026-05

### Fixed
- App version display no longer shows the previous build's number after an update.

## [1.0.3] - 2026-04

### Added
- In-app update check and notification flow.
- Auto-commit support on version bump.

## [1.0.0] - 2026-04

Initial public release of QueryDen — multi-database desktop manager with PostgreSQL, MySQL/MariaDB, SQLite, CockroachDB, and Supabase support, SSH tunneling, an encrypted credential vault, query history, saved queries, and an integrated `psql` console.

[Unreleased]: https://github.com/openidle-dev/queryden/compare/v1.0.5...HEAD
[1.0.5]: https://github.com/openidle-dev/queryden/compare/v1.0.4...v1.0.5
[1.0.4]: https://github.com/openidle-dev/queryden/compare/v1.0.3...v1.0.4
[1.0.3]: https://github.com/openidle-dev/queryden/compare/v1.0.0...v1.0.3
[1.0.0]: https://github.com/openidle-dev/queryden/releases/tag/v1.0.0
