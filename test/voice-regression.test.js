'use strict';

/**
 * Voice regression tests — HiveLogic Desktop 1.0.5.
 *
 * Covers the real "Enable Voice" failure reported 2026-08-03:
 * a stale cancelRecognition() cleared the token a trusted click had just
 * armed, so recognizeOnce() reported a false permission_denied
 * ("Microphone access was denied") and the flow died before the mic opened.
 *
 * T1  a real Enable Voice click reaches native recognition
 * T2  a stale cancel does NOT clear the newly armed token (the fix)
 * T3  a Voice failure leaves the purple Reina panel (#rnaPanel) open
 * T4  typed Reina remains usable after a Voice failure
 *
 * T3/T4 drive test/fixtures/reina-pilot-host.js — a byte-exact copy of the
 * reina-pilot-host.js deployed on hivelogic-live.vercel.app (fetched
 * 2026-08-03) — with the desktop bridge faked at globalThis.hivelogicDesktop.
 */

const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const test = require('node:test');
const assert = require('node:assert/strict');

const { createPreloadSpeechBridge } = require('../src/preload-speech');
const { createSpeechAuthorization } = require('../src/speech-authorization');

function trustedButtonClick() {
  const button = { disabled: false, isConnected: true };
  return {
    isTrusted: true,
    button: 0,
    target: {
      closest: (selector) =>
        selector === 'button.reina-pilot-voice-start' ? button : null,
    },
  };
}

/* ------------------------------------------------------------------ */
/* T1 — a real Enable Voice click reaches native recognition           */
/* ------------------------------------------------------------------ */

test('T1: a trusted Enable Voice click arms a token that reaches native recognition', async () => {
  let armedToken = null;
  let invokedChannel = null;
  let invokedToken = null;
  const bridge = createPreloadSpeechBridge({
    armSynchronously: (token) => { armedToken = token; return true; },
    invoke: async (channel, token) => {
      invokedChannel = channel;
      invokedToken = token;
      return { ok: true, transcript: 'What needs attention today?' };
    },
    randomValues: (bytes) => bytes.fill(9),
  });

  assert.equal(bridge.armFromClick(trustedButtonClick()), true);
  assert.match(armedToken, /^[a-f0-9]{32}$/);
  assert.deepEqual(await bridge.recognizeOnce(), {
    ok: true,
    transcript: 'What needs attention today?',
  });
  assert.equal(invokedChannel, 'hl-native-speech-recognize-once');
  assert.equal(invokedToken, armedToken);

  // Main-process side of the same click: the armed authorization is consumable
  // exactly once inside its TTL.
  let now = 1000;
  const auth = createSpeechAuthorization({ now: () => now, maxAgeMs: 2000 });
  assert.equal(auth.arm(7, armedToken), true);
  now = 2500;
  assert.equal(auth.consume(7, armedToken), true);
  assert.equal(auth.consume(7, armedToken), false); // single use
});

/* ------------------------------------------------------------------ */
/* T2 — the fix: a stale cancel must NOT clear the newly armed token   */
/* ------------------------------------------------------------------ */

test('T2: a stale cancelRecognition between arm and recognizeOnce no longer kills the token', async () => {
  const calls = { recognize: 0, cancel: 0 };
  const bridge = createPreloadSpeechBridge({
    armSynchronously: () => true,
    invoke: async (channel) => {
      if (channel === 'hl-native-speech-recognize-once') {
        calls.recognize += 1;
        return { ok: true, transcript: 'still armed after stale cancel' };
      }
      calls.cancel += 1;
      return { ok: true };
    },
    randomValues: (bytes) => bytes.fill(3),
  });

  assert.equal(bridge.armFromClick(trustedButtonClick()), true);
  assert.deepEqual(await bridge.cancelRecognition(), { ok: true }); // the stale cancel
  // BEFORE the fix this returned { ok:false, code:'permission_denied' } and
  // never reached native recognition. That is the exact production bug.
  assert.deepEqual(await bridge.recognizeOnce(), {
    ok: true,
    transcript: 'still armed after stale cancel',
  });
  assert.equal(calls.recognize, 1);
  assert.equal(calls.cancel, 1);
  // The token is still one-shot: a second recognizeOnce is denied.
  assert.deepEqual(await bridge.recognizeOnce(), {
    ok: false,
    code: 'permission_denied',
  });

  // The SHIPPED inline preload copy must carry the same fix.
  const preloadSource = fs.readFileSync(path.join(__dirname, '..', 'src', 'preload.js'), 'utf8');
  const inlineCancel = preloadSource.match(/async function cancelRecognition\(\) \{[\s\S]*?\n  \}/);
  assert.ok(inlineCancel, 'inline cancelRecognition found in preload.js');
  assert.ok(!/pendingToken = null/.test(inlineCancel[0]),
    'preload.js inline cancelRecognition must not clear pendingToken');

  // And the main process must not clear the armed authorization on cancel
  // (window-closed and before-quit teardown still clear it — exactly 2 sites).
  const mainSource = fs.readFileSync(path.join(__dirname, '..', 'src', 'main.js'), 'utf8');
  const cancelHandler = mainSource.match(/ipcMain\.handle\('hl-native-speech-cancel'[\s\S]*?\n\}\);/);
  assert.ok(cancelHandler, 'cancel IPC handler found in main.js');
  assert.ok(!/speechAuthorization\.clear\(\)/.test(cancelHandler[0]),
    'main.js cancel handler must not clear the armed speech authorization');
  assert.equal((mainSource.match(/speechAuthorization\.clear\(\)/g) || []).length, 2,
    'window-closed and before-quit teardown must still clear the authorization');
});

