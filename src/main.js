/**
 * HiveLogic Desktop — main process.
 * - Wraps hivelogic-live.vercel.app in a native window
 * - Offline read cache: last-synced data still shows with no internet
 * - Auto-update via GitHub Releases (electron-updater)
 */
const {
  app,
  BrowserWindow,
  Menu,
  net,
  session,
  shell,
  ipcMain,
} = require('electron');
const path = require('path');
const fs = require('fs');
const { OfflineCache, MAX_BODY_BYTES } = require('./cache');
const {
  TRUSTED_APP_ORIGIN,
  installAudioPermissionPolicy,
  isTrustedIpcSender,
} = require('./permissions');
const { createNativeSpeechService } = require('./native-speech');
const { createSpeechAuthorization } = require('./speech-authorization');

// HL_APP_URL / HL_SIMULATE_OFFLINE / HL_DEBUG are dev-only overrides.
const APP_URL = process.env.HL_APP_URL || 'https://hivelogic-live.vercel.app/';
const APP_HOST = new URL(APP_URL).hostname;
const SIMULATE_OFFLINE = process.env.HL_SIMULATE_OFFLINE === '1';
const DEBUG = process.env.HL_DEBUG === '1';

// Hosts whose GET responses are cached for offline use.
function isCacheableHost(hostname) {
  return (
    hostname === APP_HOST ||
    hostname.endsWith('.supabase.co') ||
    hostname.endsWith('.supabase.in')
  );
}

let mainWindow = null;
let cache = null;
let lastServedFromCache = false;
const nativeSpeech = createNativeSpeechService();
const speechAuthorization = createSpeechAuthorization();

function trustedMainSender(event) {
  try {
    return Boolean(
      mainWindow &&
      !mainWindow.isDestroyed() &&
      event.sender === mainWindow.webContents &&
      isTrustedIpcSender(event, TRUSTED_APP_ORIGIN)
    );
  } catch (_) {
    return false;
  }
}

/* ------------------------------------------------------------------ */
/* Single instance                                                     */
/* ------------------------------------------------------------------ */
const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
  app.quit();
} else {
  app.on('second-instance', () => {
    if (mainWindow) {
      if (mainWindow.isMinimized()) mainWindow.restore();
      mainWindow.focus();
    }
  });
}

/* ------------------------------------------------------------------ */
/* Window state persistence                                            */
/* ------------------------------------------------------------------ */
function windowStateFile() {
  return path.join(app.getPath('userData'), 'window-state.json');
}
function loadWindowState() {
  try {
    return JSON.parse(fs.readFileSync(windowStateFile(), 'utf8'));
  } catch (_) {
    return { width: 1440, height: 900 };
  }
}
function saveWindowState(win) {
  try {
    if (!win.isMinimized() && !win.isMaximized()) {
      const b = win.getBounds();
      fs.writeFileSync(
        windowStateFile(),
        JSON.stringify({ ...b, maximized: false })
      );
    } else if (win.isMaximized()) {
      const prev = loadWindowState();
      fs.writeFileSync(
        windowStateFile(),
        JSON.stringify({ ...prev, maximized: true })
      );
    }
  } catch (_) {}
}

/* ------------------------------------------------------------------ */
/* Offline cache: intercept https, serve from disk on network failure  */
/* ------------------------------------------------------------------ */
function setOfflineState(offline) {
  if (lastServedFromCache === offline) return;
  lastServedFromCache = offline;
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send('hl-offline-state', offline);
  }
}

function installNetworkLayer(ses) {
  ses.protocol.handle('https', async (request) => {
    const url = new URL(request.url);
    const cacheable = request.method === 'GET' && isCacheableHost(url.hostname);

    try {
      if (SIMULATE_OFFLINE) throw new Error('simulated offline');
      const liveResponse = await net.fetch(request, {
        bypassCustomProtocolHandlers: true,
      });

      if (cacheable && liveResponse.ok) {
        const len = Number(liveResponse.headers.get('content-length') || 0);
        if (len <= MAX_BODY_BYTES) {
          // Buffer the body so we can both cache it and return it.
          const buf = await liveResponse.arrayBuffer();
          const headers = {};
          liveResponse.headers.forEach((v, k) => {
            headers[k] = v;
          });
          // Fire-and-forget cache write.
          cache.put(request.url, liveResponse.status, headers, buf);
          setOfflineState(false);
          return new Response(buf, {
            status: liveResponse.status,
            headers: liveResponse.headers,
          });
        }
      }
      if (cacheable) setOfflineState(false);
      return liveResponse;
    } catch (err) {
      // Network failure — try the offline cache.
      if (cacheable) {
        const hit = await cache.get(request.url);
        if (hit) {
          setOfflineState(true);
          if (DEBUG) console.log('[hl-cache] OFFLINE HIT', request.url);
          const headers = new Headers(hit.meta.headers);
          headers.set('x-hivelogic-cache', 'offline-hit');
          headers.delete('content-encoding'); // body stored decoded
          headers.set('content-length', String(hit.body.byteLength));
          return new Response(hit.body, {
            status: hit.meta.status,
            headers,
          });
        }
      }
      throw err;
    }
  });
}

