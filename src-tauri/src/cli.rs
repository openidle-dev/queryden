//! Embedded CLI tools manager for QueryDen.
//!
//! ## Discovery
//!
//! Each tool is looked up in this order:
//!
//! 1. The process `PATH`.
//! 2. Well-known install locations for the current OS. Apps launched from a
//!    desktop launcher, Finder or the Start menu do not inherit shell-profile
//!    `PATH` edits, and several installers never touch `PATH` at all (EDB on
//!    Windows/macOS, Postgres.app, keg-only Homebrew `libpq`/`mysql-client`,
//!    Debian's `/usr/lib/postgresql/<ver>/bin`, PGDG's `/usr/pgsql-<ver>`).
//! 3. Binaries downloaded by QueryDen into `<app data>/cli-tools/<tool>-<major>/bin`.
//!
//! ## Download sources
//!
//! - **PostgreSQL**: no download. psql must come from a system install.
//! - **MySQL**: no download. Oracle's archives are 200+ MB, need their bundled
//!   shared libraries next to the binary, and use `.tar.xz` on Linux.
//! - **MongoDB**: mongosh from GitHub releases (self-contained binary).

use serde::{Deserialize, Serialize};
use std::path::{Path, PathBuf};
use std::process::Stdio;
use tauri::{AppHandle, Emitter, Manager, State};
use tokio::process::Command;

#[cfg(target_os = "windows")]
const CREATE_NO_WINDOW: u32 = 0x08000000;

/// Suppress the flashing console window Windows spawns for each subprocess.
/// No-op on other platforms.
fn no_console_window(cmd: &mut Command) -> &mut Command {
    // tokio's Command has `creation_flags` built in on Windows.
    #[cfg(target_os = "windows")]
    cmd.creation_flags(CREATE_NO_WINDOW);
    cmd
}

// ─── Tool kind ───────────────────────────────────────────────────────────────

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub enum ToolKind {
    Psql,
    MySql,
    Mongo,
}

impl ToolKind {
    fn alias(&self) -> &'static str {
        match self {
            ToolKind::Psql => "postgresql",
            ToolKind::MySql => "mysql",
            ToolKind::Mongo => "mongodb",
        }
    }

    fn primary_binary(&self) -> &'static str {
        match self {
            ToolKind::Psql => "psql",
            ToolKind::MySql => "mysql",
            ToolKind::Mongo => "mongosh",
        }
    }

    fn all_binaries(&self) -> &'static [&'static str] {
        match self {
            ToolKind::Psql => &["psql"],
            ToolKind::MySql => &["mysql", "mysqldump"],
            ToolKind::Mongo => &["mongosh"],
        }
    }

    fn system_install_hint(&self) -> &'static str {
        match self {
            ToolKind::Psql => "PostgreSQL client (psql) is required for the psql console.\n\n\
                Download: https://www.postgresql.org/download/\n\n\
                Linux (Debian/Ubuntu): sudo apt install postgresql-client\n\
                Linux (Fedora/RHEL):   sudo dnf install postgresql\n\
                macOS (Homebrew):      brew install libpq\n\
                macOS (app):           https://postgresapp.com\n\
                Windows (winget):      winget install PostgreSQL.PostgreSQL\n\
                Windows (manual):      https://www.postgresql.org/download/windows/\n\n\
                QueryDen also finds psql in the standard install folders\n\
                (Program Files\\PostgreSQL, /Library/PostgreSQL, Postgres.app,\n\
                Homebrew, /usr/lib/postgresql) even when it is not on PATH.",
            ToolKind::MySql => "MySQL client not found.\n\n\
                Linux (Debian/Ubuntu): sudo apt install mysql-client\n\
                Linux (Fedora/RHEL):   sudo dnf install mysql\n\
                macOS:                 brew install mysql-client\n\
                Windows:               winget install Oracle.MySQL",
            ToolKind::Mongo => "mongosh not found.\n\n\
                Install from https://www.mongodb.com/try/download/shell",
        }
    }
}

impl std::fmt::Display for ToolKind {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "{}", self.alias())
    }
}

fn parse_tool_kind(tool_kind: &str) -> Result<ToolKind, String> {
    match tool_kind {
        "postgresql" => Ok(ToolKind::Psql),
        "mysql" => Ok(ToolKind::MySql),
        "mongodb" => Ok(ToolKind::Mongo),
        _ => Err(format!("Unknown tool: {}", tool_kind)),
    }
}

// ─── Download URL resolver ────────────────────────────────────────────────────

struct DownloadSpec {
    url: &'static str,
    /// Cache directory major version. Pinned to what the URL actually
    /// contains, so a typed "5" never files mongosh 2.x under `mongodb-5`.
    major: u32,
}

fn download_spec(kind: ToolKind) -> Option<DownloadSpec> {
    match kind {
        ToolKind::Psql | ToolKind::MySql => None,
        ToolKind::Mongo => {
            let url = if cfg!(all(target_os = "linux", target_arch = "x86_64")) {
                "https://github.com/mongodb-js/mongosh/releases/download/v2.3.8/mongosh-2.3.8-linux-x64.tgz"
            } else if cfg!(all(target_os = "linux", target_arch = "aarch64")) {
                "https://github.com/mongodb-js/mongosh/releases/download/v2.3.8/mongosh-2.3.8-linux-arm64.tgz"
            } else if cfg!(all(target_os = "macos", target_arch = "aarch64")) {
                "https://github.com/mongodb-js/mongosh/releases/download/v2.3.8/mongosh-2.3.8-darwin-arm64.zip"
            } else if cfg!(all(target_os = "macos", target_arch = "x86_64")) {
                "https://github.com/mongodb-js/mongosh/releases/download/v2.3.8/mongosh-2.3.8-darwin-x64.zip"
            } else if cfg!(target_os = "windows") {
                "https://github.com/mongodb-js/mongosh/releases/download/v2.3.8/mongosh-2.3.8-win32-x64.zip"
            } else {
                return None;
            };
            Some(DownloadSpec { url, major: 2 })
        }
    }
}

// ─── Discovery ────────────────────────────────────────────────────────────────

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum ToolSource {
    /// Found on the process PATH.
    Path,
    /// Found in a well-known install folder that is not on PATH.
    InstallDir,
    /// Downloaded by QueryDen into the app data cache.
    Cached,
}

impl ToolSource {
    fn as_str(&self) -> &'static str {
        match self {
            ToolSource::Path => "path",
            ToolSource::InstallDir => "install_dir",
            ToolSource::Cached => "cached",
        }
    }
}

struct FoundTool {
    path: PathBuf,
    source: ToolSource,
    /// Major version of a cached download; 0 for system installs.
    cached_major: u32,
}

fn exe_name(binary: &str) -> String {
    format!("{}{}", binary, std::env::consts::EXE_SUFFIX)
}