/* ------------------------------------------------------------------ */
/* Harness for T3/T4: the real deployed Reina panel host               */
/* ------------------------------------------------------------------ */

function fakeElement(tag) {
  const classes = new Set();
  const node = {
    tagName: String(tag || 'div').toUpperCase(),
    style: {},
    disabled: false,
    textContent: '',
    value: '',
    type: '',
    children: [],
    isConnected: true,
    onclick: null,
    appendChild(child) { node.children.push(child); return child; },
    addEventListener() {},
    removeEventListener() {},
    setAttribute() {},
    classList: {
      add: (c) => classes.add(c),
      remove: (c) => classes.delete(c),
      contains: (c) => classes.has(c),
    },
  };
  Object.defineProperty(node, 'className', {
    enumerable: true,
    get() { return node._cn || ''; },
    set(v) {
      node._cn = String(v);
      classes.clear();
      node._cn.split(/\s+/).forEach((c) => { if (c) classes.add(c); });
    },
  });
  return node;
}

function settle(ms) { return new Promise((resolve) => setTimeout(resolve, ms)); }

async function mountRealPanelAndFailVoice() {
  const desktopCalls = { recognize: 0, cancel: 0 };
  // The deployed host CAPTURES globalThis.hivelogicDesktop at load time, so the
  // fake desktop bridge must exist before the fixture is required.
  globalThis.hivelogicDesktop = {
    recognizeOnce() {
      desktopCalls.recognize += 1;
      return Promise.resolve({ ok: false, code: 'permission_denied' });
    },
    cancelRecognition() {
      desktopCalls.cancel += 1;
      return Promise.resolve({ ok: true });
    },
  };
  const fixturePath = path.join(__dirname, 'fixtures', 'reina-pilot-host.js');
  delete require.cache[require.resolve(fixturePath)];
  const ReinaPilotHost = require(fixturePath);
  assert.equal(ReinaPilotHost.nativeRecognitionAvailable, true,
    'fixture must capture the desktop native bridge');

  const created = [];
  const page = {
    fab: fakeElement('button'), panel: fakeElement('div'), mode: fakeElement('span'),
    close: fakeElement('button'), feed: fakeElement('div'), input: fakeElement('textarea'),
    send: fakeElement('button'),
  };
  page.send.textContent = 'Send';
  const documentRef = {
    createElement(tag) { const n = fakeElement(tag); created.push(n); return n; },
    getElementById() { return null; },
  };
  const byClass = (name) => created.find((n) => (' ' + (n.className || '') + ' ').indexOf(' ' + name + ' ') !== -1);

  const SID = 'rp.' + 'a'.repeat(64);
  const GEN = '2026-01-01T00:00:00.000Z';
  const uiIntent = {
    version: 'reina.ui-intent.v1', executed: false, requiresConfirmation: true,
    conversationId: SID, turnId: 't1', intentId: 'i1', expiresAt: GEN,
    kind: 'navigate', destination: 'standup', parameters: {},
  };
  const bootstrap = {
    ok: true, sessionId: SID, generatedAt: GEN, user: { displayName: 'Chris' },
    attention: {
      total: 1, asOf: null, reviewAvailable: true,
      categories: [{ key: 'jobs', label: 'Jobs', count: 1, available: true, asOf: GEN, evidence: ['One job'] }],
      unavailableSources: [],
    },
    review: { intentId: 'i1', available: true, expiresAt: GEN },
    uiIntent, executed: false,
  };

  const client = {
    bootstrap: async () => ({ sessionId: SID, bootstrap }),
    submitTurn: async () => ({}),
    confirmReviewIntent: async () => ({ ok: true, intentId: 'i1', executed: false }),
    voiceServerTransport: async () => ({}),
  };
  let typedCount = 0;
  const host = ReinaPilotHost.createReinaPilotHost({
    documentRef,
    elements: page,
    newId: () => 'id-' + Math.random().toString(16).slice(2),
    createClient: () => client,
    createLoginBrief: (opts) => ({
      onAuthenticated() {
        opts.onView({
          state: 'greeted', greeting: 'Hello Chris.',
          attentionSummary: '1 item needs attention.',
          categories: [], unavailableDisclosures: [],
          reviewAvailable: true, question: 'Open the review?',
        });
        return { accepted: true };
      },
      confirmReview: async () => ({ accepted: false }),
      decline() {}, onAuthExpired() {}, onVoiceEnabled() {},
      getGeneration: () => 1, submitVoiceConfirmation: async () => ({}),
    }),
    createTypedPanel: (opts) => ({
      submit(text) {
        typedCount += 1;
        const turnId = 'turn-' + typedCount;
        opts.onView({
          state: 'answered', turnId,
          answer: 'Echo: ' + text,
          executionNotice: 'Synthetic read-only. Nothing was executed.',
        });
        return { accepted: true, turnId };
      },
      retry: () => ({ accepted: false }), reset() {},
    }),
    createIntentRouter: () => ({
      propose: () => ({ accepted: true }),
      confirm: () => ({}), revoke() {}, dispose() {},
    }),
    loadVoiceModules: () => Promise.resolve({
      createVoiceHost: (options) => {
        const factory = options.recognitionFactory;
        let recognition = null;
        return {
          mount: () => true,
          dispose() {},
          isVoiceAvailable: () => typeof factory === 'function',
          startListening() {
            if (typeof factory !== 'function') return false;
            recognition = factory();
            recognition.onerror = function () {};
            recognition.onresult = function () {};
            recognition.onend = function () { recognition = null; };
            try { recognition.start(); } catch (_) { return false; }
            return true;
          },
          stop() { if (recognition) { try { recognition.stop(); } catch (_) {} } },
          interrupt() {},
          emergencyOff() {},
        };
      },
      createVoiceTransport: () => ({ submitTurn: async () => ({}) }),
    }),
  });

  const mounted = await host.mount();
  assert.equal(mounted.ok, true, 'host mounts to ready');
  assert.equal(page.panel.classList.contains('open'), true, 'panel opens on ready');

  // Wait for the voice module install to finish (voiceStart becomes enabled).
  const voiceStart = byClass('reina-pilot-voice-start');
  assert.ok(voiceStart, 'Enable Voice button exists');
  for (let i = 0; i < 100 && voiceStart.disabled; i += 1) await settle(2);
  assert.equal(voiceStart.disabled, false, 'Enable Voice is enabled');

  // A REAL trusted click on Enable Voice.
  assert.equal(typeof voiceStart.onclick, 'function');
  voiceStart.onclick({ isTrusted: true });
  await settle(25); // let the deferred native recognition fail

  return { page, byClass, desktopCalls };
}

