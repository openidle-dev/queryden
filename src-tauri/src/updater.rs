use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::path::PathBuf;
use tracing::{info, warn};

const GITHUB_API_URL: &str =
    "https://api.github.com/repos/openidle-dev/queryden/releases/latest";

// -------------------------------------------------------------------
// Data types
// -------------------------------------------------------------------

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct ReleaseAsset {
    pub name: String,
    pub browser_download_url: String,
    pub size: u64,
}

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct ReleaseInfo {
    pub tag_name: String,
    pub name: Option<String>,
    pub body: Option<String>,
    pub html_url: String,
    pub published_at: Option<String>,
    pub assets: Vec<ReleaseAsset>,
}

#[derive(Debug, Serialize, Clone)]
pub struct UpdateCheckResult {
    pub update_available: bool,
    pub current_version: String,
    pub latest_version: String,
    pub release_name: Option<String>,
    pub changelog: Option<String>,
    pub release_url: String,
    pub published_at: Option<String>,
    pub download_url: Option<String>,
    pub download_size: Option<u64>,
    pub asset_name: Option<String>,
}

// -------------------------------------------------------------------
// Helpers
// -------------------------------------------------------------------

/// Normalise a version string: strip leading 'v'/'V' and trim whitespace.
fn normalise_version(v: &str) -> &str {
    v.trim().trim_start_matches(['v', 'V'])
}

/// Very simple semver compare (major.minor.patch).  Returns true when
/// `latest` is strictly newer than `current`.
fn is_newer(current: &str, latest: &str) -> bool {
    let parse = |s: &str| -> (u64, u64, u64) {
        let mut parts = s.split('.').map(|p| p.parse::<u64>().unwrap_or(0));
        (
            parts.next().unwrap_or(0),
            parts.next().unwrap_or(0),
            parts.next().unwrap_or(0),
        )
    };

    let cur = parse(normalise_version(current));
    let lat = parse(normalise_version(latest));

    lat > cur
}

/// Pick the correct asset for the current platform.
fn pick_asset(assets: &[ReleaseAsset]) -> Option<&ReleaseAsset> {
    #[cfg(target_os = "linux")]
    let candidates: &[&str] = &[".appimage", ".deb"];

    #[cfg(target_os = "windows")]
    let candidates: &[&str] = &[".exe", ".msi"];

    #[cfg(target_os = "macos")]
    let candidates: &[&str] = &[".dmg"];

    #[cfg(not(any(target_os = "linux", target_os = "windows", target_os = "macos")))]
    let candidates: &[&str] = &[];

    for ext in candidates {
        if let Some(a) = assets.iter().find(|a| a.name.to_lowercase().ends_with(ext)) {
            return Some(a);
        }
    }
    None
}

// -------------------------------------------------------------------
// Tauri commands
// -------------------------------------------------------------------

/// Check for updates by fetching the latest GitHub release.
#[tauri::command]
pub async fn check_for_updates_v2() -> Result<UpdateCheckResult, String> {
    let current = env!("CARGO_PKG_VERSION");

    let client = reqwest::Client::builder()
        .user_agent("QueryDen-Updater")
        .build()
        .map_err(|e| format!("HTTP client error: {e}"))?;

    let resp = client
        .get(GITHUB_API_URL)
        .send()
        .await
        .map_err(|e| format!("Network error: {e}"))?;

    // Handle case where no release exists yet (404)
    if resp.status() == reqwest::StatusCode::NOT_FOUND {
        info!("No releases found on GitHub (404). Assuming up-to-date.");
        return Ok(UpdateCheckResult {
            update_available: false,
            current_version: current.to_string(),
            latest_version: current.to_string(),
            release_name: Some("Initial Version".to_string()),
            changelog: Some("Welcome to QueryDen! No updates are available yet.".to_string()),
            release_url: "https://github.com/openidle-dev/queryden/releases".to_string(),
            published_at: None,
            download_url: None,
            download_size: None,
            asset_name: None,
        });
    }

    if !resp.status().is_success() {
        return Err(format!("GitHub API error (Status {}).", resp.status()));
    }

    let release: ReleaseInfo = resp
        .json()
        .await
        .map_err(|e| format!("Decoding error: {e}"))?;

    let latest = normalise_version(&release.tag_name);
    let update_available = is_newer(current, latest);
    let asset = pick_asset(&release.assets);

    info!(
        "Update check: current={current}, latest={latest}, available={update_available}"
    );

    Ok(UpdateCheckResult {
        update_available,
        current_version: current.to_string(),
        latest_version: latest.to_string(),
        release_name: release.name,
        changelog: release.body,
        release_url: release.html_url,
        published_at: release.published_at,
        download_url: asset.map(|a| a.browser_download_url.clone()),
        download_size: asset.map(|a| a.size),
        asset_name: asset.map(|a| a.name.clone()),
    })
}

