'use strict';

const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const test = require('node:test');
const assert = require('node:assert/strict');

const PRELOAD_PATH = path.join(__dirname, '..', 'src', 'preload.js');

test('sandbox preload has no local require and exposes native recognition', async () => {
  const source = fs.readFileSync(PRELOAD_PATH, 'utf8');
  const imports = Array.from(source.matchAll(/require\((['"])(.*?)\1\)/g), (match) => match[2]);
  assert.deepEqual(imports, ['electron']);

  const listeners = new Map();
  let exposed;
  let invokeResult = { ok: true, transcript: 'Hello from native speech' };
  const invokedChannels = [];
  const ipcRenderer = {
    invoke: async (channel) => {
      invokedChannels.push(channel);
      return invokeResult;
    },
    on() {},
    sendSync(channel, token) {
      return channel === 'hl-native-speech-arm' && /^[a-f0-9]{32}$/.test(token);
    },
  };
  const window = {
    crypto: { getRandomValues: (bytes) => bytes.fill(7) },
    addEventListener(name, handler, capture) {
      listeners.set(`${name}:${Boolean(capture)}`, handler);
    },
  };
  const document = {
    body: null,
    createElement: () => ({ style: {}, remove() {} }),
    documentElement: { appendChild() {} },
    getElementById: () => null,
  };
  const context = vm.createContext({
    console,
    document,
    Object,
    Reflect,
    Set,
    Uint8Array,
    window,
    require(id) {
      if (id !== 'electron') throw new Error(`sandbox blocked local import: ${id}`);
      return {
        contextBridge: {
          exposeInMainWorld(name, value) {
            assert.equal(name, 'hivelogicDesktop');
            exposed = value;
          },
        },
        ipcRenderer,
      };
    },
  });
  vm.runInContext(source, context, { filename: PRELOAD_PATH });

  assert.equal(typeof exposed.recognizeOnce, 'function');
  assert.equal(typeof exposed.cancelRecognition, 'function');
  assert.equal(typeof exposed.stopWakeWord, 'function');
  assert.equal(typeof exposed.disableWakeWord, 'function');
  await exposed.stopWakeWord();
  await exposed.disableWakeWord();
  assert.deepEqual(invokedChannels.slice(0, 2), [
    'hl-native-wake-cancel',
    'hl-native-wake-disable',
  ]);
  assert.equal(exposed.isDesktop, true);
  assert.equal(
    JSON.stringify(await exposed.recognizeOnce()),
    JSON.stringify({ ok: false, code: 'permission_denied' })
  );

  const click = listeners.get('click:true');
  assert.equal(typeof click, 'function');
  click({
    isTrusted: true,
    button: 0,
    target: {
      closest: (selector) =>
        selector === 'button.reina-pilot-voice-start'
          ? { disabled: false, isConnected: true }
          : null,
    },
  });
  assert.equal(
    JSON.stringify(await exposed.recognizeOnce()),
    JSON.stringify({ ok: true, transcript: 'Hello from native speech' })
  );

  invokeResult = Promise.reject(new Error('RAW ELECTRON ERROR'));
  assert.equal(
    JSON.stringify(await exposed.cancelRecognition()),
    JSON.stringify({ ok: false })
  );
});
