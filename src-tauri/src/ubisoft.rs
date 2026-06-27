// Ubisoft Connect account switching.
//
// Unlike Steam, Ubisoft Connect keeps no plaintext account list. The live
// session lives in encrypted blobs (`user.dat` + `ConnectSecureStorage.dat`)
// next to `settings.yaml` in %LocalAppData%\Ubisoft Game Launcher, and there is
// no readable userId / username / token anywhere on disk. So accounts can't be
// auto-discovered: the user logs into an account, names it, and we snapshot the
// session files. Switching restores a named snapshot and relaunches the client.
//
// Like steam.rs this is defensive: every command returns `Result<_, String>`,
// no `unwrap`/`expect` on fallible IO, and a missing/locked file never panics.

use std::path::{Path, PathBuf};
use std::process::Command;
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

#[cfg(windows)]
use std::os::windows::process::CommandExt;
// Detach from the parent's Job Object so Ubisoft Connect keeps running after
// the account switcher window is closed.
#[cfg(windows)]
const CREATE_BREAKAWAY_FROM_JOB: u32 = 0x01000000;

use base64::{engine::general_purpose::STANDARD, Engine as _};
use sysinfo::System;
use winreg::enums::HKEY_LOCAL_MACHINE;
use winreg::RegKey;

const DEFAULT_UBISOFT_DIR: &str = "C:\\Program Files (x86)\\Ubisoft\\Ubisoft Game Launcher";
const UBISOFT_REG_KEY: &str = "SOFTWARE\\WOW6432Node\\Ubisoft\\Launcher";
const UBISOFT_EXE: &str = "UbisoftConnect.exe";
const UBISOFT_PROCESSES: [&str; 2] = ["UbisoftConnect.exe", "upc.exe"];

// The files that together make up a logged-in Ubisoft session. `user.dat` is the
// credential store and its presence is what "logged in" actually means.
const SESSION_FILES: [&str; 3] = ["user.dat", "ConnectSecureStorage.dat", "settings.yaml"];
const LOGIN_MARKER: &str = "user.dat";

// Only credential files are restored on switch — settings.yaml holds device-level
// preferences and restoring an old snapshot of it can regress paths/language/etc.
const RESTORE_FILES: [&str; 2] = ["user.dat", "ConnectSecureStorage.dat"];

// Ubisoft Connect renders its login UI inside a Chromium Embedded Framework (CEF)
// browser. The actual OAuth cookies and localStorage that drive auto-login live in
// these subdirectories; without restoring them the app always shows the login page.
const CEF_SESSION_DIRS: [&str; 2] = [
    "cache/http2/Default/Network",
    "cache/http2/Default/Local Storage",
];

// ----------------------------------------------------------------- structs

#[derive(serde::Serialize, serde::Deserialize, Clone)]
pub struct UbisoftAccount {
    pub user_id: String,
    pub username: String,
    pub display_name: String,
    pub last_used: String, // humanized "2h ago" etc.
    pub avatar: String,    // base64 data URL or empty string
    pub initials: String,  // 2 char uppercase fallback
    pub is_active: bool,
}

/// On-disk metadata for one saved account (`meta.json`). Stored camelCase to
/// match the documented format; this is internal storage, separate from the
/// snake_case `UbisoftAccount` returned to the frontend.
#[derive(serde::Serialize, serde::Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
struct Meta {
    user_id: String,
    username: String,
    display_name: String,
    last_used: i64,
    is_active: bool,
}

// ----------------------------------------------------------------- paths

/// %LocalAppData%\Ubisoft Game Launcher — where the live session files live.
fn ubisoft_launcher_dir() -> Option<PathBuf> {
    Some(dirs::data_local_dir()?.join("Ubisoft Game Launcher"))
}

/// The live launcher data dir, verified to exist.
fn live_dir() -> Result<PathBuf, String> {
    ubisoft_launcher_dir()
        .filter(|p| p.exists())
        .ok_or_else(|| {
            "Ubisoft Game Launcher data folder not found. Is Ubisoft Connect installed?".to_string()
        })
}

/// Install directory from the registry, falling back to the default path.
pub fn resolve_ubisoft_dir() -> String {
    let hklm = RegKey::predef(HKEY_LOCAL_MACHINE);
    if let Ok(key) = hklm.open_subkey(UBISOFT_REG_KEY) {
        if let Ok(dir) = key.get_value::<String, _>("InstallDir") {
            let trimmed = dir.trim_end_matches(['\\', '/']).trim().to_string();
            if !trimmed.is_empty() {
                return trimmed;
            }
        }
    }
    DEFAULT_UBISOFT_DIR.to_string()
}