/// Fetch the expected SHA256 of `url` from a sibling `<url>.sha256` asset
/// (the convention enforced by the release workflow). Returns the 64-character
/// lowercase hex digest with any filename suffix trimmed.
async fn fetch_expected_sha256(client: &reqwest::Client, url: &str) -> Result<String, String> {
    let checksum_url = format!("{url}.sha256");
    info!("Fetching checksum from: {checksum_url}");

    let resp = client
        .get(&checksum_url)
        .send()
        .await
        .map_err(|e| format!("Failed to fetch checksum: {e}"))?;

    if !resp.status().is_success() {
        return Err(format!(
            "Update aborted: no checksum found at {checksum_url} (HTTP {}). \
             Refusing to install unverified binary.",
            resp.status()
        ));
    }

    let body = resp
        .text()
        .await
        .map_err(|e| format!("Failed to read checksum body: {e}"))?;

    // Accept both raw `<hex>` and the GNU `<hex>  filename` format.
    let digest = body
        .split_whitespace()
        .next()
        .ok_or_else(|| "Checksum file is empty".to_string())?
        .to_ascii_lowercase();

    if digest.len() != 64 || !digest.chars().all(|c| c.is_ascii_hexdigit()) {
        return Err(format!("Checksum file does not contain a valid SHA256: {digest:?}"));
    }
    Ok(digest)
}

fn sha256_hex(bytes: &[u8]) -> String {
    let mut hasher = Sha256::new();
    hasher.update(bytes);
    hex::encode(hasher.finalize())
}

/// Create a fresh download directory under the system temp dir with a random
/// suffix, defeating predictable-path symlink attacks on shared machines.
async fn make_download_dir() -> Result<PathBuf, String> {
    let suffix: u64 = rand::random();
    let dir = std::env::temp_dir().join(format!("queryden-update-{suffix:016x}"));
    tokio::fs::create_dir_all(&dir)
        .await
        .map_err(|e| format!("Failed to create download directory: {e}"))?;

    // Best-effort: restrict to owner-only on Unix.
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        if let Err(e) = std::fs::set_permissions(&dir, std::fs::Permissions::from_mode(0o700)) {
            warn!("Failed to tighten permissions on update dir {dir:?}: {e}");
        }
    }
    Ok(dir)
}

/// Download the update asset, verify its SHA256 against the sibling
/// `<asset>.sha256` published in the GitHub release, and return the local path.
/// Aborts with an error if no checksum is published or the hashes don't match —
/// the user is never asked to install an unverified binary.
#[tauri::command]
pub async fn download_update(
    _app: tauri::AppHandle,
    url: String,
    asset_name: String,
) -> Result<String, String> {
    if !url.starts_with("https://") {
        return Err(format!("Refusing to download update over non-HTTPS URL: {url}"));
    }

    info!("Downloading update from: {url}");

    let client = reqwest::Client::builder()
        .user_agent("QueryDen-Updater")
        .build()
        .map_err(|e| format!("HTTP client error: {e}"))?;

    // Fetch checksum BEFORE the binary so a missing/invalid checksum fails fast.
    let expected_sha = fetch_expected_sha256(&client, &url).await?;

    let resp = client
        .get(&url)
        .send()
        .await
        .map_err(|e| format!("Download error: {e}"))?;

    if !resp.status().is_success() {
        return Err(format!("Download failed with status: {}", resp.status()));
    }

    let bytes = resp
        .bytes()
        .await
        .map_err(|e| format!("Failed to read response body: {e}"))?;

    let actual_sha = sha256_hex(&bytes);
    if actual_sha != expected_sha {
        return Err(format!(
            "Update aborted: SHA256 mismatch. expected={expected_sha} actual={actual_sha}"
        ));
    }
    info!("Checksum verified: {actual_sha}");

    let download_dir = make_download_dir().await?;
    let file_path = download_dir.join(&asset_name);
    tokio::fs::write(&file_path, &bytes)
        .await
        .map_err(|e| format!("Failed to write update file: {e}"))?;

    #[cfg(target_os = "linux")]
    {
        if asset_name.to_lowercase().ends_with(".appimage") {
            use std::os::unix::fs::PermissionsExt;
            let perms = std::fs::Permissions::from_mode(0o755);
            std::fs::set_permissions(&file_path, perms)
                .map_err(|e| format!("Failed to make AppImage executable: {e}"))?;
        }
    }

    let path_str = file_path.to_string_lossy().to_string();
    info!("Update downloaded to: {path_str}");
    Ok(path_str)
}