fn major_of(name: &str) -> Option<u32> {
    name.split(|c: char| !c.is_ascii_digit())
        .find(|s| !s.is_empty())
        .and_then(|s| s.parse().ok())
}

/// Collect every `<parent>/<prefix>*/<rel..>` that exists, tagged with the
/// major version parsed from the directory name (0 when it has none).
fn scan_versioned_dirs(parent: &Path, prefix: &str, rel: &[&str], out: &mut Vec<(u32, PathBuf)>) {
    let Ok(entries) = std::fs::read_dir(parent) else {
        return;
    };
    for entry in entries.flatten() {
        let name = entry.file_name().to_string_lossy().to_string();
        let Some(rest) = name.strip_prefix(prefix) else {
            continue;
        };
        let mut candidate = entry.path();
        for part in rel {
            candidate.push(part);
        }
        if candidate.is_file() {
            out.push((major_of(rest).unwrap_or(0), candidate));
        }
    }
}

fn push_if_file(path: PathBuf, out: &mut Vec<(u32, PathBuf)>) {
    if path.is_file() {
        out.push((0, path));
    }
}

#[cfg(target_os = "windows")]
fn program_files_roots() -> Vec<PathBuf> {
    let mut roots: Vec<PathBuf> = Vec::new();
    for var in ["ProgramFiles", "ProgramW6432", "ProgramFiles(x86)"] {
        if let Ok(v) = std::env::var(var) {
            let p = PathBuf::from(v);
            if !roots.contains(&p) {
                roots.push(p);
            }
        }
    }
    if roots.is_empty() {
        roots.push(PathBuf::from(r"C:\Program Files"));
    }
    roots
}

/// Install folders the OS installers use, regardless of PATH.
fn install_dir_candidates(kind: ToolKind) -> Vec<(u32, PathBuf)> {
    let mut out: Vec<(u32, PathBuf)> = Vec::new();
    let bin = exe_name(kind.primary_binary());
    let bin = bin.as_str();

    #[cfg(target_os = "windows")]
    {
        let home = std::env::var("USERPROFILE").map(PathBuf::from).ok();
        let local = std::env::var("LOCALAPPDATA").map(PathBuf::from).ok();
        for root in program_files_roots() {
            match kind {
                ToolKind::Psql => {
                    scan_versioned_dirs(&root.join("PostgreSQL"), "", &["bin", bin], &mut out);
                    push_if_file(root.join("PostgreSQL").join("bin").join(bin), &mut out);
                }
                ToolKind::MySql => {
                    scan_versioned_dirs(&root.join("MySQL"), "MySQL Server ", &["bin", bin], &mut out);
                    scan_versioned_dirs(&root.join("MariaDB"), "", &["bin", bin], &mut out);
                    scan_versioned_dirs(&root, "MariaDB ", &["bin", bin], &mut out);
                }
                ToolKind::Mongo => {
                    scan_versioned_dirs(&root.join("MongoDB").join("Server"), "", &["bin", bin], &mut out);
                    push_if_file(root.join("mongosh").join(bin), &mut out);
                }
            }
        }
        if let Some(home) = home {
            let scoop_app = match kind {
                ToolKind::Psql => "postgresql",
                ToolKind::MySql => "mysql",
                ToolKind::Mongo => "mongosh",
            };
            let scoop = home.join("scoop").join("apps").join(scoop_app).join("current");
            push_if_file(scoop.join("bin").join(bin), &mut out);
            push_if_file(scoop.join(bin), &mut out);
        }
        if let (Some(local), ToolKind::Mongo) = (local, kind) {
            push_if_file(local.join("Programs").join("mongosh").join(bin), &mut out);
        }
    }

    #[cfg(target_os = "macos")]
    {
        let brew_roots = [Path::new("/opt/homebrew"), Path::new("/usr/local")];
        match kind {
            ToolKind::Psql => {
                for root in brew_roots {
                    scan_versioned_dirs(&root.join("opt"), "postgresql@", &["bin", bin], &mut out);
                    push_if_file(root.join("opt").join("libpq").join("bin").join(bin), &mut out);
                    push_if_file(root.join("bin").join(bin), &mut out);
                }
                scan_versioned_dirs(
                    Path::new("/Applications/Postgres.app/Contents/Versions"),
                    "",
                    &["bin", bin],
                    &mut out,
                );
                scan_versioned_dirs(Path::new("/Library/PostgreSQL"), "", &["bin", bin], &mut out);
                scan_versioned_dirs(Path::new("/opt/local/lib"), "postgresql", &["bin", bin], &mut out);
            }
            ToolKind::MySql => {
                for root in brew_roots {
                    push_if_file(root.join("opt").join("mysql-client").join("bin").join(bin), &mut out);
                    scan_versioned_dirs(&root.join("opt"), "mysql-client@", &["bin", bin], &mut out);
                    push_if_file(root.join("bin").join(bin), &mut out);
                }
                push_if_file(PathBuf::from("/usr/local/mysql/bin").join(bin), &mut out);
            }
            ToolKind::Mongo => {
                for root in brew_roots {
                    push_if_file(root.join("bin").join(bin), &mut out);
                }
            }
        }
    }

    #[cfg(all(unix, not(target_os = "macos")))]
    {
        match kind {
            ToolKind::Psql => {
                // Debian/Ubuntu ship real binaries here; /usr/bin/psql is a
                // Perl wrapper that needs postgresql-common to be healthy.
                scan_versioned_dirs(Path::new("/usr/lib/postgresql"), "", &["bin", bin], &mut out);
                // PGDG RPMs (RHEL, Fedora, Rocky, Alma).
                scan_versioned_dirs(Path::new("/usr"), "pgsql-", &["bin", bin], &mut out);
                push_if_file(PathBuf::from("/usr/local/pgsql/bin").join(bin), &mut out);
            }
            ToolKind::MySql | ToolKind::Mongo => {}
        }
        push_if_file(PathBuf::from("/usr/bin").join(bin), &mut out);
        push_if_file(PathBuf::from("/usr/local/bin").join(bin), &mut out);
        push_if_file(PathBuf::from("/home/linuxbrew/.linuxbrew/bin").join(bin), &mut out);
        push_if_file(PathBuf::from("/snap/bin").join(bin), &mut out);
    }

    out
}

/// Newest install-folder match. Versioned folders win over unversioned
/// ones, so `/usr/lib/postgresql/17` beats the `/usr/bin` wrapper.
fn find_in_install_dirs(kind: ToolKind) -> Option<PathBuf> {
    install_dir_candidates(kind)
        .into_iter()
        .max_by_key(|(major, _)| *major)
        .map(|(_, path)| path)
}

/// PATH first, then the OS install folders. Never the download cache.
fn find_system_tool(kind: ToolKind) -> Option<FoundTool> {
    for binary in kind.all_binaries() {
        if let Ok(path) = which::which(binary) {
            return Some(FoundTool { path, source: ToolSource::Path, cached_major: 0 });
        }
    }
    find_in_install_dirs(kind).map(|path| FoundTool { path, source: ToolSource::InstallDir, cached_major: 0 })
}

