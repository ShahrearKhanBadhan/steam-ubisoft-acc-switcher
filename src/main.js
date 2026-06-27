// Main screen logic — renders the account list / active banner from the real
// Steam backend, drives the switch animation + real account switch, and the
// main <-> settings transition.

import { getAccounts, switchAccount, addAccount, forgetAccount } from "./steam.js";
import { initSettings } from "./settings.js";
import {
  getUbisoftAccounts,
  saveUbisoftAccount,
  switchUbisoftAccount,
  launchUbisoft,
  deleteUbisoftAccount,
  fixUbisoftSession,
} from "./ubisoft.js";

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
let confirmDeleteId = null; // steamid of the card asking to confirm removal

const $ = (id) => document.getElementById(id);
const bannerEl = $("banner");
const listEl = $("list");
const countEl = $("account-count");
const screensEl = $("screens");

const CHECK_SVG =
  '<svg viewBox="0 0 24 24" width="13" height="13" fill="none">' +
  '<path d="M5 12.5l4.2 4.2L19 7" stroke="#0c1318" stroke-width="2.6" ' +
  'stroke-linecap="round" stroke-linejoin="round"/></svg>';

// Small "×" used by the remove controls on both platforms.
const DEL_SVG =
  '<svg viewBox="0 0 10 10" width="9" height="9" fill="none">' +
  '<path d="M2.5 2.5l5 5M7.5 2.5l-5 5" stroke="currentColor" stroke-width="1.4" ' +
  'stroke-linecap="round"/></svg>';

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

  // Forget failed (only the active/banner account routes its error here).
  if (a.steamid === switchingId && phase === "error") {
    bannerEl.innerHTML = `
      ${avatarHTML(a, "banner__avatar")}
      <div class="banner__info">
        <div class="banner__name" style="color:#e35d6a">Action failed</div>
        <div class="banner__user" style="color:#e35d6a">${escapeHtml(errorMsg)}</div>
      </div>`;
    return;
  }

  // Inline confirm before forgetting the active account.
  if (a.steamid === confirmDeleteId) {
    bannerEl.innerHTML = `
      ${avatarHTML(a, "banner__avatar")}
      <div class="banner__info">
        <div class="banner__name" style="color:#e35d6a">Forget account?</div>
        <div class="banner__user">${escapeHtml(a.name)}</div>
      </div>
      <div class="card__confirm banner__confirm">
        <button class="card__confirm-cancel">Cancel</button>
        <button class="card__confirm-ok">Forget</button>
      </div>`;
    bannerEl.querySelector(".card__confirm-cancel").onclick = () => { confirmDeleteId = null; render(); };
    bannerEl.querySelector(".card__confirm-ok").onclick = () => runForget(a.steamid);
    return;
  }

  bannerEl.innerHTML = `
    ${avatarHTML(a, "banner__avatar")}
    <div class="banner__info">
      <div class="banner__eyebrow"><span class="dot-online"></span>CURRENTLY ACTIVE</div>
      <div class="banner__name">${escapeHtml(a.name)}</div>
      <div class="banner__user">${escapeHtml(a.user)}</div>
    </div>
    <button class="banner__del" title="Forget account" aria-label="Forget account">${DEL_SVG}</button>`;
  bannerEl.querySelector(".banner__del").onclick = () => { confirmDeleteId = a.steamid; render(); };
}

