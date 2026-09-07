'use strict';

/**
 * Hold-to-talk arming — the real "Talk to Reina" button.
 *
 * armFromClick only ever armed native recognition for a trusted `click` on
 * button.reina-pilot-voice-start -- the secondary "Enable Hands-free"
 * button. The REAL production control users press and hold, #rnaVoice
 * (class rnaVoiceButton), is bound on pointerdown/keydown in
 * reina-pilot-host.js, not click -- and its pointerdown handler calls
 * event.preventDefault(), which in Chromium suppresses the synthesized
 * click that would otherwise follow. So armFromClick could never arm for
 * that button under any circumstance: recognizeOnce() always failed closed
 * with permission_denied, and reina-pilot-host.js's beginHoldToTalk() fell
 * back to the browser's own network-dependent SpeechRecognition instead of
 * this offline native path.
 *
 * armFromHoldGesture is the equivalent gate for the real button's real
 * gesture: a trusted pointerdown (primary button) or a trusted, non-repeat
 * keydown of Space/Enter, matched against #rnaVoice or .rnaVoiceButton.
 *
 * H1  a real pointerdown on #rnaVoice arms a token that reaches native
 *     recognition
 * H2  a real keydown (Space) on #rnaVoice arms a token too
 * H3  an untrusted or wrong-button event does not arm anything
 * H4  the SHIPPED inline preload.js copy carries the same gate
 */

const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const assert = require('node:assert/strict');

const { createPreloadSpeechBridge, HOLD_TO_TALK_SELECTOR } = require('../src/preload-speech');

function realVoiceButton() {
  return { disabled: false, isConnected: true };
}

function holdToTalkPointerDown(overrides = {}) {
  const button = realVoiceButton();
  return Object.assign(
    {
      isTrusted: true,
      type: 'pointerdown',
      button: 0,
      target: {
        closest: (selector) => (selector === HOLD_TO_TALK_SELECTOR ? button : null),
      },
    },
    overrides
  );
}

function holdToTalkKeyDown(key, overrides = {}) {
  const button = realVoiceButton();
  return Object.assign(
    {
      isTrusted: true,
      type: 'keydown',
      key,
      repeat: false,
      target: {
        closest: (selector) => (selector === HOLD_TO_TALK_SELECTOR ? button : null),
      },
    },
    overrides
  );
}

/* ------------------------------------------------------------------ */
/* H1 — a real pointerdown on #rnaVoice reaches native recognition     */
/* ------------------------------------------------------------------ */

test('H1: a trusted pointerdown on the real Talk-to-Reina button arms a token that reaches native recognition', async () => {
  let armedToken = null;
  let invokedToken = null;
  const bridge = createPreloadSpeechBridge({
    armSynchronously: (token) => { armedToken = token; return true; },
    invoke: async (channel, token) => {
      invokedToken = token;
      return { ok: true, transcript: 'What needs attention today?' };
    },
    randomValues: (bytes) => bytes.fill(5),
  });

  assert.equal(bridge.armFromHoldGesture(holdToTalkPointerDown()), true);
  assert.match(armedToken, /^[a-f0-9]{32}$/);
  assert.deepEqual(await bridge.recognizeOnce(), {
    ok: true,
    transcript: 'What needs attention today?',
  });
  assert.equal(invokedToken, armedToken);
});

/* ------------------------------------------------------------------ */
/* H2 — the keyboard hold-to-talk equivalent (Space/Enter) also arms   */
/* ------------------------------------------------------------------ */

test('H2: a trusted Space keydown on the real button arms a token the same way', async () => {
  let armedToken = null;
  const bridge = createPreloadSpeechBridge({
    armSynchronously: (token) => { armedToken = token; return true; },
    invoke: async () => ({ ok: true, transcript: 'hello' }),
    randomValues: (bytes) => bytes.fill(6),
  });

  assert.equal(bridge.armFromHoldGesture(holdToTalkKeyDown(' ')), true);
  assert.match(armedToken, /^[a-f0-9]{32}$/);

  // An Enter keydown arms the same way; a repeated keydown (holding the key)
  // and any other key must not.
  const bridge2 = createPreloadSpeechBridge({
    armSynchronously: () => true,
    invoke: async () => ({ ok: true, transcript: 'x' }),
    randomValues: (bytes) => bytes.fill(7),
  });
  assert.equal(bridge2.armFromHoldGesture(holdToTalkKeyDown('Enter')), true);
  assert.equal(bridge2.armFromHoldGesture(holdToTalkKeyDown(' ', { repeat: true })), false);
  assert.equal(bridge2.armFromHoldGesture(holdToTalkKeyDown('a')), false);
});

/* ------------------------------------------------------------------ */
/* H3 — only a real, trusted press on the real control may arm         */
/* ------------------------------------------------------------------ */

test('H3: an untrusted event, a non-primary pointer button, or the wrong target never arms', async () => {
  let armed = false;
  const bridge = createPreloadSpeechBridge({
    armSynchronously: () => { armed = true; return true; },
    invoke: async () => ({ ok: true, transcript: 'x' }),
    randomValues: (bytes) => bytes.fill(1),
  });

  assert.equal(bridge.armFromHoldGesture(holdToTalkPointerDown({ isTrusted: false })), false);
  assert.equal(armed, false);

  assert.equal(bridge.armFromHoldGesture(holdToTalkPointerDown({ button: 2 })), false);
  assert.equal(armed, false);

  assert.equal(
    bridge.armFromHoldGesture({
      isTrusted: true, type: 'pointerdown', button: 0,
      target: { closest: () => null },
    }),
    false
  );
  assert.equal(armed, false);

  // A synthesized click must not arm the hold-to-talk gate either -- that is
  // armFromClick's job, for a different button.
  assert.equal(bridge.armFromHoldGesture({ isTrusted: true, type: 'click', button: 0 }), false);
  assert.equal(armed, false);

  // Nothing armed above, so recognizeOnce() must fail closed.
  assert.deepEqual(await bridge.recognizeOnce(), { ok: false, code: 'permission_denied' });
});

/* ------------------------------------------------------------------ */
/* H4 — the SHIPPED inline preload.js copy carries the same gate       */
/* ------------------------------------------------------------------ */

test('H4: the inline preload.js copy exposes armFromHoldGesture wired to pointerdown and keydown', () => {
  const preloadSource = fs.readFileSync(path.join(__dirname, '..', 'src', 'preload.js'), 'utf8');
  assert.match(preloadSource, /function armFromHoldGesture\(event\)/,
    'preload.js must carry its own copy of armFromHoldGesture, same as armFromClick');
  assert.match(preloadSource, /HOLD_TO_TALK_SELECTOR/,
    'the real button selector must be present in the shipped bridge');
  assert.match(
    preloadSource,
    /window\.addEventListener\('pointerdown', \(event\) => \{\s*speechBridge\.armFromHoldGesture\(event\);/,
    'a capture-phase pointerdown listener must arm before the button\'s own handler starts recognition'
  );
  assert.match(
    preloadSource,
    /window\.addEventListener\('keydown', \(event\) => \{\s*speechBridge\.armFromHoldGesture\(event\);/,
    'the keyboard hold-to-talk equivalent (Space/Enter) must be armed too'
  );
});