/// First line of `<binary> --version`, bounded so a hung binary can't stall
/// the settings page.
async fn binary_version(binary: &Path) -> Option<String> {
    let mut cmd = Command::new(binary);
    cmd.arg("--version").stdin(Stdio::null()).kill_on_drop(true);
    no_console_window(&mut cmd);
    let output = tokio::time::timeout(std::time::Duration::from_secs(5), cmd.output())
        .await
        .ok()?
        .ok()?;
    if !output.status.success() {
        return None;
    }
    String::from_utf8_lossy(&output.stdout)
        .lines()
        .next()
        .map(|l| l.trim().to_string())
        .filter(|l| !l.is_empty())
}

// ─── CLI Manager ───────────────────────────────────────────────────────────────

pub struct CliManager {
    tools_dir: PathBuf,
}

impl CliManager {
    pub fn new(app_handle: &tauri::AppHandle) -> Self {
        let app_data = app_handle
            .path()
            .app_data_dir()
            .unwrap_or_else(|_| PathBuf::from("."));
        let tools_dir = app_data.join("cli-tools");
        std::fs::create_dir_all(&tools_dir).ok();
        Self { tools_dir }
    }

    /// Base directory for a tool+version: <app data>/cli-tools/mongodb-2/
    fn versioned_dir(&self, kind: ToolKind, major_version: u32) -> PathBuf {
        self.tools_dir
            .join(format!("{}-{}", kind.alias(), major_version))
    }

    /// Path to a specific binary: <app data>/cli-tools/mongodb-2/bin/mongosh
    fn binary_path(&self, kind: ToolKind, major_version: u32, binary: &str) -> PathBuf {
        self.versioned_dir(kind, major_version)
            .join("bin")
            .join(exe_name(binary))
    }

    /// Cached downloads, as (major, primary binary path).
    fn cached_versions(&self, kind: ToolKind) -> Vec<(u32, PathBuf)> {
        let Ok(entries) = std::fs::read_dir(&self.tools_dir) else {
            return Vec::new();
        };
        let mut found = Vec::new();
        for entry in entries.flatten() {
            let name = entry.file_name().to_string_lossy().to_string();
            let Some((dir_kind, version_str)) = name.split_once('-') else {
                continue;
            };
            if dir_kind != kind.alias() {
                continue;
            }
            let Ok(major) = version_str.parse::<u32>() else {
                continue;
            };
            let primary = self.binary_path(kind, major, kind.primary_binary());
            if primary.is_file() {
                found.push((major, primary));
            }
        }
        found
    }

    /// System install first, then the newest cached download.
    fn find_available(&self, kind: ToolKind) -> Option<FoundTool> {
        if let Some(found) = find_system_tool(kind) {
            return Some(found);
        }
        self.cached_versions(kind)
            .into_iter()
            .max_by_key(|(major, _)| *major)
            .map(|(major, path)| FoundTool { path, source: ToolSource::Cached, cached_major: major })
    }

    /// Download and extract a CLI tool. Returns the binary path and the
    /// major version it was cached under.
    async fn download(&self, kind: ToolKind) -> Result<(PathBuf, u32), String> {
        let spec = download_spec(kind)
            .ok_or_else(|| format!("Download not available for {}", kind))?;

        let dest_dir = self.versioned_dir(kind, spec.major);
        let bin_dir = dest_dir.join("bin");
        std::fs::create_dir_all(&bin_dir).map_err(|e| e.to_string())?;

        let tmp_path = dest_dir.join("download.tmp");

        let client = reqwest::Client::builder()
            .timeout(std::time::Duration::from_secs(300))
            .build()
            .map_err(|e| e.to_string())?;

        let response = client
            .get(spec.url)
            .send()
            .await
            .map_err(|e| format!("Download failed: {}", e))?;

        if !response.status().is_success() {
            return Err(format!("HTTP {} — {}", response.status(), spec.url));
        }

        let bytes = response
            .bytes()
            .await
            .map_err(|e| format!("Failed to read download: {}", e))?;

        std::fs::write(&tmp_path, &bytes).map_err(|e| e.to_string())?;

        let reader = std::fs::File::open(&tmp_path).map_err(|e| e.to_string())?;
        let extracted = if spec.url.ends_with(".tar.gz") || spec.url.ends_with(".tgz") {
            let dec = flate2::read::GzDecoder::new(reader);
            tar::Archive::new(dec).unpack(&dest_dir).map_err(|e| e.to_string())
        } else {
            zip::ZipArchive::new(reader)
                .and_then(|mut arch| arch.extract(&dest_dir))
                .map_err(|e| e.to_string())
        };
        std::fs::remove_file(&tmp_path).ok();
        extracted?;

        self.relocate_binaries(&dest_dir, kind)?;

        let primary = self.binary_path(kind, spec.major, kind.primary_binary());
        if primary.is_file() {
            Ok((primary, spec.major))
        } else {
            Err(format!("Binary not found after download. Expected: {}", primary.display()))
        }
    }

    /// Archives unpack to a versioned top-level folder (`mongosh-2.3.8-linux-x64/bin/…`).
    /// Move the binaries we need into `<dest>/bin` and mark them executable.
    fn relocate_binaries(&self, extracted_dir: &Path, kind: ToolKind) -> Result<(), String> {
        let bin_dir = extracted_dir.join("bin");
        std::fs::create_dir_all(&bin_dir).map_err(|e| e.to_string())?;

        let primary = exe_name(kind.primary_binary());
        let search_dir = std::fs::read_dir(extracted_dir)
            .map_err(|e| e.to_string())?
            .flatten()
            .map(|e| e.path())
            .find(|d| d.is_dir() && d.join("bin").join(&primary).is_file())
            .unwrap_or_else(|| extracted_dir.to_path_buf());

        for binary in kind.all_binaries() {
            let name = exe_name(binary);
            let src = search_dir.join("bin").join(&name);
            let dst = bin_dir.join(&name);
            if !src.is_file() {
                continue;
            }
            if dst != src {
                if dst.exists() {
                    std::fs::remove_file(&dst).ok();
                }
                std::fs::rename(&src, &dst).map_err(|e| e.to_string())?;
            }
            #[cfg(unix)]
            {
                use std::os::unix::fs::PermissionsExt;
                std::fs::set_permissions(&dst, std::fs::Permissions::from_mode(0o755))
                    .map_err(|e| e.to_string())?;
            }
        }

        Ok(())
    }
}

// ─── Command builders ──────────────────────────────────────────────────────────

struct ServerArgs<'a> {
    host: &'a str,
    port: u16,
    database: &'a str,
    username: &'a str,
    password: &'a str,
}

