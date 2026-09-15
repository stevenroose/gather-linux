const {
  app,
  BrowserWindow,
  shell,
  session,
  desktopCapturer,
  Menu,
  powerMonitor,
} = require("electron");

const URL_V2 = "https://app.v2.gather.town/";
const URL_CLASSIC = "https://app.gather.town/";

// Determine URL based on startup flags
let GATHER_URL = process.argv.includes("--classic") ? URL_CLASSIC : URL_V2;

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
    },
  });

  win.once("ready-to-show", () => win.show());

  win.loadURL(GATHER_URL, {
    userAgent:
      "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
  });

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
  configureSession();
  createWindow();

  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") app.quit();
});