/// Returns the saved ubisoft path from settings if set, otherwise registry/default.
fn effective_ubisoft_dir() -> String {
    if let Ok(settings) = crate::steam::get_settings() {
        let p = settings.ubisoft_path.trim().to_string();
        if !p.is_empty() {
            return p;
        }
    }
    resolve_ubisoft_dir()
}

fn ubisoft_exe_path() -> Result<PathBuf, String> {
    let dir = effective_ubisoft_dir();
    let exe = Path::new(&dir).join(UBISOFT_EXE);
    if exe.exists() {
        Ok(exe)
    } else {
        Err(format!("UbisoftConnect.exe not found at {}", exe.display()))
    }
}

/// {app_data}\steam-acc-switcher\ubisoft — where account snapshots are kept.
fn accounts_root() -> Result<PathBuf, String> {
    let base = dirs::data_dir().ok_or_else(|| "Could not resolve app data directory".to_string())?;
    Ok(base.join("steam-acc-switcher").join("ubisoft"))
}

fn account_dir(user_id: &str) -> Result<PathBuf, String> {
    Ok(accounts_root()?.join(user_id))
}

fn meta_path(user_id: &str) -> Result<PathBuf, String> {
    Ok(account_dir(user_id)?.join("meta.json"))
}

// ----------------------------------------------------------------- meta IO

fn read_meta(user_id: &str) -> Result<Meta, String> {
    let text = std::fs::read_to_string(meta_path(user_id)?)
        .map_err(|e| format!("Failed to read meta for {user_id}: {e}"))?;
    serde_json::from_str(&text).map_err(|e| format!("Failed to parse meta for {user_id}: {e}"))
}

fn write_meta(meta: &Meta) -> Result<(), String> {
    let dir = account_dir(&meta.user_id)?;
    std::fs::create_dir_all(&dir).map_err(|e| format!("Failed to create account folder: {e}"))?;
    let json = serde_json::to_string_pretty(meta)
        .map_err(|e| format!("Failed to serialize meta: {e}"))?;
    std::fs::write(meta_path(&meta.user_id)?, json)
        .map_err(|e| format!("Failed to write meta.json: {e}"))
}

// ----------------------------------------------------------------- small helpers

fn now_unix() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_secs() as i64)
        .unwrap_or(0)
}

/// A short, folder-safe unique id derived from the current time in nanoseconds.
fn gen_id() -> String {
    let nanos = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_nanos())
        .unwrap_or(0);
    format!("{nanos:x}")
}

fn initials_of(name: &str) -> String {
    let trimmed = name.trim();
    if trimmed.is_empty() {
        return "?".to_string();
    }
    trimmed.chars().take(2).collect::<String>().to_uppercase()
}

/// Turn a unix timestamp (seconds) into a human friendly "last used" label.
/// (Mirrors steam.rs::humanize — duplicated to keep the modules independent.)
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

/// Ubisoft *may* cache an avatar named by some internal id. We have no mapping,
/// so try `{user_id}.png` defensively and fall back to an empty string (the
/// frontend then renders an initials + gradient avatar).
fn load_avatar(user_id: &str) -> String {
    let Some(dir) = ubisoft_launcher_dir() else {
        return String::new();
    };
    let path = dir.join("avatars").join(format!("{user_id}.png"));
    match std::fs::read(path) {
        Ok(bytes) => format!("data:image/png;base64,{}", STANDARD.encode(bytes)),
        Err(_) => String::new(),
    }
}

fn account_to_dto(meta: &Meta) -> UbisoftAccount {
    let label = if meta.display_name.is_empty() {
        &meta.username
    } else {
        &meta.display_name
    };
    UbisoftAccount {
        user_id: meta.user_id.clone(),
        username: meta.username.clone(),
        display_name: meta.display_name.clone(),
        last_used: humanize(meta.last_used),
        avatar: load_avatar(&meta.user_id),
        initials: initials_of(label),
        is_active: meta.is_active,
    }
}

// ----------------------------------------------------------------- process control

fn is_ubisoft_proc(name: &str) -> bool {
    UBISOFT_PROCESSES.iter().any(|p| name.eq_ignore_ascii_case(p))
}

fn ubisoft_running(system: &mut System) -> bool {
    system.refresh_processes();
    system.processes().values().any(|p| is_ubisoft_proc(p.name()))
}

