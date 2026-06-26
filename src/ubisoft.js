// ubisoft.js — Ubisoft Connect integration via Tauri commands.
// Mirrors steam.js: the UI talks to the backend only through these functions.
// Reached through the global `window.__TAURI__` (no bundler / withGlobalTauri).
const { invoke } = window.__TAURI__.core;

export async function getUbisoftAccounts() {
  return await invoke("get_ubisoft_accounts");
}

// `name` is the user-supplied label — the live session is encrypted, so there
// is no readable account name to auto-fill.
export async function saveUbisoftAccount(name) {
  return await invoke("save_ubisoft_account", { name });
}

export async function switchUbisoftAccount(userId) {
  return await invoke("switch_ubisoft_account", { userId });
}

export async function launchUbisoft() {
  return await invoke("launch_ubisoft");
}

export async function getUbisoftPath() {
  return await invoke("get_ubisoft_path");
}

export async function deleteUbisoftAccount(userId) {
  return await invoke("delete_ubisoft_account", { userId });
}