/// psql with credentials in the environment (never argv, which `ps` shows),
/// `~/.psqlrc` ignored (`-X`: a user's `\timing` or `\x auto` would corrupt
/// parsed output) and a bounded connect so an unreachable host fails fast.
fn psql_command(binary: &Path, server: &ServerArgs) -> Command {
    let mut cmd = Command::new(binary);
    cmd.env("PGPASSWORD", server.password)
        // Force UTF-8 regardless of the Windows console code page —
        // otherwise non-ASCII output is undecodable/mangled.
        .env("PGCLIENTENCODING", "UTF8")
        .env("PGCONNECT_TIMEOUT", "15")
        .env("PGAPPNAME", "QueryDen")
        .arg("-X")
        .arg("-w")
        .arg("-h")
        .arg(server.host)
        .arg("-p")
        .arg(server.port.to_string())
        .arg("-d")
        .arg(server.database)
        .arg("-U")
        .arg(server.username)
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .kill_on_drop(true);
    no_console_window(&mut cmd);
    cmd
}

/// mysql with the password in `MYSQL_PWD` instead of `-p<password>` on argv.
fn mysql_command(binary: &Path, server: &ServerArgs, with_database: bool) -> Command {
    let mut cmd = Command::new(binary);
    if !server.password.is_empty() {
        cmd.env("MYSQL_PWD", server.password);
    }
    cmd.arg("-h")
        .arg(server.host)
        .arg("-P")
        .arg(server.port.to_string())
        .arg("-u")
        .arg(server.username)
        .arg("--connect-timeout=15");
    if with_database && !server.database.is_empty() {
        cmd.arg("-D").arg(server.database);
    }
    cmd.stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .kill_on_drop(true);
    no_console_window(&mut cmd);
    cmd
}

/// mongosh connection string with percent-encoded credentials.
fn mongo_uri(server: &ServerArgs) -> Result<String, String> {
    let mut uri = url::Url::parse(&format!("mongodb://{}:{}/", server.host, server.port))
        .map_err(|e| format!("Invalid MongoDB host: {}", e))?;
    uri.set_path(server.database);
    if !server.username.is_empty() {
        uri.set_username(server.username).map_err(|_| "Invalid MongoDB username".to_string())?;
        uri.set_password(Some(server.password)).map_err(|_| "Invalid MongoDB password".to_string())?;
    }
    Ok(uri.to_string())
}

fn mongo_command(binary: &Path, server: &ServerArgs, script: &str) -> Result<Command, String> {
    let mut cmd = Command::new(binary);
    cmd.arg("--quiet")
        .arg("--eval")
        .arg(script)
        .arg(mongo_uri(server)?)
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .kill_on_drop(true);
    no_console_window(&mut cmd);
    Ok(cmd)
}

// ─── Output parser ─────────────────────────────────────────────────────────────

// psql's unaligned mode with control-character separators. Unlike `|` and
// `\n`, these never occur in real data, so values containing pipes or line
// breaks survive intact. NULL gets its own marker so it stays distinct from
// an empty string.
const FIELD_SEP: char = '\u{1f}';
const RECORD_SEP: char = '\u{1e}';
const NULL_MARK: &str = "\u{1a}";

fn looks_like_command_tag(line: &str) -> bool {
    let t = line.trim();
    if t.is_empty() {
        return false;
    }
    // Fixed multi-word tags whose verb takes no object kind.
    if t == "START TRANSACTION" || t == "SECURITY LABEL" {
        return true;
    }
    if let Some((verb, rest)) = t.split_once(' ') {
        // DML tags: verb + ASCII row counts only.
        if matches!(verb, "SELECT" | "INSERT" | "UPDATE" | "DELETE" | "MERGE" | "COPY" | "MOVE" | "FETCH") {
            return !rest.is_empty()
                && rest.split_whitespace().all(|p| p.bytes().all(|c| c.is_ascii_digit()));
        }
        // DDL tags: verb + object kind (`CREATE TABLE`, `DROP INDEX`,
        // `DISCARD ALL`, …). Real psql tags never carry anything else.
        const DDL_VERBS: [&str; 6] = [
            "CREATE", "DROP", "ALTER", "TRUNCATE", "REFRESH", "DISCARD",
        ];
        return DDL_VERBS.contains(&verb);
    }
    // Bare single-word tags (`COMMIT`, `GRANT`, `DO`, `VACUUM`, …). Matching
    // is case-sensitive, so only an all-caps header collides — and that
    // requires a quoted reserved word used as a column name on a zero-row
    // result, which is vanishingly rare versus the certainty of tags.
    const BARE_TAGS: [&str; 23] = [
        "COMMIT", "ROLLBACK", "BEGIN", "DO", "SET", "RESET", "ABORT", "END",
        "CALL", "VACUUM", "ANALYZE", "CHECKPOINT", "REINDEX", "GRANT",
        "REVOKE", "COMMENT", "LISTEN", "UNLISTEN", "NOTIFY", "CLUSTER",
        "PREPARE", "EXECUTE", "DEALLOCATE",
    ];
    BARE_TAGS.contains(&t)
}

/// Row count carried by a DML tag (`UPDATE 5` → 5, `INSERT 0 3` → 3).
fn tag_row_count(tag: &str) -> Option<i64> {
    let (verb, rest) = tag.trim().split_once(' ')?;
    if !matches!(verb, "SELECT" | "INSERT" | "UPDATE" | "DELETE" | "MERGE" | "COPY" | "MOVE" | "FETCH") {
        return None;
    }
    rest.split_whitespace().last()?.parse().ok()
}

#[derive(Debug, Default, PartialEq)]
struct PsqlOutput {
    columns: Vec<String>,
    rows: Vec<Vec<Option<String>>>,
    /// Trailing command tag (`INSERT 0 2` after `RETURNING` rows, or the
    /// whole output of a statement that returns no rows).
    tag: Option<String>,
}

/// Parse psql output produced with `-A -F <FIELD_SEP> -R <RECORD_SEP>
/// -P footer=off -P null=<NULL_MARK>`.
///
/// Shape: `header RS row RS row\n[TAG\n]`. A statement without a result set
/// prints only `TAG\n`; an empty result set prints only `header\n`.
fn parse_psql_output(stdout: &str) -> PsqlOutput {
    let mut body = stdout.trim_end_matches(['\n', '\r']);

    let mut tag = None;
    let (head, last_line) = match body.rfind('\n') {
        Some(i) => (&body[..i], &body[i + 1..]),
        None => ("", body),
    };
    if looks_like_command_tag(last_line) {
        tag = Some(last_line.trim().to_string());
        body = head.trim_end_matches('\r');
    }

    if body.is_empty() {
        return PsqlOutput { tag, ..Default::default() };
    }

    let mut records = body.split(RECORD_SEP);
    let columns: Vec<String> = records
        .next()
        .unwrap_or_default()
        .split(FIELD_SEP)
        .map(|s| s.to_string())
        .collect();

    let rows = records
        .map(|record| {
            record
                .split(FIELD_SEP)
                .map(|v| if v == NULL_MARK { None } else { Some(v.to_string()) })
                .collect::<Vec<_>>()
        })
        .filter(|row| row.len() == columns.len())
        .collect();

    PsqlOutput { columns, rows, tag }
}

