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
  globalShortcut,
  net,
  screen,
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
const { createScreenAnnotate } = require('./screen-annotate');

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
const wakeEnabledSenders = new Set();

function wakePreferenceFile() {
  return path.join(app.getPath('userData'), 'reina-voice.json');
}
function loadWakePreference() {
  try {
    const value = JSON.parse(fs.readFileSync(wakePreferenceFile(), 'utf8'));
    return value && value.enabled === true;
  } catch (_) {
    return false;
  }
}
function saveWakePreference(enabled) {
  try {
    fs.writeFileSync(wakePreferenceFile(), JSON.stringify({ enabled: enabled === true }));
  } catch (_) {}
}

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
/* Draw on the whole screen                                            */
/*                                                                      */
/* Chris, 2026-09-06: "i need to be able to draw on my whole screen on  */
/* a call, not just inside hivelogic".                                  */
/*                                                                      */
/* Cowork's canvas is a web page and a web page cannot paint outside    */
/* its own tab — that is the browser sandbox, not a Cowork bug. This    */
/* app can, because it owns real OS windows. The logic lives in         */
/* screen-annotate.js with no Electron import; everything Electron      */
/* touches is built here and handed in, so the window maths, the        */
/* cross-monitor undo order and every escape hatch stay unit-testable.  */
/*                                                                      */
/* Note what is NOT here: any sync of these marks to the other people   */
/* on the call. There is nothing to sync. The marks are real pixels on  */
/* the real desktop, so the screen-share capture already contains them. */
/* ------------------------------------------------------------------ */
let screenAnnotate = null;

function overlayWebPreferences(preloadFile) {
  return {
    preload: path.join(__dirname, 'overlay', preloadFile),
    contextIsolation: true,
    nodeIntegration: false,
    spellcheck: false,
  };
}

function buildOverlayWindow(plan) {
  const win = new BrowserWindow({
    x: plan.x,
    y: plan.y,
    width: plan.width,
    height: plan.height,
    frame: false,
    transparent: true,
    backgroundColor: '#00000000',
    hasShadow: false,
    resizable: false,
    movable: false,
    minimizable: false,
    maximizable: false,
    fullscreenable: false,
    skipTaskbar: true,
    // Left focusable ON PURPOSE. A non-focusable overlay would be tidier —
    // the app being demonstrated would keep its caret — but it would also
    // never receive a key press, and Escape on the sheet in front of you is
    // one of the three ways out of this mode. Being able to leave beats being
    // tidy.
    focusable: true,
    acceptFirstMouse: true,
    show: false,
    webPreferences: overlayWebPreferences('overlay-preload.js'),
  });
  // 'screen-saver' is the highest level Electron offers, so the sheet sits
  // over full-screen apps too — a presentation in full screen is exactly when
  // somebody wants to circle something on it.
  win.setAlwaysOnTop(true, 'screen-saver');
  win.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
  win.setIgnoreMouseEvents(true, { forward: true });
  win.loadFile(path.join(__dirname, 'overlay', 'overlay.html'));
  win.once('ready-to-show', () => win.showInactive());
  return win;
}

function buildToolbarWindow(plan) {
  const win = new BrowserWindow({
    x: plan.x,
    y: plan.y,
    width: plan.width,
    height: plan.height,
    frame: false,
    transparent: true,
    backgroundColor: '#00000000',
    hasShadow: false,
    resizable: false,
    minimizable: false,
    maximizable: false,
    fullscreenable: false,
    skipTaskbar: true,
    show: false,
    webPreferences: overlayWebPreferences('toolbar-preload.js'),
  });
  win.setAlwaysOnTop(true, 'screen-saver');
  win.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
  win.loadFile(path.join(__dirname, 'overlay', 'toolbar.html'));
  win.once('ready-to-show', () => {
    win.showInactive();
    // Built after the sheets, so it already stacks above them; moveTop is the
    // belt to that braces. If the Stop button ends up UNDER a transparent
    // sheet, the way out is invisible and this feature has become the trap it
    // is supposed to never be.
    win.moveTop();
  });
  return win;
}

