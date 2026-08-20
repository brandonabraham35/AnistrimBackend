// Desktop/preload.js — Electron preload (contextIsolation:true).
// Exposes ONLY a narrow window.anistrim bridge to the renderer.

'use strict';

const { contextBridge, ipcRenderer } = require('electron');

// Narrow API surface — never expose raw ipcRenderer/shell/node modules.
contextBridge.exposeInMainWorld('anistrim', {
  // Version info
  platform: process.platform,
  versions: {
    electron: process.versions.electron,
    chrome: process.versions.chrome,
    node: process.versions.node,
  },

  // Navigation (from menu)
  onNavigate: (callback) => {
    const listener = (_event, path) => callback(path);
    ipcRenderer.on('navigate', listener);
    return () => ipcRenderer.removeListener('navigate', listener);
  },

  // Media control events (menu bar / global media keys)
  onMediaCommand: (callback) => {
    const listeners = [
      'media-play-pause',
      'media-mute',
      'media-skip-intro',
      'media-next-episode',
      'media-previous-episode',
    ];
    const handler = (channel) => (event) => callback(channel.replace('media-', ''));
    const wrapped = listeners.map((ch) => {
      const fn = handler(ch);
      ipcRenderer.on(ch, fn);
      return { channel: ch, fn };
    });
    return () => wrapped.forEach(({ channel, fn }) => ipcRenderer.removeListener(channel, fn));
  },

  // Window controls
  minimize: () => ipcRenderer.send('window-minimize'),
  maximize: () => ipcRenderer.send('window-maximize'),
  close: () => ipcRenderer.send('window-close'),
});