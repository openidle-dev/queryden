# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project

QueryDen is a Tauri 2 desktop database manager. The frontend is React 18 + TypeScript + Vite + Tailwind v4; the backend is Rust. It supports PostgreSQL, MySQL/MariaDB, SQLite, CockroachDB, and Supabase, with SSH tunneling, an encrypted credential vault, local history, saved queries, and an integrated `psql` console.

## Common commands

```bash
npm install                 # install JS deps (pnpm-lock.yaml is also present)
npm run dev                 # Vite only (frontend at :1420) — rarely useful alone
npm run tauri dev           # full app (Tauri shell + Vite HMR) — primary dev command
npm run tauri build         # production build (current host target)
npm run build:windows       # cross-compile Windows MSVC target from Linux (cargo-xwin + lld + nsis required, see BUILD_WINDOWS.md)
npm test                    # run Vitest pure-function tests (CI runs this on every PR)
npm run test:watch          # Vitest in watch mode for local TDD
node scripts/bump-version.js  # bump patch version in package.json, Cargo.toml, and tauri.conf.json in lockstep
```

## Testing

- **Frontend**: Vitest is configured (`vitest.config.ts`) with `environment: "node"` for pure-function tests. Test files live next to source as `*.test.ts` / `*.test.tsx` (current examples: `src/utils/sqlSecurity.test.ts`, `src/utils/SqlFormatter.test.ts`, `src/utils/logger.test.ts`, `src/components/ui/VariableSubstitutionDialog.test.ts`). **No jsdom / React Testing Library yet** — component tests aren't set up. Adding them is tracked in [#24](https://github.com/openidle-dev/queryden/issues/24).
- **Backend**: `cargo test` is wired in `.github/workflows/ci.yml` (`src-tauri/` Rust job) but there are no tests in `src-tauri/src/` yet. The encryption/lockout logic in `storage.rs` is the highest-priority surface to backfill — also tracked in [#24](https://github.com/openidle-dev/queryden/issues/24).
- **E2E**: none. Playwright is a transitive dev dep but no Playwright tests are configured. A Playwright + Tauri-IPC-mock setup is in the roadmap.
- **No lint config or formatter** is configured — typecheck (`npx tsc --noEmit`) is the only static-analysis gate today, and `cargo clippy -- -D warnings` for Rust.
- **Convention**: every bug fix should land with the failing test that proves it. For bugs that can't be cleanly fixed in the same PR, pin the test with Vitest's `it.fails(...)` (see `VariableSubstitutionDialog.test.ts` for the pattern referencing issue #19) so the bug is documented in executable form and CI flips red the moment it's fixed.

Vite's port is pinned to 1420 (`strictPort: true`).

## Architecture

### Tauri command surface (the IPC boundary)

All cross-cutting native work lives in `src-tauri/src/` and is exposed via `tauri::generate_handler!` in `lib.rs`. Adding a new command means: implement it in a module, then **register it in `lib.rs`** — forgetting this is the most common bug.

Modules:
- `storage.rs` — encrypted file persistence for connections, vault credentials, query history, saved queries, local history, settings, keymaps, templates. Uses **AES-256-GCM** with an Argon2id-derived key combining vault password + machine fingerprint + master key. Master key is stored in the OS keyring (`keyring` crate) with a file fallback. Machine fingerprint is derived from `/etc/machine-id` (Linux), `Win32_ComputerSystemProduct.UUID` via PowerShell (Windows), or `IOPlatformUUID` (macOS). **Files refuse to load on a different machine.** Brute-force lockout: 5 failed attempts via `FAILED_ATTEMPTS`/`LOCKOUT_UNTIL` atomics.
- `ssh.rs` — SSH tunnel lifecycle via `ssh2` crate, plus tunnel registry (`create_ssh_tunnel`, `close_ssh_tunnel`, `get_tunnel_status`, `close_all_tunnels`).
- `cli.rs` — Downloads and manages external DB CLIs (psql, mysql, etc.) per version. Exposes commands for tool discovery, version detection, downloads, query execution, connection testing. The `CliManager` is registered as Tauri app state in `setup()`.
- `sysinfo.rs` — system info for the about dialog.

Auto-update goes through the official **`tauri-plugin-updater`** + **`tauri-plugin-process`** (registered in `lib.rs`). The frontend uses `@tauri-apps/plugin-updater`'s `check()` / `Update.download()` / `Update.install()` and then `relaunch()` from `@tauri-apps/plugin-process` — see `src/store/updateStore.ts`. The plugin's manifest endpoint is `https://github.com/openidle-dev/queryden/releases/latest/download/latest.json`; the release workflow generates that manifest on every tag push by reading the `.sig` companion files that Tauri auto-produces when `createUpdaterArtifacts: true` is set in `tauri.conf.json`. Signing key is required: CI reads `TAURI_SIGNING_PRIVATE_KEY` + `TAURI_SIGNING_PRIVATE_KEY_PASSWORD` from repo secrets; the public key is baked into `tauri.conf.json` under `plugins.updater.pubkey`. Losing the private key + password permanently breaks the update path for all installed clients — they'd need to reinstall manually from a release built with a new keypair. The only custom updater code that survives is `get_build_info` in `lib.rs`, which surfaces the `QUERYDEN_BUILD_DATE` env var (set by `build.rs`) for the About dialog.

### Patched `tauri-plugin-sql`

`src-tauri/Cargo.toml` has a `[patch.crates-io]` entry pointing at `src-tauri/patches/tauri-plugin-sql/`. The patched version adds support for PostgreSQL types the upstream plugin doesn't handle (INTERVAL, OID, arrays, etc.). **Do not bump `tauri-plugin-sql` without updating the patch**, and do not delete the patches directory.

### Frontend structure

Entry: `src/main.tsx` → `src/App.tsx`. App wraps everything in `QueryClientProvider` (TanStack Query) → `ErrorBoundary` → `ConnectionProvider` → `ThemeProvider` → `ConfirmDialogProvider` → `AppLayout`. `SettingsDialog` and `HelpDialog` are lazy-loaded.

- `components/layout/` — `AppLayout`, `Sidebar`, `MainContent`, `Toolbar` (top-level chrome).
- `components/explorer/` — left-pane DB tree, connection dialogs, table/database create dialogs, schema selection.
- `components/editor/QueryEditor.tsx` — Monaco-based SQL editor.
- `components/results/` — results grid (Glide Data Grid) + `VisualOptimizer` (EXPLAIN ANALYZE viz).
- `components/tools/` — modal tools: AI assistant, compare, clone, activity monitor, multi-query, definition viewer.
- `components/ui/` — shared primitives, `ConfirmDialog`, `ErrorBoundary`.
- `contexts/ConnectionContext.tsx` + `useConnections.ts` — current connection state and CRUD; this is the connection lifecycle hub.
- `contexts/ThemeContext.tsx` — theme provider.
- `store/` — Zustand stores, one per concern: `aiStore`, `cliStore`, `keymapStore`, `localHistoryStore`, `queryHistoryStore`, `savedQueryStore`, `settingsStore`, `updateStore`, `vaultStore`. Stores typically persist via Tauri storage commands. **`vaultStore` is a thin wrapper that proxies to `settingsStore`** — don't add separate persistence there. **`updateStore` is a thin wrapper around `@tauri-apps/plugin-updater` + `plugin-process`** — the heavy lifting (HTTP, signature verification, install, relaunch) lives in the plugins; the store just holds UI phase state.
- `utils/SqlFormatter.ts`, `utils/sqlSecurity.ts` — SQL formatting (via `sql-formatter`) and statement safety checks.

The version string is injected at build time via Vite's `define`: `__APP_VERSION__` is read from `package.json`. Vite manualChunks splits monaco, glide grid, and the react/zustand vendor bundle.

### Global keyboard shortcuts

Wired in `App.tsx`'s top-level `useEffect`, which delegates the keydown → action mapping to the pure `matchGlobalShortcut` helper in `src/utils/globalShortcuts.ts` (unit-tested in `globalShortcuts.test.ts`). Current bindings: Ctrl+H opens help, Ctrl+Alt+S opens settings, Ctrl+Shift+L dispatches a `format-sql` CustomEvent on `window` (which `QueryEditor.tsx` listens for to run Monaco's format action — see [#9](https://github.com/openidle-dev/queryden/issues/9) for the historical mismatch). Monaco's built-in `Ctrl+Shift+F` is also wired to the same formatter inside the editor. Per-feature shortcuts live in `keymapStore`. New global shortcuts go in the `matchGlobalShortcut` table and (if they need state) a `case` in `App.tsx`; feature-local shortcuts go in their component.

### Versioning

Three files must stay in sync: `package.json`, `src-tauri/Cargo.toml`, `src-tauri/tauri.conf.json`. Use `scripts/bump-version.js` rather than editing by hand.

### Platform notes

- Linux WebKitGTK workaround is set in `lib.rs` before WebKit init (`WEBKIT_DISABLE_COMPOSITING_MODE`, `WEBKIT_DISABLE_DMABUF_RENDERER`). Do not remove.
- Cross-compiling to Windows from Linux: see `BUILD_WINDOWS.md`. Requires `cargo-xwin`, `lld`, `llvm-lib`, and `nsis`. The repo recommends GitHub Actions (`.github/workflows/release.yml`) for reliable Windows builds.
- Release profile uses `lto = "thin"`, `codegen-units = 16`, `panic = "abort"`.

## Website + documentation (`website/`)

The marketing site and documentation deploy to <https://queryden.openidle.com>. Built with Astro 5 + MDX + Shiki + Pagefind, deployed to Vercel via a release-triggered hook (`.github/workflows/deploy-website.yml`).

- **`website/src/content/docs/`** — MDX source for the docs. Folders are sections (`getting-started`, `engines`, `editor`, `ai`, `security`, `troubleshooting`). Frontmatter is validated against `website/src/content.config.ts` at build time.
- **`website/src/layouts/DocsLayout.astro`** — 3-column shell (sidebar nav + article + ToC). Renders breadcrumb, "Edit on GitHub" link, prev/next, scroll-spy ToC, copy-button code chrome.
- **`website/src/lib/docs.ts`** — sidebar builder, section metadata, prev/next finder. Adding a section means adding a folder + a row in the `SECTIONS` array.
- **`website/src/components/Callout.astro`** — `<Callout type="info|tip|warn|danger" title="...">` for MDX use.
- **`website/src/components/DocsSearch.astro`** — Pagefind UI, loaded dynamically. The dialog re-parents itself to `<body>` on script load so `position: fixed` pins to viewport.
- **`npm run build`** runs `astro build && pagefind --site dist --glob "docs/**/*.html"`. The Pagefind index is written to `dist/pagefind/`; `public/pagefind/` is a git-ignored dev-mode mirror.
- **`website/src/lib/site.ts`** — single source of truth for version, repo URL, release metadata. Fetches the latest GitHub release at build time (with a fallback constant). Set `QUERYDEN_REQUIRE_LIVE_RELEASE=1` in production to fail the build on stale data.

When fixing an app bug referenced from a docs page (grep `website/src/content/docs/` for `#<issue-num>` before opening the PR), update the docs in the same PR.

See `website/README.md` for the contributor-facing guide and `CONTRIBUTING.md#contributing-documentation` for the PR conventions.

## Data locations (runtime, not in repo)

Encrypted JSON files in the Tauri app data dir (`~/.local/share/com.queryden.app/` on Linux, equivalent per OS): `connections.json`, `vault.json`, `query-history.json`, `saved-queries.json`, `local-history.json`. `settings.json` is plaintext. These are gitignored at repo root too.
