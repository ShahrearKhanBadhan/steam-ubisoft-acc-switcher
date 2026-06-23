// Steam logic — real backend wired to the Tauri frontend.
//
// Everything here is defensive: no `unwrap`/`expect` on fallible IO, every
// command returns a `Result<_, String>` so the frontend can surface a clear
// message, and a missing/locked file never panics the app.

use std::borrow::Cow;
use std::path::{Path, PathBuf};
use std::process::Command;
use std::time::{Duration, Instant};

use base64::{engine::general_purpose::STANDARD, Engine as _};
use keyvalues_parser::{Obj, Value};
use sysinfo::System;
use winreg::enums::{HKEY_CURRENT_USER, KEY_QUERY_VALUE, KEY_SET_VALUE};
use winreg::RegKey;

const DEFAULT_STEAM_PATH: &str = "C:\\Program Files (x86)\\Steam";
const STEAM_REG_KEY: &str = "Software\\Valve\\Steam";
const RUN_REG_KEY: &str = "Software\\Microsoft\\Windows\\CurrentVersion\\Run";
const RUN_VALUE_NAME: &str = "SteamAccSwitcher";
const DEFAULT_ACCENT: &str = "#66c0f4";

// ----------------------------------------------------------------- structs

#[derive(serde::Serialize, serde::Deserialize, Clone)]
pub struct Account {
    pub steamid: String,
    pub name: String,    // PersonaName
    pub user: String,    // AccountName
    pub last: String,    // humanized timestamp
    pub avatar: String,  // base64 data URL or empty string
    pub initials: String, // first 2 chars of PersonaName uppercased
    pub most_recent: bool,
    pub can_auto_login: bool, // AllowAutoLogin + RememberPassword both set
}

#[derive(serde::Serialize, serde::Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct Settings {
    pub close_steam: bool,
    pub launch_min: bool,
    pub start_win: bool,
    pub confirm: bool,
    pub steam_path: String,
    pub accent: String,
}

impl Default for Settings {
    fn default() -> Self {
        Settings {
            close_steam: true,
            launch_min: false,
            start_win: false,
            confirm: true,
            steam_path: resolve_steam_path(),
            accent: DEFAULT_ACCENT.to_string(),
        }
    }
}

// ----------------------------------------------------------------- helpers

/// Read `SteamPath` from the registry, falling back to the default install dir
/// if the key is missing or unreadable.
fn resolve_steam_path() -> String {
    read_steam_path_registry().unwrap_or_else(|| DEFAULT_STEAM_PATH.to_string())
}

fn read_steam_path_registry() -> Option<String> {
    let hkcu = RegKey::predef(HKEY_CURRENT_USER);
    let key = hkcu.open_subkey(STEAM_REG_KEY).ok()?;
    let path: String = key.get_value("SteamPath").ok()?;
    if path.trim().is_empty() {
        None
    } else {
        Some(path)
    }
}

/// Pull the first string value for `key` out of a VDF object.
fn get_field(obj: &Obj, key: &str) -> Option<String> {
    obj.get(key)
        .and_then(|values| values.first())
        .and_then(|value| value.get_str())
        .map(|s| s.to_string())
}

/// Set (or insert) a single string value for `key` in a VDF object.
fn set_field(obj: &mut Obj, key: &str, value: &str) {
    let new_value = Value::Str(Cow::Owned(value.to_string()));
    match obj.get_mut(key) {
        Some(values) if !values.is_empty() => values[0] = new_value,
        Some(values) => values.push(new_value),
        None => {
            obj.insert(Cow::Owned(key.to_string()), vec![new_value]);
        }
    }
}

fn avatar_file_path(steam_path: &str, steamid: &str) -> PathBuf {
    Path::new(steam_path)
        .join("config")
        .join("avatarcache")
        .join(format!("{steamid}.png"))
}

/// Load an avatar PNG and encode it as a `data:` URL. Returns an empty string
/// when the file is missing or unreadable so the frontend can fall back to its
/// gradient + initials avatar.
fn load_avatar(steam_path: &str, steamid: &str) -> String {
    match std::fs::read(avatar_file_path(steam_path, steamid)) {
        Ok(bytes) => format!("data:image/png;base64,{}", STANDARD.encode(bytes)),
        Err(_) => String::new(),
    }
}