/* ------------------------------------------------------------------ */
/* T3 — Voice failure leaves the purple Reina panel open               */
/* ------------------------------------------------------------------ */

test('T3: a native permission_denied failure leaves #rnaPanel open and reports the error in place', async () => {
  const { page, byClass, desktopCalls } = await mountRealPanelAndFailVoice();

  assert.equal(desktopCalls.recognize, 1, 'the click reached native recognition');
  // THE regression: the purple panel must remain open on Voice failure.
  assert.equal(page.panel.classList.contains('open'), true, '#rnaPanel stays open');
  const voiceError = byClass('reina-pilot-voice-error');
  assert.equal(
    voiceError.textContent,
    'Microphone access was denied. Allow microphone access and try again.'
  );
  delete globalThis.hivelogicDesktop;
});

/* ------------------------------------------------------------------ */
/* T4 — typed Reina remains usable after a Voice failure               */
/* ------------------------------------------------------------------ */

test('T4: typed Reina still works after a Voice failure', async () => {
  const { page, byClass } = await mountRealPanelAndFailVoice();

  assert.equal(page.input.disabled, false, 'typed input stays enabled');
  assert.equal(page.send.disabled, false, 'Send stays enabled');

  page.input.value = 'hello reina';
  page.send.onclick();
  await settle(5);

  const bodies = [];
  (function walk(n) {
    if ((' ' + (n.className || '') + ' ').indexOf(' reina-pilot-message-body ') !== -1) bodies.push(n.textContent);
    (n.children || []).forEach(walk);
  })(page.feed);
  assert.ok(bodies.some((t) => t === 'hello reina'), 'user message rendered');
  assert.ok(bodies.some((t) => t.indexOf('Echo: hello reina') === 0), 'assistant reply rendered');
  assert.equal(page.input.value, '', 'input cleared after send');
  assert.equal(page.input.disabled, false, 'typed input usable for the next turn');
  assert.equal(page.panel.classList.contains('open'), true, 'panel still open');
  delete globalThis.hivelogicDesktop;
});
