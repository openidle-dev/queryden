//! Embedded CLI tools manager for QueryDen.
//!
//! ## Architecture
//!
//! CLI tools are cached **per major version** (e.g. `postgresql-16`, `postgresql-17`).
//! This ensures pg_dump/pg_restore binaries exactly match the server version.
//!
//! ## Download sources
//!
//! - **PostgreSQL**: https://ftp.postgresql.org/pub/disttar/
//!   - All major versions available as `postgresql-{version}.tar.gz`
//!   - Includes: psql, pg_dump, pg_restore, pg_dumpall
//! - **MySQL**: https://dev.mysql.com/get/Downloads/
//!   - Archives: mysql-{version}-macos{arch}.tar.gz, etc.
//! - **MongoDB**: GitHub releases (mongosh)
//! - **Redis**: GitHub releases (redis-cli)
//!
//! ## On-demand flow
//!
//! 1. User connects via libpq → server responds `SELECT version()`
//! 2. App parses server version (e.g. "PostgreSQL 16.5")
//! 3. App checks if ~/queryden/cli-tools/postgresql-16/ has the binaries
//! 4. If not → dialog asks user to confirm download
//! 5. Download + extract → cache forever under the versioned path

use serde::{Deserialize, Serialize};
use std::path::PathBuf;
use std::process::Stdio;
use tauri::{AppHandle, Emitter, Manager, State};
use tokio::io::{AsyncBufReadExt, BufReader};
use tokio::process::Command;

// ─── Tool kind ───────────────────────────────────────────────────────────────

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub enum ToolKind {
    Psql,
    MySql,
    Mongo,
    Redis,
}

impl ToolKind {
    fn alias(&self) -> &'static str {
        match self {
            ToolKind::Psql => "postgresql",
            ToolKind::MySql => "mysql",
            ToolKind::Mongo => "mongodb",
            ToolKind::Redis => "redis",
        }
    }

    fn primary_binary(&self) -> &'static str {
        match self {
            ToolKind::Psql => "psql",
            ToolKind::MySql => "mysql",
            ToolKind::Mongo => "mongosh",
            ToolKind::Redis => "redis-cli",
        }
    }

    fn all_binaries(&self) -> &'static [&'static str] {
        match self {
            ToolKind::Psql => &["psql", "pg_dump", "pg_restore", "pg_dumpall"],
            ToolKind::MySql => &["mysql", "mysqldump"],
            ToolKind::Mongo => &["mongosh"],
            ToolKind::Redis => &["redis-cli"],
        }
    }

    fn system_install_hint(&self) -> &'static str {
        match self {
            ToolKind::Psql => "PostgreSQL client not found.\n\n\
                Linux (Debian/Ubuntu): sudo apt install postgresql-client\n\
                Linux (Fedora/RHEL):   sudo dnf install postgresql\n\
                macOS:                 brew install libpq\n\
                Windows:              Download from postgresql.org",
            ToolKind::MySql => "MySQL client not found.\n\n\
                Linux (Debian/Ubuntu): sudo apt install mysql-client\n\
                Linux (Fedora/RHEL):   sudo dnf install mysql\n\
                macOS:                 brew install mysql-client\n\
                Windows:              Download from dev.mysql.com",
            ToolKind::Mongo => "mongosh not found.\n\n\
                Install from mongosh.org",
            ToolKind::Redis => "redis-cli not found.\n\n\
                Linux: sudo apt install redis-tools\n\
                macOS: brew install redis",
        }
    }
}

// Known PostgreSQL patch releases with exact filenames.
// Used as a fallback when we have the exact download URL.
// For unknown versions (>= 19 or gaps), URL is constructed dynamically.
const KNOWN_PG_RELEASES: &[(u32, &str)] = &[
    (18, "postgresql-18.0.0.tar.gz"),
    (17, "postgresql-17.4.tar.gz"),
    (16, "postgresql-16.8.tar.gz"),
    (15, "postgresql-15.7.tar.gz"),
    (14, "postgresql-14.12.tar.gz"),
    (13, "postgresql-13.15.tar.gz"),
    (12, "postgresql-12.17.tar.gz"),
];

impl std::fmt::Display for ToolKind {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "{}", self.alias())
    }
}

// ─── Download URL resolver ────────────────────────────────────────────────────

struct DownloadSpec {
    url: String,
    is_archive: bool,
}

/// Returns a known filename for a given PostgreSQL major version, if we have it.
fn known_pg_filename(major: u32) -> Option<&'static str> {
    KNOWN_PG_RELEASES.iter().find(|(v, _)| *v == major).map(|(_, f)| *f)
}