/// Kill UbisoftConnect.exe and upc.exe, polling every 250ms until they're gone
/// (10s timeout). No-op if Ubisoft Connect isn't running.
fn kill_ubisoft_and_wait() -> Result<(), String> {
    let mut system = System::new();
    if !ubisoft_running(&mut system) {
        return Ok(());
    }

    system.refresh_processes();
    for process in system.processes().values() {
        if is_ubisoft_proc(process.name()) {
            process.kill();
        }
    }

    let start = Instant::now();
    loop {
        std::thread::sleep(Duration::from_millis(250));
        if !ubisoft_running(&mut system) {
            return Ok(());
        }
        if start.elapsed() > Duration::from_secs(10) {
            return Err("Timed out waiting for Ubisoft Connect to close".to_string());
        }
    }
}

// ----------------------------------------------------------------- snapshot IO

fn copy_dir_all(src: &Path, dst: &Path) -> Result<(), String> {
    if !src.exists() {
        return Ok(());
    }
    std::fs::create_dir_all(dst)
        .map_err(|e| format!("Failed to create {}: {e}", dst.display()))?;
    for entry in std::fs::read_dir(src)
        .map_err(|e| format!("Failed to read {}: {e}", src.display()))?
    {
        let entry = entry.map_err(|e| format!("Dir entry error: {e}"))?;
        let src_path = entry.path();
        let dst_path = dst.join(entry.file_name());
        if src_path.is_dir() {
            copy_dir_all(&src_path, &dst_path)?;
        } else {
            match std::fs::copy(&src_path, &dst_path) {
                Ok(_) => {}
                // LevelDB LOCK files and other files held with exclusive access
                // by the running app cannot be copied; skip them — the owning
                // app recreates them on next open.
                Err(e) if e.raw_os_error() == Some(32) => {}
                Err(e) => {
                    return Err(format!("Failed to copy {}: {e}", src_path.display()));
                }
            }
        }
    }
    Ok(())
}

/// Copy the live session files into `dest`. Requires the user to be logged in
/// (user.dat present) — otherwise the snapshot would capture nothing useful.
fn snapshot_session(dest: &Path) -> Result<(), String> {
    let live = live_dir()?;
    if !live.join(LOGIN_MARKER).exists() {
        return Err(
            "Ubisoft Connect doesn't appear to be logged in. Please log in first.".to_string(),
        );
    }
    std::fs::create_dir_all(dest).map_err(|e| format!("Failed to create snapshot folder: {e}"))?;
    for file in SESSION_FILES {
        let src = live.join(file);
        if src.exists() {
            std::fs::copy(&src, dest.join(file))
                .map_err(|e| format!("Failed to copy {file}: {e}"))?;
        }
    }
    for dir in CEF_SESSION_DIRS {
        copy_dir_all(&live.join(dir), &dest.join(dir))?;
    }
    Ok(())
}

/// Copy a saved snapshot's session files back over the live ones.
fn restore_session(src: &Path) -> Result<(), String> {
    let live = live_dir()?;
    let mut restored = 0;
    for file in RESTORE_FILES {
        let snap = src.join(file);
        if snap.exists() {
            std::fs::copy(&snap, live.join(file))
                .map_err(|e| format!("Failed to restore {file}: {e}"))?;
            restored += 1;
        }
    }
    for dir in CEF_SESSION_DIRS {
        let snap_dir = src.join(dir);
        if snap_dir.exists() {
            copy_dir_all(&snap_dir, &live.join(dir))?;
            restored += 1;
        }
    }
    if restored == 0 {
        return Err("This account's saved session is missing or incomplete.".to_string());
    }
    // After a clean Ubisoft exit, Chromium sets exit_type = "Normal" and then
    // clears all session cookies on the next startup. Marking it as "Crashed"
    // makes Chromium treat the next launch as a session recovery and keep the
    // restored session cookies intact.
    patch_cef_exit_type(&live)?;
    Ok(())
}

/// Set profile.exit_type = "Crashed" in the CEF Preferences file so Chromium
/// preserves session cookies on the next startup instead of clearing them.
fn patch_cef_exit_type(live: &Path) -> Result<(), String> {
    let prefs = live
        .join("cache")
        .join("http2")
        .join("Default")
        .join("Preferences");
    if !prefs.exists() {
        return Ok(());
    }
    let text = std::fs::read_to_string(&prefs)
        .map_err(|e| format!("Failed to read Preferences: {e}"))?;
    let mut json: serde_json::Value =
        serde_json::from_str(&text).map_err(|e| format!("Failed to parse Preferences: {e}"))?;
    if let Some(profile) = json.get_mut("profile") {
        profile["exit_type"] = serde_json::Value::String("Crashed".to_string());
        profile["exited_cleanly"] = serde_json::Value::Bool(false);
    }
    let patched = serde_json::to_string(&json)
        .map_err(|e| format!("Failed to serialize Preferences: {e}"))?;
    std::fs::write(&prefs, patched)
        .map_err(|e| format!("Failed to write Preferences: {e}"))?;
    Ok(())
}

