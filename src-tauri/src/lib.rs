mod line_ownership;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .manage(line_ownership::ScanControl::default())
        .invoke_handler(tauri::generate_handler![
            line_ownership::prepare_line_ownership,
            line_ownership::sync_line_ownership,
            line_ownership::advance_line_ownership_history,
            line_ownership::cancel_line_ownership,
        ])
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