function anchorDisplayId() {
  try {
    if (!mainWindow || mainWindow.isDestroyed()) return null;
    const b = mainWindow.getBounds();
    const found = screen.getDisplayNearestPoint({
      x: Math.round(b.x + b.width / 2),
      y: Math.round(b.y + b.height / 2),
    });
    return found ? found.id : null;
  } catch (_) {
    return null;
  }
}

function ensureScreenAnnotate() {
  if (screenAnnotate) return screenAnnotate;
  screenAnnotate = createScreenAnnotate({
    screen,
    globalShortcut,
    createOverlayWindow: buildOverlayWindow,
    createToolbarWindow: buildToolbarWindow,
    getAnchorDisplayId: anchorDisplayId,
    // The page's button has to show the truth even when the session was ended
    // from somewhere the page cannot see — the toolbar's Stop, Escape on a
    // sheet, the global hotkey, or a monitor being unplugged.
    onStateChange(state) {
      if (mainWindow && !mainWindow.isDestroyed()) {
        mainWindow.webContents.send('hl-screen-annotate-state', {
          active: state.active === true,
          drawing: state.drawing === true,
        });
      }
    },
  });
  return screenAnnotate;
}

function stopScreenAnnotate() {
  if (!screenAnnotate) return;
  try {
    screenAnnotate.stop();
  } catch (_) {}
}

