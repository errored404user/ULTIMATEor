// SPDX-License-Identifier: GPL-3.0-or-later
// ORscript Desktop - Electron shell.
//
// The bridge (bridge/server.js) runs inside this main process. The window is
// just a view on it: closing the window hides it to the tray and the bridge,
// the Studio MCP helper and every extension socket keep running. Quit only
// from the tray menu (or when "close to tray" is disabled in Settings).
"use strict";

const path = require("path");
const { app, BrowserWindow, Tray, Menu, nativeImage, ipcMain, dialog, shell, Notification, nativeTheme } = require("electron");

const { Bridge } = require("../bridge/server");
const { Settings } = require("../bridge/settings");
const { Logger } = require("../bridge/log");

const PKG = require("../package.json");
const ASSETS = path.join(__dirname, "..", "assets");
const ARGS = new Set(process.argv.slice(1));
const START_HIDDEN_FLAG = ARGS.has("--hidden") || ARGS.has("--background");

let bridge = null;
let settings = null;
let log = null;
let win = null;
let tray = null;
let quitting = false;
let lastTrayState = "";

// One running copy only: a second launch just shows the existing window.
if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on("second-instance", () => showWindow());
  app.setAppUserModelId("dev.orscript.desktop");
  app.whenReady().then(boot).catch((err) => {
    dialog.showErrorBox("ORscript Desktop failed to start", String(err && err.stack || err));
    app.exit(1);
  });
}

async function boot() {
  const dataDir = path.join(app.getPath("userData"));
  settings = new Settings({ dir: dataDir });
  log = new Logger({ dir: path.join(dataDir, "logs"), level: settings.get("logLevel"), echo: !app.isPackaged });
  bridge = new Bridge({ settings, log, dataDir, version: PKG.version });

  bridge.on("snapshot", (snap) => updateTray(snap));
  bridge.on("settings", (s) => applyShellSettings(s));
  bridge.studio.on("studio", (attached) => {
    notify(attached ? "Roblox Studio connected" : "Roblox Studio disconnected", attached ? "ORscript is linked to your open place." : "The bridge keeps waiting in the background.");
  });

  createTray();
  await bridge.start();
  applyShellSettings(settings.all());

  const hidden = START_HIDDEN_FLAG || settings.get("startHidden");
  createWindow(!hidden);
  if (hidden) notify("ORscript Desktop is running", "Bridge ready on 127.0.0.1:3000 - open it from the tray icon.");
}

// ── window ──────────────────────────────────────────────────────────────────

