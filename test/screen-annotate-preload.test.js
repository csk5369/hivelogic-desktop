'use strict';

/**
 * The three preload bridges for screen markup, run as real script text in a
 * sandbox that only offers `electron` — the same shape as
 * preload-runtime.test.js, for the same reason: a preload that reaches for a
 * local require is fine in `node --test` and dead in a packaged app.
 *
 * What is actually being pinned:
 *   - the page-facing bridge reduces everything the main process says down to
 *     plain booleans, and never throws at page script;
 *   - the sheet's bridge cannot stop, clear or recolour anything (least
 *     privilege — the toolbar is the window with the buttons);
 *   - both sides' channel names match what src/main.js listens on, so a rename
 *     fails here rather than as buttons that do nothing.
 */

const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const test = require('node:test');
const assert = require('node:assert/strict');

const SRC = path.join(__dirname, '..', 'src');

function runPreload(file, ipcRenderer, expectedGlobal) {
  const filename = path.join(SRC, file);
  const source = fs.readFileSync(filename, 'utf8');
  const imports = Array.from(source.matchAll(/require\((['"])(.*?)\1\)/g), (m) => m[2]);
  assert.deepEqual(imports, ['electron'], `${file} must import electron and nothing else`);

  let exposed;
  const context = vm.createContext({
    console,
    Object,
    Reflect,
    Set,
    Uint8Array,
    window: { crypto: { getRandomValues: (b) => b.fill(7) }, addEventListener() {} },
    document: {
      body: null,
      createElement: () => ({ style: {}, remove() {} }),
      documentElement: { appendChild() {} },
      getElementById: () => null,
    },
    require(id) {
      if (id !== 'electron') throw new Error(`sandbox blocked local import: ${id}`);
      return {
        contextBridge: {
          exposeInMainWorld(name, value) {
            if (name === expectedGlobal) exposed = value;
          },
        },
        ipcRenderer,
      };
    },
  });
  vm.runInContext(source, context, { filename });
  assert.ok(exposed, `${file} exposed no ${expectedGlobal}`);
  return exposed;
}

test('the page bridge starts, stops and reports the mode as plain booleans', async () => {
  const invoked = [];
  let reply = { ok: true, active: true, drawing: true, displays: 2, secret: 'must not cross' };
  const listeners = [];
  const bridge = runPreload(
    'preload.js',
    {
      invoke: async (channel) => {
        invoked.push(channel);
        return reply;
      },
      on: (channel, fn) => listeners.push([channel, fn]),
      removeListener: () => {},
      sendSync: () => false,
    },
    'hivelogicDesktop'
  );

  assert.equal(typeof bridge.startScreenAnnotate, 'function');
  assert.equal(typeof bridge.stopScreenAnnotate, 'function');
  assert.equal(typeof bridge.screenAnnotateState, 'function');
  assert.equal(typeof bridge.onScreenAnnotateState, 'function');

  // Only ok/active/drawing survive the trip. `displays` and anything else the
  // main process happens to return stays in the main process.
  // JSON, not deepEqual: these objects are built inside the vm realm, so a
  // structural comparison fails on prototype identity alone.
  assert.equal(
    JSON.stringify(await bridge.startScreenAnnotate()),
    JSON.stringify({ ok: true, active: true, drawing: true })
  );
  reply = { ok: true, active: false };
  assert.equal(
    JSON.stringify(await bridge.stopScreenAnnotate()),
    JSON.stringify({ ok: true, active: false, drawing: false })
  );
  assert.deepEqual(invoked, ['hl-screen-annotate-start', 'hl-screen-annotate-stop']);

  // A denied or crashed main process must read as "off", never as an
  // exception thrown into Cowork's click handler.
  reply = Promise.reject(new Error('RAW ELECTRON ERROR'));
  assert.equal(
    JSON.stringify(await bridge.screenAnnotateState()),
    JSON.stringify({ ok: false, active: false, drawing: false })
  );

  const seen = [];
  const off = bridge.onScreenAnnotateState((state) => seen.push(state));
  assert.equal(typeof off, 'function');
  // preload.js already listens for the offline banner and the update pill at
  // module scope, so this is the newest subscription, not the only one.
  assert.deepEqual(listeners.at(-1)[0], 'hl-screen-annotate-state');
  listeners.at(-1)[1](null, { active: true, drawing: false, extra: 'dropped' });
  assert.equal(
    JSON.stringify(seen),
    JSON.stringify([{ ok: true, active: true, drawing: false }])
  );
  assert.equal(typeof bridge.onScreenAnnotateState('not a function'), 'function');
});

test('the sheet bridge can report a mark and bail out, and nothing else', () => {
  const sent = [];
  const bridge = runPreload(
    'overlay/overlay-preload.js',
    {
      send: (channel, payload) => sent.push([channel, payload]),
      on: () => {},
      removeListener: () => {},
    },
    'hlOverlay'
  );

  bridge.strokeAdded();
  bridge.panicStop();
  assert.deepEqual(sent.map((entry) => entry[0]), ['hl-overlay-stroke', 'hl-overlay-panic']);
  assert.deepEqual(sent.map((entry) => entry[1]), [undefined, undefined]);

  // Least privilege: the sheet is not the window with the buttons.
  ['setDrawing', 'setColor', 'undo', 'clear', 'stop'].forEach((name) => {
    assert.equal(bridge[name], undefined, `hlOverlay must not expose ${name}`);
  });
});

test('the toolbar bridge sends exactly the channels main.js listens on', () => {
  const sent = [];
  const bridge = runPreload(
    'overlay/toolbar-preload.js',
    {
      send: (channel, payload) => sent.push([channel, payload]),
      on: () => {},
      removeListener: () => {},
    },
    'hlToolbar'
  );

  bridge.setDrawing(true);
  bridge.setDrawing('yes');   // anything not exactly true is off
  bridge.setColor('#c65b4e');
  bridge.undo();
  bridge.clear();
  bridge.stop();
  assert.deepEqual(sent.map((entry) => entry[0]), [
    'hl-overlay-set-drawing',
    'hl-overlay-set-drawing',
    'hl-overlay-set-color',
    'hl-overlay-undo-request',
    'hl-overlay-clear-request',
    'hl-overlay-panic',
  ]);
  assert.deepEqual(sent.map((entry) => entry[1]), [true, false, '#c65b4e', undefined, undefined, undefined]);
});

test('main.js listens on every channel the bridges send, and guards them all', () => {
  // The cheap version of an integration test: a typo in a channel name is a
  // dead button, and a missing guard is a web page that can cover somebody's
  // whole screen. Both are caught by reading the wiring.
  const main = fs.readFileSync(path.join(SRC, 'main.js'), 'utf8');

  // The page's three channels are gated on the real HiveLogic origin in the
  // real main window, exactly like Reina Voice.
  ['hl-screen-annotate-start', 'hl-screen-annotate-stop', 'hl-screen-annotate-state'].forEach((channel) => {
    const handler = main.split(`ipcMain.handle('${channel}'`)[1];
    assert.ok(handler, `main.js does not handle ${channel}`);
    assert.ok(
      handler.slice(0, 200).includes('trustedMainSender(event)'),
      `${channel} is not gated on trustedMainSender`
    );
  });

  // Our own overlay windows are gated on identity instead, because they are
  // local file:// pages and could never pass an origin check.
  [
    'hl-overlay-stroke',
    'hl-overlay-set-drawing',
    'hl-overlay-set-color',
    'hl-overlay-undo-request',
    'hl-overlay-clear-request',
    'hl-overlay-panic',
  ].forEach((channel) => {
    const handler = main.split(`ipcMain.on('${channel}'`)[1];
    assert.ok(handler, `main.js does not listen on ${channel}`);
    assert.ok(
      handler.slice(0, 200).includes('overlaySender(event)'),
      `${channel} is not gated on overlaySender`
    );
  });

  // Closing HiveLogic, or quitting, must take the sheets with it — otherwise
  // 'window-all-closed' never fires and the app lives on behind an invisible
  // always-on-top layer with no window left to reach it from.
  assert.ok(main.includes("mainWindow.on('closed'"));
  assert.equal((main.match(/stopScreenAnnotate\(\)/g) || []).length >= 3, true);
  assert.ok(main.includes("app.on('will-quit'"));
  assert.ok(main.includes('globalShortcut.unregisterAll()'));
});
