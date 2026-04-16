// desktop/preload.js — Context bridge for renderer process
const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("electronAPI", {
  /** Returns the port the orchestrator server is listening on. */
  getServerPort: () => ipcRenderer.invoke("get-server-port"),

  /** Returns the app version string from package.json. */
  getAppVersion: () => ipcRenderer.invoke("get-app-version"),

  /** Opens a native file-picker dialog filtered to PDF files. Returns the selected path or null. */
  openFileDialog: () => ipcRenderer.invoke("open-file-dialog"),

  /** Opens a native save dialog. Returns the chosen path or null. */
  showSaveDialog: (defaultName) => ipcRenderer.invoke("show-save-dialog", defaultName),

  /** Reveals the given file path in the OS file explorer. */
  revealInExplorer: (filePath) => ipcRenderer.invoke("reveal-in-explorer", filePath),

  /** Subscribe to files opened via the File menu. */
  onFileOpened: (callback) => {
    ipcRenderer.on("file:opened", (_event, filePath) => callback(filePath));
  },

  /** Subscribe to splash status updates. */
  onSplashStatus: (callback) => {
    ipcRenderer.on("splash:status", (_event, message) => callback(message));
  },
});
