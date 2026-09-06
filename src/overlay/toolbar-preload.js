'use strict';

/**
 * Preload for the little floating control bar.
 *
 * This is the window with the buttons, so it is the one allowed to command the
 * session. Every channel here is verified in the main process against the set
 * of windows this app created (screen-annotate.js's ownsSender) — the web page
 * inside the main HiveLogic window can only reach start/stop, and only over
 * its own separately-guarded channels.
 */
const { contextBridge, ipcRenderer } = require('electron');

function subscribe(channel, handler) {
  if (typeof handler !== 'function') return () => {};
  const listener = (_event, payload) => handler(payload);
  ipcRenderer.on(channel, listener);
  return () => ipcRenderer.removeListener(channel, listener);
}

contextBridge.exposeInMainWorld('hlToolbar', {
  setDrawing: (on) => ipcRenderer.send('hl-overlay-set-drawing', on === true),
  setColor: (value) => ipcRenderer.send('hl-overlay-set-color', String(value || '')),
  undo: () => ipcRenderer.send('hl-overlay-undo-request'),
  clear: () => ipcRenderer.send('hl-overlay-clear-request'),
  stop: () => ipcRenderer.send('hl-overlay-panic'),
  onState: (handler) => subscribe('hl-overlay-state', handler),
});
