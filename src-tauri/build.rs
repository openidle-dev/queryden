fn main() {
    // Inject a build date at compile time (e.g. "2026.05.09")
    let now = chrono::Utc::now();
    println!(
        "cargo:rustc-env=QUERYDEN_BUILD_DATE={}",
        now.format("%Y.%m.%d")
    );

    tauri_build::build()
}
