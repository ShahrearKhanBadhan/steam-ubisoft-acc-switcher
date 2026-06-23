// Main screen logic — renders the account list / active banner from the real
// Steam backend, drives the switch animation + real account switch, and the
// main <-> settings transition.

import { getAccounts, switchAccount, addAccount } from "./steam.js";
import { initSettings } from "./settings.js";

// ---- timings (spec §6) ----
const T_DONE = 1000;     // spinner -> backend call / checkmark
const T_PROMOTE = 1850;  // total -> promote into banner
const T_ERROR = 2000;    // how long the error state lingers before reset

// ---- state ----
let accounts = [];
let activeId = null;      // steamid of the active account
let switchingId = null;   // steamid of the card currently switching
let phase = null;         // 'spin' | 'done' | 'error' | null
let errorMsg = null;
let addInProgress = false;

const $ = (id) => document.getElementById(id);
const bannerEl = $("banner");
const listEl = $("list");
const countEl = $("account-count");
const screensEl = $("screens");

const CHECK_SVG =
  '<svg viewBox="0 0 24 24" width="13" height="13" fill="none">' +
  '<path d="M5 12.5l4.2 4.2L19 7" stroke="#0c1318" stroke-width="2.6" ' +
  'stroke-linecap="round" stroke-linejoin="round"/></svg>';

// Deterministic gradient fallback for accounts without a cached avatar.
const GRADIENTS = [
  "linear-gradient(135deg,#1a9fff,#0a3a5c)",
  "linear-gradient(135deg,#f4a259,#c0392b)",
  "linear-gradient(135deg,#66c0f4,#1a5276)",
  "linear-gradient(135deg,#b18cff,#6c3483)",
  "linear-gradient(135deg,#a4d007,#1e8449)",
  "linear-gradient(135deg,#f4a259,#6c3483)",
];

function gradientFor(initials) {
  const s = (initials || "?").toUpperCase();
  let sum = 0;
  for (let i = 0; i < s.length; i++) sum += s.charCodeAt(i);
  return GRADIENTS[sum % GRADIENTS.length];
}

