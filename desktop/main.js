// desktop/main.js — Electron main process for PDF Accessibility Engine
// Uses CommonJS because Electron main process does not support ESM by default.

const { app, BrowserWindow, Menu, Tray, dialog, ipcMain, shell, nativeImage } = require("electron");
const path = require("path");
const net = require("net");
const http = require("http");
const { fork } = require("child_process");

// ---------------------------------------------------------------------------
// Paths
// ---------------------------------------------------------------------------
const REPO_ROOT = path.resolve(__dirname, "..");
const SERVER_SCRIPT = path.join(REPO_ROOT, "orchestrator", "server.js");
const PRELOAD_SCRIPT = path.join(__dirname, "preload.js");
const SPLASH_HTML = path.join(__dirname, "splash.html");

// ---------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------
let mainWindow = null;
let splashWindow = null;
let serverProcess = null;
let tray = null;
let serverPort = null;
let minimizeToTray = false; // configurable

// ---------------------------------------------------------------------------
// Find a free port
// ---------------------------------------------------------------------------
function findFreePort() {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.listen(0, "127.0.0.1", () => {
      const { port } = srv.address();
      srv.close(() => resolve(port));
    });
    srv.on("error", reject);
  });
}

// ---------------------------------------------------------------------------
// Poll until server is ready (simple HTTP GET on /)
// ---------------------------------------------------------------------------
function waitForServer(port, timeoutMs = 30000) {
  const start = Date.now();
  return new Promise((resolve, reject) => {
    function poll() {
      if (Date.now() - start > timeoutMs) {
        return reject(new Error("Server did not start within timeout"));
      }
      const req = http.get(`http://127.0.0.1:${port}/favicon.ico`, (res) => {
        // Any response (even 404) means the server is listening
        res.resume();
        resolve();
      });
      req.on("error", () => {
        setTimeout(poll, 250);
      });
      req.setTimeout(2000, () => {
        req.destroy();
        setTimeout(poll, 250);
      });
    }
    poll();
  });
}

// ---------------------------------------------------------------------------
// Start the orchestrator server as a child process
// ---------------------------------------------------------------------------
async function startServer() {
  serverPort = await findFreePort();

  const env = {
    ...process.env,
    PORT: String(serverPort),
    PIPELINE_DATA_ROOT: app.getPath("userData"),
    // Disable auth for local desktop usage (the default local admin key)
    PUBLIC_MODE: "true",
  };

  serverProcess = fork(SERVER_SCRIPT, [], {
    cwd: REPO_ROOT,
    env,
    stdio: ["pipe", "pipe", "pipe", "ipc"],
    // ESM loader flag so Node can run the ESM server.js via fork
    execArgv: ["--experimental-vm-modules"],
  });

  serverProcess.stdout.on("data", (data) => {
    const msg = data.toString();
    process.stdout.write(`[server] ${msg}`);
    // Update splash status when we see the listening message
    if (splashWindow && !splashWindow.isDestroyed() && msg.includes("listening")) {
      splashWindow.webContents.send("splash:status", "Server ready, loading dashboard...");
    }
  });

  serverProcess.stderr.on("data", (data) => {
    process.stderr.write(`[server:err] ${data}`);
  });

  serverProcess.on("exit", (code, signal) => {
    if (code !== 0 && code !== null && mainWindow && !mainWindow.isDestroyed()) {
      dialog
        .showMessageBox(mainWindow, {
          type: "error",
          title: "Server Crashed",
          message: `The server process exited unexpectedly (code ${code}).`,
          buttons: ["Restart Server", "Quit"],
          defaultId: 0,
        })
        .then(({ response }) => {
          if (response === 0) {
            restartServer();
          } else {
            app.quit();
          }
        });
    }
  });

  // Wait for the server to accept connections
  await waitForServer(serverPort);
}