/// Turn a unix timestamp (seconds) into a human friendly "last used" label.
fn humanize(timestamp: i64) -> String {
    if timestamp <= 0 {
        return "never".to_string();
    }
    let now = chrono::Utc::now().timestamp();
    let diff = now - timestamp;

    if diff < 60 {
        "now".to_string()
    } else if diff < 3_600 {
        format!("{}m ago", diff / 60)
    } else if diff < 86_400 {
        format!("{}h ago", diff / 3_600)
    } else if diff < 172_800 {
        "yesterday".to_string()
    } else if diff < 604_800 {
        format!("{}d ago", diff / 86_400)
    } else {
        format!("{}w ago", diff / 604_800)
    }
}

fn login_users_path(steam_path: &str) -> PathBuf {
    Path::new(steam_path).join("config").join("loginusers.vdf")
}

// The full Steam process tree. `steamwebhelper.exe` is what renders the
// login / account-picker UI, so it must die too — otherwise a relaunch
// reattaches to the stale picker instead of auto-logging in.
const STEAM_PROCESSES: [&str; 3] = ["steam.exe", "steamwebhelper.exe", "steamservice.exe"];

fn is_steam_name(name: &str) -> bool {
    name.eq_ignore_ascii_case("steam.exe") || name.eq_ignore_ascii_case("steamwebhelper.exe")
}

/// Whether `steam.exe` or any `steamwebhelper.exe` is still alive.
fn steam_tree_running(system: &mut System) -> bool {
    system.refresh_processes();
    system.processes().values().any(|p| is_steam_name(p.name()))
}

fn hard_kill_steam(system: &mut System) {
    system.refresh_processes();
    for process in system.processes().values() {
        if STEAM_PROCESSES
            .iter()
            .any(|s| process.name().eq_ignore_ascii_case(s))
        {
            process.kill();
        }
    }
}

/// Cleanly shut the whole Steam process tree down before we touch its config.
///
/// Tries Steam's own graceful `-shutdown` first (closes `steam.exe` and every
/// `steamwebhelper.exe` child), polling until the tree is gone. If that stalls,
/// it hard-kills whatever's left. No-op if Steam isn't running. Returning only
/// after everything is dead guarantees our registry/vdf writes are the final
/// state and the relaunch starts from a clean slate.
fn kill_steam_and_wait(steam_path: &str) -> Result<(), String> {
    let mut system = System::new();
    system.refresh_processes();

    // Steam was already closed — nothing to do.
    if !system.processes().values().any(|p| is_steam_name(p.name())) {
        return Ok(());
    }

    // Ask Steam to shut itself (and its webhelpers) down gracefully.
    let exe = Path::new(steam_path).join("steam.exe");
    let _ = Command::new(&exe).arg("-shutdown").spawn();

    let start = Instant::now();
    loop {
        std::thread::sleep(Duration::from_millis(250));
        if !steam_tree_running(&mut system) {
            return Ok(());
        }
        if start.elapsed() > Duration::from_secs(10) {
            break;
        }
    }

    // Graceful shutdown didn't finish — force the whole tree down.
    hard_kill_steam(&mut system);

    let start = Instant::now();
    loop {
        std::thread::sleep(Duration::from_millis(250));
        if !steam_tree_running(&mut system) {
            return Ok(());
        }
        if start.elapsed() > Duration::from_secs(5) {
            return Err("Timed out waiting for Steam to close".to_string());
        }
    }
}

struct TargetInfo {
    steamid: String,
    timestamp: i64,
}

/// Rewrite loginusers.vdf so that the target account is `MostRecent = 1` and all
/// others are `0`. Also flips `AllowAutoLogin` the same way — Steam treats this
/// as a separate per-account flag from `MostRecent`, and leaving it `0` on the
/// target makes Steam show the account-picker overlay instead of silently
/// logging in. Returns the target's steamid + timestamp for relaunch logic.
fn update_login_users(steam_path: &str, account_name: &str) -> Result<TargetInfo, String> {
    let path = login_users_path(steam_path);
    let text = std::fs::read_to_string(&path).map_err(|_| {
        format!("loginusers.vdf not found at {}", path.display())
    })?;

    let mut vdf = keyvalues_parser::parse(&text)
        .map_err(|e| format!("Failed to parse loginusers.vdf: {e}"))?
        .into_vdf()
        .into_owned();

    let users = vdf
        .value
        .get_mut_obj()
        .ok_or_else(|| "loginusers.vdf has an unexpected structure".to_string())?;

    let mut target: Option<TargetInfo> = None;

    for (steamid, values) in users.iter_mut() {
        for value in values.iter_mut() {
            let Some(inner) = value.get_mut_obj() else {
                continue;
            };

            let acct = get_field(inner, "AccountName").unwrap_or_default();
            let is_target = acct.eq_ignore_ascii_case(account_name);

            if is_target {
                let timestamp = get_field(inner, "Timestamp")
                    .and_then(|s| s.parse::<i64>().ok())
                    .unwrap_or(0);
                target = Some(TargetInfo {
                    steamid: steamid.to_string(),
                    timestamp,
                });
            }

            set_field(inner, "MostRecent", if is_target { "1" } else { "0" });
            // Only ever touch the target's own auto-login flags here — every other
            // account's AllowAutoLogin/RememberPassword reflects Steam's own last
            // real assessment of that account's saved session, which is the only
            // local signal worth anything (we can't see whether a password changed
            // on Valve's servers, only Steam's client can discover that).
            if is_target {
                set_field(inner, "AllowAutoLogin", "1");
                set_field(inner, "RememberPassword", "1");
            }
        }
    }

    let target = target.ok_or_else(|| {
        format!("Account '{account_name}' was not found in loginusers.vdf")
    })?;

    std::fs::write(&path, format!("{vdf}"))
        .map_err(|e| format!("Failed to write loginusers.vdf: {e}"))?;

    Ok(target)
}