const escapeHtml = (s) =>
  String(s ?? "").replace(/[&<>"']/g, (c) =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c])
  );

const delay = (ms) => new Promise((r) => setTimeout(r, ms));

// Avatar: real image when present, otherwise a gradient circle with initials.
function avatarHTML(a, cls) {
  if (a.avatar) {
    return `<div class="${cls}"><img src="${a.avatar}" alt="" ` +
      `style="width:100%;height:100%;border-radius:50%;object-fit:cover;display:block"></div>`;
  }
  return `<div class="${cls}" style="background:${gradientFor(a.initials)}">${escapeHtml(a.initials)}</div>`;
}

// Badge on the list-card avatar: blue when Steam has a saved login it can use
// silently, red when it doesn't (account will need to be signed into again).
function avatarWithCacheDot(a) {
  const ok = a.can_auto_login;
  const title = ok
    ? "Saved login found — should switch in without asking to sign in"
    : "No saved login on file — Steam may ask you to sign in again";
  return `<div class="card__avatar-wrap">${avatarHTML(a, "card__avatar")}` +
    `<span class="cache-dot ${ok ? "cache-dot--ok" : "cache-dot--bad"}" title="${title}"></span></div>`;
}

// ---------------------------------------------------------------- render
function render() {
  countEl.textContent = `${accounts.length} account${accounts.length === 1 ? "" : "s"} linked`;
  const active = accounts.find((a) => a.steamid === activeId) || accounts[0];
  renderBanner(active);
  renderList();
}

function renderBanner(a) {
  if (!a) {
    bannerEl.innerHTML = `<div class="banner__info"><div class="banner__name">No accounts found</div>` +
      `<div class="banner__user">Sign in to Steam at least once</div></div>`;
    return;
  }
  bannerEl.innerHTML = `
    ${avatarHTML(a, "banner__avatar")}
    <div class="banner__info">
      <div class="banner__eyebrow"><span class="dot-online"></span>CURRENTLY ACTIVE</div>
      <div class="banner__name">${escapeHtml(a.name)}</div>
      <div class="banner__user">${escapeHtml(a.user)}</div>
    </div>`;
}

function renderList() {
  const others = accounts.filter((a) => a.steamid !== activeId);
  listEl.innerHTML = others.map(cardHTML).join("");
  listEl.querySelectorAll(".card").forEach((el) => {
    el.addEventListener("click", () => onCardClick(el.dataset.id));
  });
}

function cardHTML(a) {
  const avatar = avatarHTML(a, "card__avatar");

  if (a.steamid === switchingId && phase === "spin") {
    return `<div class="card card--switching" data-id="${a.steamid}">
      ${avatar}
      <div class="card__info">
        <div class="card__name card__name--accent">Switching…</div>
        <div class="card__user">${escapeHtml(a.name)}</div>
      </div>
      <div class="card__meta"><div class="spinner"></div></div>
    </div>`;
  }

  if (a.steamid === switchingId && phase === "done") {
    return `<div class="card card--switching" data-id="${a.steamid}">
      ${avatar}
      <div class="card__info">
        <div class="card__name card__name--ready">Ready</div>
        <div class="card__user">${escapeHtml(a.name)}</div>
      </div>
      <div class="card__meta"><div class="check">${CHECK_SVG}</div></div>
    </div>`;
  }

  if (a.steamid === switchingId && phase === "error") {
    return `<div class="card card--switching" data-id="${a.steamid}">
      ${avatar}
      <div class="card__info">
        <div class="card__name" style="color:#e35d6a">Switch failed</div>
        <div class="card__user" style="color:#e35d6a">${escapeHtml(errorMsg)}</div>
      </div>
      <div class="card__meta"></div>
    </div>`;
  }

  return `<div class="card" data-id="${a.steamid}">
    ${avatarWithCacheDot(a)}
    <div class="card__info">
      <div class="card__name">${escapeHtml(a.name)}</div>
      <div class="card__user">${escapeHtml(a.user)}</div>
    </div>
    <div class="card__meta">
      <span class="card__meta-label">last used</span>
      <span class="card__meta-time">${escapeHtml(a.last)}</span>
    </div>
  </div>`;
}

// ---------------------------------------------------------------- switch
function onCardClick(id) {
  if (switchingId || addInProgress) return; // guard: ignore clicks mid-switch/add
  const account = accounts.find((a) => a.steamid === id);
  if (!account) return;

  runSwitch(account);
}

async function runSwitch(account) {
  switchingId = account.steamid;
  phase = "spin";
  errorMsg = null;
  renderList();

  // Spin for a beat, then hit the real backend.
  await delay(T_DONE);

  try {
    await switchAccount(account.user);
  } catch (e) {
    phase = "error";
    errorMsg = typeof e === "string" ? e : e?.message || "Could not switch account";
    renderList();
    await delay(T_ERROR);
    switchingId = null;
    phase = null;
    errorMsg = null;
    render();
    return;
  }

  // Success → checkmark, then promote into the banner.
  phase = "done";
  renderList();
  await delay(Math.max(T_PROMOTE - T_DONE, 0));
  promote(account.steamid);
}

function promote(id) {
  const incoming = accounts.find((a) => a.steamid === id);
  const outgoing = accounts.find((a) => a.steamid === activeId);
  if (incoming) {
    incoming.last = "now";
    incoming.can_auto_login = true;
  }
  if (outgoing && outgoing !== incoming) outgoing.last = "moments ago";
  // Switching only ever marks the target as auto-loginable — everyone else's
  // can_auto_login is left as Steam's own last-known value (see steam.rs).
  accounts.forEach((a) => (a.most_recent = a.steamid === id));

  activeId = id;
  switchingId = null;
  phase = null;
  errorMsg = null;
  render();
}

// ------------------------------------------------------------ add account
let pollTimer = null;

function stopAccountPoll() {
  if (pollTimer) {
    clearInterval(pollTimer);
    pollTimer = null;
  }
}

// Steam's login screen is a separate window we don't control, so the only way
// to notice a newly-added account is to keep re-reading loginusers.vdf until
// the account list actually changes (or we give up after a while).
function pollForNewAccount() {
  stopAccountPoll();
  const knownIds = new Set(accounts.map((a) => a.steamid));
  const deadline = Date.now() + 5 * 60 * 1000;

  pollTimer = setInterval(async () => {
    if (Date.now() > deadline) {
      stopAccountPoll();
      return;
    }
    if (switchingId) return; // don't clobber the in-flight switch animation

    try {
      const fresh = await getAccounts();
      const changed =
        fresh.length !== accounts.length || fresh.some((a) => !knownIds.has(a.steamid));
      if (changed) {
        stopAccountPoll();
        accounts = fresh;
        const active = accounts.find((a) => a.most_recent) || accounts[0];
        activeId = active ? active.steamid : null;
        render();
      }
    } catch {
      // Steam is mid-restart or the file is momentarily locked — try again next tick.
    }
  }, 3000);
}

async function onAddAccountClick() {
  if (switchingId || addInProgress) return; // guard: ignore mid-switch/add
  addInProgress = true;

  const btn = $("add-btn");
  const originalLabel = btn.textContent;
  btn.disabled = true;
  btn.textContent = "Opening Steam…";

  try {
    await addAccount();
    btn.textContent = originalLabel;
    btn.disabled = false;
    addInProgress = false;
    pollForNewAccount();
  } catch (e) {
    const msg = typeof e === "string" ? e : e?.message || "Could not open Steam";
    btn.textContent = msg;
    btn.style.color = "#e35d6a";
    await delay(T_ERROR);
    btn.textContent = originalLabel;
    btn.style.color = "";
    btn.disabled = false;
    addInProgress = false;
  }
}

// ---------------------------------------------------------------- screens
function openSettings() { screensEl.classList.add("show-settings"); }
function closeSettings() { screensEl.classList.remove("show-settings"); }

// ---------------------------------------------------------------- window controls
function wireWindowControls() {
  const w = window.__TAURI__?.window?.getCurrentWindow?.();
  $("min-btn").addEventListener("click", () => w?.minimize());
  $("close-btn").addEventListener("click", () => w?.close());
}

// ---------------------------------------------------------------- boot
async function boot() {
  try {
    accounts = await getAccounts();
  } catch (e) {
    accounts = [];
    const msg = typeof e === "string" ? e : e?.message || "Failed to load accounts";
    countEl.textContent = "0 accounts linked";
    bannerEl.innerHTML =
      `<div class="banner__info"><div class="banner__name">Couldn't load accounts</div>` +
      `<div class="banner__user">${escapeHtml(msg)}</div></div>`;
    listEl.innerHTML = "";
  }

  if (accounts.length) {
    const active = accounts.find((a) => a.most_recent) || accounts[0];
    activeId = active.steamid;
    render();
  }

  $("gear-btn").addEventListener("click", openSettings);
  $("add-btn").addEventListener("click", onAddAccountClick);

  initSettings({ onClose: closeSettings });
  wireWindowControls();
}

boot();
