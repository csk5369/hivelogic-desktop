'use strict';

/**
 * Chris, 2026-09-06: "i need to be able to draw on my whole screen on a call,
 * not just inside hivelogic".
 *
 * What can and cannot be tested here, stated up front so nobody reads a green
 * run as more than it is: none of this renders a window. Electron's real
 * BrowserWindow needs a display and a packaged app, so an always-on-top
 * transparent sheet actually appearing over Excel is a thing a person has to
 * look at. What IS testable is everything that decides where those windows go,
 * who is allowed to command them, which mark an Undo removes, and — the part
 * that matters most — that every route out of the mode really tears every
 * window down. A stuck, unclickable, invisible sheet over someone's whole
 * screen is the worst bug this feature can have, so the escape hatches are
 * tested first-class rather than trusted.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  PANIC_SHORTCUT,
  TOOLBAR_HEIGHT,
  TOOLBAR_WIDTH,
  createScreenAnnotate,
  createStrokeLedger,
  overlayPlans,
  pickToolbarDisplay,
  toolbarPlan,
} = require('../src/screen-annotate');

/* ------------------------------------------------------------------ */
/* Display maths                                                        */
/* ------------------------------------------------------------------ */

test('one overlay plan per monitor, negative virtual-desktop coordinates intact', () => {
  // The real shape of a two-monitor Windows desk with the second screen
  // placed to the LEFT of the primary: its origin is negative, and that is
  // normal, not corrupt. Clamping it to 0 would stack both overlays on the
  // primary and leave the left-hand monitor bare.
  const plans = overlayPlans([
    { id: 1, bounds: { x: 0, y: 0, width: 2560, height: 1440 } },
    { id: 2, bounds: { x: -1920, y: -180, width: 1920, height: 1080 } },
  ]);
  assert.deepEqual(plans, [
    { displayId: 1, x: 0, y: 0, width: 2560, height: 1440 },
    { displayId: 2, x: -1920, y: -180, width: 1920, height: 1080 },
  ]);
});

test('overlay plans drop junk displays instead of covering nothing or everything', () => {
  const plans = overlayPlans([
    { id: 1, bounds: { x: 0, y: 0, width: 1920, height: 1080 } },
    { id: 2, bounds: { x: 0, y: 0, width: 0, height: 0 } },          // zero-size
    { id: 3, bounds: { x: NaN, y: 0, width: 1920, height: 1080 } },  // unreadable
    { id: 1, bounds: { x: 500, y: 0, width: 1920, height: 1080 } },  // duplicate id
    { id: 4 },                                                       // no bounds
    null,
  ]);
  assert.deepEqual(plans.map((p) => p.displayId), [1]);
  assert.deepEqual(overlayPlans(null), []);
  assert.deepEqual(overlayPlans('not a list'), []);
});

test('overlay plans round fractional bounds to whole pixels', () => {
  const [plan] = overlayPlans([
    { id: 9, bounds: { x: -1536.5, y: 0.4, width: 1536.6, height: 864.2 } },
  ]);
  assert.deepEqual(plan, { displayId: 9, x: -1536, y: 0, width: 1537, height: 864 });
});

test('toolbar sits bottom-centre inside its monitor, negative origins included', () => {
  const plan = toolbarPlan({
    id: 2,
    bounds: { x: -1920, y: -180, width: 1920, height: 1080 },
    workArea: { x: -1920, y: -180, width: 1920, height: 1040 },
  });
  assert.equal(plan.width, TOOLBAR_WIDTH);
  assert.equal(plan.height, TOOLBAR_HEIGHT);
  assert.equal(plan.x, -1920 + Math.round((1920 - TOOLBAR_WIDTH) / 2));
  assert.equal(plan.y, -180 + 1040 - TOOLBAR_HEIGHT - 28);
  // Fully inside the work area, which is the whole point of clamping.
  assert.ok(plan.x >= -1920 && plan.x + plan.width <= -1920 + 1920);
  assert.ok(plan.y >= -180 && plan.y + plan.height <= -180 + 1040);
});

test('toolbar stays on screen on a monitor too small to hold it', () => {
  // Stop lives on this bar. A toolbar placed off-screen is the stranding bug.
  const plan = toolbarPlan({ id: 3, bounds: { x: 40, y: 40, width: 200, height: 90 } });
  assert.equal(plan.x, 40);
  assert.equal(plan.y, 40);
});

test('toolbar falls back to bounds when the OS reports no work area', () => {
  const plan = toolbarPlan({ id: 4, bounds: { x: 0, y: 0, width: 1920, height: 1080 } });
  assert.equal(plan.y, 1080 - TOOLBAR_HEIGHT - 28);
  assert.deepEqual(toolbarPlan(null), { x: 0, y: 0, width: TOOLBAR_WIDTH, height: TOOLBAR_HEIGHT });
});

