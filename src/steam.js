// steam.js — real Steam integration via Tauri commands.
// The UI talks ONLY through these functions, so all backend wiring is isolated
// here.
//
// This project ships no JS bundler (tauri.conf.json -> frontendDist "../src")
// and enables `withGlobalTauri`, so the Tauri API is reached through the global
// `window.__TAURI__` rather than a bare `@tauri-apps/api/core` import (which the
// webview can't resolve without a bundler/import-map). Same `invoke`, same
// command names + argument shapes.
const invoke = (cmd, args) => window.__TAURI__.core.invoke(cmd, args);

export async function getAccounts() {
  return await invoke("get_accounts");
}

export async function switchAccount(accountName) {
  return await invoke("switch_account", { accountName });
}

export async function addAccount() {
  return await invoke("add_account");
}

// `steamid` (lowercase) matches the Rust command's parameter name exactly.
export async function forgetAccount(steamid) {
  return await invoke("forget_account", { steamid });
}

export async function getSteamPath() {
  return await invoke("get_steam_path");
}

export async function getSettings() {
  return await invoke("get_settings");
}

export async function saveSettings(settings) {
  return await invoke("save_settings", { settings });
}

export async function browseSteamPath() {
  return await invoke("browse_folder", { defaultPath: "C:\\Program Files (x86)\\Steam" });
}

export async function browseUbisoftPath() {
  return await invoke("browse_folder", { defaultPath: "C:\\Program Files (x86)\\Ubisoft\\Ubisoft Game Launcher" });
}

// Default settings mirror the backend defaults, kept for any UI fallback.
const defaultSettings = {
  closeSteam: true,
  launchMin: false,
  startWin: false,
  confirm: true,
  steamPath: "C:\\Program Files (x86)\\Steam",
  ubisoftPath: "C:\\Program Files (x86)\\Ubisoft\\Ubisoft Game Launcher",
  accent: "#66c0f4",
};

export { defaultSettings };
