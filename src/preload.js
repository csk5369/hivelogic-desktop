/**
 * HiveLogic Desktop — preload.
 * Shows the offline banner and the "update ready" pill inside the web app.
 */
const { contextBridge, ipcRenderer } = require('electron');

// Electron sandboxed preloads may only import Electron and a small set of
// built-ins. Keep this bridge self-contained so a local require cannot prevent
// the entire desktop API from being exposed.
const VOICE_START_SELECTOR = 'button.reina-pilot-voice-start';
const WAKE_WORD_START_SELECTOR = 'button#rnaVoiceToggle';
const MAX_TRANSCRIPT_CHARS = 1000;
const SPEECH_FAILURE_CODES = new Set([
  'no_speech',
  'os_microphone_denied',
  'permission_denied',
  'unavailable',
  'timeout',
  'canceled',
  'recognition_error',
]);

function ownData(object, key) {
  if (!object || typeof object !== 'object') return undefined;
  let descriptor;
  try {
    descriptor = Object.getOwnPropertyDescriptor(object, key);
  } catch (_) {
    return undefined;
  }
  return descriptor && Object.prototype.hasOwnProperty.call(descriptor, 'value')
    ? descriptor.value
    : undefined;
}

function hasExactOwnKeys(object, expected) {
  if (!object || typeof object !== 'object') return false;
  try {
    const prototype = Object.getPrototypeOf(object);
    if (prototype !== Object.prototype && prototype !== null) return false;
    const keys = Reflect.ownKeys(object);
    return (
      keys.length === expected.length &&
      expected.every((key) => keys.includes(key))
    );
  } catch (_) {
    return false;
  }
}

function normalizeRecognitionResult(value) {
  const ok = ownData(value, 'ok');
  if (ok === true && hasExactOwnKeys(value, ['ok', 'transcript'])) {
    const transcript = ownData(value, 'transcript');
    if (
      typeof transcript === 'string' &&
      transcript.length > 0 &&
      transcript.length <= MAX_TRANSCRIPT_CHARS &&
      transcript === transcript.trim() &&
      !/[\u0000-\u001f\u007f-\u009f]/.test(transcript)
    ) {
      return { ok: true, transcript };
    }
  }
  if (ok === false && hasExactOwnKeys(value, ['ok', 'code'])) {
    const code = ownData(value, 'code');
    if (SPEECH_FAILURE_CODES.has(code)) return { ok: false, code };
  }
  return { ok: false, code: 'recognition_error' };
}

function normalizeCancelResult(value) {
  if (!hasExactOwnKeys(value, ['ok'])) return { ok: false };
  return ownData(value, 'ok') === true ? { ok: true } : { ok: false };
}

function createSpeechToken() {
  const bytes = new Uint8Array(16);
  window.crypto.getRandomValues(bytes);
  return Array.from(bytes, (value) => value.toString(16).padStart(2, '0')).join('');
}

function createPreloadSpeechBridge() {
  let pendingToken = null;

  function armFromClick(event) {
    pendingToken = null;
    try {
      if (!event || event.isTrusted !== true || event.button !== 0) return false;
      const target = event.target;
      const button = target && target.closest(VOICE_START_SELECTOR);
      if (!button || button.disabled === true || button.isConnected !== true) {
        return false;
      }
      const token = createSpeechToken();
      if (ipcRenderer.sendSync('hl-native-speech-arm', token) !== true) return false;
      pendingToken = token;
      return true;
    } catch (_) {
      pendingToken = null;
      return false;
    }
  }

  async function recognizeOnce() {
    const token = pendingToken;
    pendingToken = null;
    if (!token) return { ok: false, code: 'permission_denied' };
    try {
      return normalizeRecognitionResult(
        await ipcRenderer.invoke('hl-native-speech-recognize-once', token)
      );
    } catch (_) {
      return { ok: false, code: 'recognition_error' };
    }
  }

  async function cancelRecognition() {
    // FIX (voice regression): a cancel targets only the ACTIVE native
    // recognition. It must NEVER clear a freshly click-armed token —
    // otherwise a stale/defensive cancel racing a new Enable Voice click
    // wipes the token before recognizeOnce() runs and reports a false
    // "permission denied". The token is already single-use with a 2s TTL
    // enforced in the main process, so not clearing it here loses nothing.
    try {
      return normalizeCancelResult(
        await ipcRenderer.invoke('hl-native-speech-cancel')
      );
    } catch (_) {
      return { ok: false };
    }
  }

  return Object.freeze({ armFromClick, recognizeOnce, cancelRecognition });
}

const speechBridge = createPreloadSpeechBridge();

function enableWakeWordFromClick(event) {
  try {
    if (!event || event.isTrusted !== true || event.button !== 0) return false;
    const button = event.target && event.target.closest(WAKE_WORD_START_SELECTOR);
    if (!button || button.disabled === true || button.isConnected !== true) return false;
    const token = createSpeechToken();
    if (ipcRenderer.sendSync('hl-native-speech-arm', token) !== true) return false;
    return ipcRenderer.sendSync('hl-native-wake-enable', token) === true;
  } catch (_) {
    return false;
  }
}

window.addEventListener('click', (event) => {
  speechBridge.armFromClick(event);
  enableWakeWordFromClick(event);
}, true);

contextBridge.exposeInMainWorld('hivelogicDesktop', {
  version: () => ipcRenderer.invoke('hl-get-version'),
  cacheStats: () => ipcRenderer.invoke('hl-cache-stats'),
  recognizeOnce: speechBridge.recognizeOnce,
  cancelRecognition: speechBridge.cancelRecognition,
  startWakeWord: () => ipcRenderer.invoke('hl-native-wake-listen'),
  resumeWakeWord: async () => {
    try {
      const result = await ipcRenderer.invoke('hl-native-wake-resume');
      return result && result.ok === true && result.enabled === true;
    } catch (_) {
      return false;
    }
  },
  stopWakeWord: () => ipcRenderer.invoke('hl-native-wake-disable'),
  onWakeDetected: (handler) => {
    if (typeof handler !== 'function') return () => {};
    const listener = () => handler();
    ipcRenderer.on('hl-native-wake-detected', listener);
    return () => ipcRenderer.removeListener('hl-native-wake-detected', listener);
  },
  onWakeResult: (handler) => {
    if (typeof handler !== 'function') return () => {};
    const listener = (_event, result) => handler(normalizeRecognitionResult(result));
    ipcRenderer.on('hl-native-wake-result', listener);
    return () => ipcRenderer.removeListener('hl-native-wake-result', listener);
  },
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
