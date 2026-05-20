use serde::Serialize;
use tauri::{Manager, Runtime, Webview};
use tauri_plugin_updater::UpdaterExt;
use url::Url;

const STABLE_ENDPOINT: &str =
    "https://github.com/openidle-dev/queryden/releases/latest/download/latest.json";
const BETA_ENDPOINT: &str =
    "https://github.com/openidle-dev/queryden/releases/download/beta-latest/beta.json";

/// Mirror of the upstream plugin's crate-private `Metadata` struct. The JS
/// `Update` constructor consumes exactly this shape, so we must keep field
/// names and casing in lockstep with @tauri-apps/plugin-updater.
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct UpdateMetadata {
    rid: tauri::ResourceId,
    current_version: String,
    version: String,
    date: Option<String>,
    body: Option<String>,
    raw_json: serde_json::Value,
}

fn endpoint_for(channel: &str) -> &'static str {
    match channel {
        "beta" => BETA_ENDPOINT,
        _ => STABLE_ENDPOINT,
    }
}

#[tauri::command]
pub async fn check_for_update_on_channel<R: Runtime>(
    webview: Webview<R>,
    channel: String,
) -> Result<Option<UpdateMetadata>, String> {
    let url = Url::parse(endpoint_for(&channel)).map_err(|e| e.to_string())?;

    // Webview-scoped: the resource ID must live in the same table the
    // plugin's download/install commands read from.
    let updater = webview
        .updater_builder()
        .endpoints(vec![url])
        .map_err(|e| e.to_string())?
        .build()
        .map_err(|e| e.to_string())?;

    let update = updater.check().await.map_err(|e| e.to_string())?;

    let Some(update) = update else {
        return Ok(None);
    };

    let date = match update.date {
        Some(d) => Some(
            d.format(&time::format_description::well_known::Rfc3339)
                .map_err(|e| e.to_string())?,
        ),
        None => None,
    };

    let metadata = UpdateMetadata {
        current_version: update.current_version.clone(),
        version: update.version.clone(),
        date,
        body: update.body.clone(),
        raw_json: update.raw_json.clone(),
        rid: webview.resources_table().add(update),
    };

    Ok(Some(metadata))
}
