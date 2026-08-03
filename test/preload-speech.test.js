'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  createPreloadSpeechBridge,
  normalizeCancelResult,
  normalizeRecognitionResult,
} = require('../src/preload-speech');

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

test('does not start recognition without a one-shot trusted voice-button click', async () => {
  let calls = 0;
  const bridge = createPreloadSpeechBridge({
    invoke: async () => {
      calls += 1;
      return { ok: true, transcript: 'heard' };
    },
    armSynchronously: () => true,
    randomValues: (bytes) => bytes.fill(1),
  });

  assert.deepEqual(await bridge.recognizeOnce(), {
    ok: false,
    code: 'permission_denied',
  });
  assert.equal(calls, 0);
  assert.equal(bridge.armFromClick({ ...trustedButtonClick(), isTrusted: false }), false);
  assert.equal(bridge.armFromClick(trustedButtonClick()), true);
  assert.deepEqual(await bridge.recognizeOnce(), { ok: true, transcript: 'heard' });
  assert.deepEqual(await bridge.recognizeOnce(), {
    ok: false,
    code: 'permission_denied',
  });
  assert.equal(calls, 1);
});

test('preload catches IPC rejection and strictly validates exact own-data results', async () => {
  const rejecting = createPreloadSpeechBridge({
    invoke: async () => { throw new Error('RAW SECRET'); },
    armSynchronously: () => true,
    randomValues: (bytes) => bytes.fill(2),
  });
  rejecting.armFromClick(trustedButtonClick());
  assert.deepEqual(await rejecting.recognizeOnce(), {
    ok: false,
    code: 'recognition_error',
  });
  assert.deepEqual(await rejecting.cancelRecognition(), { ok: false });

  assert.deepEqual(normalizeRecognitionResult({ ok: true, transcript: 'hello' }), {
    ok: true,
    transcript: 'hello',
  });
  assert.deepEqual(
    normalizeRecognitionResult(Object.create({ ok: true, transcript: 'forged' })),
    { ok: false, code: 'recognition_error' }
  );
  assert.deepEqual(normalizeRecognitionResult({ ok: false, code: 'timeout' }), {
    ok: false,
    code: 'timeout',
  });
  assert.deepEqual(normalizeCancelResult({ ok: true, extra: true }), { ok: false });
});