/// Returns a download spec for a tool at a specific major version.
/// For PostgreSQL: always generates a URL (known or constructed).
/// For MongoDB/Redis: uses hardcoded GitHub URLs.
/// For MySQL: uses hardcoded URLs.
fn download_spec(kind: ToolKind, major_version: Option<u32>) -> Option<DownloadSpec> {
    match kind {
        ToolKind::Psql => {
            let maj = major_version.unwrap_or(0);
            if maj == 0 {
                return None;
            }
            // Try known exact filename first, otherwise construct dynamically
            let filename = known_pg_filename(maj)
                .map(|s| s.to_string())
                .unwrap_or_else(|| format!("postgresql-{}.0.0.tar.gz", maj));
            Some(DownloadSpec {
                url: format!("https://ftp.postgresql.org/pub/disttar/{}", filename),
                is_archive: true,
            })
        }
        ToolKind::Mongo => {
            // mongosh publishes platform binaries on GitHub
            let url = if cfg!(all(target_os = "linux", target_arch = "x86_64")) {
                "https://github.com/mongodb-js/mongosh/releases/download/v2.3.8/mongosh-2.3.8-linux-x64.tgz"
            } else if cfg!(all(target_os = "macos", target_arch = "aarch64")) {
                "https://github.com/mongodb-js/mongosh/releases/download/v2.3.8/mongosh-2.3.8-darwin-arm64.tgz"
            } else if cfg!(all(target_os = "macos", target_arch = "x86_64")) {
                "https://github.com/mongodb-js/mongosh/releases/download/v2.3.8/mongosh-2.3.8-darwin-x64.tgz"
            } else if cfg!(target_os = "windows") {
                "https://github.com/mongodb-js/mongosh/releases/download/v2.3.8/mongosh-2.3.8-win32-x64.zip"
            } else {
                return None;
            };
            Some(DownloadSpec { url: url.to_string(), is_archive: true })
        }
        ToolKind::Redis => {
            if cfg!(target_os = "linux") {
                Some(DownloadSpec {
                    url: "https://github.com/redis/redis/raw/7.4.0/src/redis-cli".to_string(),
                    is_archive: false,
                })
            } else {
                None
            }
        }
        ToolKind::MySql => {
            // MySQL compressed tarballs on dev.mysql.com
            let url = if cfg!(all(target_os = "macos", target_arch = "aarch64")) {
                "https://dev.mysql.com/get/Downloads/mysql-9.0.0-macos14-arm64.tar.gz"
            } else if cfg!(all(target_os = "macos", target_arch = "x86_64")) {
                "https://dev.mysql.com/get/Downloads/mysql-9.0.0-macos14-x86_64.tar.gz"
            } else {
                return None;
            };
            Some(DownloadSpec { url: url.to_string(), is_archive: true })
        }
    }
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

    /// Base directory for a tool+version: ~/cli-tools/postgresql-16/
    fn versioned_dir(&self, kind: ToolKind, major_version: u32) -> PathBuf {
        self.tools_dir
            .join(format!("{}-{}", kind.alias(), major_version))
    }

    /// Path to a specific binary: ~/cli-tools/postgresql-16/bin/psql
    fn binary_path(&self, kind: ToolKind, major_version: u32, binary: &str) -> PathBuf {
        let ext = if cfg!(target_os = "windows") { ".exe" } else { "" };
        self.versioned_dir(kind, major_version)
            .join("bin")
            .join(format!("{}{}", binary, ext))
    }

    /// Try system PATH, then bundled binaries for all known versions.
    /// Returns (path, major_version) of the first match.
    async fn find_available(&self, kind: ToolKind) -> Option<(PathBuf, u32)> {
        for binary in kind.all_binaries() {
            if which::which(binary).is_ok() {
                return which::which(binary).ok().map(|p| (p, 0)); // version 0 = system
            }
        }

        // Check bundled versioned directories
        let entries = std::fs::read_dir(&self.tools_dir).ok()?;
        for entry in entries.flatten() {
            let name = entry.file_name().to_string_lossy().to_string();
            // e.g. "postgresql-16" → extract kind and version
            let parts: Vec<&str> = name.split('-').collect();
            if parts.len() != 2 {
                continue;
            }
            let (dir_kind, version_str) = (parts[0], parts[1]);
            if dir_kind != kind.alias() {
                continue;
            }
            let major: u32 = version_str.parse().ok()?;
            let primary = self.binary_path(kind, major, kind.primary_binary());
            if primary.exists() {
                return Some((primary, major));
            }
        }

        None
    }

    /// Check system PATH only (no bundled/auto-download).
    /// Returns (path, version) if a system binary is found.
    async fn find_system(&self, kind: ToolKind) -> Option<(PathBuf, u32)> {
        for binary in kind.all_binaries() {
            if which::which(binary).is_ok() {
                return which::which(binary).ok().map(|p| (p, 0));
            }
        }
        None
    }

    /// Download and extract a versioned CLI tool.
    async fn download_versioned(&self, kind: ToolKind, major_version: u32) -> Result<PathBuf, String> {
        // For unknown major versions (e.g. PostgreSQL 19+ not in KNOWN_PG_RELEASES),
        // resolve the exact filename from the FTP server directory listing.
        let resolved_filename = if let Some(known) = known_pg_filename(major_version) {
            known.to_string()
        } else {
            self.resolve_pg_filename(major_version).await?
        };

        let spec = DownloadSpec {
            url: format!("https://ftp.postgresql.org/pub/disttar/{}", resolved_filename),
            is_archive: true,
        };

        let dest_dir = self.versioned_dir(kind, major_version);
        let bin_dir = dest_dir.join("bin");
        std::fs::create_dir_all(&bin_dir).map_err(|e| e.to_string())?;

        let tmp_path = dest_dir.join("download.tmp");

        // Download with HTTP client
        let client = reqwest::Client::builder()
            .timeout(std::time::Duration::from_secs(300))
            .build()
            .map_err(|e| e.to_string())?;

        let download_url = spec.url.clone();
        let response = client
            .get(&download_url)
            .send()
            .await
            .map_err(|e| format!("Download failed: {}", e))?;

        if !response.status().is_success() {
            return Err(format!("HTTP {} — {}", response.status(), download_url));
        }

        let bytes = response
            .bytes()
            .await
            .map_err(|e| format!("Failed to read download: {}", e))?;

        std::fs::write(&tmp_path, &bytes).map_err(|e| e.to_string())?;

        if spec.is_archive {
            let reader = std::fs::File::open(&tmp_path).map_err(|e| e.to_string())?;
            if spec.url.ends_with(".tar.gz") || spec.url.ends_with(".tgz") {
                let dec = flate2::read::GzDecoder::new(reader);
                let mut arch = tar::Archive::new(dec);
                arch.unpack(&dest_dir).map_err(|e| e.to_string())?;
            } else {
                // ZIP
                let mut arch = zip::ZipArchive::new(reader).map_err(|e| e.to_string())?;
                arch.extract(&dest_dir).map_err(|e| e.to_string())?;
            }

            // PostgreSQL tarballs contain a versioned subdirectory
            // e.g. postgresql-16.8/bin/psql
            // We need to find the actual binaries and move them to our bin/ dir
            self.relocate_binaries(&dest_dir, kind, major_version)
                .await?;
        } else {
            // Single file → put directly in bin/
            let binary = self.binary_path(kind, major_version, kind.primary_binary());
            std::fs::rename(&tmp_path, &binary).map_err(|e| e.to_string())?;
        }

        std::fs::remove_file(&tmp_path).ok();

        // Verify primary binary exists
        let primary = self.binary_path(kind, major_version, kind.primary_binary());
        if primary.exists() {
            #[cfg(unix)]
            {
                use std::os::unix::fs::PermissionsExt;
                if let Ok(meta) = std::fs::metadata(&primary) {
                    let mut perms = meta.permissions();
                    perms.set_mode(0o755);
                    std::fs::set_permissions(&primary, perms).ok();
                }
            }
            Ok(primary)
        } else {
            Err(format!("Binary not found after download. Expected: {}", primary.display()))
        }
    }

    /// Find binaries inside the unpacked archive and move them to our bin/ dir.
    /// PostgreSQL tarballs unpack to a top-level dir like postgresql-16.8/
    async fn relocate_binaries(
        &self,
        extracted_dir: &PathBuf,
        kind: ToolKind,
        _major_version: u32,
    ) -> Result<(), String> {
        let bin_dir = extracted_dir.join("bin");
        std::fs::create_dir_all(&bin_dir).map_err(|e| e.to_string())?;

        // Scan extracted_dir for the actual binaries (they're in a versioned subdir)
        let entries = std::fs::read_dir(extracted_dir).map_err(|e| e.to_string())?;
        let top_level_dirs: Vec<PathBuf> = entries
            .filter_map(|e| e.ok())
            .filter(|e| e.path().is_dir())
            .map(|e| e.path())
            .collect();

        // Find the subdirectory that contains our binaries
        // PostgreSQL: postgresql-16.8/bin/psql exists
        let subdir = top_level_dirs.iter().find(|d| {
            let bin = d.join("bin");
            bin.join(kind.primary_binary()).exists()
        });

        if let Some(src_dir) = subdir {
            for binary in kind.all_binaries() {
                let src = src_dir.join("bin").join(binary);
                if src.exists() {
                    let dst = bin_dir.join(binary);
                    if dst.exists() {
                        std::fs::remove_file(&dst).ok();
                    }
                    std::fs::rename(&src, &dst).map_err(|e| e.to_string())?;

                    #[cfg(unix)]
                    {
                        use std::os::unix::fs::PermissionsExt;
                        if let Ok(meta) = std::fs::metadata(&dst) {
                            let mut perms = meta.permissions();
                            perms.set_mode(0o755);
                            std::fs::set_permissions(&dst, perms).ok();
                        }
                    }
                }
            }
        }

        Ok(())
    }

    /// Fetch the FTP directory listing and find the actual download filename for a
    /// PostgreSQL major version. Falls back to `postgresql-{maj}.0.0.tar.gz` if the
    /// listing can't be fetched.
    async fn resolve_pg_filename(&self, major_version: u32) -> Result<String, String> {
        let client = reqwest::Client::builder()
            .timeout(std::time::Duration::from_secs(30))
            .build()
            .map_err(|e| e.to_string())?;

        let listing_url = "https://ftp.postgresql.org/pub/disttar/";
        let response = client
            .get(listing_url)
            .send()
            .await
            .map_err(|e| format!("Failed to fetch FTP directory: {}", e))?;

        if !response.status().is_success() {
            return Ok(format!("postgresql-{}.0.0.tar.gz", major_version));
        }

        let body = response
            .text()
            .await
            .map_err(|e| e.to_string())?;

        let prefix = format!("postgresql-{}.", major_version);
        let candidates: Vec<&str> = body
            .split('\n')
            .filter_map(|line| {
                let trimmed = line.trim();
                if trimmed.starts_with(&prefix) && trimmed.ends_with(".tar.gz") {
                    Some(trimmed)
                } else {
                    None
                }
            })
            .collect();

        if candidates.is_empty() {
            return Ok(format!("postgresql-{}.0.0.tar.gz", major_version));
        }

        // Pick the latest patch version (highest number after the major)
        let latest = candidates
            .iter()
            .max_by_key(|name| {
                // e.g. "postgresql-19.0.1.tar.gz" → extract "0.1" → parse for sorting
                let after = name.strip_prefix(&prefix).unwrap_or("0.0");
                let patch = after.trim_end_matches(".tar.gz");
                let parts: Vec<u32> = patch
                    .split('.')
                    .filter_map(|s| s.parse().ok())
                    .collect();
                parts.first().copied().unwrap_or(0)
            })
            .unwrap();

        Ok(latest.to_string())
    }
}

