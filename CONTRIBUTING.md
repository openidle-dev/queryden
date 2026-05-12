# Contributing to QueryDen

Thanks for considering a contribution! QueryDen is a Tauri 2 desktop database manager and we're happy to take pull requests for bug fixes, new database support, UX polish, and documentation.

## Ground rules

- Be kind. See the [Code of Conduct](CODE_OF_CONDUCT.md).
- Open an [issue](https://github.com/openidle-dev/queryden/issues) before starting non-trivial work so we can agree on scope.
- One logical change per PR. Smaller PRs land faster.
- New features and behavior changes should mention what they touched in [CHANGELOG.md](CHANGELOG.md) under `## [Unreleased]`.

## Development setup

### Prerequisites
- **Node.js 18+** and **npm** (npm is canonical; `package-lock.json` is the tracked lockfile)
- **Rust 1.70+** via [rustup](https://rustup.rs/)
- Platform build tools — see [Tauri's prerequisites](https://tauri.app/start/prerequisites/) for your OS

### Run the app
```bash
git clone https://github.com/openidle-dev/queryden.git
cd queryden
npm install
npm run tauri dev
```

The Tauri shell wraps Vite. Vite is pinned to port `1420` (`strictPort: true`) by Tauri convention — if something else is on 1420, free it before starting the dev server.

### Build a release artifact
```bash
npm run tauri build
```
Output lands in `src-tauri/target/release/bundle/`. For cross-compiling to Windows from Linux, see [BUILD_WINDOWS.md](BUILD_WINDOWS.md).

## Repository layout

```
queryden/
├── src/                       React + TypeScript frontend
│   ├── components/            UI components (editor, explorer, results, tools, ui)
│   ├── contexts/              React contexts (connection lifecycle, theme)
│   ├── store/                 Zustand stores (one per concern)
│   ├── utils/                 SQL formatter, security helpers, dev-only logger
│   └── config/                App + provider configuration
├── src-tauri/                 Rust backend
│   ├── src/
│   │   ├── storage.rs         Encrypted file storage (AES-256-GCM + Argon2id)
│   │   ├── ssh.rs             SSH tunnel lifecycle (ssh2 crate)
│   │   ├── cli.rs             External DB CLI download + execution (psql, mysql, ...)
│   │   ├── updater.rs         Custom updater with SHA256 verification
│   │   └── sysinfo.rs         System info for the about dialog
│   ├── capabilities/          Tauri permission scopes (scoped to app data dirs)
│   └── patches/               Patched tauri-plugin-sql (extended PG type support)
└── scripts/                   Maintenance scripts
```

See [CLAUDE.md](CLAUDE.md) for a deeper architecture walkthrough — it's written for AI assistants but doubles as the canonical "how this fits together" doc.

## Coding conventions

There's no linter or formatter wired up yet (that's on the roadmap — see [#1](https://github.com/openidle-dev/queryden/issues) if you'd like to drive it). Until then:

- **TypeScript** — keep `strict: true` happy. Prefer specific types over `any`. The Tauri IPC boundary is the main exception; we're tightening that gradually.
- **React** — function components and hooks. Use Zustand for cross-component state, React Context for connection lifecycle.
- **Logging** — use `src/utils/logger.ts` (silent in production) for diagnostics. Don't ship `console.log`. `console.error` / `logger.error` is fine for real errors.
- **Rust** — propagate errors via `Result<T, String>` (matches Tauri's command convention). Avoid `unwrap()` / `expect()` outside of true invariants. Use `tracing::warn!` / `tracing::error!` instead of `eprintln!` so log filtering works.
- **No emojis in source** unless the user-facing UI needs them.

Indentation is 2 spaces (JS/TS/JSON) and 4 spaces (Rust, per `rustfmt` defaults). Trailing whitespace is trimmed; final newline preserved. See [`.editorconfig`](.editorconfig).

## Tests

There is no automated test suite yet. CI runs `tsc --noEmit`, `cargo check`, and `cargo clippy -- -D warnings`. If you're adding a Rust function with non-trivial logic, please include a `#[cfg(test)]` block.

## Tauri command surface

Every new `#[tauri::command]` must be registered in `src-tauri/src/lib.rs` inside `tauri::generate_handler!`. Forgetting this is the single most common cause of "command not found" errors at runtime.

## Security-sensitive changes

If your change touches `storage.rs`, `updater.rs`, the `capabilities/` directory, or the AI assistant code path, please call it out in the PR description. We default to extra review.

To report a vulnerability privately, see [SECURITY.md](SECURITY.md). Please don't open public issues for security problems.

## Cutting a release (maintainers)

1. Update `CHANGELOG.md` — move `Unreleased` entries to a new version section.
2. Run the bump script. It keeps `package.json`, `src-tauri/Cargo.toml`, `src-tauri/Cargo.lock`, and `src-tauri/tauri.conf.json` in lockstep:
   ```bash
   node scripts/bump-version.js patch          # 1.0.4 -> 1.0.5
   node scripts/bump-version.js minor          # 1.0.4 -> 1.1.0
   node scripts/bump-version.js major          # 1.0.4 -> 2.0.0
   node scripts/bump-version.js 1.2.3          # explicit target
   ```
3. Review the diff, then commit and tag:
   ```bash
   git add -A
   git commit -m "chore: release vX.Y.Z"
   git tag vX.Y.Z
   git push --follow-tags
   ```
4. The `Release` workflow takes it from there — it builds artifacts for Linux, Windows, and macOS (Intel + Apple Silicon), generates `<asset>.sha256` companions (required by the in-app updater), and publishes the GitHub release.

> CI runs a **version drift check** on every push. If any of the four files disagree, the build fails before any other job runs. If you ever see that error, re-run the bump script.

## License

By contributing, you agree that your contribution is licensed under the [MIT License](LICENSE).