/// Install the downloaded update, then exit so the installer can replace the
/// running binary. Platform-specific flows:
///
/// - **Windows**: silently uninstall the previous build via the registry-stored
///   uninstaller, then run the new NSIS installer with `/S`. This bypasses
///   Tauri's `.onInit` upgrade-detection wizard, which fires before
///   `NSIS_HOOK_PREINSTALL` and so can't be silenced from the `.nsh` hook.
/// - **macOS**: mount the DMG, copy the bundled `.app` over the running one,
///   detach, and schedule a delayed `open -n` so the new instance launches
///   after the old PID has exited.
/// - **Linux AppImage**: replace the running AppImage in place via `$APPIMAGE`
///   and relaunch — avoids accumulating copies under `queryden-update-*`.
/// - **Linux .deb**: hand off to `xdg-open` (no silent flow yet).
#[tauri::command]
pub async fn install_update(app: tauri::AppHandle, file_path: String) -> Result<(), String> {
    let path = PathBuf::from(&file_path);

    if !path.exists() {
        return Err("Update file not found".to_string());
    }

    info!("Installing update from: {file_path}");

    #[cfg(target_os = "linux")]
    {
        let ext = path.extension().and_then(|e| e.to_str()).unwrap_or("");
        match ext.to_lowercase().as_str() {
            "appimage" => install_appimage_linux(&path)?,
            "deb" => install_deb_linux(&path)?,
            _ => {
                // Unknown format — let the desktop pick a handler.
                std::process::Command::new("xdg-open")
                    .arg(&file_path)
                    .spawn()
                    .map_err(|e| format!("Failed to open installer: {e}"))?;
            }
        }
    }

    #[cfg(target_os = "windows")]
    {
        install_nsis_windows(&path)?;
    }

    #[cfg(target_os = "macos")]
    {
        install_dmg_macos(&path)?;
    }

    // Give the installer (or delayed relauncher) a moment to start, then exit.
    tokio::time::sleep(std::time::Duration::from_millis(1500)).await;
    app.exit(0);

    Ok(())
}

// -------------------------------------------------------------------
// Platform install helpers
// -------------------------------------------------------------------

#[cfg(target_os = "linux")]
fn install_appimage_linux(new_path: &std::path::Path) -> Result<(), String> {
    use std::os::unix::fs::PermissionsExt;

    // Replace the running AppImage in place when $APPIMAGE is set so the user
    // ends up with one canonical copy. AppRun sets $APPIMAGE to the absolute
    // path of the AppImage that mounted it.
    if let Some(target) = std::env::var_os("APPIMAGE") {
        let target_path = std::path::PathBuf::from(&target);
        info!("Replacing existing AppImage at {}", target_path.display());

        // Try a rename first; fall back to copy + remove on EXDEV.
        if let Err(rename_err) = std::fs::rename(new_path, &target_path) {
            warn!(
                "rename({} -> {}) failed: {rename_err}; falling back to copy",
                new_path.display(),
                target_path.display()
            );
            std::fs::copy(new_path, &target_path).map_err(|e| {
                format!(
                    "Failed to copy new AppImage over {}: {e}",
                    target_path.display()
                )
            })?;
            let _ = std::fs::remove_file(new_path);
        }

        std::fs::set_permissions(&target_path, std::fs::Permissions::from_mode(0o755))
            .map_err(|e| format!("Failed to chmod {}: {e}", target_path.display()))?;

        std::process::Command::new(&target_path)
            .spawn()
            .map_err(|e| format!("Failed to relaunch AppImage: {e}"))?;
    } else {
        // Not running from a real AppImage — likely a dev build. Just launch
        // the freshly downloaded one and let the user clean up.
        warn!("$APPIMAGE not set; launching new AppImage from temp dir without in-place replacement");
        std::process::Command::new(new_path)
            .spawn()
            .map_err(|e| format!("Failed to launch AppImage: {e}"))?;
    }
    Ok(())
}

