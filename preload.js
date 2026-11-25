// Runs in an isolated world next to the Gather page: it shares the DOM with
// the page but not its JavaScript globals, and nothing here is exposed to the
// page. It adds one button to Gather's left sidebar that opens the wrapper's
// own settings dialog.
//
// Nothing is inserted into the part of the page React manages. The button and
// the dialog hang off <body> and are positioned over the sidebar, so a Gather
// re-render can neither remove them nor trip over them. If Gather changes its
// sidebar so the anchor below no longer matches, the button just does not
// appear; auto-away keeps working from the saved settings.

const { ipcRenderer } = require("electron");

const BUTTON_ID = "gather-linux-settings-button";
const POSITION_INTERVAL_MS = 500;
// Same limits as main.js, which enforces them; a sandboxed preload cannot
// share a module with it.
const MIN_IDLE_MINUTES = 1;
const MAX_IDLE_MINUTES = 240;

let settings = null;
// Whether idle detection can work on this desktop, as reported by main.js.
let idleSupport = { available: true };
let button = null;
let dialogHost = null;
let dialogOpening = false;

// Gather's keyboard shortcuts (WASD to walk, etc.) must not fire while the
// user types in our dialog. Preloads run before page scripts, so this window
// capture listener is the first to see every key event. Stopping propagation
// keeps the event from Gather but not its default action, so typing, Tab and
// Space still work inside the dialog.
for (const type of ["keydown", "keyup", "keypress"]) {
  window.addEventListener(
    type,
    (event) => {
      if (!dialogHost) return;
      event.stopImmediatePropagation();
      if (type !== "keydown") return;
      if (event.key === "Escape") {
        closeDialog();
      } else if (
        event.key === "Enter" &&
        dialogHost.shadowRoot.activeElement?.id !== "cancel"
      ) {
        event.preventDefault();
        saveDialog();
      }
    },
    true,
  );
}

if (location.hostname.endsWith("gather.town")) {
  window.addEventListener("DOMContentLoaded", init);
}

async function init() {
  try {
    ({ settings, idleSupport } = await ipcRenderer.invoke("settings:get"));
  } catch (err) {
    console.log("gather-linux: could not load settings:", err);
    return;
  }
  setInterval(positionButton, POSITION_INTERVAL_MS);
  window.addEventListener("resize", positionButton);
  positionButton();
}

// The bottom-most sidebar button is the settings gear. Its icon and classes
// are generated names that change between Gather builds, so it is found from
// the nav links above it, whose data-testid attributes are stable:
//
//   <div>                      nav group, ends with the activity feed link
//     <a data-testid="gather-chat-activity-feed-nav">
//   <div>                      bottom group
//     <button>…</button>
//     <button>gear</button>
function findSidebar() {
  const feedLink = document.querySelector(
    '[data-testid="gather-chat-activity-feed-nav"]',
  );
  const navGroup = feedLink && feedLink.parentElement;
  const bottomGroup = navGroup && navGroup.nextElementSibling;
  const gear = bottomGroup && bottomGroup.lastElementChild;
  if (!gear || gear.tagName !== "BUTTON") return null;
  return { navGroup, bottomGroup, gear };
}

// There is no room below the gear, so the button sits above the bottom group,
// in the empty stretch of sidebar between it and the nav links.
function positionButton() {
  const sidebar = findSidebar();
  if (!sidebar) {
    if (button) button.style.display = "none";
    return;
  }
  const { navGroup, bottomGroup, gear } = sidebar;
  const gearRect = gear.getBoundingClientRect();
  const bottomRect = bottomGroup.getBoundingClientRect();
  const navRect = navGroup.getBoundingClientRect();
  const gap = parseFloat(getComputedStyle(bottomGroup).rowGap) || 12;
  const top = bottomRect.top - gap - gearRect.height;

  if (!button || !button.isConnected) button = createButton();

  // Hidden sidebar (e.g. a full-screen view), or a window so short that the
  // button would overlap the nav links.
  if (gearRect.width === 0 || top < navRect.bottom + gap) {
    button.style.display = "none";
    return;
  }

  // Borrow the gear's look so the button follows Gather's styling across
  // builds without hard-coding any of its generated class names.
  if (button.className !== gear.className) button.className = gear.className;
  const icon = gear.querySelector("span, svg");
  button.style.color = icon ? getComputedStyle(icon).color : "";
  button.style.display = "";
  button.style.left = `${gearRect.left}px`;
  button.style.top = `${top}px`;
  button.style.width = `${gearRect.width}px`;
  button.style.height = `${gearRect.height}px`;
  updateButtonIcon();
}

function createButton() {
  const el = document.createElement("button");
  el.id = BUTTON_ID;
  el.type = "button";
  el.title = "Auto-away (Gather Linux)";
  el.setAttribute("aria-label", "Auto-away settings");
  el.style.position = "fixed";
  el.style.zIndex = "1";
  el.style.display = "flex";
  el.style.alignItems = "center";
  el.style.justifyContent = "center";
  el.addEventListener("click", openDialog);
  document.body.appendChild(el);
  return el;
}

// A crescent moon, filled while auto-away is on.
function updateButtonIcon() {
  const enabled = settings.autoAway.enabled ? "on" : "off";
  if (button.dataset.state === enabled) return;
  button.dataset.state = enabled;
  const fill = enabled === "on" ? "currentColor" : "none";
  button.innerHTML = `
    <svg width="18" height="18" viewBox="0 0 24 24" fill="${fill}"
         stroke="currentColor" stroke-width="2" stroke-linecap="round"
         stroke-linejoin="round" aria-hidden="true">
      <path d="M21 12.79A9 9 0 1 1 11.21 3 7 7 0 0 0 21 12.79z"/>
    </svg>`;
}

