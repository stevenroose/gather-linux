const fs = require("fs");
const path = require("path");
const { spawn } = require("child_process");
const {
  app,
  BrowserWindow,
  shell,
  session,
  desktopCapturer,
  Menu,
  powerMonitor,
  ipcMain,
} = require("electron");

const URL_V2 = "https://app.v2.gather.town/";
const URL_CLASSIC = "https://app.gather.town/";

// Determine URL based on startup flags
let GATHER_URL = process.argv.includes("--classic") ? URL_CLASSIC : URL_V2;

// With --devtools, open the Chromium DevTools on startup and let F12 or
// Ctrl+Shift+I toggle them. Without the flag these keys go to Gather untouched.
const DEVTOOLS = process.argv.includes("--devtools");

// Present as the plain Chrome that this Electron is built on. The default user
// agent also names the app and Electron, which sites treat as an unsupported
// browser. Claiming any other Chrome version does not work either: the
// version still shows in the Client Hints headers and navigator.userAgentData,
// and Cloudflare's bot check (on Gather's login page) fails on the mismatch.
// Set app-wide so iframes, workers and popups send the same string.
const CHROME_MAJOR = process.versions.chrome.split(".")[0];
app.userAgentFallback =
  "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) " +
  `Chrome/${CHROME_MAJOR}.0.0.0 Safari/537.36`;

// DISABLE THE NATIVE MENU
Menu.setApplicationMenu(null);

function setAway(win) {
  if (!win || win.isDestroyed()) return;
  win.webContents
    .executeJavaScript(
      `
      (function() {
        const container = document.getElementById('av-toolbar-pip-container');
        if (container) {
          const avatarBtn = container.querySelector('button');
          if (avatarBtn) {
            avatarBtn.click(); // 1. Open Menu
            setTimeout(() => {
              const allButtons = Array.from(document.querySelectorAll('button'));
              const awayBtn = allButtons.find(b => b.textContent && b.textContent.trim() === 'Away');
              if (awayBtn) {
                awayBtn.click(); // 2. Click Away
                console.log("Set status to Away");
              }
            }, 100);
          }
        }
      })();
    `,
    )
    .catch((err) => console.log("Auto-Away Error:", err));
}

// --- SETTINGS ---
// Stored in the app's userData directory (~/.config/Gather/settings.json) and
// edited from the button preload.js adds to Gather's sidebar.

const DEFAULT_IDLE_MINUTES = 10;
const MIN_IDLE_MINUTES = 1;
const MAX_IDLE_MINUTES = 240;

let settings = sanitizeSettings({});

function settingsPath() {
  return path.join(app.getPath("userData"), "settings.json");
}

// Anything missing or malformed falls back to the defaults, so a hand-edited
// or older settings file can never turn a feature on by accident.
function sanitizeSettings(raw) {
  const autoAway = (raw && raw.autoAway) || {};
  let idleMinutes = Number(autoAway.idleMinutes);
  if (!Number.isInteger(idleMinutes)) idleMinutes = DEFAULT_IDLE_MINUTES;
  idleMinutes = Math.min(
    Math.max(idleMinutes, MIN_IDLE_MINUTES),
    MAX_IDLE_MINUTES,
  );
  return {
    autoAway: {
      enabled: autoAway.enabled === true,
      idleMinutes,
    },
  };
}

function loadSettings() {
  try {
    const raw = JSON.parse(fs.readFileSync(settingsPath(), "utf8"));
    settings = sanitizeSettings(raw);
  } catch (err) {
    if (err.code !== "ENOENT") console.log("Could not read settings:", err);
    settings = sanitizeSettings({});
  }
}

// Write to a temporary file and rename it over the old one, so a crash
// mid-write cannot leave a truncated settings file behind.
function saveSettings() {
  const file = settingsPath();
  const tmp = `${file}.tmp`;
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(tmp, JSON.stringify(settings, null, 2) + "\n");
  fs.renameSync(tmp, file);
}

function configureSettingsIpc() {
  ipcMain.handle("settings:get", () => ({
    settings,
    idleSupport: idleSupport(),
  }));
  ipcMain.handle("settings:set", async (_event, raw) => {
    settings = sanitizeSettings(raw);
    saveSettings();
    updateIdleWatcher();
    // swayidle fails within milliseconds when it cannot work (not installed,
    // or the compositor lacks the idle protocol). Waiting a moment lets the
    // dialog report that right away instead of the next time it is opened.
    if (swayidle) await new Promise((resolve) => setTimeout(resolve, 1000));
    return { settings, idleSupport: idleSupport() };
  });
}

