# Changelog

All notable changes to QueryDen are documented here. This project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html) and the format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/).

## [Unreleased]

## [1.0.5] - 2026-05-13

First public release of QueryDen. Internal builds existed at versions 1.0.0–1.0.4 before open-sourcing but were never published; this is the first release available on the [releases page](https://github.com/openidle-dev/queryden/releases) and via the in-app updater.

QueryDen is a multi-database desktop manager built with Tauri 2, React, and TypeScript. It supports PostgreSQL, MySQL/MariaDB, SQLite, CockroachDB, and Supabase, with SSH tunneling, an encrypted credential vault, local history, saved queries, and an integrated `psql` console.

### Highlights of the launch release

**Security and storage**

- AES-256-GCM encryption with Argon2id key derivation for connections, vault credentials, query history, saved queries, and local history.
- OS keyring storage for the master key (file fallback). Encryption refuses to proceed if neither persistence path is available — no silent degradation to known keys.
- Machine-binding: encrypted files refuse to load on a different machine.
- Brute-force protection: vault locks after 5 failed unlock attempts.
- Tauri filesystem permissions scoped to app data, downloads, documents, and desktop directories.

**In-app updater**

- SHA256 verification for every download. The updater fetches `<asset>.sha256` from the GitHub release before downloading the binary and refuses to install on digest mismatch.
- Updates download into a per-invocation random temp directory (0700 on Unix) to defeat predictable-path symlink attacks.
- HTTPS-only — non-HTTPS update URLs are rejected.

**Build and runtime**

- Local Monaco editor bundle. The SQL editor works offline; no runtime CDN dependency.
- Bundle targets for Linux (deb, AppImage), Windows (NSIS), and macOS (Intel + Apple Silicon dmg/app).
- AI assistant `fetch()` calls use a 30 s abort timeout.

**Optional AI assistant**

- OpenAI, Anthropic, Google, and Ollama supported.
- Off by default. When enabled, prompts and the user's API key are sent directly from the desktop app to the configured provider — no QueryDen-operated server in the middle. See the README "Privacy & the AI assistant" section.

**Project infrastructure**

- `CONTRIBUTING.md`, `CODE_OF_CONDUCT.md`, `SECURITY.md`, issue and PR templates.
- CI on every push/PR: version-drift check, typecheck, Vitest unit tests, frontend build, `cargo check`, `cargo clippy -- -D warnings`, `cargo test`.
- Release workflow on tag push: cross-platform build matrix with `<asset>.sha256` companion files for the in-app updater.
- Dev-only `logger` utility so diagnostic output stays out of production builds.
- Typed Tauri IPC boundary (`src/lib/ipc.ts`); no remaining `invoke<any>` call sites.

[Unreleased]: https://github.com/openidle-dev/queryden/compare/v1.0.5...HEAD
[1.0.5]: https://github.com/openidle-dev/queryden/releases/tag/v1.0.5
