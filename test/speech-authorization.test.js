'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { createSpeechAuthorization } = require('../src/speech-authorization');

test('speech authorization is owner-bound, one-shot, and short-lived', () => {
  let time = 100;
  const authorization = createSpeechAuthorization({ now: () => time, maxAgeMs: 20 });
  const token = 'a'.repeat(32);
  assert.equal(authorization.arm(7, token), true);
  assert.equal(authorization.consume(8, token), false);
  assert.equal(authorization.consume(7, token), false);

  assert.equal(authorization.arm(7, token), true);
  assert.equal(authorization.consume(7, token), true);
  assert.equal(authorization.consume(7, token), false);

  assert.equal(authorization.arm(7, token), true);
  time = 121;
  assert.equal(authorization.consume(7, token), false);
  assert.equal(authorization.arm(7, 'not-a-token'), false);
});