// ─── Output parser ─────────────────────────────────────────────────────────────

/// Parse raw psql stdout into structured columns + rows.
/// psql with `-A -F|` outputs:
///   header_line (e.g. "id|name|email")
///   data_line_1  (e.g. "1|Alice|alice@example.com")
///   ...more data...
///   footer_line  (e.g. "(4 rows)")
/// Meta-commands like \d, \dt, \l produce different output that we just return as-is.
fn parse_psql_output(lines: &[String]) -> (Vec<String>, Vec<Vec<String>>) {
    if lines.is_empty() {
        return (Vec::new(), Vec::new());
    }

    // Heuristic: SELECT output has pipe-separated header AND at least one pipe-separated data line
    let first_line = &lines[0];
    let has_pipes = first_line.contains('|');

    if !has_pipes {
        // Meta-command output or empty result — no structured data
        return (Vec::new(), Vec::new());
    }

    let header: Vec<String> = first_line.split('|').map(|s| s.trim().to_string()).collect();

    let mut data_rows: Vec<Vec<String>> = Vec::new();

    for line in lines.iter().skip(1) {
        let trimmed = line.trim();
        // Skip footer lines like "(4 rows)" or "(0 rows)"
        if trimmed.starts_with('(') && trimmed.ends_with("rows)") {
            continue;
        }
        if trimmed.is_empty() {
            continue;
        }
        let values: Vec<String> = line.split('|').map(|s| s.trim().to_string()).collect();
        // Only treat as a data row if it has the same number of columns as the header
        if values.len() == header.len() {
            data_rows.push(values);
        }
    }

    (header, data_rows)
}