// Only a window this process created may drive the toolbar channels. These
// pages are local file:// documents, so isTrustedIpcSender() — which asks
// "did this come from the HiveLogic web origin" — correctly says no about
// them; identity is the right question for our own windows.
function overlaySender(event) {
  try {
    return Boolean(
      screenAnnotate &&
      event &&
      event.sender &&
      screenAnnotate.ownsSender(event.sender.id)
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
    wakeEnabledSenders.clear();
    nativeSpeech.cancelRecognition();
    // Two reasons, and the second one is the app-breaking one.
    //
    // Nobody should be left with transparent sheets over every monitor and
    // the window they started them from gone. And 'window-all-closed' only
    // fires when the LAST BrowserWindow closes — with overlays still alive,
    // closing HiveLogic would close the visible app while the process kept
    // running behind an invisible always-on-top layer, with no window left to
    // reach it from. Killing the overlays here is what lets that event fire.
    stopScreenAnnotate();
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
  // Compute the final answer first and assign event.returnValue exactly
  // once. Assigning it twice (a placeholder up front, then the real
  // result) silently locks in the FIRST assignment as what the renderer's
  // sendSync() actually receives -- the second assignment has no effect
  // on the reply, even though re-reading event.returnValue afterwards
  // still shows the newer value inside this same function. That made
  // arm() always report failure to the renderer regardless of its real
  // result, which is why a real, correctly-armed hold-to-talk press still
  // failed closed with "permission denied".
  let result = false;
  try {
    if (trustedMainSender(event)) {
      result = speechAuthorization.arm(event.sender.id, token) === true;
    }
  } catch (_) {
    result = false;
  }
  event.returnValue = result;
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
  // FIX (voice regression): cancel stops only the ACTIVE native recognition.
  // Clearing the armed authorization here let a stale cancel kill the token a
  // real Enable Voice click had just armed (-> false "permission denied").
  // The authorization is single-use with a 2s TTL; window close and app quit
  // still clear it explicitly.
  return nativeSpeech.cancelRecognition();
});
ipcMain.on('hl-native-wake-enable', (event, token) => {
  // Same fix as hl-native-speech-arm above: assign event.returnValue
  // exactly once, at the end, with the real result -- not a placeholder
  // followed by a real value, which silently locks in the placeholder.
  let result = false;
  try {
    if (trustedMainSender(event) && speechAuthorization.consume(event.sender.id, token)) {
      wakeEnabledSenders.add(event.sender.id);
      saveWakePreference(true);
      result = true;
    }
  } catch (_) {
    result = false;
  }
  event.returnValue = result;
});
ipcMain.handle('hl-native-wake-resume', (event) => {
  if (!trustedMainSender(event) || !loadWakePreference()) return { ok: false, enabled: false };
  wakeEnabledSenders.add(event.sender.id);
  return { ok: true, enabled: true };
});
ipcMain.handle('hl-native-wake-listen', async (event) => {
  if (!trustedMainSender(event) || !wakeEnabledSenders.has(event.sender.id)) {
    return { ok: false, code: 'permission_denied' };
  }
  const sender = event.sender;
  const ownerId = sender.id;
  const result = await nativeSpeech.listenForWakeWord({
    onWake() {
      if (wakeEnabledSenders.has(ownerId) && !sender.isDestroyed()) {
        sender.send('hl-native-wake-detected');
      }
    },
  });
  if (wakeEnabledSenders.has(ownerId) && !sender.isDestroyed()) {
    sender.send('hl-native-wake-result', result);
  }
  return result;
});
ipcMain.handle('hl-native-wake-cancel', async (event) => {
  if (!trustedMainSender(event) || !wakeEnabledSenders.has(event.sender.id)) return { ok: false };
  // A listener attempt ending is not an opt-out. Keep the persisted Voice
  // preference so the page can re-arm after a timeout or completed turn.
  return nativeSpeech.cancelRecognition();
});
ipcMain.handle('hl-native-wake-disable', async (event) => {
  if (!trustedMainSender(event)) return { ok: false };
  wakeEnabledSenders.delete(event.sender.id);
  saveWakePreference(false);
  await nativeSpeech.cancelRecognition();
  return { ok: true };
});

/* ---- screen markup: from the HiveLogic page ---- */
// Same trust boundary as Voice: the real HiveLogic origin, in the real main
// window, or nothing. Covering someone's entire screen with an always-on-top
// window is not something a stray frame gets to ask for.
ipcMain.handle('hl-screen-annotate-start', (event) => {
  if (!trustedMainSender(event)) return { ok: false, active: false, code: 'permission_denied' };
  return ensureScreenAnnotate().start();
});
ipcMain.handle('hl-screen-annotate-stop', (event) => {
  if (!trustedMainSender(event)) return { ok: false, active: false, code: 'permission_denied' };
  if (!screenAnnotate) return { ok: true, active: false };
  return screenAnnotate.stop();
});
ipcMain.handle('hl-screen-annotate-state', (event) => {
  if (!trustedMainSender(event)) return { active: false, drawing: false };
  if (!screenAnnotate) return { active: false, drawing: false };
  const state = screenAnnotate.state();
  return { active: state.active === true, drawing: state.drawing === true };
});

/* ---- screen markup: from our own overlay windows ---- */
ipcMain.on('hl-overlay-stroke', (event) => {
  if (!overlaySender(event)) return;
  screenAnnotate.recordStroke(event.sender.id);
});
ipcMain.on('hl-overlay-set-drawing', (event, on) => {
  if (!overlaySender(event)) return;
  screenAnnotate.setDrawing(on === true);
});
ipcMain.on('hl-overlay-set-color', (event, value) => {
  if (!overlaySender(event)) return;
  screenAnnotate.setColor(value);
});
ipcMain.on('hl-overlay-undo-request', (event) => {
  if (!overlaySender(event)) return;
  screenAnnotate.undo();
});
ipcMain.on('hl-overlay-clear-request', (event) => {
  if (!overlaySender(event)) return;
  screenAnnotate.clear();
});
// The escape hatch, reachable from the toolbar's Stop button and from Escape
// on any sheet. Left unguarded on purpose beyond "it is one of our windows":
// getting OUT of this mode must never be the thing that fails a check.
ipcMain.on('hl-overlay-panic', (event) => {
  if (!overlaySender(event)) return;
  screenAnnotate.stop();
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
  wakeEnabledSenders.clear();
  nativeSpeech.cancelRecognition();
  stopScreenAnnotate();
});

// Belt and braces on the global hotkey: whatever else happens on the way out,
// the machine does not keep a HiveLogic key binding after HiveLogic is gone.
app.on('will-quit', () => {
  stopScreenAnnotate();
  try {
    globalShortcut.unregisterAll();
  } catch (_) {}
});