/* ------------------------------------------------------------------ */
/* Window                                                               */
/* ------------------------------------------------------------------ */
function createWindow() {
  const state = loadWindowState();
  mainWindow = new BrowserWindow({
    width: state.width || 1440,
    height: state.height || 900,
    x: state.x,
    y: state.y,
    minWidth: 1024,
    minHeight: 640,
    backgroundColor: '#10131c',
    title: 'HiveLogic',
    icon: path.join(__dirname, '..', 'build', 'icon.png'),
    autoHideMenuBar: true,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      spellcheck: true,
    },
  });

  if (state.maximized) mainWindow.maximize();

  mainWindow.loadURL(APP_URL);

  // First-ever launch with no internet and no cache → branded offline page.
  mainWindow.webContents.on('did-fail-load', (_e, code, _desc, failedUrl, isMainFrame) => {
    if (isMainFrame && code !== -3 /* aborted */) {
      mainWindow.loadFile(path.join(__dirname, '..', 'assets', 'offline.html'));
    }
  });

  // Sign-in popups (Microsoft 365 / MSAL) must open INSIDE the app so the
  // auth flow can complete and hand the token back. MSAL popups start as
  // about:blank, then navigate to the identity provider. Everything else
  // external opens in the default browser.
  const AUTH_POPUP_HOSTS = /(^|\.)login\.microsoftonline\.com$|(^|\.)login\.live\.com$|(^|\.)login\.microsoft\.com$|(^|\.)account\.microsoft\.com$/;
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    if (url === 'about:blank' || url === '') {
      return { action: 'allow', overrideBrowserWindowOptions: { autoHideMenuBar: true } };
    }
    try {
      const u = new URL(url);
      if (u.hostname === APP_HOST) return { action: 'allow' };
      if (AUTH_POPUP_HOSTS.test(u.hostname)) {
        return { action: 'allow', overrideBrowserWindowOptions: { autoHideMenuBar: true } };
      }
    } catch (_) {}
    shell.openExternal(url);
    return { action: 'deny' };
  });

  mainWindow.on('close', () => saveWindowState(mainWindow));
  mainWindow.on('closed', () => {
    speechAuthorization.clear();
    nativeSpeech.cancelRecognition();
    mainWindow = null;
  });
}

/* ------------------------------------------------------------------ */
/* Auto-update                                                          */
/* ------------------------------------------------------------------ */
function setupAutoUpdate() {
  if (!app.isPackaged) return;
  let autoUpdater;
  try {
    ({ autoUpdater } = require('electron-updater'));
  } catch (_) {
    return;
  }
  autoUpdater.autoDownload = true;
  autoUpdater.autoInstallOnAppQuit = true;
  autoUpdater.on('error', () => {
    /* no release channel configured yet, or offline — never bother the user */
  });
  autoUpdater.on('update-downloaded', (info) => {
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send('hl-update-ready', info.version);
    }
    // Self-healing rollout: once an update is downloaded, apply it the next
    // time the app has clearly been left idle (no focus for 30+ minutes), so
    // machines that never get restarted still pick up new versions the same
    // day. Never interrupts someone actively working.
    const armed = Date.now();
    const idleTimer = setInterval(() => {
      const idle = !mainWindow || mainWindow.isDestroyed() || !mainWindow.isFocused();
      if (idle && Date.now() - armed > 30 * 60 * 1000) {
        clearInterval(idleTimer);
        try { autoUpdater.quitAndInstall(true, true); } catch (_) {}
      }
    }, 5 * 60 * 1000);
  });
  const check = () => autoUpdater.checkForUpdates().catch(() => {});
  check();
  setInterval(check, 30 * 60 * 1000); // every 30 minutes
}

/* ------------------------------------------------------------------ */
/* IPC                                                                  */
/* ------------------------------------------------------------------ */
ipcMain.handle('hl-get-version', () => app.getVersion());
ipcMain.handle('hl-retry-online', () => {
  if (mainWindow) mainWindow.loadURL(APP_URL);
});
ipcMain.handle('hl-cache-stats', () => cache.stats());
ipcMain.handle('hl-restart-to-update', () => {
  try {
    const { autoUpdater } = require('electron-updater');
    autoUpdater.quitAndInstall();
  } catch (_) {}
});
ipcMain.on('hl-native-speech-arm', (event, token) => {
  event.returnValue = false;
  if (!trustedMainSender(event)) return;
  try {
    event.returnValue = speechAuthorization.arm(event.sender.id, token);
  } catch (_) {
    event.returnValue = false;
  }
});
ipcMain.handle('hl-native-speech-recognize-once', (event, token) => {
  if (
    !trustedMainSender(event) ||
    !speechAuthorization.consume(event.sender.id, token)
  ) {
    return { ok: false, code: 'permission_denied' };
  }
  return nativeSpeech.recognizeOnce();
});
ipcMain.handle('hl-native-speech-cancel', (event) => {
  if (!trustedMainSender(event)) return { ok: false };
  speechAuthorization.clear();
  return nativeSpeech.cancelRecognition();
});

/* ------------------------------------------------------------------ */
/* App lifecycle                                                        */
/* ------------------------------------------------------------------ */
app.whenReady().then(() => {
  cache = new OfflineCache(path.join(app.getPath('userData'), 'offline-cache'));
  installAudioPermissionPolicy(session.defaultSession, TRUSTED_APP_ORIGIN);
  installNetworkLayer(session.defaultSession);

  Menu.setApplicationMenu(
    Menu.buildFromTemplate([
      {
        label: 'HiveLogic',
        submenu: [
          { role: 'reload' },
          { role: 'forceReload' },
          { type: 'separator' },
          { role: 'resetZoom' },
          { role: 'zoomIn' },
          { role: 'zoomOut' },
          { type: 'separator' },
          { role: 'togglefullscreen' },
          { type: 'separator' },
          { role: 'quit' },
        ],
      },
      { role: 'editMenu' },
    ])
  );

  createWindow();
  setupAutoUpdate();

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});

app.on('before-quit', () => {
  speechAuthorization.clear();
  nativeSpeech.cancelRecognition();
});
