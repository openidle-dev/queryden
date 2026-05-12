# Security Policy

QueryDen stores database credentials and other sensitive material on the user's machine. We take reports seriously.

## Reporting a vulnerability

Please do **not** open a public GitHub issue for security problems.

Email: **hello@openidle.com** (or open a private security advisory via GitHub's "Report a vulnerability" button on this repository).

When reporting, please include:

- A description of the issue and the impact you've identified.
- Steps to reproduce (proof-of-concept code or screenshots welcome).
- The QueryDen version (`Help → About` in the app) and your OS.
- Whether you've shared this report anywhere else.

We'll acknowledge receipt within 3 business days and aim to provide an initial assessment within 7 days. Coordinated disclosure timelines are negotiated per report; the default is 90 days from the date we acknowledge.

## Supported versions

Only the latest minor release line receives security fixes. We recommend keeping the in-app updater enabled.

| Version  | Supported |
| -------- | --------- |
| 1.0.x    | Yes       |
| < 1.0    | No        |

## Scope

In scope:

- The QueryDen desktop application (Rust backend, React frontend).
- The patched `tauri-plugin-sql` shipped in `src-tauri/patches/`.
- Release artifacts published from this repository.
- The auto-update flow (checksum verification, fetch, install handoff).

Out of scope:

- Vulnerabilities in third-party database drivers / servers that QueryDen connects to (please report those upstream).
- Issues that require the attacker to already have local code execution as the user.
- Self-XSS in the SQL editor when the user pastes attacker-controlled content into their own query buffer.
- Findings whose only impact is on configurations explicitly opted into by the user (for example, disabling vault encryption in settings).

## Security design

A short summary of what QueryDen does to protect stored data; see the README for the full claim list.

- **Encryption at rest** — sensitive files (`connections.json`, `vault.json`, `query-history.json`, `saved-queries.json`, `local-history.json`) are encrypted with AES-256-GCM. The 256-bit key is derived via Argon2id from a per-machine identifier, a per-install master key, and (for vault data) the user's vault password.
- **Master key storage** — primary location is the OS keyring (`keyring` crate); a file fallback in the app data directory is used only if keyring access fails. If neither path can persist a key, encryption refuses to proceed rather than silently weakening.
- **Machine binding** — files written on one machine cannot be decrypted on another. A machine fingerprint is stored alongside each file and verified on load.
- **Brute-force protection** — the vault locks for a period after 5 failed unlock attempts.
- **Auto-update integrity** — each release publishes a `<asset>.sha256` companion file. The updater fetches the checksum first and refuses to install a binary whose SHA256 doesn't match.
- **CSP** — the in-app webview runs under a strict Content Security Policy; remote scripts are not permitted.
- **Capability scoping** — Tauri filesystem permissions are scoped to app data, downloads, documents, and desktop directories.
- **Parameterized queries** — SQL execution uses prepared statements via `sqlx` / `tauri-plugin-sql`; user-supplied values are never concatenated into SQL strings.

## Known limitations

- QueryDen has not undergone an external security audit. Use accordingly for highly sensitive deployments.
- The optional AI assistant transmits your SQL and the relevant API key directly to the provider you configure. See the Privacy section in the README.
- Once your OS user account is compromised, encryption at rest cannot protect data that the same user can decrypt during normal app use.

## Acknowledgments

We're grateful to anyone who takes the time to find and report problems carefully. Reporters who follow this policy will be credited (with their permission) in the relevant `CHANGELOG.md` entry.