/// Parse PostgreSQL version string and return the major version number.
/// Input: "PostgreSQL 16.5" or "PostgreSQL 16.5 on x86_64..." etc.
fn parse_pg_version(version_output: &str) -> Result<u32, String> {
    let parts: Vec<&str> = version_output.split_whitespace().collect();
    if parts.len() < 2 {
        return Err(format!("Unexpected version format: {}", version_output));
    }
    let version_num = parts[1];
    version_num
        .split('.')
        .next()
        .and_then(|s| s.parse().ok())
        .ok_or_else(|| format!("Could not parse major version from: {}", version_num))
}

fn stderr_lines(stderr: &[u8]) -> Vec<String> {
    String::from_utf8_lossy(stderr)
        .lines()
        .map(|l| l.trim_end().to_string())
        .filter(|l| !l.is_empty())
        .collect()
}

// ─── Tauri commands ───────────────────────────────────────────────────────────

#[derive(Debug, Serialize, Deserialize)]
pub struct ToolInfo {
    pub kind: String,
    pub major_version: Option<u32>,
    pub available: bool,
    pub path: Option<String>,
    /// "path" | "install_dir" | "cached"
    pub source: Option<String>,
    /// First line of `--version`, e.g. "psql (PostgreSQL) 16.4".
    pub version: Option<String>,
    /// Whether QueryDen can download this tool on the current platform.
    pub downloadable: bool,
    pub system_install_hint: String,
}

#[derive(Debug, Serialize, Deserialize)]
pub struct CachedTool {
    pub kind: String,
    pub major_version: u32,
    pub binaries: Vec<String>,
    pub path: String,
    pub size_bytes: u64,
}

/// Recursively sum file sizes under `path`.
fn dir_size(path: &Path) -> u64 {
    let mut total = 0u64;
    if let Ok(entries) = std::fs::read_dir(path) {
        for entry in entries.flatten() {
            let p = entry.path();
            if p.is_dir() {
                total += dir_size(&p);
            } else if let Ok(meta) = entry.metadata() {
                total += meta.len();
            }
        }
    }
    total
}

/// Check all tools — system and bundled — and return their status.
#[tauri::command]
pub async fn cli_check_tools(
    manager: State<'_, CliManager>,
) -> Result<Vec<ToolInfo>, String> {
    let mut infos = Vec::new();

    for kind in [ToolKind::Psql, ToolKind::MySql, ToolKind::Mongo] {
        let found = manager.find_available(kind);
        let version = match &found {
            Some(f) => binary_version(&f.path).await,
            None => None,
        };
        infos.push(ToolInfo {
            kind: kind.alias().to_string(),
            major_version: found.as_ref().map(|f| f.cached_major).filter(|m| *m != 0),
            available: found.is_some(),
            path: found.as_ref().map(|f| f.path.to_string_lossy().to_string()),
            source: found.as_ref().map(|f| f.source.as_str().to_string()),
            version,
            downloadable: download_spec(kind).is_some(),
            system_install_hint: kind.system_install_hint().to_string(),
        });
    }

    Ok(infos)
}

/// List all versioned CLI tools currently cached locally.
#[tauri::command]
pub async fn cli_list_cached(
    manager: State<'_, CliManager>,
) -> Result<Vec<CachedTool>, String> {
    let mut cached = Vec::new();

    let entries = std::fs::read_dir(&manager.tools_dir).map_err(|e| e.to_string())?;
    for entry in entries.flatten() {
        let name = entry.file_name().to_string_lossy().to_string();
        let Some((kind_str, version_str)) = name.split_once('-') else {
            continue;
        };
        let Ok(major_version) = version_str.parse::<u32>() else {
            continue;
        };
        let Ok(kind) = parse_tool_kind(kind_str) else {
            continue;
        };

        let bin_dir = manager.versioned_dir(kind, major_version).join("bin");
        let binaries: Vec<String> = std::fs::read_dir(&bin_dir)
            .ok()
            .into_iter()
            .flatten()
            .filter_map(|e| e.ok())
            .filter(|e| e.path().is_file())
            .map(|e| {
                let n = e.file_name().to_string_lossy().to_string();
                match n.strip_suffix(".exe") {
                    Some(stem) if cfg!(target_os = "windows") => stem.to_string(),
                    _ => n,
                }
            })
            .collect();

        cached.push(CachedTool {
            kind: kind.alias().to_string(),
            major_version,
            binaries,
            path: entry.path().to_string_lossy().to_string(),
            size_bytes: dir_size(&entry.path()),
        });
    }

    Ok(cached)
}

/// Remove a cached (downloaded) CLI tool version from disk to free space.
/// Does not touch system-installed binaries — only the versioned cache dir.
#[tauri::command]
pub async fn cli_remove_cached(
    tool_kind: String,
    major_version: u32,
    manager: State<'_, CliManager>,
) -> Result<(), String> {
    let kind = parse_tool_kind(&tool_kind)?;
    let dir = manager.versioned_dir(kind, major_version);
    if !dir.exists() {
        return Ok(());
    }
    std::fs::remove_dir_all(&dir).map_err(|e| format!("Failed to remove cached tool: {}", e))
}

/// Download a CLI tool. `major_version` is advisory: each tool has one
/// pinned download, cached under its real major version.
#[tauri::command]
pub async fn cli_download_version(
    app: AppHandle,
    tool_kind: String,
    major_version: u32,
    manager: State<'_, CliManager>,
) -> Result<String, String> {
    let kind = parse_tool_kind(&tool_kind)?;

    let Some(spec) = download_spec(kind) else {
        return Err(format!(
            "Auto-download is not available for {}. {}",
            tool_kind,
            kind.system_install_hint()
        ));
    };

    if let Some((_, path)) = manager
        .cached_versions(kind)
        .into_iter()
        .find(|(major, _)| *major == spec.major)
    {
        return Ok(path.to_string_lossy().to_string());
    }

    let _ = app.emit("cli-download-progress", serde_json::json!({
        "tool": tool_kind,
        "version": major_version,
        "status": "downloading"
    }));

    let result = manager.download(kind).await;

    let _ = app.emit("cli-download-progress", serde_json::json!({
        "tool": tool_kind,
        "version": spec.major,
        "status": if result.is_ok() { "done" } else { "error" }
    }));

    result.map(|(path, _)| path.to_string_lossy().to_string())
}

