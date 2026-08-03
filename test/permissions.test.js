'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  TRUSTED_APP_ORIGIN,
  installAudioPermissionPolicy,
  isAllowedAudioPermissionCheck,
  isAllowedAudioPermissionRequest,
  isTrustedIpcSender,
} = require('../src/permissions');

test('allows exact audio-only requests from the trusted HiveLogic origin', () => {
  assert.equal(
    isAllowedAudioPermissionRequest('media', {
      requestingUrl: `${TRUSTED_APP_ORIGIN}/command-center`,
      mediaTypes: ['audio'],
    }),
    true
  );
  assert.equal(
    isAllowedAudioPermissionCheck(
      'media',
      TRUSTED_APP_ORIGIN,
      { mediaType: 'audio' }
    ),
    true
  );
});

test('denies video, mixed media, other permissions, and untrusted origins', () => {
  const request = (permission, requestingUrl, mediaTypes) =>
    isAllowedAudioPermissionRequest(permission, { requestingUrl, mediaTypes });

  assert.equal(request('media', TRUSTED_APP_ORIGIN, ['video']), false);
  assert.equal(request('media', TRUSTED_APP_ORIGIN, ['audio', 'video']), false);
  assert.equal(request('geolocation', TRUSTED_APP_ORIGIN, ['audio']), false);
  assert.equal(request('media', 'https://example.com', ['audio']), false);
  assert.equal(request('media', 'https://hivelogic-live.vercel.app.evil.test', ['audio']), false);
  assert.equal(request('media', 'file:///offline.html', ['audio']), false);
});

test('installed Electron handlers fail closed and invoke request callback once', () => {
  let requestHandler;
  let checkHandler;
  installAudioPermissionPolicy({
    setPermissionRequestHandler(value) {
      requestHandler = value;
    },
    setPermissionCheckHandler(value) {
      checkHandler = value;
    },
  });

  const results = [];
  requestHandler(
    null,
    'media',
    (allowed) => results.push(allowed),
    { requestingUrl: TRUSTED_APP_ORIGIN, mediaTypes: ['audio'] }
  );
  requestHandler(
    null,
    'media',
    (allowed) => results.push(allowed),
    { requestingUrl: TRUSTED_APP_ORIGIN, mediaTypes: ['video'] }
  );
  assert.deepEqual(results, [true, false]);
  assert.equal(
    checkHandler(null, 'media', TRUSTED_APP_ORIGIN, { mediaType: 'audio' }),
    true
  );
  assert.equal(checkHandler(null, 'media', TRUSTED_APP_ORIGIN, {}), false);
});

test('IPC sender trust is exact-origin and descriptor failures fail closed', () => {
  assert.equal(
    isTrustedIpcSender({ senderFrame: { url: `${TRUSTED_APP_ORIGIN}/` } }),
    true
  );
  assert.equal(
    isTrustedIpcSender({ senderFrame: { url: 'https://example.com/' } }),
    false
  );
  assert.equal(
    isTrustedIpcSender({
      get senderFrame() {
        throw new Error('SECRET');
      },
    }),
    false
  );
});
