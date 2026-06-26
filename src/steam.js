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

// No native folder picker is wired up yet; settings.js imports this, so keep it
// exported as a no-op until a real dialog flow is added.
export async function browseSteamPath() {
  return null;
}

// Default settings mirror the backend defaults, kept for any UI fallback.
const defaultSettings = {
  closeSteam: true,
  launchMin: false,
  startWin: false,
  confirm: true,
  steamPath: "C:\\Program Files (x86)\\Steam",
  accent: "#66c0f4",
};

export { defaultSettings };