/// Check what a CLI tool's status is for a given version.
/// Returns { available, path, needsDownload, downloadUrl, downloadFilename, cachedVersion, installHint }.
/// Does NOT auto-download — lets the frontend decide whether to prompt the user.
#[tauri::command]
pub async fn cli_check_tool(
    tool_kind: String,
    major_version: u32,
    manager: State<'_, CliManager>,
) -> Result<serde_json::Value, String> {
    let kind = parse_tool_kind(&tool_kind)?;

    // A system install always qualifies (psql talks to older and newer
    // servers alike); a cached download only for its own major version.
    if let Some(found) = manager.find_available(kind) {
        if found.cached_major == 0 || found.cached_major == major_version {
            return Ok(serde_json::json!({
                "available": true,
                "path": found.path.to_string_lossy(),
                "needsDownload": false,
                "downloadUrl": serde_json::Value::Null,
                "downloadFilename": serde_json::Value::Null,
                "cachedVersion": if found.cached_major == 0 { serde_json::Value::Null } else { serde_json::json!(found.cached_major) },
                "installHint": serde_json::Value::Null,
            }));
        }
    }

    match download_spec(kind) {
        Some(spec) => Ok(serde_json::json!({
            "available": false,
            "path": serde_json::Value::Null,
            "needsDownload": true,
            "downloadUrl": spec.url,
            "downloadFilename": spec.url.rsplit('/').next().unwrap_or(""),
            "cachedVersion": serde_json::Value::Null,
            "installHint": serde_json::Value::Null,
        })),
        None => Ok(serde_json::json!({
            "available": false,
            "path": serde_json::Value::Null,
            "needsDownload": false,
            "downloadUrl": serde_json::Value::Null,
            "downloadFilename": serde_json::Value::Null,
            "cachedVersion": serde_json::Value::Null,
            "installHint": kind.system_install_hint(),
        })),
    }
}

/// Check for a system install only (PATH or OS install folders). Used when
/// server version is unknown and we just want to know if a system psql exists.
#[tauri::command]
pub async fn cli_check_system_tool(
    tool_kind: String,
) -> Result<serde_json::Value, String> {
    let kind = parse_tool_kind(&tool_kind)?;
    let found = find_system_tool(kind);
    Ok(serde_json::json!({
        "available": found.is_some(),
        "path": found.map(|f| f.path.to_string_lossy().to_string()),
    }))
}

/// Ensure a CLI tool is available (system or download).
/// Returns the binary path.
#[tauri::command]
pub async fn cli_ensure(
    tool_kind: String,
    major_version: Option<u32>,
    manager: State<'_, CliManager>,
) -> Result<String, String> {
    let _ = major_version;
    let kind = parse_tool_kind(&tool_kind)?;

    if let Some(found) = manager.find_available(kind) {
        return Ok(found.path.to_string_lossy().to_string());
    }

    if download_spec(kind).is_none() {
        return Err(kind.system_install_hint().to_string());
    }

    let (path, _) = manager.download(kind).await?;
    Ok(path.to_string_lossy().to_string())
}

/// Get the version string of a CLI tool.
#[tauri::command]
pub async fn cli_get_version(
    tool_kind: String,
    _major_version: Option<u32>,
    manager: State<'_, CliManager>,
) -> Result<String, String> {
    let kind = parse_tool_kind(&tool_kind)?;
    let found = manager.find_available(kind).ok_or_else(|| "Tool not found".to_string())?;
    binary_version(&found.path)
        .await
        .ok_or_else(|| "Version check failed".to_string())
}

/// Detect the major version of a PostgreSQL server via psql.
#[tauri::command]
pub async fn cli_detect_pg_version(
    host: String,
    port: u16,
    database: String,
    username: String,
    password: String,
    manager: tauri::State<'_, CliManager>,
) -> Result<u32, String> {
    let found = manager
        .find_available(ToolKind::Psql)
        .ok_or_else(|| ToolKind::Psql.system_install_hint().to_string())?;

    let server = ServerArgs { host: &host, port, database: &database, username: &username, password: &password };
    let mut cmd = psql_command(&found.path, &server);
    cmd.arg("-t").arg("-A").arg("-c").arg("SELECT version()");
    let output = cmd.output().await.map_err(|e| e.to_string())?;

    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr);
        return Err(format!("Connection failed: {}", stderr.trim()));
    }

    parse_pg_version(&String::from_utf8_lossy(&output.stdout))
}

/// Test a connection using the CLI tool.
#[tauri::command]
#[allow(clippy::too_many_arguments)] // Tauri command — args mirror the IPC contract
pub async fn cli_test_connection(
    tool_kind: String,
    host: String,
    port: u16,
    database: String,
    username: String,
    password: String,
    _major_version: u32,
    manager: tauri::State<'_, CliManager>,
) -> Result<String, String> {
    let kind = parse_tool_kind(&tool_kind)?;
    let found = manager
        .find_available(kind)
        .ok_or_else(|| kind.system_install_hint().to_string())?;

    let server = ServerArgs { host: &host, port, database: &database, username: &username, password: &password };
    let mut cmd = match kind {
        ToolKind::Psql => {
            let mut cmd = psql_command(&found.path, &server);
            cmd.arg("-t").arg("-A").arg("-c").arg("SELECT 1");
            cmd
        }
        ToolKind::MySql => {
            let mut cmd = mysql_command(&found.path, &server, true);
            cmd.arg("-N").arg("-e").arg("SELECT 1");
            cmd
        }
        ToolKind::Mongo => mongo_command(&found.path, &server, "db.runCommand({ ping: 1 })")?,
    };

    let output = cmd.output().await.map_err(|e| e.to_string())?;

    if !output.status.success() {
        return Err(String::from_utf8_lossy(&output.stderr).trim().to_string());
    }

    Ok("Connected successfully".to_string())
}

/// Execute a query using the CLI tool.
///
/// psql results come back as structured `columns` + `rows` (NULL as JSON
/// null). Meta-commands (`\d`, `\dt`, …) and expanded display (`-x`) run in
/// psql's normal aligned format and come back as raw `stdout` lines, exactly
/// as an interactive psql would print them. Server NOTICEs (stderr on a
/// successful run) come back in `notices`.
#[tauri::command]
#[allow(clippy::too_many_arguments)] // Tauri command — args mirror the IPC contract
pub async fn cli_execute_query(
    tool_kind: String,
    query: String,
    host: String,
    port: u16,
    database: String,
    username: String,
    password: String,
    major_version: u32,
    expanded_display: bool,
    manager: tauri::State<'_, CliManager>,
) -> Result<serde_json::Value, String> {
    let _ = major_version;
    let kind = parse_tool_kind(&tool_kind)?;
    let found = manager
        .find_available(kind)
        .ok_or_else(|| kind.system_install_hint().to_string())?;

    let server = ServerArgs { host: &host, port, database: &database, username: &username, password: &password };
    run_cli_query(&found.path, kind, &server, &query, expanded_display).await
}