test('the toolbar lands on the monitor HiveLogic is on, then the primary', () => {
  const displays = [{ id: 1 }, { id: 2 }, { id: 3 }];
  assert.equal(pickToolbarDisplay(displays, 3, 1).id, 3);
  assert.equal(pickToolbarDisplay(displays, 99, 2).id, 2); // window moved to a gone monitor
  assert.equal(pickToolbarDisplay(displays, null, null).id, 1);
  assert.equal(pickToolbarDisplay([], 1, 1), null);
});

/* ------------------------------------------------------------------ */
/* Undo order across monitors                                           */
/* ------------------------------------------------------------------ */

test('undo removes the newest mark wherever on the desk it was drawn', () => {
  const ledger = createStrokeLedger();
  ledger.record(1); // laptop
  ledger.record(2); // external monitor
  ledger.record(2);
  assert.equal(ledger.size(), 3);
  assert.equal(ledger.popLast(), 2);
  assert.equal(ledger.popLast(), 2);
  assert.equal(ledger.popLast(), 1);
  assert.equal(ledger.popLast(), null);
  assert.equal(ledger.record(null), false);
  ledger.record(7);
  ledger.clear();
  assert.equal(ledger.size(), 0);
});

/* ------------------------------------------------------------------ */
/* Lifecycle, with fake windows                                         */
/* ------------------------------------------------------------------ */

let nextWebContentsId = 100;

function fakeWindow(kind, plan) {
  const win = {
    kind,
    plan,
    destroyed: false,
    ignoreMouse: null,
    handlers: {},
    sent: [],
    webContents: {
      id: (nextWebContentsId += 1),
      send(channel, payload) {
        win.sent.push([channel, payload]);
      },
    },
    isDestroyed: () => win.destroyed,
    setIgnoreMouseEvents(ignore) {
      win.ignoreMouse = ignore;
    },
    on(event, handler) {
      (win.handlers[event] = win.handlers[event] || []).push(handler);
    },
    removeAllListeners(event) {
      delete win.handlers[event];
    },
    destroy() {
      win.destroyed = true;
      (win.handlers.closed || []).forEach((fn) => fn());
    },
  };
  return win;
}

function harness(options = {}) {
  const displays = options.displays || [
    { id: 1, bounds: { x: 0, y: 0, width: 1920, height: 1080 } },
    { id: 2, bounds: { x: -1920, y: 0, width: 1920, height: 1080 } },
  ];
  const made = { overlays: [], toolbars: [] };
  const shortcuts = new Map();
  const screenEvents = new Map();
  const states = [];

  const session = createScreenAnnotate({
    screen: {
      getAllDisplays: () => displays,
      getPrimaryDisplay: () => displays[0],
      on(event, handler) {
        (screenEvents.get(event) || screenEvents.set(event, []).get(event)).push(handler);
      },
      removeListener(event, handler) {
        const list = screenEvents.get(event) || [];
        screenEvents.set(event, list.filter((fn) => fn !== handler));
      },
    },
    globalShortcut: {
      isRegistered: (key) => shortcuts.has(key),
      register(key, handler) {
        if (options.shortcutTaken) return false;
        shortcuts.set(key, handler);
        return true;
      },
      unregister(key) {
        shortcuts.delete(key);
      },
    },
    createOverlayWindow(plan) {
      const win = fakeWindow('overlay', plan);
      made.overlays.push(win);
      return win;
    },
    createToolbarWindow(plan) {
      const win = fakeWindow('toolbar', plan);
      made.toolbars.push(win);
      return win;
    },
    getAnchorDisplayId: () => options.anchorId ?? null,
    onStateChange: (state) => states.push(state),
  });

  return { session, made, shortcuts, screenEvents, states, displays };
}

test('start covers every monitor, arms drawing, and claims the panic hotkey', () => {
  const { session, made, shortcuts } = harness();
  const result = session.start();

  assert.deepEqual(result, { ok: true, active: true, displays: 2 });
  assert.equal(made.overlays.length, 2);
  assert.equal(made.toolbars.length, 1);
  assert.deepEqual(made.overlays.map((w) => w.plan.displayId), [1, 2]);
  // Armed on start: pressing the button in Cowork means "let me draw now",
  // not "put a layer up that ignores me until I find a second button".
  assert.deepEqual(made.overlays.map((w) => w.ignoreMouse), [false, false]);
  assert.ok(shortcuts.has(PANIC_SHORTCUT));

  // Starting twice is a no-op, not a second set of sheets over the first.
  assert.deepEqual(session.start(), { ok: true, active: true, displays: 2 });
  assert.equal(made.overlays.length, 2);
});