/// Mark `user_id` active (and bump its lastUsed), everyone else inactive.
fn set_active(user_id: &str) -> Result<(), String> {
    let root = accounts_root()?;
    if !root.exists() {
        return Ok(());
    }
    for entry in std::fs::read_dir(&root).map_err(|e| format!("Failed to read accounts: {e}"))? {
        let entry = entry.map_err(|e| format!("Failed to read account entry: {e}"))?;
        if !entry.path().is_dir() {
            continue;
        }
        let id = entry.file_name().to_string_lossy().to_string();
        let Ok(mut meta) = read_meta(&id) else {
            continue;
        };
        let target = id == user_id;
        let mut changed = false;
        if meta.is_active != target {
            meta.is_active = target;
            changed = true;
        }
        if target {
            meta.last_used = now_unix();
            changed = true;
        }
        if changed {
            write_meta(&meta)?;
        }
    }
    Ok(())
}

/// The user_id of the currently-active account, if any.
fn active_account_id() -> Result<Option<String>, String> {
    let root = accounts_root()?;
    if !root.exists() {
        return Ok(None);
    }
    for entry in std::fs::read_dir(&root).map_err(|e| format!("Failed to read accounts: {e}"))? {
        let entry = entry.map_err(|e| format!("Failed to read account entry: {e}"))?;
        if !entry.path().is_dir() {
            continue;
        }
        let id = entry.file_name().to_string_lossy().to_string();
        if let Ok(meta) = read_meta(&id) {
            if meta.is_active {
                return Ok(Some(meta.user_id));
            }
        }
    }
    Ok(None)
}

/// Find a saved account whose display name matches (case-insensitive).
fn find_by_name(name: &str) -> Result<Option<String>, String> {
    let root = accounts_root()?;
    if !root.exists() {
        return Ok(None);
    }
    for entry in std::fs::read_dir(&root).map_err(|e| format!("Failed to read accounts: {e}"))? {
        let entry = entry.map_err(|e| format!("Failed to read account entry: {e}"))?;
        if !entry.path().is_dir() {
            continue;
        }
        let id = entry.file_name().to_string_lossy().to_string();
        if let Ok(meta) = read_meta(&id) {
            if meta.display_name.eq_ignore_ascii_case(name.trim()) {
                return Ok(Some(meta.user_id));
            }
        }
    }
    Ok(None)
}

// ---------------------------------------------------------------- helpers

/// Spawn `exe` detached from this process's Job Object so it keeps running
/// after the account switcher closes. Falls back to a plain spawn if the
/// current job does not allow breakaway.
fn spawn_detached(exe: &Path) -> std::io::Result<()> {
    #[cfg(windows)]
    {
        let result = Command::new(exe)
            .creation_flags(CREATE_BREAKAWAY_FROM_JOB)
            .spawn();
        if result.is_ok() {
            return Ok(());
        }
    }
    Command::new(exe).spawn().map(|_| ())
}

// ---------------------------------------------------------------- commands

#[tauri::command]
pub fn get_ubisoft_accounts() -> Result<Vec<UbisoftAccount>, String> {
    let root = accounts_root()?;
    if !root.exists() {
        return Ok(Vec::new());
    }

    let mut rows: Vec<(UbisoftAccount, i64)> = Vec::new();
    for entry in std::fs::read_dir(&root).map_err(|e| format!("Failed to read accounts: {e}"))? {
        let entry = entry.map_err(|e| format!("Failed to read account entry: {e}"))?;
        if !entry.path().is_dir() {
            continue;
        }
        let id = entry.file_name().to_string_lossy().to_string();
        let Ok(meta) = read_meta(&id) else {
            continue;
        };
        let last_used = meta.last_used;
        rows.push((account_to_dto(&meta), last_used));
    }

    // Active first, then most-recently-used by timestamp descending.
    rows.sort_by(|a, b| b.0.is_active.cmp(&a.0.is_active).then(b.1.cmp(&a.1)));
    Ok(rows.into_iter().map(|(account, _)| account).collect())
}

