#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_shell::init())
        .plugin(tauri_plugin_store::Builder::new().build())
        .plugin(tauri_plugin_http::init())
        .plugin(tauri_plugin_sql::Builder::new().build())
        // Updates are driven entirely from TypeScript: the plugin's JS `check()`
        // and `downloadAndInstall()` both accept request headers, which is what
        // lets a private repository serve the manifest and binary.
        .plugin(tauri_plugin_updater::Builder::new().build())
        // Needed to relaunch after an update is installed.
        .plugin(tauri_plugin_process::init())
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
