# Changelog

All notable changes to QueryDen are documented here. This project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html) and the format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/).

## [Unreleased]

### Fixed
- **[#86](https://github.com/openidle-dev/queryden/issues/86) — Removed misleading pulse dot from the help button.** The help button (top-right of `AppLayout`) rendered a small blue dot with `animate-pulse` on hover. It wasn't bound to any state — no "new help content" counter, no unread flag, just decoration. The visual language (small blue dot, top-right of a button, pulsing) is identical to a real unread-notification indicator, which set up an attention conflict with the neighbouring `UpdateNotification` bell that *is* a real notification surface. Deleted the `<span>`; the existing `group-hover:text-[var(--color-accent)]` on the `HelpCircle` icon stays as the hover affordance.

## [1.0.16] - 2026-05-17

A UX and branding polish release on top of v1.0.15's cold-start work. The boot splash now uses the actual QueryDen network-graph logo with a "Query**Den**" wordmark instead of a generic gradient block ([#79](https://github.com/openidle-dev/queryden/issues/79)). The Windows installer .exe finally shows the correct icon — the .ico was right since v1.0.11 but Tauri's NSIS bundler wasn't picking it up ([#80](https://github.com/openidle-dev/queryden/issues/80)). The pre-paint white flash is gone via a native window background color ([#75](https://github.com/openidle-dev/queryden/issues/75)). Clicking a connection in the explorer now shows a spinner on the right tree node and the status bar stops claiming "Select a database…" mid-connect ([#76](https://github.com/openidle-dev/queryden/issues/76)). The results panel toolbar got a substantial cleanup from @kix007 — Jump-to-column is a searchable keyboard-navigable dropdown, exports collapse into a single Download menu, row actions are icon-only with a dirty-count badge on Save, and Discard now correctly reverts modified rows instead of just hiding the dirty flags ([#70](https://github.com/openidle-dev/queryden/pull/70)).

### Fixed
- **[#75](https://github.com/openidle-dev/queryden/issues/75) — White flash on launch eliminated.** WebView2's OS-allocated canvas defaults to white before any HTML loads, and no CSS rule on `html`/`body` can prevent it because the canvas exists before HTML parses. Set `backgroundColor: [11, 15, 23]` on the Tauri window config so the canvas is dark from the moment the OS shows the window.
- **[#76](https://github.com/openidle-dev/queryden/issues/76) — Connection feedback is now accurate.** Clicking a connection in the Database Explorer left the footer status bar showing "Select a database…" for the entire connect attempt, because the conditions in the status renderer weren't mutually exclusive — `isConnecting` was set, but `selectedDatabase` was null, so the misleading message visually won. Replaced `isConnecting: boolean` with `connectingConnectionIds: Set<string>` so individual server tree nodes show a spinner on the right node, and rewrote the status text as a priority-ordered single string (`Connecting to <name>… → Loading database… → Loading schema… → Loading table details…`). The "Select a database…" line is gone from the loading bar.
- **[#70](https://github.com/openidle-dev/queryden/pull/70) — Discard now actually discards modifications.** The PR's original `onDiscard` swapped the server re-fetch for a client-side filter that stripped `_isNew`/`_isModified` flags but did not revert the edited cell values — leaving a phantom-modified state where Save became a no-op. Hybrid handler now re-runs the SELECT when there are real modifications (the only way to recover original values, since nothing in the codebase preserves them), and falls back to the cheap client-side filter when only new (client-only) rows need to be dropped. Preserves the perf win for the common "user added rows, changed their mind" case.
- **[#70](https://github.com/openidle-dev/queryden/pull/70) — Jump-to-column now uses the correct column list.** Was indexing into `columns` while the grid renders with `displayColumns || columns`; in multi-result mode those diverge and clicking a column name jumped to the wrong cell.

### Changed
- **[#79](https://github.com/openidle-dev/queryden/issues/79) — Boot splash redesigned.** The minimal v1.0.15 splash used a generic gradient block + "Loading…" in tiny gray text — didn't use the actual product logo and looked like a placeholder. Now uses the real network-graph mark (`/img/icon.png`) at 84px with a subtle cyan drop-shadow and a gentle float animation, "Query**Den**" wordmark at 30px with the "Den" half running the same cyan→purple brand gradient, and a small uppercase tagline ("A modern database manager"). The `prefers-color-scheme` rule was dropped — the app is dark-only at boot regardless of OS setting. Splash is now a sibling overlay rather than living inside `#root`, so it can fade out via CSS transition with a 700ms minimum on-screen time (so a fast warm boot doesn't flash it for ~80 ms — perceptible but unreadable).
- **[#80](https://github.com/openidle-dev/queryden/issues/80) — Windows installer .exe shows the QueryDen icon.** The `.ico` file in `src-tauri/icons/` held the real logo since v1.0.11, but Tauri's NSIS bundler doesn't auto-promote `bundle.icon[].ico` to the installer wrapper's own icon. Added `bundle.windows.nsis.installerIcon: "icons/icon.ico"`. Note: Windows aggressively caches file icons in Explorer, so existing users may need to install once before the new icon shows up (or clear the icon cache).
- **[#70](https://github.com/openidle-dev/queryden/pull/70) — Results panel toolbar refactor (@kix007).** Three meaningful UX upgrades: (1) The Jump-to-column control replaces the text input + `<select>` pair with a single searchable dropdown that supports keyboard navigation (Arrow up/down + Enter), with the active item highlighted and auto-scrolled into view; mouse hover and keyboard cursor stay in sync. (2) The five separate export-format icon buttons collapse into a single Download dropdown with a section header, and Escape closes it consistently with the column dropdown. (3) Row action buttons (Add, Duplicate, Remove, Save, Discard) are now icon-only for compactness, with tooltips on each; Save gains a small emerald dirty-count badge in the top-right corner (capped at "99+") so the at-a-glance signal of pending edits survives the text removal. Discard now shows a confirmation dialog before wiping local changes.

## [1.0.15] - 2026-05-17

A targeted cold-start fix. On Windows, app launch was taking **5–8 seconds of invisible window** before the UI appeared, contradicting v1.0.13 / v1.0.14's perf claims. Two compounding causes, both fixed here ([#72](https://github.com/openidle-dev/queryden/issues/72)): every startup `load_*` IPC call was running a full Argon2id key derivation (~100–250 ms on Windows × 10+ calls = 2–4 s of redundant CPU work, all producing the same 32 bytes); and the window stayed hidden the entire time React was mounting and IPC-ing, so the user saw nothing. The derived key is now cached process-wide, the window is visible immediately with a CSS-only splash, and the app starts maximized.

### Performance
- **[#72](https://github.com/openidle-dev/queryden/issues/72) — Argon2-derived encryption key is now cached for the session.** `get_encryption_key()` in `storage.rs` ran a full Argon2id derivation on every call. Startup fires 8 parallel `load_*` IPC calls (`load_connections`, `load_vault_credentials`, `load_settings`, `load_query_history`, `load_saved_queries`, `load_local_history`, `load_keymaps`, `load_templates`), and `load_connections` adds one derivation per encrypted field per connection — 10–15 derivations in practice, every one producing the same 32 bytes because the no-vault path is deterministic on `(machine_id, master_key, salt)`. The derived key is now memoized in a `OnceLock<[u8; 32]>` for the no-vault paths (machine-locked and legacy) and a `Mutex<HashMap<_, _>>` keyed by SHA-256 password fingerprint for the vault path. Reduces 10+ derivations to 1 per session. The cache stores only the 32-byte derived key plus a password fingerprint as a map key — no plaintext passwords are retained.
- **[#72](https://github.com/openidle-dev/queryden/issues/72) — Window is visible immediately with an HTML splash.** Reverts the `visible: false` + RAF-driven reveal pattern from [#56](https://github.com/openidle-dev/queryden/issues/56). That pattern was correct for ~200 ms shell flashes but actively harmful when the load was multi-second — users saw 5–8 s of nothing. WebView2 now paints a minimal CSS-only splash (gradient mark + "QueryDen" + "Loading…") the instant it renders the page, *before* the JS bundle parses. The splash respects `prefers-color-scheme`. React mount replaces it on first render. The backend 8 s force-show failsafe and `src/lib/revealAppWindow.ts` are no longer needed and have been deleted.

### Changed
- **App now starts maximized.** `tauri.conf.json` window config sets `maximized: true`. Standard for desktop DB tools (DataGrip, DBeaver behave this way). First-run is maximized; subsequent launches preserve OS-level window state.

## [1.0.14] - 2026-05-16

A UX-collision and psql-polish release with notable cold-start and Windows perf fixes. The psql console no longer mangles `SELECT 1;` into a syntax error or commented-out LIMIT ([#38](https://github.com/openidle-dev/queryden/issues/38)) and now respects the `\x` extended-display and `\c` change-connection meta-commands ([#45](https://github.com/openidle-dev/queryden/issues/45)). Three editor shortcut collisions are resolved: `Ctrl+D` no longer fights Monaco's multi-cursor ([#13](https://github.com/openidle-dev/queryden/issues/13)), `Ctrl+Shift+F` is freed for global search ([#12](https://github.com/openidle-dev/queryden/issues/12)), and the toolbar **Format SQL** button now routes through the same `sql-formatter` path as `Ctrl+Shift+L` instead of a separate hand-rolled formatter ([#16](https://github.com/openidle-dev/queryden/issues/16)). The cold-start entry bundle drops another **4 MB → 524 kB** by lazy-loading Monaco itself ([#56](https://github.com/openidle-dev/queryden/issues/56)), and the main window stays hidden until first paint so there's no half-rendered shell during boot. On Windows, a process-wide cache for the machine-ID derivation eliminates a startup hang where PowerShell was spawned 8–15 times. The connection picker hides 17 coming-soon providers behind a Show-all toggle by default ([#54](https://github.com/openidle-dev/queryden/issues/54)). Docs scoped accurately around protocol-compatible engines ([#18](https://github.com/openidle-dev/queryden/issues/18)). 13 of 15 open Dependabot alerts closed ([#47](https://github.com/openidle-dev/queryden/issues/47)).

### Fixed
- **[#38](https://github.com/openidle-dev/queryden/issues/38) — psql console no longer mangles queries with trailing semicolons or comments.** The auto-LIMIT helper appended ` LIMIT 1000` verbatim, so `SELECT 1;` became `SELECT 1; LIMIT 1000` — two statements, the second a syntax error. Worse, `SELECT 1; -- foo` would put the LIMIT inside a comment that extends to end-of-line, silently bypassing the safety mechanism designed to prevent unbounded results. The helper now iteratively strips trailing whitespace, semicolons, line comments (`--`), and block comments (`/* */`) before appending — surgical to the tail, so inline comments mid-query are preserved. Extracted to a pure `applyQueryLimit` helper with seven Vitest cases pinning every edge. The comment-bypass class of the bug was caught in PR review before reaching `main`.
- **[#45](https://github.com/openidle-dev/queryden/issues/45) — psql console honors `\x` extended display and `\c` change connection.** Both were silently swallowed by the wrapper that runs queries through `psql --command`, so `\x` had no effect and `\c <db>` couldn't switch databases without dropping the tab. The wrapper now recognizes both meta-commands client-side and routes them appropriately.
- **[#13](https://github.com/openidle-dev/queryden/issues/13) — Database Explorer toggle moved from `Ctrl+D` to `Ctrl+\`.** `Ctrl+D` shadowed Monaco's built-in "add selection to next occurrence" (multi-cursor) when focus was inside the SQL editor — costly muscle memory for anyone used to VS Code / JetBrains. The new binding matches the VS Code / DataGrip sidebar-toggle convention and doesn't collide with any Monaco default. The `databaseExplorer` entry in the default keymap preset (which previously advertised `Ctrl+Alt+S`, itself a collision with Settings) is now in sync.
- **[#12](https://github.com/openidle-dev/queryden/issues/12) — `Ctrl+Shift+F` reaches the global search bar from inside the editor.** Monaco bound `Ctrl+Shift+F` to `editor.action.formatDocument` as a duplicate of the canonical `Ctrl+Shift+L` formatter shortcut. While focus was in the editor, the app-level global-search handler in `AppLayout.tsx` never saw the keystroke. Dropping the Monaco binding lets `Ctrl+Shift+F` bubble correctly.
- **Windows startup hang / "Not Responding".** On Windows, `get_machine_id()` shells out to `powershell.exe` + WMI (`Get-CimInstance Win32_ComputerSystemProduct`) to derive the encryption key and fingerprint. The result was never memoized, so every storage load (connections, vault, settings, query history, saved queries, local history) and every key-derivation pass re-spawned PowerShell — ~8–15 concurrent invocations during cold start. On machines with slow WMI, aggressive EDR/AV, or a bloated WMI repo, that compounded into multi-second hangs and the OS marking the window unresponsive. Cached in a process-wide `OnceLock<String>` so PowerShell runs at most once per session; only real values are memoized so a transient detection failure can't poison key derivation.

### Changed
- **[#16](https://github.com/openidle-dev/queryden/issues/16) — One SQL formatter, one code path.** The toolbar **Format SQL (Prettify)** button used to call a hand-rolled `formatSql()` in `src/utils/SqlFormatter.ts` (keyword newlines + naive paren indent) while `Ctrl+Shift+L` and Monaco's in-editor format-document went through Monaco's `DocumentFormattingEditProvider` backed by the `sql-formatter` npm package — two formatters producing different output for the same intent. The toolbar button now dispatches the same `format-sql` `CustomEvent` and the legacy helper is deleted. Side benefit: the toolbar path now formats the live editor buffer directly instead of reading a debounce-lagged ref.
- **[#54](https://github.com/openidle-dev/queryden/issues/54) — Connection dialog hides coming-soon providers by default.** The driver picker rendered all 38 provider tiles on first open — most of them coming-soon placeholders that refuse to connect. The default view now shows the 21 protocol-supported engines (PostgreSQL family, MySQL family, SQLite), with a `Show all (N)` toggle revealing the 17 coming-soon tiles. Search keeps working across both tiers.
- **[#18](https://github.com/openidle-dev/queryden/issues/18) — Docs scoped accurately around protocol-compatible engines.** MariaDB is described as supported through the MySQL wire protocol; CockroachDB and Supabase as supported through the PostgreSQL wire protocol (Supabase adds a connection-string helper, not a separate backend). No code or driver changes — just docs and README copy so the engine list doesn't overpromise distinct backends.
- **[#55](https://github.com/openidle-dev/queryden/issues/55) — `LocalHistoryDialog` is now genuinely lazy.** A static import in `FilesExplorer.tsx` was defeating the `React.lazy(...)` boundary in `MainContent.tsx`, so the dialog (and its Monaco diff view) loaded eagerly on every cold start despite the lazy wrapper. Converted the `FilesExplorer` import to `React.lazy` + `Suspense` so the chunk only loads when the dialog is opened, and the Rollup chunk-warning that previously fired on every build is gone.
- **[#56](https://github.com/openidle-dev/queryden/issues/56) — Cold start: window hidden until first paint, Monaco off the critical path.** The main window now starts hidden (`visible: false` in `tauri.conf.json`) and is revealed only after the React app has rendered, so users no longer see a half-painted shell that fails to respond cleanly to maximize/fullscreen during boot. `QueryEditor` is also lazy-loaded from `MainContent` — Monaco (3.7 MB raw / 967 kB gzip) and its 146 kB stylesheet leave the entry bundle, which drops from **~4 MB → 524 kB raw (151 kB gzip)**. Two failsafes guarantee the window can't get stuck invisible: a 4 s frontend `setTimeout` falls back to a forced show if RAF-driven reveal misfires, and an 8 s backend tokio task in `setup()` force-shows if the JS bundle never loads at all.

### Security
- **[#47](https://github.com/openidle-dev/queryden/issues/47) — 13 of 15 open Dependabot alerts patched.** `quinn-proto 0.11.13 → 0.11.14` in the Rust lock; website `astro ^5 → ^6` (6.3.2), `vitest ^2.1.9 → ^3.2.4` (which dedupes nested vite to 6.4.2 and esbuild to 0.25.12), and Monaco's nested `dompurify` is now pinned to `^3.4.3` via an npm `overrides` entry. Two transitive alerts (`glib 0.18.5`, `rand 0.7.3`) are deferred — both are pinned by `tauri 2.11.1` and need an upstream Tauri bump to GTK 0.20 bindings to resolve. Astro 6 changed the prerender chunk layout, so `website/src/lib/changelog.ts` switched from a runtime `readFileSync` to a Vite `?raw` import — bundled at build time, strictly more robust.

### Known Issues
- [#40](https://github.com/openidle-dev/queryden/issues/40) — PostgreSQL CLI auto-download is broken end-to-end (404 URL template; source vs binary tarball mismatch). Doesn't affect most users — anyone with a system `psql` on PATH never hits this code path. Workaround: install the PostgreSQL client matching your server's major version via your OS package manager.
- [#41](https://github.com/openidle-dev/queryden/issues/41) — `BIGINT` and `BIGINT[]` values whose magnitude exceeds JavaScript's `Number.MAX_SAFE_INTEGER` (2^53) are silently rounded to the nearest float64 representation at the IPC boundary. Workaround: cast to `text` in the SELECT when exact precision matters.

## [1.0.13] - 2026-05-14

Three SQL editor bugs fixed plus two big size cuts. Schema-qualified autocomplete (`SELECT * FROM app.`) and alias-column completion (`u.` after a multi-dot line) no longer collapse to empty ([#28](https://github.com/openidle-dev/queryden/issues/28)). `INT2[]` / `INT4[]` / `INT8[]` result columns no longer crash the deserializer ([#27](https://github.com/openidle-dev/queryden/issues/27)). `Ctrl+Shift+L` now actually formats the active SQL editor ([#9](https://github.com/openidle-dev/queryden/issues/9)). Monaco's unused languages and workers are stripped from the build — `dist/assets/*.js` drops from 14.99 MB raw / 3.59 MB gzip to **5.29 MB / 1.39 MB** (-65% / -61%). The Rust release profile is tightened (`lto = "fat"`, `codegen-units = 1`) and `reqwest` swapped to `rustls-tls`, shrinking the Windows binary from 16.21 MB to **13.03 MB** (-19.6%).

### Fixed
- **[#28](https://github.com/openidle-dev/queryden/issues/28) — SQL autocomplete no longer collapses to empty after typing `.` on a schema-qualified table or table alias.** Monaco's default fuzzy matcher treats `.` as a member-access trigger and filters out completion labels that don't share a bare-name representation with the typed text. Two distinct cases broke from the same root cause: `SELECT * FROM app.` lost its schema-table suggestions, and `SELECT u.id FROM app.users u WHERE u.` lost its column suggestions on multi-dot lines (the legacy `tablePrefix` extractor also picked up the wrong dot on those lines). The completion provider now detects `<schema>.<typed>` and `<alias>.<typed>` contexts up-front via dedicated detectors and returns bare-name suggestions with a replacement range covering only the post-dot text, matching how DataGrip and DBeaver behave. `public.` also surfaces tables stored without an explicit schema prefix, and `<table>.` works for unaliased references like `SELECT users.id FROM app.users`. Logic extracted to `src/components/editor/completionContext.ts` and covered by 26 pure-function tests; the legacy `tablePrefix` branch is removed.
- **[#27](https://github.com/openidle-dev/queryden/issues/27) — `INT2[]` / `INT4[]` / `INT8[]` result columns no longer crash the deserializer with "unsupported datatype".** The patched `tauri-plugin-sql` already handled a handful of Postgres array types but integer arrays fell through to the generic `Vec<String>` fallback, which sqlx refuses to decode. Added explicit match arms that decode each width as `Vec<Option<T>>` so SQL `NULL` elements survive as JSON `null`, mirroring the scalar `INT2/INT4/INT8` arms. Smoke script: `dev/test-db/test-scripts/07-int-arrays.sql`.
- **[#9](https://github.com/openidle-dev/queryden/issues/9) — `Ctrl+Shift+L` now actually formats the current SQL editor.** The global handler in `App.tsx` was dispatching a `format-code` CustomEvent, but `QueryEditor.tsx` listens for `format-sql`, so the shortcut silently did nothing. Aligned the dispatch name and extracted the shortcut mapping into a pure, unit-tested `matchGlobalShortcut` helper so this class of mismatch is caught by CI.

### Changed
- **Rust release profile and dependency cleanup.** Tightened `[profile.release]` in `src-tauri/Cargo.toml` (`lto = "fat"`, `codegen-units = 1`, `incremental = false`), dropped the unused top-level `sqlx` dependency (it stays as a transitive dep of the patched `tauri-plugin-sql`, but is no longer pulled in twice with our own feature set), and swapped `reqwest` from the default native-tls backend to `rustls-tls`. The Windows release binary shrinks from **16.21 MB → 13.03 MB (-3.18 MB / -19.6%)**. The updater plugin (`tauri-plugin-updater`) ships its own TLS stack and is unaffected.
- Pruned unused Monaco languages and workers from the build. The `monaco-editor` default entry pulled in ~80 basic-language Monarch tokenizers (ABAP, F#, Solidity, etc.) plus four language-service workers (JSON, TypeScript, CSS, HTML) — none of which a SQL editor uses. `monacoSetup.ts` now imports from `monaco-editor/esm/vs/editor/edcore.main.js` and re-registers only the SQL contribution; `vite.config.ts`'s `manualChunks` switched to a function so it groups what we actually import instead of naming the bare package (which was forcing `editor.main.js` and its full graph back into the build). Total `dist/assets/*.js` **14.99 MB → 5.29 MB raw (-65%), 3.59 MB → 1.39 MB gzipped (-61%)**; biggest chunk drops are the four eliminated language workers (`ts.worker` 7.0 MB, `css.worker` 1.0 MB, `html.worker` 695 KB, `json.worker` 385 KB raw).

### Known Issues
- [#38](https://github.com/openidle-dev/queryden/issues/38) — In the psql console, queries ending with `;` get a safety `LIMIT 1000` appended after the semicolon, producing a syntax error. Workaround: omit the trailing `;` in psql tabs. The libpq path (regular Postgres connections) is unaffected.
- [#40](https://github.com/openidle-dev/queryden/issues/40) — PostgreSQL CLI auto-download is broken end-to-end (404 URL template; source vs binary tarball mismatch). Doesn't affect most users — anyone with a system `psql` on PATH never hits this code path. Workaround: install the PostgreSQL client matching your server's major version via your OS package manager.
- [#41](https://github.com/openidle-dev/queryden/issues/41) — `BIGINT` and `BIGINT[]` values whose magnitude exceeds JavaScript's `Number.MAX_SAFE_INTEGER` (2^53) are silently rounded to the nearest float64 representation at the IPC boundary. Newly visible with this release's `BIGINT[]` support — scalar `BIGINT` has had this behaviour since first-release. Workaround: cast to `text` in the SELECT when exact precision matters.

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

[Unreleased]: https://github.com/openidle-dev/queryden/compare/v1.0.16...HEAD
[1.0.16]: https://github.com/openidle-dev/queryden/compare/v1.0.15...v1.0.16
[1.0.15]: https://github.com/openidle-dev/queryden/compare/v1.0.14...v1.0.15
[1.0.14]: https://github.com/openidle-dev/queryden/compare/v1.0.13...v1.0.14
[1.0.13]: https://github.com/openidle-dev/queryden/compare/v1.0.12...v1.0.13
[1.0.12]: https://github.com/openidle-dev/queryden/compare/v1.0.11...v1.0.12
[1.0.11]: https://github.com/openidle-dev/queryden/compare/v1.0.10...v1.0.11
[1.0.10]: https://github.com/openidle-dev/queryden/compare/v1.0.9...v1.0.10
[1.0.9]: https://github.com/openidle-dev/queryden/compare/v1.0.8...v1.0.9
[1.0.8]: https://github.com/openidle-dev/queryden/compare/v1.0.7...v1.0.8
[1.0.7]: https://github.com/openidle-dev/queryden/compare/v1.0.6...v1.0.7
[1.0.6]: https://github.com/openidle-dev/queryden/compare/v1.0.5...v1.0.6
[1.0.5]: https://github.com/openidle-dev/queryden/releases/tag/v1.0.5
