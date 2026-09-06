'use strict';

/**
 * Draw on the whole screen — the part a browser tab can never do.
 *
 * Chris, 2026-09-06: "i need to be able to draw on my whole screen on a call,
 * not just inside hivelogic".
 *
 * Cowork's annotation canvas lives in a web page, and a web page is sealed
 * inside its own tab. It can paint over HiveLogic and over the shared video,
 * and it physically cannot paint over Excel, over Jobber in another browser,
 * or over the desktop. That is not a bug in Cowork; it is the browser sandbox,
 * and no amount of work in cowork-markup.js gets past it. This app is the only
 * place in HiveLogic that CAN, because Electron owns real OS windows.
 *
 * So: while this is on, one frameless, transparent, always-on-top window sits
 * exactly over each monitor. Marks drawn on it are real pixels on the real
 * screen. That matters more than it sounds — it means the marks need no
 * network sync at all. When Chris shares his screen, the OS capture that feeds
 * the video call reads the composited desktop, overlay included, so everyone
 * on the call sees the marks for free. Piping shape data across process
 * boundaries into the LiveKit data channel would have been a second, parallel
 * copy of machinery that already works, to achieve something the compositor
 * does by itself. cowork-markup.js is left completely alone.
 *
 * Everything here is deliberately free of `require('electron')`. Electron is
 * injected by main.js, so the window maths, the undo ordering across monitors,
 * the trust boundary and the whole start/stop lifecycle — including every
 * escape hatch — can be unit-tested with fakes. Overlay windows are the one
 * feature in this app that can strand somebody, so the tests have to be able
 * to reach the code that un-strands them.
 */

// A monitor smaller than this is a bad reading from the OS, not a monitor.
const MIN_DISPLAY_SIDE = 64;
const TOOLBAR_WIDTH = 380;
const TOOLBAR_HEIGHT = 140;
// How far up from the bottom edge of the anchor monitor the toolbar floats.
const TOOLBAR_BOTTOM_MARGIN = 28;
// The "I am stuck under a transparent sheet" hotkey. Deliberately not Escape:
// registering Escape globally would swallow it in every other application on
// the machine, which is a far worse bug than the one it guards against. The
// overlay windows also close on their own Escape key locally, and the toolbar
// has a Stop button — this is the third way out, for when the overlay has
// somehow outlived the toolbar.
const PANIC_SHORTCUT = 'CommandOrControl+Shift+F9';

function isFiniteNumber(value) {
  return typeof value === 'number' && Number.isFinite(value);
}

/**
 * Turn Electron's screen.getAllDisplays() into one overlay window plan per
 * monitor.
 *
 * One window per display, NOT one window spanning the bounding box of all of
 * them. The spanning version is fewer windows and is wrong on the machines
 * that matter: Electron positions windows in device-independent pixels, and a
 * laptop at 150% scaling beside an external monitor at 100% has two different
 * DIP-to-pixel ratios. One window stretched across both renders its canvas at
 * a single scale, so marks land in the right place on one screen and drift on
 * the other. Per-display windows each get their own scaleFactor and each map
 * 1:1 onto the monitor they cover.
 *
 * Bounds are copied through untouched, including negative x/y. On Windows the
 * virtual desktop origin is the PRIMARY monitor's top-left, so a monitor
 * placed to the left of or above the primary one genuinely has negative
 * coordinates (x: -1920 is normal, not corrupt). Anything that "helpfully"
 * clamped these to zero would stack every left-hand monitor's overlay on top
 * of the primary and leave the real monitor bare.
 */
function overlayPlans(displays) {
  if (!Array.isArray(displays)) return [];
  const plans = [];
  const seen = new Set();
  for (const display of displays) {
    if (!display || typeof display !== 'object') continue;
    const bounds = display.bounds;
    if (!bounds || typeof bounds !== 'object') continue;
    const { x, y, width, height } = bounds;
    if (!isFiniteNumber(x) || !isFiniteNumber(y)) continue;
    if (!isFiniteNumber(width) || !isFiniteNumber(height)) continue;
    if (width < MIN_DISPLAY_SIDE || height < MIN_DISPLAY_SIDE) continue;
    const displayId = display.id;
    if (displayId == null || seen.has(displayId)) continue;
    seen.add(displayId);
    plans.push({
      displayId,
      x: Math.round(x),
      y: Math.round(y),
      width: Math.round(width),
      height: Math.round(height),
    });
  }
  return plans;
}