#[cfg(target_os = "linux")]
fn install_deb_linux(deb_path: &std::path::Path) -> Result<(), String> {
    // Prefer `pkexec dpkg -i` for a single polkit prompt + silent install
    // when pkexec is available. Fall back to `xdg-open` (opens the
    // desktop's package-manager UI) when pkexec isn't on PATH or returns
    // non-zero — covers auth cancel, dpkg dependency failure, missing
    // polkit agent, etc.
    if which::which("pkexec").is_ok() {
        info!("Installing .deb via pkexec dpkg -i");
        let status = std::process::Command::new("pkexec")
            .args(["dpkg", "-i"])
            .arg(deb_path)
            .status();
        match status {
            Ok(s) if s.success() => return Ok(()),
            Ok(s) => warn!("pkexec dpkg -i exited with {s}; falling back to xdg-open"),
            Err(e) => warn!("Failed to invoke pkexec ({e}); falling back to xdg-open"),
        }
    } else {
        info!("pkexec not available; using xdg-open for .deb install");
    }

    std::process::Command::new("xdg-open")
        .arg(deb_path)
        .spawn()
        .map_err(|e| format!("Failed to open .deb installer: {e}"))?;
    Ok(())
}

#[cfg(target_os = "windows")]
fn install_nsis_windows(new_installer: &std::path::Path) -> Result<(), String> {
    // Silently uninstall the previous build first. Without this, the new
    // installer's `.onInit` triggers Tauri's "previous version detected"
    // wizard, which `NSIS_HOOK_PREINSTALL` is too late to silence.
    silently_uninstall_previous_windows();

    // /S = NSIS silent mode. spawn() returns immediately; the installer
    // continues after our app exits. queryden.exe stays locked until our
    // process exits, which is why install_update sleeps 1.5s afterwards —
    // NSIS gets to the file-copy stage just after the lock is released.
    std::process::Command::new(new_installer)
        .arg("/S")
        .spawn()
        .map_err(|e| format!("Failed to launch installer: {e}"))?;
    Ok(())
}

#[cfg(target_os = "windows")]
fn silently_uninstall_previous_windows() {
    use winreg::enums::*;
    use winreg::RegKey;

    // Tauri's NSIS template writes the uninstall entry at:
    //   Software\Microsoft\Windows\CurrentVersion\Uninstall\${PRODUCTNAME}
    // We check both hives — HKCU is the default since v1.0.7 (per-user
    // install), HKLM catches users still on v1.0.5/v1.0.6 machine-wide builds.
    const SUBKEY: &str = r"Software\Microsoft\Windows\CurrentVersion\Uninstall\QueryDen";

    for &hive in &[HKEY_CURRENT_USER, HKEY_LOCAL_MACHINE] {
        let Ok(key) = RegKey::predef(hive).open_subkey(SUBKEY) else {
            continue;
        };

        // Tauri only writes UninstallString, not QuietUninstallString — we
        // still check the quiet variant first in case a future Tauri release
        // starts populating it.
        let (program, args) =
            if let Ok(quiet) = key.get_value::<String, _>("QuietUninstallString") {
                parse_command_line(&quiet)
            } else if let Ok(plain) = key.get_value::<String, _>("UninstallString") {
                let (prog, mut a) = parse_command_line(&plain);
                a.push("/S".to_string());
                (prog, a)
            } else {
                continue;
            };

        let scope = if hive == HKEY_CURRENT_USER {
            "user"
        } else {
            "machine"
        };
        info!("Uninstalling previous QueryDen ({scope}): {program} {args:?}");

        // Block until the uninstaller exits. NSIS uninstallers self-copy to
        // %TEMP% before deleting their install dir, so they always exit
        // cleanly. Any files still locked (our own queryden.exe) survive —
        // the new installer overwrites them once we exit a moment later.
        match std::process::Command::new(&program).args(&args).status() {
            Ok(s) if s.success() => info!("Previous {scope} install removed"),
            Ok(s) => warn!("Uninstaller ({scope}) exited with status {s}"),
            Err(e) => warn!("Failed to run uninstaller ({scope}) {program}: {e}"),
        }
    }
}