/// Path to settings.json, sitting next to the running executable.
fn settings_path() -> Result<PathBuf, String> {
    let exe = std::env::current_exe()
        .map_err(|e| format!("Failed to locate executable: {e}"))?;
    let dir = exe
        .parent()
        .ok_or_else(|| "Failed to resolve executable directory".to_string())?;
    Ok(dir.join("settings.json"))
}

/// Add or remove the app from the Windows "run at startup" registry key.
fn apply_start_with_windows(enable: bool) -> Result<(), String> {
    let hkcu = RegKey::predef(HKEY_CURRENT_USER);
    let (run_key, _) = hkcu
        .create_subkey(RUN_REG_KEY)
        .map_err(|e| format!("Failed to open Run registry key: {e}"))?;

    if enable {
        let exe = std::env::current_exe()
            .map_err(|e| format!("Failed to locate executable: {e}"))?;
        run_key
            .set_value(RUN_VALUE_NAME, &exe.to_string_lossy().to_string())
            .map_err(|e| format!("Failed to set startup entry: {e}"))?;
    } else {
        // Deleting a value that doesn't exist is fine — ignore that error.
        let _ = run_key.delete_value(RUN_VALUE_NAME);
    }

    Ok(())
}

// ---------------------------------------------------------------- commands

#[tauri::command]
pub fn get_accounts() -> Result<Vec<Account>, String> {
    let steam_path = resolve_steam_path();
    let path = login_users_path(&steam_path);

    let text = std::fs::read_to_string(&path).map_err(|_| {
        format!("loginusers.vdf not found at {}", path.display())
    })?;

    let vdf = keyvalues_parser::parse(&text)
        .map_err(|e| format!("Failed to parse loginusers.vdf: {e}"))?;

    let users = vdf
        .value
        .get_obj()
        .ok_or_else(|| "loginusers.vdf has an unexpected structure".to_string())?;

    // Keep the timestamp alongside each account for sorting.
    let mut rows: Vec<(Account, i64)> = Vec::new();

    for (steamid, values) in users.iter() {
        let Some(inner) = values.first().and_then(|v| v.get_obj()) else {
            continue;
        };

        let account_name = get_field(inner, "AccountName").unwrap_or_default();
        let persona = get_field(inner, "PersonaName").unwrap_or_default();
        let most_recent = get_field(inner, "MostRecent")
            .map(|s| s == "1")
            .unwrap_or(false);
        let timestamp = get_field(inner, "Timestamp")
            .and_then(|s| s.parse::<i64>().ok())
            .unwrap_or(0);
        let allow_auto_login = get_field(inner, "AllowAutoLogin")
            .map(|s| s == "1")
            .unwrap_or(false);
        let remember_password = get_field(inner, "RememberPassword")
            .map(|s| s == "1")
            .unwrap_or(false);
        let can_auto_login = allow_auto_login && remember_password;

        let initials = persona.chars().take(2).collect::<String>().to_uppercase();
        let avatar = load_avatar(&steam_path, steamid);

        rows.push((
            Account {
                steamid: steamid.to_string(),
                name: persona,
                user: account_name,
                last: humanize(timestamp),
                avatar,
                initials,
                most_recent,
                can_auto_login,
            },
            timestamp,
        ));
    }

    // MostRecent first, then most-recently-used by timestamp descending.
    rows.sort_by(|a, b| {
        b.0.most_recent
            .cmp(&a.0.most_recent)
            .then(b.1.cmp(&a.1))
    });

    Ok(rows.into_iter().map(|(account, _)| account).collect())
}

