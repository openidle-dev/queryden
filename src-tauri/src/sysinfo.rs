use serde::Serialize;
use sysinfo::System;

#[derive(Debug, Serialize)]
pub struct SystemInfo {
    os_name: String,
    os_version: String,
    kernel_version: String,
    hostname: String,
    cpu_model: String,
    cpu_count: usize,
    memory_total_kb: u64,
    memory_used_kb: u64,
    memory_free_kb: u64,
    uptime_seconds: u64,
    app_version: String,
}

#[tauri::command]
pub fn get_system_info() -> Result<SystemInfo, String> {
    let mut sys = System::new_all();
    
    // Initial refresh to get valid data
    sys.refresh_all();
    
    let cpu_model = sys.cpus()
        .first()
        .map(|cpu| cpu.brand().to_string())
        .unwrap_or_else(|| "Unknown".to_string());

    let uptime = System::uptime();
    
    Ok(SystemInfo {
        os_name: System::name().unwrap_or_else(|| "Unknown".to_string()),
        os_version: System::os_version().unwrap_or_else(|| "Unknown".to_string()),
        kernel_version: System::kernel_version().unwrap_or_else(|| "Unknown".to_string()),
        hostname: System::host_name().unwrap_or_else(|| "Unknown".to_string()),
        cpu_model,
        cpu_count: sys.cpus().len(),
        memory_total_kb: sys.total_memory() / 1024,
        memory_used_kb: sys.used_memory() / 1024,
        memory_free_kb: sys.free_memory() / 1024,
        uptime_seconds: uptime,
        app_version: env!("CARGO_PKG_VERSION").to_string(),
    })
}