/**
 * Where the little toolbar window goes: bottom-centre of one chosen monitor,
 * fully inside that monitor's work area.
 *
 * Clamped, not just centred. A monitor narrower than the toolbar, or one at a
 * negative origin, would otherwise place the toolbar partly or entirely off
 * every screen — and the toolbar is the visible way to stop, so a toolbar you
 * cannot see is the stranding bug wearing a different hat.
 */
function toolbarPlan(display, size) {
  const width = Math.round((size && size.width) || TOOLBAR_WIDTH);
  const height = Math.round((size && size.height) || TOOLBAR_HEIGHT);
  const area =
    (display && (display.workArea || display.bounds)) || { x: 0, y: 0, width: 0, height: 0 };
  const ax = isFiniteNumber(area.x) ? Math.round(area.x) : 0;
  const ay = isFiniteNumber(area.y) ? Math.round(area.y) : 0;
  const aw = isFiniteNumber(area.width) ? Math.round(area.width) : 0;
  const ah = isFiniteNumber(area.height) ? Math.round(area.height) : 0;

  const centred = ax + Math.round((aw - width) / 2);
  const lowest = ay + ah - height - TOOLBAR_BOTTOM_MARGIN;

  // Math.min BEFORE Math.max: on a monitor too small to hold the toolbar the
  // left/top edge wins, so at least the Stop button stays on screen.
  const x = Math.max(ax, Math.min(centred, ax + aw - width));
  const y = Math.max(ay, Math.min(lowest, ay + ah - height));
  return { x, y, width, height };
}

/**
 * Which monitor the toolbar should sit on: the one the HiveLogic window is on,
 * falling back to the primary. Chris is looking at the call when he turns this
 * on, so that is the screen his eyes are already on.
 */
function pickToolbarDisplay(displays, preferredId, primaryId) {
  const list = Array.isArray(displays) ? displays.filter(Boolean) : [];
  if (!list.length) return null;
  return (
    list.find((d) => d.id === preferredId) ||
    list.find((d) => d.id === primaryId) ||
    list[0]
  );
}

/**
 * Undo across monitors, in the order the marks were actually drawn.
 *
 * Each overlay owns its own board, so "undo" cannot just be sent to one of
 * them — pressing it has to remove the most recent mark wherever it was made.
 * Draw on the laptop, then the external monitor, then undo twice: the external
 * mark goes first, the laptop mark second. Sending undo to a fixed window, or
 * to all of them, would delete the wrong mark or two marks per press, and from
 * the outside that reads as "undo is broken".
 */
function createStrokeLedger() {
  const order = [];
  return Object.freeze({
    record(displayId) {
      if (displayId == null) return false;
      order.push(displayId);
      return true;
    },
    popLast() {
      return order.length ? order.pop() : null;
    },
    clear() {
      order.length = 0;
    },
    size() {
      return order.length;
    },
  });
}

/**
 * The lifecycle. `deps` carries every Electron touchpoint:
 *
 *   screen             — Electron's screen module (getAllDisplays, getPrimaryDisplay,
 *                        getDisplayNearestPoint, on/removeListener)
 *   createOverlayWindow(plan) -> window handle
 *   createToolbarWindow(plan) -> window handle
 *   globalShortcut     — register/unregister/isRegistered
 *   getAnchorDisplayId() -> display id the HiveLogic window is on, or null
 *
 * A "window handle" is whatever createOverlayWindow returns; the controller
 * only ever calls a small, documented set of methods on it, which is what
 * makes the tests possible.
 */
