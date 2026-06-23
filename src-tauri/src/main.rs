// Prevents additional console window on Windows in release, DO NOT REMOVE!!
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

mod steam;

fn main() {
    tauri::Builder::default()
        .invoke_handler(tauri::generate_handler![
            steam::get_accounts,
            steam::switch_account,
            steam::add_account,
            steam::get_steam_path,
            steam::get_settings,
            steam::save_settings,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