// ---------------------------------------------------------------------------
// Restart server after crash
// ---------------------------------------------------------------------------
async function restartServer() {
  try {
    if (splashWindow && !splashWindow.isDestroyed()) {
      splashWindow.webContents.send("splash:status", "Restarting server...");
      splashWindow.show();
    }
    await startServer();
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.loadURL(`http://127.0.0.1:${serverPort}`);
    }
  } catch (err) {
    dialog.showErrorBox("Fatal Error", `Could not restart server: ${err.message}`);
    app.quit();
  }
}

// ---------------------------------------------------------------------------
// Kill the server child process
// ---------------------------------------------------------------------------
function killServer() {
  if (serverProcess && !serverProcess.killed) {
    serverProcess.kill("SIGTERM");
    // Force-kill after a grace period
    setTimeout(() => {
      if (serverProcess && !serverProcess.killed) {
        serverProcess.kill("SIGKILL");
      }
    }, 3000);
    serverProcess = null;
  }
}

// ---------------------------------------------------------------------------
// Splash screen
// ---------------------------------------------------------------------------
function createSplashWindow() {
  splashWindow = new BrowserWindow({
    width: 480,
    height: 360,
    frame: false,
    transparent: false,
    resizable: false,
    alwaysOnTop: true,
    backgroundColor: "#0f172a",
    webPreferences: {
      preload: PRELOAD_SCRIPT,
      contextIsolation: true,
      nodeIntegration: false,
    },
  });
  splashWindow.loadFile(SPLASH_HTML);
  splashWindow.center();
}

// ---------------------------------------------------------------------------
// Main window
// ---------------------------------------------------------------------------
function createMainWindow() {
  mainWindow = new BrowserWindow({
    width: 1280,
    height: 800,
    minWidth: 900,
    minHeight: 600,
    show: false,
    frameless: false,
    titleBarStyle: process.platform === "darwin" ? "hiddenInset" : "default",
    backgroundColor: "#0f172a",
    webPreferences: {
      preload: PRELOAD_SCRIPT,
      contextIsolation: true,
      nodeIntegration: false,
    },
  });

  mainWindow.loadURL(`http://127.0.0.1:${serverPort}`);

  mainWindow.once("ready-to-show", () => {
    if (splashWindow && !splashWindow.isDestroyed()) {
      splashWindow.close();
      splashWindow = null;
    }
    mainWindow.show();
  });

  mainWindow.on("close", (e) => {
    if (minimizeToTray && tray) {
      e.preventDefault();
      mainWindow.hide();
    }
  });

  mainWindow.on("closed", () => {
    mainWindow = null;
  });
}

// ---------------------------------------------------------------------------
// Application menu
// ---------------------------------------------------------------------------
function buildMenu() {
  const template = [
    {
      label: "File",
      submenu: [
        {
          label: "Open PDF...",
          accelerator: "CmdOrCtrl+O",
          click: async () => {
            const result = await dialog.showOpenDialog(mainWindow, {
              title: "Open PDF",
              filters: [{ name: "PDF Files", extensions: ["pdf"] }],
              properties: ["openFile"],
            });
            if (!result.canceled && result.filePaths.length > 0) {
              mainWindow.webContents.send("file:opened", result.filePaths[0]);
            }
          },
        },
        { type: "separator" },
        {
          label: "Quit",
          accelerator: "CmdOrCtrl+Q",
          click: () => app.quit(),
        },
      ],
    },
    {
      label: "View",
      submenu: [
        {
          label: "Reload",
          accelerator: "CmdOrCtrl+R",
          click: () => {
            if (mainWindow) mainWindow.reload();
          },
        },
        {
          label: "Toggle Developer Tools",
          accelerator: process.platform === "darwin" ? "Alt+Cmd+I" : "Ctrl+Shift+I",
          click: () => {
            if (mainWindow) mainWindow.webContents.toggleDevTools();
          },
        },
      ],
    },
    {
      label: "Help",
      submenu: [
        {
          label: "About PDF Accessibility Engine",
          click: () => {
            dialog.showMessageBox(mainWindow, {
              type: "info",
              title: "About",
              message: "PDF Accessibility Engine",
              detail: `Version ${app.getVersion()}\nElectron ${process.versions.electron}\nNode ${process.versions.node}\nChromium ${process.versions.chrome}`,
            });
          },
        },
        {
          label: "Documentation",
          click: () => {
            shell.openExternal("https://github.com/PDFIsAbsurd/OpenAutoTag#readme");
          },
        },
      ],
    },
  ];

  // macOS app menu
  if (process.platform === "darwin") {
    template.unshift({
      label: app.getName(),
      submenu: [
        { role: "about" },
        { type: "separator" },
        { role: "hide" },
        { role: "hideOthers" },
        { role: "unhide" },
        { type: "separator" },
        { role: "quit" },
      ],
    });
  }

  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}