/// Parse a Windows command line of the form `"path with spaces" arg1 arg2`
/// into (program, args). This is the bare minimum needed for the strings NSIS
/// writes to the registry — not full CommandLineToArgvW semantics.
#[cfg(target_os = "windows")]
fn parse_command_line(s: &str) -> (String, Vec<String>) {
    let s = s.trim();
    if let Some(rest) = s.strip_prefix('"') {
        if let Some(end) = rest.find('"') {
            let program = rest[..end].to_string();
            let args = rest[end + 1..]
                .split_whitespace()
                .map(|t| t.to_string())
                .collect();
            return (program, args);
        }
    }
    let mut parts = s.split_whitespace();
    let program = parts.next().unwrap_or("").to_string();
    let args = parts.map(|t| t.to_string()).collect();
    (program, args)
}

#[cfg(target_os = "macos")]
fn install_dmg_macos(dmg: &std::path::Path) -> Result<(), String> {
    let dmg_str = dmg.to_str().ok_or("DMG path is not valid UTF-8")?;

    // 1. Mount.
    let attach = std::process::Command::new("hdiutil")
        .args(["attach", "-nobrowse", "-quiet", dmg_str])
        .output()
        .map_err(|e| format!("hdiutil attach failed: {e}"))?;
    if !attach.status.success() {
        return Err(format!(
            "hdiutil attach exited with {}: {}",
            attach.status,
            String::from_utf8_lossy(&attach.stderr)
        ));
    }

    // 2. Parse the mountpoint — last whitespace-separated token on lines
    //    whose value starts with /Volumes/.
    let stdout = String::from_utf8_lossy(&attach.stdout);
    let mountpoint = stdout
        .lines()
        .filter_map(|line| {
            line.split_whitespace()
                .last()
                .filter(|tok| tok.starts_with("/Volumes/"))
                .map(|s| s.to_string())
        })
        .last()
        .ok_or_else(|| format!("Could not locate DMG mountpoint in hdiutil output:\n{stdout}"))?;
    info!("Mounted DMG at {mountpoint}");

    // Auto-detach on every exit path from here on.
    let _detach_guard = MountGuard {
        mountpoint: mountpoint.clone(),
    };

    // 3. Find the .app bundle inside the mount.
    let app_bundle = std::fs::read_dir(&mountpoint)
        .map_err(|e| format!("Failed to read mountpoint {mountpoint}: {e}"))?
        .filter_map(|e| e.ok())
        .find(|e| {
            e.path()
                .extension()
                .and_then(|x| x.to_str())
                .map(|x| x.eq_ignore_ascii_case("app"))
                .unwrap_or(false)
        })
        .ok_or_else(|| format!("No .app bundle found in {mountpoint}"))?;

    let src = app_bundle.path();
    let app_name = src
        .file_name()
        .ok_or("App bundle has no filename")?
        .to_owned();

    // 4. Pick destination: replace the running bundle if we can locate it,
    //    else fall back to ~/Applications/. This keeps users on /Applications
    //    on /Applications, and users on ~/Applications on ~/Applications.
    let home = std::env::var_os("HOME")
        .map(std::path::PathBuf::from)
        .ok_or("HOME is not set")?;
    let dest_dir = running_app_bundle_dir()
        .and_then(|p| p.parent().map(|x| x.to_path_buf()))
        .unwrap_or_else(|| home.join("Applications"));
    std::fs::create_dir_all(&dest_dir)
        .map_err(|e| format!("Could not create {}: {e}", dest_dir.display()))?;
    let dest = dest_dir.join(&app_name);

    // 5. Remove any existing bundle. POSIX allows unlinking a directory whose
    //    binary is currently executing — the running process keeps its open
    //    fds to the (now unreachable) inodes until exit.
    if dest.exists() {
        std::fs::remove_dir_all(&dest)
            .map_err(|e| format!("Could not remove existing {}: {e}", dest.display()))?;
    }

    // 6. Copy in the new bundle. `cp -R` preserves extended attributes
    //    including the code-signing seal; walking with std::fs::copy would not.
    let copy_status = std::process::Command::new("cp")
        .arg("-R")
        .arg(&src)
        .arg(&dest)
        .status()
        .map_err(|e| format!("cp -R failed: {e}"))?;
    if !copy_status.success() {
        return Err(format!("cp -R exited with status {copy_status}"));
    }

    // 7. Schedule the new app to launch a few seconds AFTER our PID exits.
    //    Calling `open` synchronously here would just bring our own (about-to-
    //    exit) instance forward, since macOS dedupes by Bundle ID.
    let dest_str = dest
        .to_str()
        .ok_or("Destination path is not valid UTF-8")?;
    let shell_cmd = format!("sleep 3 && /usr/bin/open -n {}", shell_quote(dest_str));
    std::process::Command::new("/bin/sh")
        .arg("-c")
        .arg(&shell_cmd)
        .spawn()
        .map_err(|e| format!("Failed to spawn delayed relauncher: {e}"))?;

    Ok(())
}