test('pausing drawing hands the mouse back to whatever is underneath', () => {
  const { session, made } = harness();
  session.start();

  session.setDrawing(false);
  assert.deepEqual(made.overlays.map((w) => w.ignoreMouse), [true, true]);
  assert.equal(session.state().drawing, false);

  session.setDrawing(true);
  assert.deepEqual(made.overlays.map((w) => w.ignoreMouse), [false, false]);
});

test('stop destroys every window on every monitor and releases the hotkey', () => {
  // Three monitors, because the bug this pins only appears past the first two:
  // destroying window one fires its own 'closed', which re-enters stop(), and
  // an implementation that trusted `active` alone would return early and leave
  // monitors two and three still covered by an invisible sheet.
  const { session, made, shortcuts, screenEvents } = harness({
    displays: [
      { id: 1, bounds: { x: 0, y: 0, width: 1920, height: 1080 } },
      { id: 2, bounds: { x: 1920, y: 0, width: 1920, height: 1080 } },
      { id: 3, bounds: { x: -1920, y: 0, width: 1920, height: 1080 } },
    ],
  });
  session.start();
  assert.equal(made.overlays.length, 3);

  assert.deepEqual(session.stop(), { ok: true, active: false });
  assert.deepEqual(made.overlays.map((w) => w.destroyed), [true, true, true]);
  assert.equal(made.toolbars[0].destroyed, true);
  assert.equal(shortcuts.has(PANIC_SHORTCUT), false);
  assert.equal(session.isActive(), false);
  assert.equal(session.state().displays, 0);
  // No display listeners left behind to resurrect anything.
  [...screenEvents.values()].forEach((list) => assert.deepEqual(list, []));

  // Stopping when nothing is running is safe and silent.
  assert.deepEqual(session.stop(), { ok: true, active: false });
});

test('the global hotkey really tears the session down', () => {
  const { session, made, shortcuts } = harness();
  session.start();
  shortcuts.get(PANIC_SHORTCUT)();
  assert.equal(session.isActive(), false);
  assert.deepEqual(made.overlays.map((w) => w.destroyed), [true, true]);
});

test('a hotkey another app already owns does not stop the feature working', () => {
  // Losing the third escape hatch is acceptable; refusing to start because a
  // hotkey is taken is not. The toolbar Stop button and Escape still work.
  const { session, made } = harness({ shortcutTaken: true });
  assert.equal(session.start().ok, true);
  assert.equal(made.overlays.length, 2);
  assert.equal(session.stop().ok, true);
});

test('a window dying on its own ends the whole session', () => {
  // A GPU crash, or a monitor pulled out mid-call. One sheet gone and the rest
  // still up is a half-covered screen with a toolbar that lies about it.
  const { session, made } = harness();
  session.start();
  made.overlays[0].destroy();
  assert.equal(session.isActive(), false);
  assert.equal(made.overlays[1].destroyed, true);
  assert.equal(made.toolbars[0].destroyed, true);
});

test('losing the toolbar ends the session rather than leaving no way out', () => {
  const { session, made } = harness();
  session.start();
  made.toolbars[0].destroy();
  assert.equal(session.isActive(), false);
  assert.deepEqual(made.overlays.map((w) => w.destroyed), [true, true]);
});

test('start fails cleanly and leaves nothing behind when no monitor is readable', () => {
  const { session, made } = harness({ displays: [{ id: 1, bounds: { x: 0, y: 0, width: 4, height: 4 } }] });
  assert.deepEqual(session.start(), { ok: false, active: false, code: 'no_display' });
  assert.equal(session.isActive(), false);
  assert.deepEqual(made.overlays, []);
});

test('a controller with no Electron injected refuses instead of half-starting', () => {
  const session = createScreenAnnotate();
  assert.deepEqual(session.start(), { ok: false, active: false, code: 'unavailable' });
  assert.deepEqual(session.stop(), { ok: true, active: false });
  assert.equal(session.ownsSender(1), false);
});

/* ------------------------------------------------------------------ */
/* Trust boundary                                                       */
/* ------------------------------------------------------------------ */

test('only windows this process created may drive the toolbar channels', () => {
  const { session, made } = harness();
  session.start();

  assert.equal(session.ownsSender(made.overlays[0].webContents.id), true);
  assert.equal(session.ownsSender(made.toolbars[0].webContents.id), true);
  assert.equal(session.ownsSender(999999), false); // a random renderer
  assert.equal(session.ownsSender(null), false);
  assert.equal(session.ownsSender(undefined), false);

  const overlayId = made.overlays[0].webContents.id;
  session.stop();
  // After the windows are gone the ids stop being trusted, so a late message
  // from a dead renderer cannot command anything.
  assert.equal(session.ownsSender(overlayId), false);
});

