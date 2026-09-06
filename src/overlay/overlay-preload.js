'use strict';

/**
 * Preload for the transparent full-screen drawing sheets.
 *
 * Deliberately smaller than the toolbar's bridge (toolbar-preload.js). This
 * page's whole job is to paint marks and say when it made one; it has no
 * business being able to stop the session, change the colour or clear the
 * other monitors. The main process checks sender identity on every one of
 * these channels anyway (screen-annotate.js's ownsSender), so this split is
 * the second lock, not the only one.
 */
const { contextBridge, ipcRenderer } = require('electron');

function subscribe(channel, handler) {
  if (typeof handler !== 'function') return () => {};
  const listener = (_event, payload) => handler(payload);
  ipcRenderer.on(channel, listener);
  return () => ipcRenderer.removeListener(channel, listener);
}

contextBridge.exposeInMainWorld('hlOverlay', {
  // "I just finished a mark." The main process keeps the cross-monitor order
  // so Undo removes the last mark wherever on the desk it was drawn.
  strokeAdded: () => ipcRenderer.send('hl-overlay-stroke'),
  // The escape hatch that lives on this window: Escape closes the whole thing.
  panicStop: () => ipcRenderer.send('hl-overlay-panic'),
  onState: (handler) => subscribe('hl-overlay-state', handler),
  onColor: (handler) => subscribe('hl-overlay-color', handler),
  onUndo: (handler) => subscribe('hl-overlay-undo', handler),
  onClear: (handler) => subscribe('hl-overlay-clear', handler),
});