function createScreenAnnotate(deps = {}) {
  const screen = deps.screen || null;
  const globalShortcut = deps.globalShortcut || null;
  const createOverlayWindow = deps.createOverlayWindow || null;
  const createToolbarWindow = deps.createToolbarWindow || null;
  const getAnchorDisplayId = deps.getAnchorDisplayId || (() => null);

  let overlays = [];
  let toolbar = null;
  let active = false;
  let drawing = false;
  let color = null;
  let shortcutRegistered = false;
  let displayListener = null;
  const ledger = createStrokeLedger();

  function safe(fn) {
    try {
      return fn();
    } catch (_) {
      return undefined;
    }
  }

  function alive(win) {
    if (!win) return false;
    return safe(() => (typeof win.isDestroyed === 'function' ? !win.isDestroyed() : true)) === true;
  }

  function send(win, channel, payload) {
    if (!alive(win)) return;
    safe(() => win.webContents.send(channel, payload));
  }

  function eachOverlay(fn) {
    overlays.forEach((entry) => {
      if (alive(entry.win)) safe(() => fn(entry));
    });
  }

  /* ---------------- click-through ----------------
   * The overlay is transparent to the mouse unless Chris has explicitly
   * pressed Draw. That is the whole difference between "an annotation layer"
   * and "my computer stopped responding": between marks he still needs to
   * click the thing he is talking about. `forward: true` keeps move events
   * flowing to the page so a hover cursor still works while click-through.
   */
  function applyClickThrough() {
    eachOverlay(({ win }) => {
      if (typeof win.setIgnoreMouseEvents === 'function') {
        win.setIgnoreMouseEvents(!drawing, { forward: true });
      }
    });
  }

  function broadcastState() {
    const payload = { active, drawing, color, marks: ledger.size() };
    eachOverlay(({ win }) => send(win, 'hl-overlay-state', payload));
    send(toolbar, 'hl-overlay-state', payload);
    if (typeof deps.onStateChange === 'function') safe(() => deps.onStateChange(payload));
    return payload;
  }

  function destroyWindows() {
    const all = overlays.map((entry) => entry.win).concat(toolbar ? [toolbar] : []);
    overlays = [];
    toolbar = null;
    all.forEach((win) => {
      if (!win) return;
      // removeAllListeners first: 'closed' handlers call stop(), and stop()
      // is what is running. Without this, tearing down window one re-enters
      // stop() before windows two and three have been touched, and on a
      // three-monitor machine the last overlay survives the stop that was
      // meant to remove it — the exact stuck-transparent-sheet state this
      // whole feature has to be incapable of reaching.
      safe(() => {
        if (typeof win.removeAllListeners === 'function') win.removeAllListeners('closed');
      });
      safe(() => {
        if (typeof win.destroy === 'function') win.destroy();
        else if (typeof win.close === 'function') win.close();
      });
    });
  }

  function releaseShortcut() {
    if (!shortcutRegistered || !globalShortcut) return;
    shortcutRegistered = false;
    safe(() => globalShortcut.unregister(PANIC_SHORTCUT));
  }

  function claimShortcut() {
    if (!globalShortcut || shortcutRegistered) return;
    const taken = safe(() => globalShortcut.isRegistered(PANIC_SHORTCUT)) === true;
    if (taken) return; // another app owns it; the toolbar and Escape still work
    shortcutRegistered = safe(() => globalShortcut.register(PANIC_SHORTCUT, () => stop())) === true;
  }

  function watchDisplays() {
    if (!screen || typeof screen.on !== 'function' || displayListener) return;
    displayListener = () => {
      if (active) rebuild();
    };
    ['display-added', 'display-removed', 'display-metrics-changed'].forEach((event) => {
      safe(() => screen.on(event, displayListener));
    });
  }

  function unwatchDisplays() {
    if (!screen || !displayListener || typeof screen.removeListener !== 'function') {
      displayListener = null;
      return;
    }
    ['display-added', 'display-removed', 'display-metrics-changed'].forEach((event) => {
      safe(() => screen.removeListener(event, displayListener));
    });
    displayListener = null;
  }

  function build() {
    const displays = safe(() => screen.getAllDisplays()) || [];
    const plans = overlayPlans(displays);
    if (!plans.length) return { ok: false, code: 'no_display' };

    overlays = [];
    plans.forEach((plan) => {
      const win = safe(() => createOverlayWindow(plan));
      if (!win) return;
      safe(() => {
        if (typeof win.on === 'function') {
          // A window that dies on its own (a GPU crash, a display yanked out)
          // must not leave the session claiming to be running.
          win.on('closed', () => {
            if (active) stop();
          });
        }
      });
      overlays.push({ displayId: plan.displayId, win, plan });
    });
    if (!overlays.length) return { ok: false, code: 'overlay_failed' };

    const primary = safe(() => screen.getPrimaryDisplay());
    const anchorDisplay = pickToolbarDisplay(
      displays,
      safe(() => getAnchorDisplayId()),
      primary && primary.id
    );
    toolbar = safe(() => createToolbarWindow(toolbarPlan(anchorDisplay))) || null;
    if (toolbar) {
      safe(() => {
        if (typeof toolbar.on === 'function') {
          // Losing the toolbar loses the visible Stop button. Rather than
          // leave overlays up with no obvious way out, the whole session ends.
          toolbar.on('closed', () => {
            if (active) stop();
          });
        }
      });
    }
    return { ok: true };
  }

  function start() {
    if (active) return { ok: true, active: true, displays: overlays.length };
    if (!screen || !createOverlayWindow || !createToolbarWindow) {
      return { ok: false, active: false, code: 'unavailable' };
    }
    const built = build();
    if (!built.ok) {
      destroyWindows();
      return { ok: false, active: false, code: built.code };
    }
    active = true;
    drawing = true; // turning it on means he wants to draw right now
    ledger.clear();
    applyClickThrough();
    claimShortcut();
    watchDisplays();
    broadcastState();
    return { ok: true, active: true, displays: overlays.length };
  }

  function stop() {
    if (!active && !overlays.length && !toolbar) {
      return { ok: true, active: false };
    }
    active = false;
    drawing = false;
    ledger.clear();
    releaseShortcut();
    unwatchDisplays();
    destroyWindows();
    if (typeof deps.onStateChange === 'function') {
      safe(() => deps.onStateChange({ active: false, drawing: false, color, marks: 0 }));
    }
    return { ok: true, active: false };
  }

  /** A monitor was plugged in, unplugged or rescaled: re-cover what is there now. */
  function rebuild() {
    if (!active) return { ok: true, active: false };
    const wasDrawing = drawing;
    destroyWindows();
    const built = build();
    if (!built.ok) return stop();
    drawing = wasDrawing;
    applyClickThrough();
    broadcastState();
    return { ok: true, active: true, displays: overlays.length };
  }

  /**
   * The trust boundary for the overlay's own pages.
   *
   * These are local file:// pages, so isTrustedIpcSender() — which asks
   * "did this come from https://hivelogic-live.vercel.app" — correctly says
   * no about them. Identity is the right question for a window this process
   * created itself: is this sender one of MY windows. Anything else, including
   * the web page, cannot drive the toolbar.
   */
  function ownsSender(senderId) {
    if (senderId == null) return false;
    const match = (win) =>
      alive(win) && safe(() => win.webContents && win.webContents.id) === senderId;
    return overlays.some((entry) => match(entry.win)) || match(toolbar);
  }

  function setDrawing(on) {
    if (!active) return { ok: false, active: false };
    drawing = on === true;
    applyClickThrough();
    return { ok: true, ...broadcastState() };
  }

  function setColor(value) {
    if (!active) return { ok: false, active: false };
    if (typeof value !== 'string' || !/^#[0-9a-fA-F]{6}$/.test(value)) {
      return { ok: false, active: true };
    }
    color = value;
    eachOverlay(({ win }) => send(win, 'hl-overlay-color', color));
    return { ok: true, ...broadcastState() };
  }

  function recordStroke(senderId) {
    const entry = overlays.find(
      (item) =>
        alive(item.win) && safe(() => item.win.webContents && item.win.webContents.id) === senderId
    );
    if (!entry) return { ok: false };
    ledger.record(entry.displayId);
    broadcastState();
    return { ok: true, marks: ledger.size() };
  }

  function undo() {
    if (!active) return { ok: false, active: false };
    const displayId = ledger.popLast();
    if (displayId == null) {
      broadcastState();
      return { ok: true, marks: 0 };
    }
    const entry = overlays.find((item) => item.displayId === displayId);
    if (entry) send(entry.win, 'hl-overlay-undo', null);
    broadcastState();
    return { ok: true, marks: ledger.size() };
  }

  function clear() {
    if (!active) return { ok: false, active: false };
    ledger.clear();
    eachOverlay(({ win }) => send(win, 'hl-overlay-clear', null));
    broadcastState();
    return { ok: true, marks: 0 };
  }

  function state() {
    return { active, drawing, color, marks: ledger.size(), displays: overlays.length };
  }

  return Object.freeze({
    start,
    stop,
    rebuild,
    ownsSender,
    setDrawing,
    setColor,
    recordStroke,
    undo,
    clear,
    state,
    isActive: () => active,
  });
}

module.exports = {
  MIN_DISPLAY_SIDE,
  PANIC_SHORTCUT,
  TOOLBAR_HEIGHT,
  TOOLBAR_WIDTH,
  createScreenAnnotate,
  createStrokeLedger,
  overlayPlans,
  pickToolbarDisplay,
  toolbarPlan,
};
