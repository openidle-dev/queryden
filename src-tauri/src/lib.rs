mod cli;
mod ssh;
mod storage;
mod sysinfo;

use tauri::Manager;
use tracing::info;
use tracing_subscriber::{layer::SubscriberExt, util::SubscriberInitExt};

/// Build timestamp injected by build.rs at compile time. Surfaced to the
/// frontend so the About dialog can show "built on YYYY-MM-DD" alongside
/// the version number.
#[tauri::command]
fn get_build_info() -> Result<String, String> {
    Ok(env!("QUERYDEN_BUILD_DATE").to_string())
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    // Workaround for WebKitGTK crash/CPU issues on Linux
    // These must be set BEFORE WebKit initializes
    #[cfg(target_os = "linux")]
    {
        std::env::set_var("WEBKIT_DISABLE_COMPOSITING_MODE", "1");
        std::env::set_var("WEBKIT_DISABLE_DMABUF_RENDERER", "1");
    }

    tracing_subscriber::registry()
        .with(
            tracing_subscriber::EnvFilter::try_from_default_env()
                .unwrap_or_else(|_| "queryden=debug,tauri=info".into()),
        )
        .with(tracing_subscriber::fmt::layer())
        .init();

    info!("Starting QueryDen...");

    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .plugin(
            tauri_plugin_sql::Builder::default()
                .build(),
        )
        .plugin(tauri_plugin_fs::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_process::init())
        .plugin(tauri_plugin_updater::Builder::new().build())
        .invoke_handler(tauri::generate_handler![
            storage::save_connections,
            storage::load_connections,
            storage::export_connections,
            storage::import_connections,
            storage::save_settings,
            storage::load_settings,
            storage::save_query_history,
            storage::load_query_history,
            storage::save_saved_queries,
            storage::load_saved_queries,
            storage::save_local_history,
            storage::load_local_history,
            storage::clear_local_history,
            storage::save_keymaps,
            storage::load_keymaps,
            storage::save_templates,
            storage::load_templates,
            storage::get_app_data_path,
            storage::save_vault_credentials,
            storage::load_vault_credentials,
            sysinfo::get_system_info,
            get_build_info,
            cli::cli_check_tools,
            cli::cli_list_cached,
            cli::cli_check_tool,
            cli::cli_check_system_tool,
            cli::cli_ensure,
            cli::cli_get_version,
            cli::cli_detect_pg_version,
            cli::cli_download_version,
            cli::cli_execute_query,
            cli::cli_list_databases,
            cli::cli_test_connection,
            cli::cli_get_pg_versions,
            ssh::create_ssh_tunnel,
            ssh::close_ssh_tunnel,
            ssh::get_tunnel_status,
            ssh::close_all_tunnels,
        ])
        .setup(|app| {
            info!("QueryDen application setup complete");
            // Backend failsafe: the window is created with `visible: false` so
            // the frontend can reveal it after first paint (see
            // `src/lib/revealAppWindow.ts`). If the JS bundle fails to load
            // entirely — parse error, missing asset, etc. — the frontend
            // failsafe never schedules and the window would stay hidden
            // forever. Force-reveal after a generous timeout so the user can
            // at least see the broken state and quit the app.
            if let Some(window) = app.get_webview_window("main") {
                tauri::async_runtime::spawn(async move {
                    tokio::time::sleep(std::time::Duration::from_secs(8)).await;
                    match window.is_visible() {
                        Ok(true) => {}
                        _ => {
                            tracing::warn!(
                                "Frontend never revealed main window within 8s; forcing show()"
                            );
                            let _ = window.show();
                            let _ = window.set_focus();
                        }
                    }
                });
            }
            // Register the CLI manager as app state so commands can access it
            let cli = cli::CliManager::new(app.handle());
            app.manage(cli);
            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}