function renderList() {
  const others = accounts.filter((a) => a.steamid !== activeId);
  listEl.innerHTML = others.map(cardHTML).join("");
  listEl.querySelectorAll(".card").forEach((el) => {
    const id = el.dataset.id;
    el.addEventListener("click", (e) => {
      if (e.target.closest(".card__del") || e.target.closest(".card__confirm")) return;
      onCardClick(id);
    });
    el.querySelector(".card__del")?.addEventListener("click", (e) => {
      e.stopPropagation();
      confirmDeleteId = id;
      renderList();
    });
    el.querySelector(".card__confirm-cancel")?.addEventListener("click", (e) => {
      e.stopPropagation();
      confirmDeleteId = null;
      renderList();
    });
    el.querySelector(".card__confirm-ok")?.addEventListener("click", (e) => {
      e.stopPropagation();
      runForget(id);
    });
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

  if (a.steamid === confirmDeleteId) {
    return `<div class="card card--switching" data-id="${a.steamid}">
      ${avatarHTML(a, "card__avatar")}
      <div class="card__info">
        <div class="card__name" style="color:#e35d6a">Forget account?</div>
        <div class="card__user">${escapeHtml(a.name)}</div>
      </div>
      <div class="card__confirm">
        <button class="card__confirm-cancel">Cancel</button>
        <button class="card__confirm-ok">Forget</button>
      </div>
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
    <button class="card__del" title="Forget account" aria-label="Forget account">${DEL_SVG}</button>
  </div>`;
}

// ---------------------------------------------------------------- switch
function onCardClick(id) {
  if (switchingId || addInProgress || confirmDeleteId) return; // guard: mid-switch/add/confirm
  const account = accounts.find((a) => a.steamid === id);
  if (!account) return;

  runSwitch(account);
}

// Forget a saved Steam login, then re-sync the list from the backend.
async function runForget(id) {
  if (switchingId) return;
  confirmDeleteId = null;

  try {
    await forgetAccount(id);
  } catch (e) {
    switchingId = id;
    phase = "error";
    errorMsg = typeof e === "string" ? e : e?.message || "Could not forget account";
    render(); // render() covers both the banner and list cases
    await delay(T_ERROR);
    switchingId = null;
    phase = null;
    errorMsg = null;
    render();
    return;
  }

  try {
    accounts = await getAccounts();
  } catch {
    accounts = accounts.filter((a) => a.steamid !== id);
  }
  const active = accounts.find((a) => a.most_recent) || accounts[0] || null;
  activeId = active ? active.steamid : null;
  render();
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

// ================================================================ PLATFORM TABS
function initTabs() {
  const tabs = document.querySelectorAll("#tabbar .tab");
  const app = document.querySelector(".app");
  tabs.forEach((tab) => {
    tab.addEventListener("click", () => {
      if (tab.classList.contains("tab--active")) return;
      tabs.forEach((t) => t.classList.remove("tab--active"));
      tab.classList.add("tab--active");
      const isUbi = tab.dataset.platform === "ubisoft";
      app.classList.toggle("show-ubisoft", isUbi);
      if (isUbi && !ubiBooted) ubiBoot(); // lazy load on first visit
    });
  });
}

// ================================================================ UBISOFT
// Self-contained controller for the Ubisoft tab. Shares the generic helpers
// (avatarHTML, gradientFor, escapeHtml, delay, CHECK_SVG, timings) with Steam,
// but keeps its own state and DOM so the two platforms never interfere.

let ubiAccounts = [];
let ubiActiveId = null;
let ubiSwitchingId = null;
let ubiPhase = null;          // 'spin' | 'done' | 'error' | null
let ubiErrorMsg = null;
let ubiConfirmDeleteId = null;
let ubiHighlightId = null;
let ubiAddStep = 0;           // 0 closed · -1 launching · 2 save
let ubiBooted = false;

const ubiBannerEl = $("ubi-banner");
const ubiListEl = $("ubi-list");
const ubiCountEl = $("ubi-account-count");

const ubiModal = $("ubi-modal");
const ubiModalTitle = $("ubi-modal-title");
const ubiModalBody = $("ubi-modal-body");
const ubiModalInput = $("ubi-modal-name");
const ubiModalError = $("ubi-modal-error");
const ubiModalPrimary = $("ubi-modal-primary");
const ubiModalCancel = $("ubi-modal-cancel");
const ubiModalBackdrop = $("ubi-modal-backdrop");

// ---------------------------------------------------------------- ubi render
function ubiRender() {
  ubiCountEl.textContent = `${ubiAccounts.length} account${ubiAccounts.length === 1 ? "" : "s"} saved`;
  // Strictly the tracked active account — no fallback, so a removed active
  // account correctly leaves the banner empty until you switch into one.
  const active = ubiActiveId
    ? ubiAccounts.find((a) => a.user_id === ubiActiveId)
    : null;
  ubiRenderBanner(active);
  ubiRenderList();
}

function ubiRenderBanner(a) {
  if (!a) {
    ubiBannerEl.className = "banner";
    ubiBannerEl.innerHTML =
      `<div class="banner__info"><div class="banner__name">No active account</div>` +
      `<div class="banner__user">${ubiAccounts.length ? "Pick an account below to switch in" : "Add an account to get started"}</div></div>`;
    return;
  }

  // Remove failed (only the active/banner account routes its error here).
  if (a.user_id === ubiSwitchingId && ubiPhase === "error") {
    ubiBannerEl.className = "banner";
    ubiBannerEl.innerHTML = `
      ${avatarHTML(a, "banner__avatar")}
      <div class="banner__info">
        <div class="banner__name" style="color:#e35d6a">Something went wrong</div>
        <div class="banner__user" style="color:#e35d6a">${escapeHtml(ubiErrorMsg)}</div>
      </div>`;
    return;
  }

  // Inline confirm before removing the active account.
  if (a.user_id === ubiConfirmDeleteId) {
    ubiBannerEl.className = "banner";
    ubiBannerEl.innerHTML = `
      ${avatarHTML(a, "banner__avatar")}
      <div class="banner__info">
        <div class="banner__name" style="color:#e35d6a">Remove account?</div>
        <div class="banner__user">${escapeHtml(a.display_name)}</div>
      </div>
      <div class="card__confirm banner__confirm">
        <button class="card__confirm-cancel">Cancel</button>
        <button class="card__confirm-ok">Remove</button>
      </div>`;
    ubiBannerEl.querySelector(".card__confirm-cancel").onclick = () => { ubiConfirmDeleteId = null; ubiRender(); };
    ubiBannerEl.querySelector(".card__confirm-ok").onclick = () => ubiRunDelete(a.user_id);
    return;
  }

  const isNew = a.user_id === ubiHighlightId;
  ubiBannerEl.className = isNew ? "banner banner--new" : "banner";
  ubiBannerEl.innerHTML = `
    ${avatarHTML(a, "banner__avatar")}
    <div class="banner__info">
      <div class="banner__eyebrow"><span class="dot-online"></span>CURRENTLY ACTIVE</div>
      <div class="banner__name">${escapeHtml(a.display_name)}</div>
      <div class="banner__user">Ubisoft Connect</div>
    </div>
    <button class="banner__del" title="Remove account" aria-label="Remove account">${DEL_SVG}</button>`;
  ubiBannerEl.querySelector(".banner__del").onclick = () => { ubiConfirmDeleteId = a.user_id; ubiRender(); };
}

function ubiRenderList() {
  if (ubiAccounts.length === 0) {
    ubiListEl.innerHTML =
      `<div class="empty-state">No accounts added yet.<br>` +
      `Click <strong>+ Add Account</strong> to get started.</div>`;
    return;
  }

  const others = ubiAccounts.filter((a) => a.user_id !== ubiActiveId);
  if (others.length === 0) {
    ubiListEl.innerHTML =
      `<div class="empty-state">Only one account saved.<br>` +
      `Add another to switch between them.</div>`;
    return;
  }

  ubiListEl.innerHTML = others.map(ubiCardHTML).join("");
  ubiListEl.querySelectorAll(".card").forEach((el) => {
    const id = el.dataset.id;
    el.addEventListener("click", (e) => {
      if (e.target.closest(".card__del") || e.target.closest(".card__confirm")) return;
      ubiOnCardClick(id);
    });
    el.querySelector(".card__del")?.addEventListener("click", (e) => {
      e.stopPropagation();
      ubiConfirmDeleteId = id;
      ubiRenderList();
    });
    el.querySelector(".card__confirm-cancel")?.addEventListener("click", (e) => {
      e.stopPropagation();
      ubiConfirmDeleteId = null;
      ubiRenderList();
    });
    el.querySelector(".card__confirm-ok")?.addEventListener("click", (e) => {
      e.stopPropagation();
      ubiRunDelete(id);
    });
  });
}

function ubiCardHTML(a) {
  const avatar = avatarHTML(a, "card__avatar");

  if (a.user_id === ubiSwitchingId && ubiPhase === "spin") {
    return `<div class="card card--switching" data-id="${a.user_id}">
      ${avatar}
      <div class="card__info">
        <div class="card__name card__name--accent">Switching…</div>
        <div class="card__user">${escapeHtml(a.display_name)}</div>
      </div>
      <div class="card__meta"><div class="spinner"></div></div>
    </div>`;
  }

  if (a.user_id === ubiSwitchingId && ubiPhase === "done") {
    return `<div class="card card--switching" data-id="${a.user_id}">
      ${avatar}
      <div class="card__info">
        <div class="card__name card__name--ready">Ready</div>
        <div class="card__user">${escapeHtml(a.display_name)}</div>
      </div>
      <div class="card__meta"><div class="check">${CHECK_SVG}</div></div>
    </div>`;
  }

  if (a.user_id === ubiSwitchingId && ubiPhase === "error") {
    return `<div class="card card--switching" data-id="${a.user_id}">
      ${avatar}
      <div class="card__info">
        <div class="card__name" style="color:#e35d6a">Something went wrong</div>
        <div class="card__user" style="color:#e35d6a">${escapeHtml(ubiErrorMsg)}</div>
      </div>
      <div class="card__meta"></div>
    </div>`;
  }

  if (a.user_id === ubiConfirmDeleteId) {
    return `<div class="card card--switching" data-id="${a.user_id}">
      ${avatar}
      <div class="card__info">
        <div class="card__name" style="color:#e35d6a">Remove account?</div>
        <div class="card__user">${escapeHtml(a.display_name)}</div>
      </div>
      <div class="card__confirm">
        <button class="card__confirm-cancel">Cancel</button>
        <button class="card__confirm-ok">Remove</button>
      </div>
    </div>`;
  }

  const newCls = a.user_id === ubiHighlightId ? " card--new" : "";
  return `<div class="card${newCls}" data-id="${a.user_id}">
    ${avatar}
    <div class="card__info">
      <div class="card__name">${escapeHtml(a.display_name)}</div>
      <div class="card__user">Ubisoft Connect</div>
    </div>
    <div class="card__meta">
      <span class="card__meta-label">last used</span>
      <span class="card__meta-time">${escapeHtml(a.last_used)}</span>
    </div>
    <button class="card__del" title="Remove account" aria-label="Remove account">${DEL_SVG}</button>
  </div>`;
}

// ---------------------------------------------------------------- ubi switch
function ubiOnCardClick(id) {
  if (ubiSwitchingId || ubiConfirmDeleteId || ubiAddStep) return;
  const account = ubiAccounts.find((a) => a.user_id === id);
  if (account) ubiRunSwitch(account);
}

async function ubiRunSwitch(account) {
  ubiSwitchingId = account.user_id;
  ubiPhase = "spin";
  ubiErrorMsg = null;
  ubiRenderList();

  await delay(T_DONE);

  try {
    await switchUbisoftAccount(account.user_id);
  } catch (e) {
    ubiPhase = "error";
    ubiErrorMsg = typeof e === "string" ? e : e?.message || "Could not switch account";
    ubiRenderList();
    await delay(T_ERROR);
    ubiSwitchingId = null;
    ubiPhase = null;
    ubiErrorMsg = null;
    ubiRender();
    return;
  }

  ubiPhase = "done";
  ubiRenderList();
  await delay(Math.max(T_PROMOTE - T_DONE, 0));
  ubiPromote(account.user_id);
}

function ubiPromote(id) {
  const incoming = ubiAccounts.find((a) => a.user_id === id);
  const outgoing = ubiAccounts.find((a) => a.user_id === ubiActiveId);
  if (incoming) incoming.last_used = "now";
  if (outgoing && outgoing !== incoming) outgoing.last_used = "moments ago";
  ubiAccounts.forEach((a) => (a.is_active = a.user_id === id));

  ubiActiveId = id;
  ubiSwitchingId = null;
  ubiPhase = null;
  ubiErrorMsg = null;
  ubiRender();
}

// ---------------------------------------------------------------- ubi delete
async function ubiRunDelete(id) {
  try {
    await deleteUbisoftAccount(id);
  } catch (e) {
    // Surface the error briefly (render() covers both banner and list cases).
    ubiConfirmDeleteId = null;
    ubiSwitchingId = id;
    ubiPhase = "error";
    ubiErrorMsg = typeof e === "string" ? e : e?.message || "Could not remove account";
    ubiRender();
    await delay(T_ERROR);
    ubiSwitchingId = null;
    ubiPhase = null;
    ubiErrorMsg = null;
    ubiRender();
    return;
  }
  ubiConfirmDeleteId = null;
  if (id === ubiActiveId) ubiActiveId = null; // removed the active one → no active
  ubiAccounts = ubiAccounts.filter((a) => a.user_id !== id);
  ubiRender();
}

// ---------------------------------------------------------------- add account
// Mirrors Steam's add flow: clicking Add launches Ubisoft Connect immediately
// (no confirmation step), then opens the modal straight at the name-entry step.
// The name is still required because the live session is encrypted — there's no
// readable account name to auto-fill.
async function ubiAddClick() {
  if (ubiSwitchingId || ubiAddStep) return; // guard: ignore mid-switch/add

  const btn = $("ubi-add-btn");
  const originalLabel = btn.textContent;
  ubiAddStep = -1; // launching: blocks re-entry, not yet a modal step
  btn.disabled = true;
  btn.textContent = "Opening Ubisoft Connect…";

  try {
    await launchUbisoft();
  } catch (e) {
    ubiAddStep = 0;
    btn.textContent =
      typeof e === "string" ? e : e?.message || "Could not open Ubisoft Connect";
    btn.style.color = "#e35d6a";
    await delay(T_ERROR);
    btn.textContent = originalLabel;
    btn.style.color = "";
    btn.disabled = false;
    return;
  }

  btn.textContent = originalLabel;
  btn.disabled = false;
  ubiOpenSaveModal();
}

// Opens the modal at the name-entry step (Ubisoft Connect is already launching).
function ubiOpenSaveModal() {
  ubiAddStep = 2;
  ubiModalError.textContent = "";
  ubiModalInput.value = "";
  ubiModalInput.hidden = false;
  ubiModalBody.textContent =
    "Once you're logged in, give this account a name and save it.";
  ubiModalPrimary.textContent = "Save Account";
  ubiModalPrimary.className = "ubi-modal__btn ubi-modal__btn--save";
  ubiModalPrimary.disabled = false;
  ubiModal.classList.add("show");
  ubiModal.setAttribute("aria-hidden", "false");
  ubiModalInput.focus();
}

function ubiCloseModal() {
  ubiAddStep = 0;
  ubiModal.classList.remove("show");
  ubiModal.setAttribute("aria-hidden", "true");
}

async function ubiPrimaryClick() {
  // Step 2 — snapshot the current session under the chosen name.
  if (ubiAddStep === 2) {
    const name = ubiModalInput.value.trim();
    if (!name) {
      ubiModalError.textContent = "Please enter a name for this account.";
      ubiModalInput.focus();
      return;
    }
    ubiModalError.textContent = "";
    ubiModalPrimary.disabled = true;
    const prev = ubiModalPrimary.textContent;
    ubiModalPrimary.textContent = "Saving…";

    let saved;
    try {
      saved = await saveUbisoftAccount(name);
    } catch (e) {
      ubiModalError.textContent =
        typeof e === "string" ? e : e?.message || "Could not save account";
      ubiModalPrimary.textContent = prev;
      ubiModalPrimary.disabled = false;
      return;
    }

    ubiCloseModal();

    try {
      ubiAccounts = await getUbisoftAccounts();
    } catch {
      /* keep whatever we already have */
    }
    const active = ubiAccounts.find((a) => a.is_active) || ubiAccounts[0];
    ubiActiveId = active ? active.user_id : null;

    // Brief highlight on the freshly-saved account (it's now the active one).
    ubiHighlightId = saved?.user_id || null;
    ubiRender();
    if (ubiHighlightId) {
      const hid = ubiHighlightId;
      setTimeout(() => {
        if (ubiHighlightId === hid) {
          ubiHighlightId = null;
          ubiRender();
        }
      }, 1400);
    }
  }
}

function ubiWire() {
  $("ubi-add-btn").addEventListener("click", ubiAddClick);
  ubiModalCancel.addEventListener("click", ubiCloseModal);
  ubiModalBackdrop.addEventListener("click", ubiCloseModal);
  ubiModalPrimary.addEventListener("click", ubiPrimaryClick);
  ubiModalInput.addEventListener("keydown", (e) => {
    if (e.key === "Enter") ubiPrimaryClick();
  });
}

async function ubiBoot() {
  ubiBooted = true;
  // Patch CEF exit_type to "Crashed" so session cookies survive PC restarts.
  // Best-effort — silently ignored if Ubisoft is already running or not installed.
  fixUbisoftSession().catch(() => {});
  try {
    ubiAccounts = await getUbisoftAccounts();
  } catch (e) {
    ubiAccounts = [];
    const msg = typeof e === "string" ? e : e?.message || "Failed to load accounts";
    ubiCountEl.textContent = "0 accounts saved";
    ubiBannerEl.innerHTML =
      `<div class="banner__info"><div class="banner__name">Couldn't load accounts</div>` +
      `<div class="banner__user">${escapeHtml(msg)}</div></div>`;
    ubiListEl.innerHTML = "";
    return;
  }
  const active = ubiAccounts.find((a) => a.is_active);
  ubiActiveId = active ? active.user_id : null;
  ubiRender();
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
  $("ubi-gear-btn").addEventListener("click", openSettings);
  $("add-btn").addEventListener("click", onAddAccountClick);

  initSettings({ onClose: closeSettings });
  wireWindowControls();

  // Ubisoft tab — wire controls now; account data loads lazily on first visit.
  initTabs();
  ubiWire();
}

boot();
