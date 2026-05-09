use serde::{Deserialize, Serialize};
use std::path::PathBuf;
use tracing::info;

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
    v.trim().trim_start_matches(|c| c == 'v' || c == 'V')
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
    let candidates = &[".appimage", ".deb"];

    #[cfg(target_os = "windows")]
    let candidates = &[".exe", ".msi"];

    #[cfg(not(any(target_os = "linux", target_os = "windows")))]
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

/// Download the update asset to a temp directory and return the path.
#[tauri::command]
pub async fn download_update(
    _app: tauri::AppHandle,
    url: String,
    asset_name: String,
) -> Result<String, String> {
    info!("Downloading update from: {url}");

    let client = reqwest::Client::builder()
        .user_agent("QueryDen-Updater")
        .build()
        .map_err(|e| format!("HTTP client error: {e}"))?;

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

    // Write to a temp directory
    let download_dir = std::env::temp_dir().join("queryden-updates");
    tokio::fs::create_dir_all(&download_dir)
        .await
        .map_err(|e| format!("Failed to create download directory: {e}"))?;

    let file_path = download_dir.join(&asset_name);
    tokio::fs::write(&file_path, &bytes)
        .await
        .map_err(|e| format!("Failed to write update file: {e}"))?;

    // On Linux, make AppImage executable
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

/// Open the downloaded file (installer) using the system default handler,
/// then exit the app so the installer can replace the binary.
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
            "appimage" => {
                // Launch the new AppImage directly
                std::process::Command::new(&file_path)
                    .spawn()
                    .map_err(|e| format!("Failed to launch AppImage: {e}"))?;
            }
            "deb" => {
                // Open with the default package installer
                std::process::Command::new("xdg-open")
                    .arg(&file_path)
                    .spawn()
                    .map_err(|e| format!("Failed to open .deb installer: {e}"))?;
            }
            _ => {
                std::process::Command::new("xdg-open")
                    .arg(&file_path)
                    .spawn()
                    .map_err(|e| format!("Failed to open installer: {e}"))?;
            }
        }
    }

    #[cfg(target_os = "windows")]
    {
        std::process::Command::new("cmd")
            .args(["/C", "start", "", &file_path])
            .spawn()
            .map_err(|e| format!("Failed to launch installer: {e}"))?;
    }

    // Give the installer a moment to start, then exit
    tokio::time::sleep(std::time::Duration::from_millis(1500)).await;
    app.exit(0);

    Ok(())
}

/// Get the build timestamp (injected at compile time).
#[tauri::command]
pub fn get_build_info() -> Result<String, String> {
    // This is set in build.rs
    Ok(env!("QUERYDEN_BUILD_DATE").to_string())
}
