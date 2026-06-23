// Settings screen logic — loads real settings, live accent theming, and the
// real save flow. Talks to the backend through steam.js.

import { getSettings, saveSettings, browseSteamPath } from "./steam.js";

const $ = (id) => document.getElementById(id);

const ACCENT_CHECK =
  '<svg class="dot__check" viewBox="0 0 24 24" width="13" height="13" fill="none">' +
  '<path d="M5 12.5l4.2 4.2L19 7" stroke="#0c1318" stroke-width="2.8" ' +
  'stroke-linecap="round" stroke-linejoin="round"/></svg>';

// live working copy of settings
let settings = null;

// "#66c0f4" -> "102,192,244" so accent tints (built on --accent-rgb) re-theme too.
function hexToRgb(hex) {
  const m = String(hex || "").replace("#", "").match(/^([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/i);
  if (!m) return null;
  return `${parseInt(m[1], 16)},${parseInt(m[2], 16)},${parseInt(m[3], 16)}`;
}

function applyAccent(hex) {
  const root = document.documentElement.style;
  root.setProperty("--accent", hex);
  const rgb = hexToRgb(hex);
  if (rgb) root.setProperty("--accent-rgb", rgb);
}

function dotHex(dot) {
  return dot.style.getPropertyValue("--c").trim();
}

export async function initSettings({ onClose }) {
  settings = await getSettings();

  // --- back arrow: slide back to main without saving ---
  $("back-btn").addEventListener("click", onClose);

  // --- behavior toggles ---
  document.querySelectorAll("#toggles .toggle-row").forEach((row) => {
    const key = row.dataset.key;
    const pill = row.querySelector(".pill");
    const on = !!settings[key];
    pill.classList.toggle("on", on);
    pill.setAttribute("aria-checked", String(on));

    pill.addEventListener("click", () => {
      settings[key] = !settings[key];
      pill.classList.toggle("on", settings[key]);
      pill.setAttribute("aria-checked", String(settings[key]));
    });
  });

  // --- steam path (read-only field, browse is a no-op stub) ---
  const pathText = document.querySelector(".path-field__text");
  if (pathText && settings.steamPath) pathText.textContent = settings.steamPath;

  $("browse-btn").addEventListener("click", async () => {
    const picked = await browseSteamPath();
    if (picked) {
      settings.steamPath = picked;
      if (pathText) pathText.textContent = picked;
    }
  });

  // --- theme accent dots (live re-theme) ---
  const dots = document.querySelectorAll("#accents .dot");
  dots.forEach((dot) => {
    dot.insertAdjacentHTML("beforeend", ACCENT_CHECK);
    const selected = dotHex(dot).toLowerCase() === String(settings.accent || "").toLowerCase();
    dot.classList.toggle("selected", selected);

    dot.addEventListener("click", () => {
      dots.forEach((d) => d.classList.remove("selected"));
      dot.classList.add("selected");
      const hex = dotHex(dot);
      applyAccent(hex);
      settings.accent = hex;
    });
  });

  // Apply the loaded accent immediately.
  applyAccent(settings.accent);

  // --- save ---
  const saveBtn = $("save-btn");
  const footer = saveBtn.closest(".s-footer") || saveBtn.parentElement;

  // Error line lives below the button; created lazily, no markup in index.html.
  let errEl = null;
  const showError = (msg) => {
    if (!errEl) {
      errEl = document.createElement("div");
      errEl.style.color = "#e35d6a";
      errEl.style.fontSize = "11.5px";
      errEl.style.marginTop = "8px";
      errEl.style.textAlign = "center";
      footer.appendChild(errEl);
    }
    errEl.textContent = msg;
  };
  const clearError = () => { if (errEl) errEl.textContent = ""; };

  saveBtn.addEventListener("click", async () => {
    if (saveBtn.disabled) return;
    saveBtn.disabled = true;
    clearError();

    try {
      await saveSettings(settings);
    } catch (e) {
      showError(typeof e === "string" ? e : e?.message || "Failed to save settings");
      saveBtn.disabled = false;
      return;
    }

    saveBtn.classList.add("saved");
    saveBtn.textContent = "Saved ✓";
    setTimeout(() => {
      onClose();
      // reset label after the slide-back completes
      setTimeout(() => {
        saveBtn.classList.remove("saved");
        saveBtn.textContent = "Save";
        saveBtn.disabled = false;
      }, 320);
    }, 850);
  });
}
