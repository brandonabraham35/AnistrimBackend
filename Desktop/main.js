// Desktop/main.js — Electron main process (CommonJS).
// Security: contextIsolation:true, nodeIntegration:false, strict CSP.
// Renderer talks to the same API base (ANISTRIM_API_BASE) with X-Client: desktop.
// Electron file:// pages send no Origin header, so CORS already permits them.

'use strict';

const { app, BrowserWindow, shell, Menu, ipcMain, globalShortcut } = require('electron');
const path = require('path');

// ── Auto-update stub ────────────────────────────────────────
// Replace with electron-updater in production once a release feed is set up.
let autoUpdater = null;
try {
  // eslint-disable-next-line global-require
  const { autoUpdater: updater } = require('electron-updater');
  updater.autoDownload = false;
  autoUpdater = updater;
} catch (e) {
  // electron-updater not installed — stub it.
}

// ── Crash reporting hook (basic) ────────────────────────────
process.on('uncaughtException', (err) => {
  console.error('[AniStrim Desktop] Uncaught exception:', err);
  // In production, send to a crash reporting endpoint here.
});

process.on('unhandledRejection', (reason) => {
  console.error('[AniStrim Desktop] Unhandled rejection:', reason);
});

// ── Remember window bounds ──────────────────────────────────
const windowState = (() => {
  try {
    const fs = require('fs');
    const stateFile = path.join(app.getPath('userData'), 'window-state.json');
    if (fs.existsSync(stateFile)) {
      return JSON.parse(fs.readFileSync(stateFile, 'utf8'));
    }
  } catch (e) { /* ignore */ }
  return null;
})();

function saveWindowState(win) {
  try {
    const fs = require('fs');
    const stateFile = path.join(app.getPath('userData'), 'window-state.json');
    const bounds = win.getBounds();
    fs.writeFileSync(stateFile, JSON.stringify({ ...bounds, isMaximized: win.isMaximized() }));
  } catch (e) { /* ignore */ }
}

// ── Create the main window ──────────────────────────────────
let mainWindow = null;

function createWindow() {
  const winOptions = {
    width: windowState?.width || 1280,
    height: windowState?.height || 800,
    x: windowState?.x,
    y: windowState?.y,
    minWidth: 900,
    minHeight: 600,
    backgroundColor: '#0a0a0f',
    title: 'AniStrim',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      webSecurity: true,
    },
  };
  mainWindow = new BrowserWindow(winOptions);
  if (windowState?.isMaximized) mainWindow.maximize();

  // Strict CSP — the renderer never loads remote scripts.
  mainWindow.webContents.session.webRequest.onHeadersReceived((details, callback) => {
    const csp = [
      'default-src \'self\'',
      'script-src \'self\' \'wasm-unsafe-eval\'',
      'style-src \'self\' \'unsafe-inline\'',
      'img-src \'self\' data: blob: https: http:',
      'media-src \'self\' blob: https: http:',
      'connect-src \'self\' https: http:',
      'font-src \'self\' data:',
      'frame-src \'self\'',
    ].join('; ');
    callback({
      responseHeaders: {
        ...details.responseHeaders,
        'Content-Security-Policy': [csp],
      },
    });
  });

  mainWindow.loadFile(path.join(__dirname, 'index.html'));

  // Open external links in the system browser, never in the app shell.
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    shell.openExternal(url);
    return { action: 'deny' };
  });

  mainWindow.on('close', () => saveWindowState(mainWindow));
  mainWindow.on('closed', () => { mainWindow = null; });
}

// ── Application menu ────────────────────────────────────────
function buildMenu() {
  const template = [
    ...(process.platform === 'darwin' ? [{
      label: app.name,
      submenu: [
        { role: 'about' },
        { type: 'separator' },
        { role: 'services' },
        { type: 'separator' },
        { role: 'hide' },
        { role: 'hideOthers' },
        { role: 'unhide' },
        { type: 'separator' },
        { role: 'quit' },
      ],
    }] : []),
    {
      label: 'File',
      submenu: [
        { label: 'Home', accelerator: 'CmdOrCtrl+H', click: () => mainWindow?.webContents.send('navigate', '/') },
        { type: 'separator' },
        process.platform === 'darwin' ? { role: 'close' } : { role: 'quit' },
      ],
    },
    {
      label: 'View',
      submenu: [
        { role: 'reload' },
        { role: 'forceReload' },
        { role: 'toggleDevTools' },
        { type: 'separator' },
        { role: 'resetZoom' },
        { role: 'zoomIn' },
        { role: 'zoomOut' },
        { type: 'separator' },
        { role: 'togglefullscreen' },
      ],
    },
    {
      label: 'Playback',
      submenu: [
        { label: 'Play/Pause', accelerator: 'Space', click: () => mainWindow?.webContents.send('media-play-pause') },
        { label: 'Mute', accelerator: 'CmdOrCtrl+M', click: () => mainWindow?.webContents.send('media-mute') },
        { type: 'separator' },
        { label: 'Skip Intro', accelerator: 'CmdOrCtrl+Shift+Right', click: () => mainWindow?.webContents.send('media-skip-intro') },
        { label: 'Next Episode', accelerator: 'CmdOrCtrl+Shift+Down', click: () => mainWindow?.webContents.send('media-next-episode') },
      ],
    },
    {
      label: 'Window',
      submenu: [
        { role: 'minimize' },
        { role: 'zoom' },
        ...(process.platform === 'darwin' ? [{ role: 'front' }] : []),
      ],
    },
    {
      role: 'help',
      submenu: [
        { label: 'Report an issue', click: () => shell.openExternal('https://github.com/brandonabraham35/AnistrimBackend/issues') },
      ],
    },
  ];
  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}

// ── Global media keys ───────────────────────────────────────
function registerMediaKeys() {
  globalShortcut.register('MediaPlayPause', () => mainWindow?.webContents.send('media-play-pause'));
  globalShortcut.register('MediaNextTrack', () => mainWindow?.webContents.send('media-next-episode'));
  globalShortcut.register('MediaPreviousTrack', () => mainWindow?.webContents.send('media-previous-episode'));
}

// ── Window control IPC (renderer bridge) ────────────────────
// preload.js exposes window.anistrim.{minimize,maximize,close} which send
// these channels; without handlers the bridge was dead. Each handler acts on
// the window that sent the event (BrowserWindow.fromWebContents) so it stays
// correct even with multiple windows. Close goes through win.close() so the
// existing 'close' hook still persists window bounds.
ipcMain.on('window-minimize', (event) => {
  const win = BrowserWindow.fromWebContents(event.sender);
  if (win) win.minimize();
});

ipcMain.on('window-maximize', (event) => {
  const win = BrowserWindow.fromWebContents(event.sender);
  if (!win) return;
  // Toggle so the single channel provides both maximize and restore.
  if (win.isMaximized()) win.unmaximize();
  else win.maximize();
});

ipcMain.on('window-close', (event) => {
  const win = BrowserWindow.fromWebContents(event.sender);
  if (win) win.close();
});

// ── App lifecycle ───────────────────────────────────────────
app.whenReady().then(() => {
  buildMenu();
  createWindow();
  registerMediaKeys();

  if (autoUpdater) {
    autoUpdater.checkForUpdatesAndNotify().catch(() => {});
  }

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});

app.on('will-quit', () => {
  globalShortcut.unregisterAll();
});