// ─── Tauri commands ───────────────────────────────────────────────────────────

#[derive(Debug, Serialize, Deserialize)]
pub struct ToolInfo {
    pub kind: String,
    pub major_version: Option<u32>,
    pub available: bool,
    pub path: Option<String>,
    pub system_install_hint: String,
}

#[derive(Debug, Serialize, Deserialize)]
pub struct CachedTool {
    pub kind: String,
    pub major_version: u32,
    pub binaries: Vec<String>,
    pub path: String,
}

/// Check all tools — system and bundled — and return their status.
#[tauri::command]
pub async fn cli_check_tools(
    manager: State<'_, CliManager>,
) -> Result<Vec<ToolInfo>, String> {
    let mut infos = Vec::new();

    for kind in [ToolKind::Psql, ToolKind::MySql, ToolKind::Mongo, ToolKind::Redis] {
        let (available, path, version) = match manager.find_available(kind).await {
            Some((p, v)) => (true, Some(p.to_string_lossy().to_string()), Some(v)),
            None => (false, None, None),
        };

        infos.push(ToolInfo {
            kind: kind.alias().to_string(),
            major_version: if version == Some(0) { None } else { version },
            available,
            path,
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
        let parts: Vec<&str> = name.split('-').collect();
        if parts.len() != 2 {
            continue;
        }
        let (kind_str, version_str) = (parts[0], parts[1]);
        let major_version: u32 = match version_str.parse() {
            Ok(v) => v,
            Err(_) => continue,
        };
        let kind = match kind_str {
            "postgresql" => ToolKind::Psql,
            "mysql" => ToolKind::MySql,
            "mongodb" => ToolKind::Mongo,
            "redis" => ToolKind::Redis,
            _ => continue,
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
                if cfg!(target_os = "windows") {
                    n.trim_end_matches(".exe").to_string()
                } else {
                    n
                }
            })
            .collect();

        cached.push(CachedTool {
            kind: kind.alias().to_string(),
            major_version,
            binaries,
            path: entry.path().to_string_lossy().to_string(),
        });
    }

    Ok(cached)
}

/// Download a specific version of a CLI tool.
#[tauri::command]
pub async fn cli_download_version(
    app: AppHandle,
    tool_kind: String,
    major_version: u32,
    manager: State<'_, CliManager>,
) -> Result<String, String> {
    let kind = match tool_kind.as_str() {
        "postgresql" => ToolKind::Psql,
        "mysql" => ToolKind::MySql,
        "mongodb" => ToolKind::Mongo,
        "redis" => ToolKind::Redis,
        _ => return Err(format!("Unknown tool: {}", tool_kind)),
    };

    // Check if already cached
    if let Some((path, v)) = manager.find_available(kind).await {
        if v == major_version {
            return Ok(path.to_string_lossy().to_string());
        }
    }

    let _ = app.emit("cli-download-progress", serde_json::json!({
        "tool": tool_kind,
        "version": major_version,
        "status": "downloading"
    }));

    let path = manager.download_versioned(kind, major_version).await?;

    let _ = app.emit("cli-download-progress", serde_json::json!({
        "tool": tool_kind,
        "version": major_version,
        "status": "done"
    }));

    Ok(path.to_string_lossy().to_string())
}

/// Check what a CLI tool's status is for a given version.
/// Returns { available, path, needsDownload, downloadUrl, downloadFilename }.
/// Does NOT auto-download — lets the frontend decide whether to prompt the user.
/// If version > 0, always returns a download spec even if not in KNOWN_PG_RELEASES.
#[tauri::command]
pub async fn cli_check_tool(
    tool_kind: String,
    major_version: u32,
    manager: State<'_, CliManager>,
) -> Result<serde_json::Value, String> {
    let kind = match tool_kind.as_str() {
        "postgresql" => ToolKind::Psql,
        "mysql" => ToolKind::MySql,
        "mongodb" => ToolKind::Mongo,
        "redis" => ToolKind::Redis,
        _ => return Err(format!("Unknown tool: {}", tool_kind)),
    };

    // Check system + cached first
    if let Some((path, v)) = manager.find_available(kind).await {
        if v == 0 || v == major_version {
            return Ok(serde_json::json!({
                "available": true,
                "path": path.to_string_lossy(),
                "needsDownload": false,
                "downloadUrl": serde_json::Value::Null,
                "downloadFilename": serde_json::Value::Null,
                "cachedVersion": if v == 0 { serde_json::Value::Null } else { serde_json::json!(v) },
            }));
        }
        // Cached but wrong version — treat as not matching
    }

    // No exact match — see if we can provide a download spec
    let spec = download_spec(kind, Some(major_version))
        .ok_or_else(|| "Download not available for this platform".to_string())?;

    Ok(serde_json::json!({
        "available": false,
        "path": serde_json::Value::Null,
        "needsDownload": true,
        "downloadUrl": spec.url,
        "downloadFilename": spec.url.rsplit('/').next().unwrap_or(""),
        "cachedVersion": serde_json::Value::Null,
    }))
}

/// Check system PATH only for a tool kind. Used when server version is unknown
/// and we just want to know if a system psql exists.
#[tauri::command]
pub async fn cli_check_system_tool(
    tool_kind: String,
    manager: State<'_, CliManager>,
) -> Result<serde_json::Value, String> {
    let kind = match tool_kind.as_str() {
        "postgresql" => ToolKind::Psql,
        "mysql" => ToolKind::MySql,
        "mongodb" => ToolKind::Mongo,
        "redis" => ToolKind::Redis,
        _ => return Err(format!("Unknown tool: {}", tool_kind)),
    };

    if let Some((path, _)) = manager.find_system(kind).await {
        return Ok(serde_json::json!({
            "available": true,
            "path": path.to_string_lossy(),
        }));
    }

    Ok(serde_json::json!({
        "available": false,
        "path": serde_json::Value::Null,
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
    let kind = match tool_kind.as_str() {
        "postgresql" => ToolKind::Psql,
        "mysql" => ToolKind::MySql,
        "mongodb" => ToolKind::Mongo,
        "redis" => ToolKind::Redis,
        _ => return Err(format!("Unknown tool: {}", tool_kind)),
    };

    // Try system binary first
    if let Some((path, _)) = manager.find_available(kind).await {
        return Ok(path.to_string_lossy().to_string());
    }

    // No download available for this platform → return system install hint
    if download_spec(kind, major_version).is_none() {
        return Err(kind.system_install_hint().to_string());
    }

    let maj = major_version.unwrap_or(16); // default to latest stable
    let path = manager.download_versioned(kind, maj).await?;
    Ok(path.to_string_lossy().to_string())
}

/// Get the version string of a CLI tool.
#[tauri::command]
pub async fn cli_get_version(
    tool_kind: String,
    _major_version: Option<u32>,
    manager: State<'_, CliManager>,
) -> Result<String, String> {
    let kind = match tool_kind.as_str() {
        "postgresql" => ToolKind::Psql,
        "mysql" => ToolKind::MySql,
        "mongodb" => ToolKind::Mongo,
        "redis" => ToolKind::Redis,
        _ => return Err(format!("Unknown tool: {}", tool_kind)),
    };

    let (binary, _) = manager.find_available(kind).await
        .ok_or_else(|| "Tool not found".to_string())?;

    let flag = match kind {
        ToolKind::Psql | ToolKind::MySql => "--version",
        ToolKind::Mongo | ToolKind::Redis => "--version",
    };

    let output = Command::new(&binary)
        .arg(flag)
        .output()
        .await
        .map_err(|e| e.to_string())?;

    if !output.status.success() {
        return Err("Version check failed".to_string());
    }

    Ok(String::from_utf8_lossy(&output.stdout).trim().to_string())
}

/// Detect the major version of a PostgreSQL server.
/// Uses psql's version output to extract the major version.
#[tauri::command]
pub async fn cli_detect_pg_version(
    host: String,
    port: u16,
    database: String,
    username: String,
    password: String,
) -> Result<u32, String> {
    // Try to use psql to get server version
    // First check if psql is available anywhere
    let binary = match which::which("psql") {
        Ok(p) => p,
        Err(_) => {
            return Err(
                "psql not found in PATH. Install PostgreSQL client first:\n\n\
                 Linux: sudo apt install postgresql-client\n\
                 macOS: brew install libpq\n\
                 Windows: Download from postgresql.org".to_string(),
            );
        }
    };

    let output = Command::new(&binary)
        .env("PGPASSWORD", &password)
        .arg("-h")
        .arg(&host)
        .arg("-p")
        .arg(port.to_string())
        .arg("-d")
        .arg(&database)
        .arg("-U")
        .arg(&username)
        .arg("-t") // tuples only
        .arg("-A") // unaligned
        .arg("-w") // never prompt
        .arg("-c")
        .arg("SELECT version()")
        .output()
        .await
        .map_err(|e| e.to_string())?;

    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr);
        return Err(format!("Connection failed: {}", stderr.trim()));
    }

    let version_output = String::from_utf8_lossy(&output.stdout);
    parse_pg_version(&version_output)
}

/// Parse PostgreSQL version string and return the major version number.
/// Input: "PostgreSQL 16.5" or "PostgreSQL 16.5 on x86_64..." etc.
fn parse_pg_version(version_output: &str) -> Result<u32, String> {
    let parts: Vec<&str> = version_output.split_whitespace().collect();
    if parts.len() < 2 {
        return Err(format!("Unexpected version format: {}", version_output));
    }
    let version_num = parts[1]; // e.g. "16.5" or "16.5 on..."
    let major: u32 = version_num
        .split('.')
        .next()
        .and_then(|s| s.parse().ok())
        .ok_or_else(|| format!("Could not parse major version from: {}", version_num))?;
    Ok(major)
}

/// Test a connection using the versioned CLI tool.
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
    let kind = match tool_kind.as_str() {
        "postgresql" => ToolKind::Psql,
        "mysql" => ToolKind::MySql,
        "mongodb" => ToolKind::Mongo,
        "redis" => ToolKind::Redis,
        _ => return Err(format!("Unknown tool: {}", tool_kind)),
    };

    let binary = manager.find_available(kind).await
        .ok_or_else(|| "Tool not found — call cli_download_version first".to_string())?
        .0;

    let test_query = match kind {
        ToolKind::Psql => "SELECT 1",
        ToolKind::MySql => "SELECT 1",
        ToolKind::Mongo => "db.runCommand({ ping: 1 })",
        ToolKind::Redis => "PING",
    };

    let mut cmd = Command::new(&binary);
    match kind {
        ToolKind::Psql => {
            cmd.env("PGPASSWORD", &password);
            cmd.arg("-h").arg(&host);
            cmd.arg("-p").arg(port.to_string());
            cmd.arg("-d").arg(&database);
            cmd.arg("-U").arg(&username);
            cmd.arg("-t").arg("-A").arg("-w");
            cmd.arg("-c").arg(test_query);
        }
        ToolKind::MySql => {
            cmd.arg("-h").arg(&host);
            cmd.arg("-P").arg(port.to_string());
            cmd.arg("-D").arg(&database);
            cmd.arg("-u").arg(&username);
            if !password.is_empty() {
                cmd.arg(format!("-p{}", password));
            }
            cmd.arg("-N").arg("-e").arg(test_query);
        }
        ToolKind::Mongo => {
            cmd.arg("--quiet").arg("--eval").arg(test_query);
            cmd.arg(format!("mongodb://{}:{}@{}:{}/{}",
                username, password, host, port, database));
        }
        ToolKind::Redis => {
            cmd.arg("-h").arg(&host).arg("-p").arg(port.to_string());
            if !password.is_empty() {
                cmd.arg("-a").arg(&password);
            }
            cmd.arg(test_query);
        }
    }

    let output = cmd.output().await.map_err(|e| e.to_string())?;

    if !output.status.success() {
        return Err(String::from_utf8_lossy(&output.stderr).trim().to_string());
    }

    Ok("Connected successfully".to_string())
}

/// Execute a query using the versioned CLI tool.
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
    let kind = match tool_kind.as_str() {
        "postgresql" => ToolKind::Psql,
        "mysql" => ToolKind::MySql,
        "mongodb" => ToolKind::Mongo,
        "redis" => ToolKind::Redis,
        _ => return Err(format!("Unknown tool: {}", tool_kind)),
    };

    let (binary, cached_version) = manager.find_available(kind).await
        .ok_or_else(|| "Tool not found — call cli_download_version first".to_string())?;

    // If the cached version doesn't match required version, warn but proceed
    if cached_version != 0 && cached_version != major_version {
        // For query execution we can tolerate a different minor version,
        // but for pg_dump/pg_restore this would be a problem
    }

    let mut cmd = Command::new(&binary);

    match kind {
        ToolKind::Psql => {
            cmd.env("PGPASSWORD", &password);
            cmd.arg("-h").arg(&host);
            cmd.arg("-p").arg(port.to_string());
            cmd.arg("-d").arg(&database);
            cmd.arg("-U").arg(&username);
            
            if expanded_display {
                cmd.arg("-x");
            } else {
                cmd.arg("-F").arg("|");
            }
            cmd.arg("-w");
        }
        ToolKind::MySql => {
            cmd.arg("-h").arg(&host);
            cmd.arg("-P").arg(port.to_string());
            cmd.arg("-D").arg(&database);
            cmd.arg("-u").arg(&username);
            if !password.is_empty() {
                cmd.arg(format!("-p{}", password));
            }
            cmd.arg("-N").arg("-b").arg("-e").arg(&query);
        }
        ToolKind::Mongo => {
            if !password.is_empty() {
                cmd.env("MONGOSH_WIRED_TIGER_KEY", &password);
            }
            cmd.arg("--quiet").arg("--eval").arg(&query);
            cmd.arg(format!("mongodb://{}:{}@{}:{}/{}",
                username, password, host, port, database));
        }
        ToolKind::Redis => {
            cmd.arg("-h").arg(&host).arg("-p").arg(port.to_string());
            if !password.is_empty() {
                cmd.arg("-a").arg(&password);
            }
            cmd.arg("--no-auth-warning").arg(&query);
        }
    }

    cmd.stdout(Stdio::piped());
    cmd.stderr(Stdio::piped());
    cmd.stdin(Stdio::piped());

    let start = std::time::Instant::now();
    let mut child = cmd.spawn().map_err(|e| format!("Spawn failed: {}", e))?;

    // Write query to stdin
    if let Some(mut stdin) = child.stdin.take() {
        use tokio::io::AsyncWriteExt;
        stdin.write_all(query.as_bytes()).await.ok();
        stdin.flush().await.ok();
        drop(stdin);
    }

    let stdout = child.stdout.take().ok_or("No stdout")?;
    let mut reader = BufReader::new(stdout).lines();

    let mut stdout_lines: Vec<String> = Vec::new();

    while let Ok(Some(line)) = reader.next_line().await {
        stdout_lines.push(line);
    }

    let status = child.wait().await.map_err(|e| e.to_string())?;
    let ms = start.elapsed().as_millis() as u64;

    if !status.success() {
        let stderr = if let Some(mut s) = child.stderr.take() {
            let mut b = String::new();
            tokio::io::AsyncReadExt::read_to_string(&mut s, &mut b).await.ok();
            b
        } else {
            String::new()
        };
        return Err(format!("CLI error: {}", stderr.trim()));
    }

    // Parse stdout into columns + rows if this looks like a SELECT result
    let (columns, rows): (Vec<String>, Vec<Vec<String>>) = if expanded_display {
        (Vec::new(), Vec::new())
    } else {
        parse_psql_output(&stdout_lines)
    };

    Ok(serde_json::json!({
        "columns": columns,
        "rows": rows,
        "stdout": stdout_lines,
        "rowsAffected": rows.len() as i64,
        "executionTimeMs": ms,
        "error": serde_json::Value::Null,
    }))
}