/* ------------------------------------------------------------------ */
/* Marks                                                                */
/* ------------------------------------------------------------------ */

test('undo targets the monitor the newest mark was drawn on', () => {
  const { session, made } = harness();
  session.start();
  const [left, right] = made.overlays;

  session.recordStroke(left.webContents.id);
  session.recordStroke(right.webContents.id);
  assert.equal(session.state().marks, 2);

  session.undo();
  assert.deepEqual(right.sent.filter(([c]) => c === 'hl-overlay-undo').length, 1);
  assert.deepEqual(left.sent.filter(([c]) => c === 'hl-overlay-undo').length, 0);

  session.undo();
  assert.deepEqual(left.sent.filter(([c]) => c === 'hl-overlay-undo').length, 1);

  // Undo with nothing left is a no-op, not an error and not a stray message.
  assert.deepEqual(session.undo(), { ok: true, marks: 0 });
  assert.equal(left.sent.filter(([c]) => c === 'hl-overlay-undo').length, 1);
});

test('a stroke reported by a stranger is not counted', () => {
  const { session } = harness();
  session.start();
  assert.deepEqual(session.recordStroke(424242), { ok: false });
  assert.equal(session.state().marks, 0);
});

test('clear wipes every monitor and resets the undo history', () => {
  const { session, made } = harness();
  session.start();
  session.recordStroke(made.overlays[0].webContents.id);
  session.recordStroke(made.overlays[1].webContents.id);

  assert.deepEqual(session.clear(), { ok: true, marks: 0 });
  made.overlays.forEach((win) => {
    assert.equal(win.sent.filter(([c]) => c === 'hl-overlay-clear').length, 1);
  });
  session.undo();
  made.overlays.forEach((win) => {
    assert.equal(win.sent.filter(([c]) => c === 'hl-overlay-undo').length, 0);
  });
});

test('only a real six-digit hex colour reaches the sheets', () => {
  const { session, made } = harness();
  session.start();

  assert.equal(session.setColor('#c65b4e').ok, true);
  assert.equal(session.setColor('red').ok, false);
  assert.equal(session.setColor('#fff').ok, false);
  assert.equal(session.setColor('javascript:alert(1)').ok, false);
  assert.equal(session.setColor(null).ok, false);

  const colors = made.overlays[0].sent.filter(([c]) => c === 'hl-overlay-color');
  assert.deepEqual(colors, [['hl-overlay-color', '#c65b4e']]);
});

test('commands are ignored entirely when the session is not running', () => {
  const { session } = harness();
  assert.deepEqual(session.setDrawing(true), { ok: false, active: false });
  assert.deepEqual(session.undo(), { ok: false, active: false });
  assert.deepEqual(session.clear(), { ok: false, active: false });
  assert.deepEqual(session.setColor('#c65b4e'), { ok: false, active: false });
});

/* ------------------------------------------------------------------ */
/* Monitors changing mid-session                                        */
/* ------------------------------------------------------------------ */

test('plugging a monitor in re-covers the desk and keeps the drawing state', () => {
  const h = harness();
  h.session.start();
  h.session.setDrawing(false);
  const firstSet = h.made.overlays.slice();

  h.displays.push({ id: 3, bounds: { x: 1920, y: 0, width: 1280, height: 720 } });
  h.screenEvents.get('display-added').forEach((fn) => fn());

  firstSet.forEach((win) => assert.equal(win.destroyed, true));
  const current = h.made.overlays.slice(2);
  assert.equal(current.length, 3);
  assert.deepEqual(current.map((w) => w.plan.displayId), [1, 2, 3]);
  // Paused stays paused across the rebuild — a rebuild that silently re-armed
  // the sheets would take the mouse back without anyone asking.
  assert.deepEqual(current.map((w) => w.ignoreMouse), [true, true, true]);
  assert.equal(h.session.isActive(), true);
});

test('unplugging the last monitor stops rather than orphaning windows', () => {
  const h = harness();
  h.session.start();
  h.displays.length = 0;
  h.screenEvents.get('display-removed').forEach((fn) => fn());
  assert.equal(h.session.isActive(), false);
  h.made.overlays.forEach((win) => assert.equal(win.destroyed, true));
});

test('the page is told every time the mode turns on or off', () => {
  const h = harness();
  h.session.start();
  h.session.setDrawing(false);
  h.session.stop();
  assert.equal(h.states[0].active, true);
  assert.equal(h.states.at(-1).active, false);
  assert.equal(h.states.at(-1).drawing, false);
});