#[tauri::command]
pub fn save_ubisoft_account(name: String) -> Result<UbisoftAccount, String> {
    let name = name.trim().to_string();
    if name.is_empty() {
        return Err("Please enter a name for this account.".to_string());
    }

    // Must be logged in to capture anything meaningful.
    let live = live_dir()?;
    if !live.join(LOGIN_MARKER).exists() {
        return Err(
            "Ubisoft Connect doesn't appear to be logged in. Please log in first.".to_string(),
        );
    }

    // Re-using the same name updates the existing snapshot (re-login refreshes
    // the token); a new name creates a new account folder.
    let user_id = find_by_name(&name)?.unwrap_or_else(gen_id);

    snapshot_session(&account_dir(&user_id)?)?;

    let meta = Meta {
        user_id: user_id.clone(),
        username: name.clone(),
        display_name: name,
        last_used: now_unix(),
        is_active: true,
    };
    write_meta(&meta)?;

    // Saving captures the *current* live session, so this account is now active.
    set_active(&user_id)?;

    Ok(account_to_dto(&read_meta(&user_id)?))
}

#[tauri::command]
pub fn switch_ubisoft_account(user_id: String) -> Result<(), String> {
    let dir = account_dir(&user_id)?;
    if !dir.exists() {
        return Err("That account is no longer saved.".to_string());
    }

    // Step 0 — re-snapshot the account we're leaving.
    //
    // Ubisoft refreshes its session token while running and rewrites the live
    // user.dat / cookies; the old token in that account's saved snapshot is then
    // invalidated server-side. If we restored the stale snapshot next time, the
    // account would land on the login page. So before switching away, capture the
    // *current* live session back into the active account, keeping its token
    // fresh. Best-effort: never block the switch if capture fails (e.g. the live
    // session is logged out or mid-write).
    if let Ok(Some(active_id)) = active_account_id() {
        if active_id != user_id {
            if let Ok(active_dir) = account_dir(&active_id) {
                let _ = snapshot_session(&active_dir);
            }
        }
    }

    // Step 1 — close Ubisoft Connect (skips automatically if already closed).
    kill_ubisoft_and_wait()?;

    // Step 2 — restore the snapshot over the live session files.
    restore_session(&dir)?;

    // Step 3 — flip the active flag and bump lastUsed.
    set_active(&user_id)?;

    // Step 4 — relaunch.
    let exe = ubisoft_exe_path()?;
    spawn_detached(&exe).map_err(|e| format!("Failed to launch Ubisoft Connect: {e}"))?;

    Ok(())
}

/// Launch Ubisoft Connect so the user can log into an account they want to add.
/// (Not in the original command list, but the "Open Ubisoft Connect" step of the
/// add-account flow needs a way to start the client.)
#[tauri::command]
pub fn launch_ubisoft() -> Result<(), String> {
    let exe = ubisoft_exe_path()?;
    spawn_detached(&exe).map_err(|e| format!("Failed to launch Ubisoft Connect: {e}"))?;
    Ok(())
}

#[tauri::command]
pub fn get_ubisoft_path() -> Result<String, String> {
    let dir = effective_ubisoft_dir();
    if Path::new(&dir).exists() {
        Ok(dir)
    } else {
        Err(format!("Ubisoft install path does not exist on disk: {dir}"))
    }
}

/// Patch the live CEF Preferences so session cookies survive the next startup.
///
/// When Windows shuts down, Ubisoft exits cleanly and CEF writes
/// `exit_type = "Normal"` to its Preferences file. On next launch CEF sees
/// "Normal" and clears all session cookies, sending the user to the login page.
/// Calling this when the switcher app opens (and Ubisoft is not yet running)
/// resets `exit_type` to "Crashed" so CEF treats the next launch as a session
/// recovery and keeps the cookies intact.
///
/// Returns `true` if the patch was applied, `false` if Ubisoft is already
/// running (in which case we leave the live session alone).
#[tauri::command]
pub fn fix_ubisoft_session() -> Result<bool, String> {
    let mut system = System::new();
    if ubisoft_running(&mut system) {
        return Ok(false);
    }
    let live = match live_dir() {
        Ok(d) => d,
        Err(_) => return Ok(false), // Ubisoft not installed
    };
    patch_cef_exit_type(&live)?;
    Ok(true)
}

/// Remove a saved account's snapshot. Any account can be removed, including the
/// active one — this only deletes our saved snapshot; the live Ubisoft session
/// (whoever is currently logged in) is left untouched.
#[tauri::command]
pub fn delete_ubisoft_account(user_id: String) -> Result<(), String> {
    let dir = account_dir(&user_id)?;
    if !dir.exists() {
        return Err("That account is no longer saved.".to_string());
    }
    std::fs::remove_dir_all(&dir).map_err(|e| format!("Failed to remove account: {e}"))?;
    Ok(())
}
