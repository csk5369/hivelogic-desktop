/**
 * HiveLogic Desktop — preload.
 * Shows the offline banner and the "update ready" pill inside the web app.
 */
const { contextBridge, ipcRenderer } = require('electron');
const { createPreloadSpeechBridge } = require('./preload-speech');

const speechBridge = createPreloadSpeechBridge({
  invoke: (channel, ...args) => ipcRenderer.invoke(channel, ...args),
  armSynchronously: (token) => ipcRenderer.sendSync('hl-native-speech-arm', token),
  randomValues: (bytes) => globalThis.crypto.getRandomValues(bytes),
});

window.addEventListener('click', speechBridge.armFromClick, true);

contextBridge.exposeInMainWorld('hivelogicDesktop', {
  version: () => ipcRenderer.invoke('hl-get-version'),
  cacheStats: () => ipcRenderer.invoke('hl-cache-stats'),
  recognizeOnce: speechBridge.recognizeOnce,
  cancelRecognition: speechBridge.cancelRecognition,
  isDesktop: true,
});

function el(tag, css, text) {
  const n = document.createElement(tag);
  n.style.cssText = css;
  if (text) n.textContent = text;
  return n;
}

/* ---------------- Offline banner ---------------- */
let banner = null;
function showBanner(show) {
  if (show && !banner) {
    banner = el(
      'div',
      [
        'position:fixed;top:0;left:0;right:0;z-index:2147483647',
        'background:#8a5a00;color:#fff',
        'font:600 13px/1 -apple-system,Segoe UI,Roboto,sans-serif',
        'padding:8px 14px;text-align:center;letter-spacing:.02em',
        'box-shadow:0 2px 8px rgba(0,0,0,.35)',
      ].join(';'),
      "You're offline — showing last-synced data. Changes are disabled until you reconnect."
    );
    document.documentElement.appendChild(banner);
  } else if (!show && banner) {
    banner.remove();
    banner = null;
  }
}

ipcRenderer.on('hl-offline-state', (_e, offline) => showBanner(offline));
window.addEventListener('offline', () => showBanner(true));
window.addEventListener('online', () => showBanner(false));

/* ---------------- Update-ready pill ---------------- */
ipcRenderer.on('hl-update-ready', (_e, version) => {
  if (document.getElementById('hl-update-pill')) return;
  const pill = el(
    'button',
    [
      'position:fixed;bottom:18px;right:18px;z-index:2147483647',
      'background:#28508C;color:#fff;border:0;border-radius:999px',
      'font:600 13px -apple-system,Segoe UI,Roboto,sans-serif',
      'padding:10px 18px;cursor:pointer;box-shadow:0 4px 14px rgba(0,0,0,.4)',
    ].join(';'),
    `Update ${version} ready — restart to install`
  );
  pill.id = 'hl-update-pill';
  pill.onclick = () => ipcRenderer.invoke('hl-restart-to-update');
  const attach = () => document.body && document.body.appendChild(pill);
  document.body ? attach() : window.addEventListener('DOMContentLoaded', attach);
});