#[tauri::command]
pub fn switch_account(account_name: String) -> Result<(), String> {
    let settings = get_settings().unwrap_or_default();
    let steam_path = if settings.steam_path.trim().is_empty() {
        resolve_steam_path()
    } else {
        settings.steam_path.clone()
    };

    // Step 1 — kill Steam if requested (skips automatically if already closed).
    if settings.close_steam {
        kill_steam_and_wait(&steam_path)?;
    }

    // Step 2 — point Steam's auto-login at the target account.
    let hkcu = RegKey::predef(HKEY_CURRENT_USER);
    let steam_key = hkcu
        .open_subkey_with_flags(STEAM_REG_KEY, KEY_QUERY_VALUE | KEY_SET_VALUE)
        .map_err(|e| format!("Failed to open Steam registry key: {e}"))?;
    steam_key
        .set_value("AutoLoginUser", &account_name)
        .map_err(|e| format!("Failed to set AutoLoginUser: {e}"))?;
    steam_key
        .set_value("RememberPassword", &1u32)
        .map_err(|e| format!("Failed to set RememberPassword: {e}"))?;

    // Step 3 — flip MostRecent in loginusers.vdf.
    let target = update_login_users(&steam_path, &account_name)?;

    // Step 4 — relaunch Steam.
    // Modern Steam (new login UI) ignores the legacy AutoLoginUser registry
    // value for the auto-login-vs-account-picker decision and lands on the
    // picker instead. Passing `-login <username>` tells it to target that
    // specific remembered account directly: if a cached token exists it logs
    // straight in, otherwise it shows the login screen with the name prefilled.
    let exe = Path::new(&steam_path).join("steam.exe");
    let mut command = Command::new(&exe);
    command.arg("-login").arg(&account_name);

    // A "cached token" is implied by an avatar on disk or a prior login
    // (non-zero timestamp). Only minimize to tray when minimized launch is
    // requested AND the account can actually auto-login.
    let has_token = target.timestamp > 0
        || avatar_file_path(&steam_path, &target.steamid).exists();
    if settings.launch_min && has_token {
        command.arg("-silent");
    }

    command
        .spawn()
        .map_err(|e| format!("Failed to launch Steam: {e}"))?;

    Ok(())
}

/// Launch Steam so it shows its own login screen, letting the user sign into
/// a new (or different, not-yet-cached) account. Steam writes that account
/// into loginusers.vdf itself on successful login, so it just shows up the
/// next time `get_accounts` runs.
#[tauri::command]
pub fn add_account() -> Result<(), String> {
    let steam_path = resolve_steam_path();

    // Steam only shows the login screen on a fresh launch with no cached
    // auto-login target, so it must be closed first regardless of the
    // closeSteam setting.
    kill_steam_and_wait(&steam_path)?;

    let hkcu = RegKey::predef(HKEY_CURRENT_USER);
    let steam_key = hkcu
        .open_subkey_with_flags(STEAM_REG_KEY, KEY_QUERY_VALUE | KEY_SET_VALUE)
        .map_err(|e| format!("Failed to open Steam registry key: {e}"))?;
    steam_key
        .set_value("AutoLoginUser", &"")
        .map_err(|e| format!("Failed to clear AutoLoginUser: {e}"))?;

    // Always launch visibly (ignore launchMin) — the user needs to interact
    // with the login screen.
    let exe = Path::new(&steam_path).join("steam.exe");
    Command::new(&exe)
        .spawn()
        .map_err(|e| format!("Failed to launch Steam: {e}"))?;

    Ok(())
}

#[tauri::command]
pub fn get_steam_path() -> Result<String, String> {
    let path = resolve_steam_path();
    if Path::new(&path).exists() {
        Ok(path)
    } else {
        Err(format!("Steam path does not exist on disk: {path}"))
    }
}

#[tauri::command]
pub fn get_settings() -> Result<Settings, String> {
    let path = settings_path()?;
    match std::fs::read_to_string(&path) {
        Ok(content) => serde_json::from_str(&content)
            .map_err(|e| format!("Failed to parse settings.json: {e}")),
        // No file yet — hand back sensible defaults.
        Err(_) => Ok(Settings::default()),
    }
}

#[tauri::command]
pub fn save_settings(settings: Settings) -> Result<(), String> {
    let path = settings_path()?;
    let json = serde_json::to_string_pretty(&settings)
        .map_err(|e| format!("Failed to serialize settings: {e}"))?;
    std::fs::write(&path, json)
        .map_err(|e| format!("Failed to write settings.json: {e}"))?;

    // Keep the "run at startup" registry entry in sync with the setting.
    apply_start_with_windows(settings.start_win)?;

    Ok(())
}