#[cfg(target_os = "macos")]
fn running_app_bundle_dir() -> Option<std::path::PathBuf> {
    let exe = std::env::current_exe().ok()?;
    let mut current = exe.as_path();
    while let Some(parent) = current.parent() {
        if parent
            .extension()
            .and_then(|e| e.to_str())
            .map(|e| e.eq_ignore_ascii_case("app"))
            .unwrap_or(false)
        {
            return Some(parent.to_path_buf());
        }
        current = parent;
    }
    None
}

#[cfg(target_os = "macos")]
fn shell_quote(s: &str) -> String {
    // Wrap in single quotes; embedded single quotes become '\''.
    format!("'{}'", s.replace('\'', r"'\''"))
}

#[cfg(target_os = "macos")]
struct MountGuard {
    mountpoint: String,
}

#[cfg(target_os = "macos")]
impl Drop for MountGuard {
    fn drop(&mut self) {
        let _ = std::process::Command::new("hdiutil")
            .arg("detach")
            .arg("-quiet")
            .arg(&self.mountpoint)
            .status();
    }
}

/// Get the build timestamp (injected at compile time).
#[tauri::command]
pub fn get_build_info() -> Result<String, String> {
    // This is set in build.rs
    Ok(env!("QUERYDEN_BUILD_DATE").to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn normalise_version_strips_v_prefix_and_whitespace() {
        assert_eq!(normalise_version("v1.2.3"), "1.2.3");
        assert_eq!(normalise_version("V1.2.3"), "1.2.3");
        assert_eq!(normalise_version("  v1.2.3 \n"), "1.2.3");
        assert_eq!(normalise_version("1.2.3"), "1.2.3");
    }

    #[test]
    fn is_newer_detects_strictly_newer_versions() {
        assert!(is_newer("1.0.4", "1.0.5"));
        assert!(is_newer("1.0.4", "1.1.0"));
        assert!(is_newer("1.0.4", "2.0.0"));
        assert!(is_newer("v1.0.4", "v1.0.5"));
    }

    #[test]
    fn is_newer_rejects_equal_or_older_versions() {
        assert!(!is_newer("1.0.5", "1.0.5"));
        assert!(!is_newer("1.0.5", "1.0.4"));
        assert!(!is_newer("2.0.0", "1.99.99"));
    }

    #[test]
    fn is_newer_treats_malformed_segments_as_zero() {
        // We don't want a malformed remote version to look "newer" than a clean local one.
        assert!(!is_newer("1.0.5", "garbage"));
    }

    #[test]
    fn sha256_hex_matches_known_vector() {
        // Empty string SHA256 — standard test vector.
        assert_eq!(
            sha256_hex(b""),
            "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855"
        );
        assert_eq!(
            sha256_hex(b"abc"),
            "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad"
        );
    }

    #[cfg(target_os = "windows")]
    #[test]
    fn parse_command_line_handles_quoted_path_with_spaces() {
        // The exact format NSIS writes to UninstallString — a single quoted
        // path with no following args.
        let (p, a) = parse_command_line(r#""C:\Users\alice\AppData\Local\QueryDen\uninstall.exe""#);
        assert_eq!(p, r"C:\Users\alice\AppData\Local\QueryDen\uninstall.exe");
        assert!(a.is_empty());
    }

    #[cfg(target_os = "windows")]
    #[test]
    fn parse_command_line_preserves_trailing_args() {
        let (p, a) =
            parse_command_line(r#""C:\Program Files\App\uninst.exe" /S /KEEP-USER-DATA"#);
        assert_eq!(p, r"C:\Program Files\App\uninst.exe");
        assert_eq!(a, vec!["/S".to_string(), "/KEEP-USER-DATA".to_string()]);
    }

    #[cfg(target_os = "windows")]
    #[test]
    fn parse_command_line_handles_unquoted() {
        let (p, a) = parse_command_line(r"C:\Tools\uninst.exe /S");
        assert_eq!(p, r"C:\Tools\uninst.exe");
        assert_eq!(a, vec!["/S".to_string()]);
    }
}
