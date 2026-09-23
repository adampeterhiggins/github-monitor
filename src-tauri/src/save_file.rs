//! Saving exports through the system save dialog.
//!
//! The page supplies a suggested name and the contents; the user chooses where the
//! file goes. The page never passes a path, so it cannot write anywhere the user
//! did not pick.
use tauri_plugin_dialog::DialogExt;

/// A suggested file name: no directories, no hidden files, nothing empty.
fn safe_name(name: &str) -> Result<String, String> {
    let name = name.trim();
    if name.is_empty()
        || name.starts_with('.')
        || name.contains(['/', '\\', '\0'])
        || name.len() > 200
    {
        return Err("Invalid file name".into());
    }
    Ok(name.to_owned())
}

/// Show a save dialog and write `contents` where the user chooses. Resolves to
/// the saved path, or `None` when the dialog is cancelled.
#[tauri::command]
pub async fn save_text_file(
    app: tauri::AppHandle,
    default_name: String,
    contents: String,
    filter_name: String,
    extensions: Vec<String>,
) -> Result<Option<String>, String> {
    let name = safe_name(&default_name)?;
    tauri::async_runtime::spawn_blocking(move || {
        let extensions: Vec<&str> = extensions
            .iter()
            .map(String::as_str)
            .filter(|e| !e.is_empty() && e.chars().all(|c| c.is_ascii_alphanumeric()))
            .collect();
        let mut dialog = app.dialog().file().set_file_name(&name);
        if !extensions.is_empty() {
            dialog = dialog.add_filter(&filter_name, &extensions);
        }
        let Some(chosen) = dialog.blocking_save_file() else {
            return Ok(None);
        };
        let path = chosen.into_path().map_err(|e| e.to_string())?;
        std::fs::write(&path, contents.as_bytes())
            .map_err(|e| format!("Could not save {}: {e}", path.display()))?;
        Ok(Some(path.to_string_lossy().into_owned()))
    })
    .await
    .map_err(|e| e.to_string())?
}

#[cfg(test)]
mod tests {
    use super::safe_name;

    #[test]
    fn suggested_names_cannot_choose_a_directory() {
        assert_eq!(safe_name(" mappings.json ").unwrap(), "mappings.json");
        for bad in ["", "../x.json", "a/b.json", ".hidden", "a\\b.json"] {
            assert!(safe_name(bad).is_err(), "{bad}");
        }
    }
}