// The dialog lives in a shadow root so Gather's CSS cannot reach it and its
// CSS cannot leak into Gather.
async function openDialog() {
  if (dialogHost || dialogOpening) return;
  // Fetch fresh state: idle detection may have failed since the page loaded.
  dialogOpening = true;
  try {
    ({ settings, idleSupport } = await ipcRenderer.invoke("settings:get"));
  } catch (err) {
    console.log("gather-linux: could not load settings:", err);
  } finally {
    dialogOpening = false;
  }
  dialogHost = document.createElement("div");
  const root = dialogHost.attachShadow({ mode: "open" });
  root.innerHTML = `
    <style>
      :host { all: initial; }
      .overlay {
        position: fixed; inset: 0; z-index: 2147483647;
        display: flex; align-items: center; justify-content: center;
        background: rgba(0, 0, 0, 0.55);
        font: 14px/1.4 system-ui, sans-serif;
        color-scheme: dark;
      }
      .panel {
        width: min(380px, calc(100vw - 32px));
        padding: 20px;
        border-radius: 12px;
        background: #2c2e33;
        color: #e8e9ec;
        box-shadow: 0 12px 40px rgba(0, 0, 0, 0.5);
      }
      h2 { margin: 0 0 6px; font-size: 16px; font-weight: 600; }
      p { margin: 0 0 16px; color: #a9acb4; }
      label { display: flex; align-items: center; gap: 8px; margin-bottom: 12px; }
      input[type="number"] {
        width: 64px; padding: 4px 6px;
        border: 1px solid #4a4d55; border-radius: 6px;
        background: #1f2024; color: inherit; font: inherit;
      }
      input:disabled { opacity: 0.5; }
      .warning {
        margin: 0 0 12px; padding: 8px 10px; border-radius: 8px;
        background: rgba(255, 183, 77, 0.12); color: #ffcc80;
      }
      .warning[hidden] { display: none; }
      .error { color: #ff8a80; min-height: 1.4em; margin: 0 0 8px; }
      .buttons { display: flex; justify-content: flex-end; gap: 8px; }
      button {
        padding: 6px 14px; border-radius: 8px; border: 1px solid #4a4d55;
        background: transparent; color: inherit; font: inherit; cursor: pointer;
      }
      button.primary { background: #5865f2; border-color: #5865f2; color: #fff; }
    </style>
    <div class="overlay">
      <div class="panel" role="dialog" aria-modal="true" aria-labelledby="title">
        <h2 id="title">Auto-away</h2>
        <p>Set your status to Away when there has been no keyboard or mouse
           input on this computer, in any app, for a while.</p>
        <label>
          <input type="checkbox" id="enabled">
          Enable auto-away
        </label>
        <label>
          After
          <input type="number" id="minutes" min="${MIN_IDLE_MINUTES}"
                 max="${MAX_IDLE_MINUTES}" step="1">
          minutes idle
        </label>
        <p class="warning" id="warning" hidden></p>
        <div class="error" id="error"></div>
        <div class="buttons">
          <button type="button" id="cancel">Cancel</button>
          <button type="button" id="save" class="primary">Save</button>
        </div>
      </div>
    </div>`;

  const enabled = root.getElementById("enabled");
  const minutes = root.getElementById("minutes");
  enabled.checked = settings.autoAway.enabled;
  minutes.value = String(settings.autoAway.idleMinutes);
  minutes.disabled = !enabled.checked;
  showIdleSupport(root);
  enabled.addEventListener("change", () => {
    minutes.disabled = !enabled.checked;
  });
  root.getElementById("cancel").addEventListener("click", closeDialog);
  root.getElementById("save").addEventListener("click", saveDialog);
  root.querySelector(".overlay").addEventListener("click", (event) => {
    if (event.target === event.currentTarget) closeDialog();
  });

  document.body.appendChild(dialogHost);
  enabled.focus();
}

function showIdleSupport(root) {
  const warning = root.getElementById("warning");
  warning.hidden = idleSupport.available;
  warning.textContent = idleSupport.available
    ? ""
    : `${idleSupport.reason} Auto-away can still react to the screen ` +
      "locking, where the desktop reports it.";
}

function closeDialog() {
  if (!dialogHost) return;
  dialogHost.remove();
  dialogHost = null;
  if (button) button.focus();
}

async function saveDialog() {
  if (!dialogHost) return;
  const root = dialogHost.shadowRoot;
  const enabled = root.getElementById("enabled").checked;
  const minutes = Number(root.getElementById("minutes").value);
  const error = root.getElementById("error");
  if (
    !Number.isInteger(minutes) ||
    minutes < MIN_IDLE_MINUTES ||
    minutes > MAX_IDLE_MINUTES
  ) {
    error.textContent =
      "Enter a whole number of minutes from " +
      `${MIN_IDLE_MINUTES} to ${MAX_IDLE_MINUTES}.`;
    return;
  }
  const save = root.getElementById("save");
  if (save.disabled) return;
  save.disabled = true;
  save.textContent = "Saving…";
  error.textContent = "";
  try {
    ({ settings, idleSupport } = await ipcRenderer.invoke("settings:set", {
      autoAway: { enabled, idleMinutes: minutes },
    }));
  } catch (err) {
    error.textContent = "Could not save the settings.";
    console.log("gather-linux: could not save settings:", err);
    return;
  } finally {
    save.disabled = false;
    save.textContent = "Save";
  }
  if (button) updateButtonIcon();
  // Saved, but say so if it cannot actually work here instead of closing as
  // if all were well.
  if (enabled && !idleSupport.available) {
    showIdleSupport(root);
    return;
  }
  closeDialog();
}
