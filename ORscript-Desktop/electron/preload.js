// SPDX-License-Identifier: GPL-3.0-or-later
// Exposes a tiny, explicit API to the UI (contextIsolation on, sandbox on).
"use strict";

const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("orscript", {
  isDesktop: true,
  minimize: () => ipcRenderer.invoke("win:minimize"),
  toggleMaximize: () => ipcRenderer.invoke("win:toggle-maximize"),
  close: () => ipcRenderer.invoke("win:close"),
  isMaximized: () => ipcRenderer.invoke("win:is-maximized"),
  quit: () => ipcRenderer.invoke("app:quit"),
  info: () => ipcRenderer.invoke("app:info"),
  pickFolder: () => ipcRenderer.invoke("app:pick-folder"),
  openExternal: (url) => ipcRenderer.invoke("app:open-external", String(url)),
  settingsChanged: (settings) => ipcRenderer.invoke("app:settings-changed", settings),
  setTheme: (theme) => ipcRenderer.invoke("app:set-theme", String(theme)),
  onWindowState: (cb) => {
    const handler = (_e, state) => cb(state);
    ipcRenderer.on("window-state", handler);
    return () => ipcRenderer.removeListener("window-state", handler);
  },
});