// --- AUTO AWAY WHEN IDLE ---
// Off unless the user turns it on. "Idle" means no keyboard or mouse input on
// the whole system, not just in this window, and the status is set to Away
// once per idle stretch: after that the user is left alone until they have
// been active again.
//
// Where the idle time comes from depends on the session:
//  - X11: Electron's powerMonitor.getSystemIdleTime(), polled.
//  - Wayland: Electron always reports 0 there, so swayidle is run instead. It
//    uses the ext-idle-notify-v1 protocol, which Sway, Hyprland, niri, KDE,
//    COSMIC and other compositors support (GNOME does not), and prints a line
//    when the user goes idle or comes back.

const IDLE_POLL_MS = 15 * 1000;
// swayidle exiting this soon after starting means it cannot work here (most
// likely the compositor lacks the idle protocol), rather than a hiccup.
const SWAYIDLE_STARTUP_MS = 10 * 1000;
const SWAYIDLE_MISSING =
  "On Wayland, auto-away needs swayidle, which is not installed.";

let idleTimer = null;
let awaySentWhileIdle = false;
let swayidle = null;
// Why swayidle could not run, once it has failed. Shown in the dialog.
let swayidleFailure = null;

function isWaylandSession() {
  return (
    Boolean(process.env.WAYLAND_DISPLAY) ||
    process.env.XDG_SESSION_TYPE === "wayland"
  );
}

function findInPath(name) {
  for (const dir of (process.env.PATH || "").split(path.delimiter)) {
    if (!dir) continue;
    const candidate = path.join(dir, name);
    try {
      fs.accessSync(candidate, fs.constants.X_OK);
      return candidate;
    } catch {}
  }
  return null;
}

// What the settings dialog tells the user about whether auto-away can work.
function idleSupport() {
  if (!isWaylandSession()) return { available: true };
  if (swayidleFailure) return { available: false, reason: swayidleFailure };
  if (!findInPath("swayidle")) {
    return { available: false, reason: SWAYIDLE_MISSING };
  }
  return { available: true };
}

function setAwayEverywhere() {
  for (const win of BrowserWindow.getAllWindows()) setAway(win);
}

function checkIdle() {
  const idleSeconds = powerMonitor.getSystemIdleTime();
  if (DEVTOOLS) console.log(`Auto-away: system idle for ${idleSeconds}s`);
  if (idleSeconds >= settings.autoAway.idleMinutes * 60) {
    if (!awaySentWhileIdle) {
      awaySentWhileIdle = true;
      console.log(`Auto-away: idle for ${idleSeconds}s, setting Away`);
      setAwayEverywhere();
    }
  } else {
    awaySentWhileIdle = false;
  }
}

function startSwayidle() {
  const timeout = settings.autoAway.idleMinutes * 60;
  // swayidle also loads the user's own config file on top of the events given
  // here, which would run their lock and screen-off commands a second time.
  // An empty config keeps this instance to auto-away alone.
  const child = spawn(
    "swayidle",
    [
      "-C", "/dev/null",
      "timeout", String(timeout), "echo idle",
      "resume", "echo active",
    ],
    { stdio: ["ignore", "pipe", "pipe"] },
  );
  const startedAt = Date.now();
  let stderr = "";
  let stdout = "";
  swayidle = child;

  child.stdout.setEncoding("utf8");
  child.stdout.on("data", (chunk) => {
    stdout += chunk;
    const lines = stdout.split("\n");
    stdout = lines.pop();
    for (const line of lines) {
      if (line.trim() === "idle") {
        console.log(`Auto-away: idle for ${timeout}s, setting Away`);
        setAwayEverywhere();
      } else if (DEVTOOLS && line.trim() === "active") {
        console.log("Auto-away: active again");
      }
    }
  });
  child.stderr.setEncoding("utf8");
  child.stderr.on("data", (chunk) => {
    stderr = (stderr + chunk).slice(-2000);
  });

  const fail = (reason) => {
    if (swayidle !== child) return;
    swayidle = null;
    swayidleFailure = reason;
    console.log(`Auto-away: ${reason}`);
  };
  child.on("error", (err) => {
    fail(
      err.code === "ENOENT"
        ? SWAYIDLE_MISSING
        : `Could not start swayidle: ${err.message}`,
    );
  });
  child.on("exit", (code, signal) => {
    if (swayidle !== child) return; // Stopped on purpose.
    const detail =
      stderr.trim().split("\n").pop() || `exit ${code ?? signal}`;
    fail(
      Date.now() - startedAt < SWAYIDLE_STARTUP_MS
        ? `Idle detection is not available on this desktop (swayidle: ${detail}).`
        : `swayidle stopped unexpectedly (${detail}).`,
    );
  });
}