function createWindow(show = true) {
  if (win) { if (show) showWindow(); return win; }
  win = new BrowserWindow({
    width: 1240,
    height: 800,
    minWidth: 920,
    minHeight: 600,
    show: false,
    frame: false,
    titleBarStyle: process.platform === "darwin" ? "hiddenInset" : "hidden",
    backgroundColor: "#0c0b09",
    icon: path.join(ASSETS, process.platform === "win32" ? "icon.ico" : "icon.png"),
    autoHideMenuBar: true,
    webPreferences: {
      preload: path.join(__dirname, "preload.js"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      spellcheck: false,
    },
  });
  win.setMenuBarVisibility(false);
  win.loadURL(`http://${bridge.host}:${bridge.ports.http}/app/`).catch(() => {});
  win.webContents.on("did-fail-load", () => {
    // Bridge port not bound yet (or conflict) - retry until it is.
    setTimeout(() => { if (win && !win.isDestroyed()) win.loadURL(`http://${bridge.host}:${bridge.ports.http}/app/`).catch(() => {}); }, 1500);
  });
  win.webContents.setWindowOpenHandler(({ url }) => { shell.openExternal(url); return { action: "deny" }; });
  win.once("ready-to-show", () => { if (show) win.show(); });
  win.on("close", (e) => {
    if (quitting || !settings.get("closeToTray")) return;
    e.preventDefault();
    win.hide();
    if (process.platform === "darwin") app.dock && app.dock.hide();
    firstHideHint();
  });
  win.on("closed", () => { win = null; });
  win.on("maximize", () => sendWindowState());
  win.on("unmaximize", () => sendWindowState());
  return win;
}

function showWindow() {
  if (!win) createWindow(true);
  if (win.isMinimized()) win.restore();
  if (!win.isVisible()) win.show();
  win.focus();
  if (process.platform === "darwin") app.dock && app.dock.show();
}

function sendWindowState() {
  if (win && !win.isDestroyed()) win.webContents.send("window-state", { maximized: win.isMaximized() });
}

let hinted = false;
function firstHideHint() {
  if (hinted) return;
  hinted = true;
  notify("ORscript keeps running", "The bridge and Studio link stay active in the tray. Right-click the tray icon to quit.");
}

// ── tray ────────────────────────────────────────────────────────────────────

function trayImage() {
  const file = process.platform === "win32" ? "icon.ico" : "tray.png";
  let img = nativeImage.createFromPath(path.join(ASSETS, file));
  if (process.platform === "darwin") img = nativeImage.createFromPath(path.join(ASSETS, "tray-16.png"));
  return img;
}

function createTray() {
  tray = new Tray(trayImage());
  tray.setToolTip("ORscript Desktop - bridge starting");
  tray.on("click", () => showWindow());
  tray.on("double-click", () => showWindow());
  rebuildTrayMenu(null);
}

function rebuildTrayMenu(snap) {
  const studio = snap ? snap.studio : null;
  const bridgeOk = snap ? snap.bound.http && snap.bound.roblox && snap.bound.local : false;
  const menu = Menu.buildFromTemplate([
    { label: `ORscript Desktop v${PKG.version}`, enabled: false },
    { label: bridgeOk ? `Bridge listening 127.0.0.1:${snap.ports.http}` : "Bridge: port conflict", enabled: false },
    { label: studio ? (studio.studio ? "Studio: connected" : studio.studio_proc ? "Studio: open, not attached" : "Studio: closed") : "Studio: …", enabled: false },
    { type: "separator" },
    { label: "Open ORscript", click: () => showWindow() },
    { label: "Open workspace folder", click: () => shell.openPath(bridge.workspace.root) },
    { label: "Restart Studio MCP", click: () => bridge.studio.restart().catch(() => {}) },
    { label: "Kill Roblox Studio", click: () => bridge.studio.killStudio().catch(() => {}) },
    { type: "separator" },
    { label: "Launch at sign-in", type: "checkbox", checked: !!settings.get("launchAtLogin"), click: (item) => settings.update({ launchAtLogin: item.checked }) },
    { label: "Close window to tray", type: "checkbox", checked: !!settings.get("closeToTray"), click: (item) => settings.update({ closeToTray: item.checked }) },
    { type: "separator" },
    { label: "Quit ORscript (stops the bridge)", click: () => quitApp() },
  ]);
  tray.setContextMenu(menu);
}

function updateTray(snap) {
  if (!tray) return;
  const s = snap.studio;
  const linked = snap.bridge.linked;
  const tip = `ORscript Desktop v${snap.version}\nBridge ${snap.bound.http ? (linked ? "linked" : "waiting") : "PORT BUSY"} 127.0.0.1:${snap.ports.http}\nStudio ${s.studio ? "connected" : s.studio_proc ? "open" : "closed"} · ${snap.tools.total} tools`;
  tray.setToolTip(tip);
  const key = `${snap.bound.http}|${linked}|${s.studio}|${s.studio_proc}|${snap.tools.total}|${settings.get("launchAtLogin")}|${settings.get("closeToTray")}`;
  if (key !== lastTrayState) { lastTrayState = key; rebuildTrayMenu(snap); }
}

// ── shell settings ──────────────────────────────────────────────────────────

function applyShellSettings(s) {
  try {
    app.setLoginItemSettings({ openAtLogin: !!s.launchAtLogin, args: ["--hidden"], name: "ORscript Desktop" });
  } catch (err) {
    log && log.warn("shell", `login item: ${err.message}`);
  }
  nativeTheme.themeSource = "dark";
}

function notify(title, body) {
  try {
    if (!Notification.isSupported()) return;
    new Notification({ title, body, icon: path.join(ASSETS, "icon.png"), silent: true }).show();
  } catch { /* ignore */ }
}

async function quitApp() {
  if (quitting) return;
  quitting = true;
  try { tray && tray.destroy(); } catch { /* ignore */ }
  try { if (bridge) await bridge.stop(); } catch { /* ignore */ }
  app.quit();
}

// ── IPC (preload bridge) ────────────────────────────────────────────────────

ipcMain.handle("win:minimize", () => { win && win.minimize(); });
ipcMain.handle("win:toggle-maximize", () => { if (!win) return; if (win.isMaximized()) win.unmaximize(); else win.maximize(); return win.isMaximized(); });
ipcMain.handle("win:close", () => { win && win.close(); });
ipcMain.handle("win:is-maximized", () => !!(win && win.isMaximized()));
ipcMain.handle("app:quit", () => quitApp());
ipcMain.handle("app:info", () => ({ version: PKG.version, platform: process.platform, electron: process.versions.electron, node: process.versions.node, packaged: app.isPackaged, dataDir: app.getPath("userData") }));
ipcMain.handle("app:pick-folder", async () => {
  const r = await dialog.showOpenDialog(win, { title: "Choose the ORscript workspace folder", properties: ["openDirectory", "createDirectory"], defaultPath: bridge ? bridge.workspace.root : undefined });
  return r.canceled || !r.filePaths.length ? null : r.filePaths[0];
});
ipcMain.handle("app:open-external", (_e, url) => { if (/^https?:\/\//i.test(String(url))) shell.openExternal(String(url)); });
ipcMain.handle("app:settings-changed", (_e, s) => { if (s) applyShellSettings(s); });
ipcMain.handle("app:set-theme", (_e, theme) => { if (win && !win.isDestroyed()) win.setBackgroundColor(theme === "emerald" ? "#080c0a" : theme === "graphite" ? "#0b0c0e" : "#0c0b09"); });

// ── app lifecycle ───────────────────────────────────────────────────────────

app.on("window-all-closed", () => {
  // Keep running in the tray. Only an explicit quit (tray menu / closeToTray off) stops the bridge.
  if (!settings || !settings.get("closeToTray")) quitApp();
});
app.on("activate", () => showWindow());
app.on("before-quit", () => { quitting = true; });
process.on("uncaughtException", (err) => { log ? log.error("shell", `uncaught: ${err.stack || err.message}`) : console.error(err); });
process.on("unhandledRejection", (err) => { log ? log.error("shell", `unhandled rejection: ${(err && err.stack) || err}`) : console.error(err); });