/// List databases via the versioned CLI tool.
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
    let kind = match tool_kind.as_str() {
        "postgresql" => ToolKind::Psql,
        "mysql" => ToolKind::MySql,
        _ => return Err("Database listing not supported for this tool".to_string()),
    };

    let (binary, _) = manager.find_available(kind).await
        .ok_or_else(|| "Tool not found".to_string())?;

    let query = match kind {
        ToolKind::Psql => "SELECT datname FROM pg_database WHERE datistemplate = false ORDER BY datname",
        ToolKind::MySql => "SHOW DATABASES",
        _ => unreachable!(),
    };

    let mut cmd = Command::new(&binary);
    match kind {
        ToolKind::Psql => {
            cmd.env("PGPASSWORD", &password);
            cmd.arg("-h").arg(&host);
            cmd.arg("-p").arg(port.to_string());
            cmd.arg("-d").arg(&database);
            cmd.arg("-U").arg(&username);
            cmd.arg("-t").arg("-A").arg("-F").arg("|").arg("-w");
            cmd.arg("-c").arg(query);
        }
        ToolKind::MySql => {
            cmd.arg("-h").arg(&host);
            cmd.arg("-P").arg(port.to_string());
            cmd.arg("-u").arg(&username);
            if !password.is_empty() {
                cmd.arg(format!("-p{}", password));
            }
            cmd.arg("-N").arg("-e").arg(query);
        }
        _ => unreachable!(),
    }

    let output = cmd.output().await.map_err(|e| e.to_string())?;

    if !output.status.success() {
        return Err(String::from_utf8_lossy(&output.stderr).trim().to_string());
    }

    let stdout = String::from_utf8_lossy(&output.stdout);
    Ok(stdout.lines().map(|l| l.trim().to_string()).filter(|l| !l.is_empty()).collect())
}

/// Get all available PostgreSQL major versions with known filenames.
#[tauri::command]
pub fn cli_get_pg_versions() -> Vec<(u32, String)> {
    KNOWN_PG_RELEASES
        .iter()
        .map(|(v, f)| (*v, f.to_string()))
        .collect()
}