function stopIdleWatcher() {
  clearInterval(idleTimer);
  idleTimer = null;
  awaySentWhileIdle = false;
  if (swayidle) {
    const child = swayidle;
    swayidle = null;
    child.kill();
  }
}

function updateIdleWatcher() {
  stopIdleWatcher();
  // Every change of settings is a fresh attempt.
  swayidleFailure = null;
  if (!settings.autoAway.enabled) {
    console.log("Auto-away: off");
    return;
  }
  const wayland = isWaylandSession();
  console.log(
    `Auto-away: on, after ${settings.autoAway.idleMinutes} min idle ` +
      `(${wayland ? "swayidle" : "X11 idle time"})`,
  );
  if (wayland) {
    startSwayidle();
  } else {
    idleTimer = setInterval(checkIdle, IDLE_POLL_MS);
  }
}

function configureAutoAway() {
  // Locking the screen is as clear a sign of being away as idling is. Not
  // every compositor reports it, which is why the idle watcher does the real
  // work.
  powerMonitor.on("lock-screen", () => {
    if (settings.autoAway.enabled) setAwayEverywhere();
  });
  // swayidle is a separate process and would outlive the app otherwise.
  app.on("will-quit", stopIdleWatcher);
  updateIdleWatcher();
}
// ----------------------------

function createWindow() {
  const win = new BrowserWindow({
    width: 1280,
    height: 800,
    title: "Gather",
    autoHideMenuBar: true,
    // Painting only once the first frame is ready avoids a white flash and a
    // round of wasted layout work on startup.
    show: false,
    backgroundColor: "#2c2e33",
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true,
      sandbox: true,
      // The spellchecker keeps a dictionary resident and runs on every
      // keystroke in the chat box; Gather does not need it.
      spellcheck: false,
      // Let Chromium throttle timers and rendering while the window is hidden
      // or minimised (this is the default, but it is the whole point here).
      backgroundThrottling: true,
      // Adds the auto-away settings button to Gather's sidebar.
      preload: path.join(__dirname, "preload.js"),
    },
  });

  win.once("ready-to-show", () => win.show());

  if (DEVTOOLS) {
    // Detached, so the DevTools do not shrink Gather's viewport.
    win.webContents.openDevTools({ mode: "detach" });
    win.webContents.on("before-input-event", (event, input) => {
      if (input.type !== "keyDown") return;
      const isF12 = input.key === "F12";
      const isCtrlShiftI =
        input.control && input.shift && input.key.toLowerCase() === "i";
      if (isF12 || isCtrlShiftI) {
        event.preventDefault();
        win.webContents.toggleDevTools();
      }
    });
  }

  win.loadURL(GATHER_URL);

  // --- AUTO AWAY ON SUSPEND ---
  const onSuspend = () => {
    console.log("System suspending...");
    setAway(win);
  };
  powerMonitor.on("suspend", onSuspend);
  win.on("closed", () => powerMonitor.removeListener("suspend", onSuspend));
  // ----------------------------

  win.webContents.setWindowOpenHandler(({ url }) => {
    if (
      url.startsWith("https://gather.town") ||
      url.includes("accounts.google.com")
    ) {
      return { action: "allow" };
    }
    if (url.startsWith("https://") || url.startsWith("http://")) {
      shell.openExternal(url);
    }
    return { action: "deny" };
  });

  return win;
}

// Session-wide handlers belong on the session, not on each window, so that
// reopening a window does not stack up another copy of them.
function configureSession() {
  session.defaultSession.setSpellCheckerEnabled(false);

  session.defaultSession.setPermissionRequestHandler(
    (webContents, permission, callback) => {
      const allowedPermissions = [
        "media",
        "accessibility-events",
        "display-capture",
      ];
      if (allowedPermissions.includes(permission)) {
        callback(true);
      } else {
        callback(false);
      }
    },
  );

  session.defaultSession.setDisplayMediaRequestHandler(
    (request, callback) => {
      desktopCapturer
        .getSources({ types: ["screen", "window"] })
        .then((sources) => {
          if (sources.length === 1) {
            callback({ video: sources[0] });
            return;
          }
          const menu = Menu.buildFromTemplate(
            sources.map((source) => {
              return {
                label: source.name,
                click: () => {
                  // Video only (Audio must be excluded to prevent crash)
                  callback({ video: source });
                },
              };
            }),
          );
          menu.popup();
        })
        .catch((err) => console.log("Screen share error:", err));
    },
    {
      useSystemPicker: true,
    },
  );
}

app.whenReady().then(() => {
  loadSettings();
  configureSettingsIpc();
  configureAutoAway();
  configureSession();
  createWindow();

  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") app.quit();
});