// ---------------------------------------------------------------------------
// System tray
// ---------------------------------------------------------------------------
function createTray() {
  // Use a simple 16x16 empty icon — replaced by real icon in production builds
  const icon = nativeImage.createEmpty();
  tray = new Tray(icon);
  tray.setToolTip("PDF Accessibility Engine");
  const contextMenu = Menu.buildFromTemplate([
    {
      label: "Show Window",
      click: () => {
        if (mainWindow) {
          mainWindow.show();
          mainWindow.focus();
        }
      },
    },
    {
      label: "Minimize to Tray on Close",
      type: "checkbox",
      checked: minimizeToTray,
      click: (item) => {
        minimizeToTray = item.checked;
      },
    },
    { type: "separator" },
    {
      label: "Quit",
      click: () => app.quit(),
    },
  ]);
  tray.setContextMenu(contextMenu);
  tray.on("double-click", () => {
    if (mainWindow) {
      mainWindow.show();
      mainWindow.focus();
    }
  });
}

// ---------------------------------------------------------------------------
// IPC handlers
// ---------------------------------------------------------------------------
function registerIpcHandlers() {
  ipcMain.handle("get-server-port", () => serverPort);

  ipcMain.handle("get-app-version", () => app.getVersion());

  ipcMain.handle("open-file-dialog", async () => {
    const result = await dialog.showOpenDialog(mainWindow, {
      title: "Select a PDF",
      filters: [{ name: "PDF Files", extensions: ["pdf"] }],
      properties: ["openFile"],
    });
    if (result.canceled) return null;
    return result.filePaths[0];
  });

  ipcMain.handle("show-save-dialog", async (_event, defaultName) => {
    const result = await dialog.showSaveDialog(mainWindow, {
      title: "Save File",
      defaultPath: defaultName || "output.pdf",
      filters: [
        { name: "PDF Files", extensions: ["pdf"] },
        { name: "All Files", extensions: ["*"] },
      ],
    });
    if (result.canceled) return null;
    return result.filePath;
  });

  ipcMain.handle("reveal-in-explorer", (_event, filePath) => {
    shell.showItemInFolder(filePath);
  });
}

// ---------------------------------------------------------------------------
// App lifecycle
// ---------------------------------------------------------------------------
app.whenReady().then(async () => {
  registerIpcHandlers();
  buildMenu();
  createTray();
  createSplashWindow();

  try {
    if (splashWindow && !splashWindow.isDestroyed()) {
      splashWindow.webContents.send("splash:status", "Starting server...");
    }
    await startServer();
    createMainWindow();
  } catch (err) {
    if (splashWindow && !splashWindow.isDestroyed()) {
      splashWindow.close();
    }
    dialog.showErrorBox(
      "Startup Error",
      `Could not start the server:\n${err.message}\n\nPlease ensure Node.js and all dependencies are installed.`
    );
    app.quit();
  }
});

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") {
    app.quit();
  }
});

app.on("activate", () => {
  // macOS: re-create window when dock icon is clicked
  if (mainWindow === null && serverPort) {
    createMainWindow();
  }
});

app.on("before-quit", () => {
  // Ensure tray-minimize doesn't prevent quit
  minimizeToTray = false;
});

app.on("will-quit", () => {
  killServer();
  if (tray) {
    tray.destroy();
    tray = null;
  }
});
