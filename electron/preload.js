'use strict';
// The only bridge between the panel page and Electron: window chrome, the
// attention flash and connections (settings edits run in the main process).
// The page itself talks to the local server over HTTP/SSE.

const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('cockpit', {
  close: () => ipcRenderer.send('cockpit:close'),
  minimize: () => ipcRenderer.send('cockpit:minimize'),
  isPinned: () => ipcRenderer.invoke('cockpit:pinned'),
  setPinned: (on) => ipcRenderer.invoke('cockpit:pin', Boolean(on)),
  attention: (on) => ipcRenderer.send('cockpit:attention', Boolean(on)),
  setupStatus: () => ipcRenderer.invoke('cockpit:setup-status'),
  setupApply: (action, parts) => ipcRenderer.invoke('cockpit:setup-apply', String(action), Array.isArray(parts) ? parts.map(String) : []),
});