/// One query through `binary`; the body of `cli_execute_query`.
async fn run_cli_query(
    binary: &Path,
    kind: ToolKind,
    server: &ServerArgs<'_>,
    query: &str,
    expanded_display: bool,
) -> Result<serde_json::Value, String> {
    let is_meta_command = query.trim_start().starts_with('\\');
    let structured = kind == ToolKind::Psql && !expanded_display && !is_meta_command;

    let mut cmd = match kind {
        ToolKind::Psql => {
            let mut cmd = psql_command(binary, server);
            if expanded_display {
                cmd.arg("-x");
            } else if structured {
                cmd.arg("-A")
                    .arg("-F")
                    .arg(FIELD_SEP.to_string())
                    .arg("-R")
                    .arg(RECORD_SEP.to_string())
                    .arg("-P")
                    .arg("footer=off")
                    .arg("-P")
                    .arg(format!("null={}", NULL_MARK));
            }
            cmd.arg("-c").arg(query);
            cmd
        }
        ToolKind::MySql => {
            let mut cmd = mysql_command(binary, server, true);
            cmd.arg("-t").arg("-e").arg(query);
            cmd
        }
        ToolKind::Mongo => mongo_command(binary, server, query)?,
    };

    let start = std::time::Instant::now();
    let output = cmd.output().await.map_err(|e| format!("Spawn failed: {}", e))?;
    let ms = start.elapsed().as_millis() as u64;

    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr);
        return Err(format!("CLI error: {}", stderr.trim()));
    }

    let stdout_text = String::from_utf8_lossy(&output.stdout);
    let notices = stderr_lines(&output.stderr);

    if structured {
        let parsed = parse_psql_output(&stdout_text);
        let rows_affected = parsed
            .tag
            .as_deref()
            .and_then(tag_row_count)
            .unwrap_or(parsed.rows.len() as i64);
        return Ok(serde_json::json!({
            "columns": parsed.columns,
            "rows": parsed.rows,
            "stdout": parsed.tag.into_iter().collect::<Vec<_>>(),
            "notices": notices,
            "rowsAffected": rows_affected,
            "executionTimeMs": ms,
            "error": serde_json::Value::Null,
        }));
    }

    // `str::lines` handles both `\n` and Windows `\r\n` endings.
    let stdout_lines: Vec<String> = stdout_text.lines().map(|l| l.to_string()).collect();
    Ok(serde_json::json!({
        "columns": Vec::<String>::new(),
        "rows": Vec::<Vec<String>>::new(),
        "stdout": stdout_lines,
        "notices": notices,
        "rowsAffected": 0,
        "executionTimeMs": ms,
        "error": serde_json::Value::Null,
    }))
}

/// List databases via the CLI tool.
#[tauri::command]
#[allow(clippy::too_many_arguments)] // Tauri command — args mirror the IPC contract
pub async fn cli_list_databases(
    tool_kind: String,
    host: String,
    port: u16,
    database: String,
    username: String,
    password: String,
    _major_version: u32,
    manager: tauri::State<'_, CliManager>,
) -> Result<Vec<String>, String> {
    let kind = parse_tool_kind(&tool_kind)?;
    let found = manager.find_available(kind).ok_or_else(|| "Tool not found".to_string())?;

    let server = ServerArgs { host: &host, port, database: &database, username: &username, password: &password };
    let mut cmd = match kind {
        ToolKind::Psql => {
            let mut cmd = psql_command(&found.path, &server);
            cmd.arg("-t").arg("-A").arg("-c")
                .arg("SELECT datname FROM pg_database WHERE datistemplate = false ORDER BY datname");
            cmd
        }
        ToolKind::MySql => {
            let mut cmd = mysql_command(&found.path, &server, false);
            cmd.arg("-N").arg("-e").arg("SHOW DATABASES");
            cmd
        }
        ToolKind::Mongo => return Err("Database listing not supported for this tool".to_string()),
    };

    let output = cmd.output().await.map_err(|e| e.to_string())?;

    if !output.status.success() {
        return Err(String::from_utf8_lossy(&output.stderr).trim().to_string());
    }

    let stdout = String::from_utf8_lossy(&output.stdout);
    Ok(stdout.lines().map(|l| l.trim().to_string()).filter(|l| !l.is_empty()).collect())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn out(records: &[&[&str]], tail: &str) -> String {
        let body: Vec<String> = records
            .iter()
            .map(|r| r.join(&FIELD_SEP.to_string()))
            .collect();
        format!("{}\n{}", body.join(&RECORD_SEP.to_string()), tail)
    }

    fn row(v: &[Option<&str>]) -> Vec<Option<String>> {
        v.iter().map(|s| s.map(|s| s.to_string())).collect()
    }

    #[test]
    fn parses_multi_column_select_with_header() {
        let p = parse_psql_output(&out(&[&["id", "name"], &["1", "Alice"], &["2", "Bob"]], ""));
        assert_eq!(p.columns, vec!["id", "name"]);
        assert_eq!(p.rows, vec![row(&[Some("1"), Some("Alice")]), row(&[Some("2"), Some("Bob")])]);
        assert_eq!(p.tag, None);
    }

    #[test]
    fn parses_single_column_select() {
        let p = parse_psql_output(&out(&[&["?column?"], &["1"]], ""));
        assert_eq!(p.columns, vec!["?column?"]);
        assert_eq!(p.rows, vec![row(&[Some("1")])]);
    }

    #[test]
    fn keeps_pipes_newlines_and_nulls_in_values() {
        let p = parse_psql_output(&out(
            &[&["a", "b", "c"], &["x|y", "multi\nline", NULL_MARK], &["", "z", "w"]],
            "",
        ));
        assert_eq!(p.columns, vec!["a", "b", "c"]);
        assert_eq!(
            p.rows,
            vec![
                row(&[Some("x|y"), Some("multi\nline"), None]),
                row(&[Some(""), Some("z"), Some("w")]),
            ]
        );
    }

    #[test]
    fn returning_rows_keep_trailing_tag_separate() {
        let p = parse_psql_output(&out(&[&["id", "v"], &["1", "a"], &["2", "b"]], "INSERT 0 2\n"));
        assert_eq!(p.columns, vec!["id", "v"]);
        assert_eq!(p.rows.len(), 2);
        assert_eq!(p.rows[1], row(&[Some("2"), Some("b")]));
        assert_eq!(p.tag.as_deref(), Some("INSERT 0 2"));
        assert_eq!(tag_row_count("INSERT 0 2"), Some(2));
    }

    #[test]
    fn empty_result_keeps_header() {
        let p = parse_psql_output("id\n");
        assert_eq!(p.columns, vec!["id"]);
        assert!(p.rows.is_empty());
        let p = parse_psql_output(&format!("id{}name\n", FIELD_SEP));
        assert_eq!(p.columns, vec!["id", "name"]);
        assert!(p.rows.is_empty());
    }

    #[test]
    fn command_tags_have_no_grid() {
        for tag in [
            "CREATE TABLE", "DROP TABLE", "ALTER TABLE", "CREATE INDEX", "TRUNCATE TABLE",
            "GRANT", "COMMIT", "ROLLBACK", "BEGIN", "DO", "SET", "VACUUM",
            "START TRANSACTION", "SELECT 1", "INSERT 0 1", "UPDATE 5", "DELETE 3", "COPY 10",
        ] {
            let p = parse_psql_output(&format!("{}\n", tag));
            assert!(p.columns.is_empty() && p.rows.is_empty(), "tag rendered as grid: {tag}");
            assert_eq!(p.tag.as_deref(), Some(tag));
        }
        assert_eq!(tag_row_count("UPDATE 5"), Some(5));
        assert_eq!(tag_row_count("CREATE TABLE"), None);
    }

    #[test]
    fn header_shaped_like_words_still_grids() {
        let p = parse_psql_output("status\n");
        assert_eq!(p.columns, vec!["status"]);
        // Case-sensitive: a quoted lowercase column never matches a tag.
        let p = parse_psql_output("commit\n");
        assert_eq!(p.columns, vec!["commit"]);
    }

    #[test]
    fn windows_line_endings() {
        let p = parse_psql_output(&format!("id{}1\r\nUPDATE 1\r\n", RECORD_SEP));
        assert_eq!(p.columns, vec!["id"]);
        assert_eq!(p.rows, vec![row(&[Some("1")])]);
        assert_eq!(p.tag.as_deref(), Some("UPDATE 1"));
    }

    #[test]
    fn empty_output() {
        assert_eq!(parse_psql_output(""), PsqlOutput::default());
    }

    #[test]
    fn parses_pg_version_strings() {
        assert_eq!(parse_pg_version("PostgreSQL 16.5 on x86_64-pc-linux-gnu").unwrap(), 16);
        assert_eq!(parse_pg_version("PostgreSQL 18.1").unwrap(), 18);
    }

    #[test]
    fn major_from_install_dir_names() {
        assert_eq!(major_of("16"), Some(16));
        assert_eq!(major_of("postgresql@17"), Some(17));
        assert_eq!(major_of("MySQL Server 8.0"), Some(8));
        assert_eq!(major_of("libpq"), None);
    }

    #[test]
    fn scan_picks_versioned_dirs() {
        let root = std::env::temp_dir().join(format!("qd-cli-scan-{}", std::process::id()));
        for v in ["14", "17"] {
            let bin = root.join(v).join("bin");
            std::fs::create_dir_all(&bin).unwrap();
            std::fs::write(bin.join("psql"), b"").unwrap();
        }
        std::fs::create_dir_all(root.join("15").join("bin")).unwrap();
        let mut found = Vec::new();
        scan_versioned_dirs(&root, "", &["bin", "psql"], &mut found);
        found.sort();
        assert_eq!(found.iter().map(|(m, _)| *m).collect::<Vec<_>>(), vec![14, 17]);
        std::fs::remove_dir_all(&root).ok();
    }

    #[test]
    fn mongo_uri_encodes_credentials() {
        let server = ServerArgs { host: "db.local", port: 27017, database: "app", username: "u@x", password: "p:w/d" };
        assert_eq!(mongo_uri(&server).unwrap(), "mongodb://u%40x:p%3Aw%2Fd@db.local:27017/app");
    }

    /// The psql console path end to end: real `psql`, real server. Runs when
    /// `QUERYDEN_TEST_PG_URL` (postgres://user[:pass]@host:port/db) is set
    /// and a psql binary is installed; skipped otherwise.
    #[test]
    fn psql_console_against_a_live_server() {
        let Ok(raw) = std::env::var("QUERYDEN_TEST_PG_URL") else { return };
        let Some(psql) = find_system_tool(ToolKind::Psql) else { return };
        let url = url::Url::parse(&raw).expect("QUERYDEN_TEST_PG_URL");
        let host = url.host_str().unwrap_or("localhost").to_string();
        let database = url.path().trim_start_matches('/').to_string();
        let server = ServerArgs {
            host: &host,
            port: url.port().unwrap_or(5432),
            database: &database,
            username: url.username(),
            password: url.password().unwrap_or(""),
        };
        let rt = tokio::runtime::Builder::new_current_thread().enable_all().build().unwrap();
        let run = |q: &str, expanded: bool| rt.block_on(run_cli_query(&psql.path, ToolKind::Psql, &server, q, expanded));
        let ok = |q: &str| run(q, false).unwrap_or_else(|e| panic!("{q}: {e}"));

        ok("DROP SCHEMA IF EXISTS qd_cli CASCADE");
        let created = ok("CREATE SCHEMA qd_cli");
        assert_eq!(created["stdout"], serde_json::json!(["CREATE SCHEMA"]));
        ok("CREATE TABLE qd_cli.t (id int PRIMARY KEY, v text)");

        let sel = ok("SELECT 1 AS a, NULL AS b, 'x|y' AS c, E'line1\\nline2' AS d, 'ünïcode' AS e");
        assert_eq!(sel["columns"], serde_json::json!(["a", "b", "c", "d", "e"]));
        assert_eq!(sel["rows"], serde_json::json!([["1", null, "x|y", "line1\nline2", "ünïcode"]]));

        let ins = ok("INSERT INTO qd_cli.t VALUES (1, 'a'), (2, 'b') RETURNING id");
        assert_eq!(ins["rows"], serde_json::json!([["1"], ["2"]]));
        assert_eq!(ins["stdout"], serde_json::json!(["INSERT 0 2"]));
        assert_eq!(ins["rowsAffected"], serde_json::json!(2));

        let upd = ok("UPDATE qd_cli.t SET v = 'z'");
        assert_eq!(upd["columns"], serde_json::json!([]));
        assert_eq!(upd["stdout"], serde_json::json!(["UPDATE 2"]));
        assert_eq!(upd["rowsAffected"], serde_json::json!(2));

        let empty = ok("SELECT id FROM qd_cli.t WHERE false");
        assert_eq!(empty["columns"], serde_json::json!(["id"]));
        assert_eq!(empty["rows"], serde_json::json!([]));

        let notice = ok("DO $$ BEGIN RAISE NOTICE 'hello from DO'; END $$");
        assert_eq!(notice["stdout"], serde_json::json!(["DO"]));
        assert!(notice["notices"].to_string().contains("hello from DO"), "{notice}");

        let meta = ok("\\dt qd_cli.*");
        let meta_text = meta["stdout"].to_string();
        assert!(meta_text.contains("List of relations") && meta_text.contains("qd_cli"), "{meta}");

        let expanded = run("SELECT 1 AS a", true).unwrap();
        assert!(expanded["stdout"].to_string().contains("RECORD 1"), "{expanded}");

        let err = run("SELECT * FROM qd_cli.missing", false).unwrap_err();
        assert!(err.contains("does not exist"), "{err}");

        ok("DROP SCHEMA qd_cli CASCADE");
    }
}
