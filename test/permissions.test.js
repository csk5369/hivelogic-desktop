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

test('permission-check handler also allows video (camera), gated by origin', () => {
  assert.equal(
    isAllowedAudioPermissionCheck('media', TRUSTED_APP_ORIGIN, { mediaType: 'video' }),
    true
  );
  assert.equal(
    isAllowedAudioPermissionCheck('media', 'https://example.com', { mediaType: 'video' }),
    false
  );
  assert.equal(
    isAllowedAudioPermissionCheck('media', TRUSTED_APP_ORIGIN, { mediaType: 'screen' }),
    false
  );
});

test('allows camera and screen-share requests from the trusted origin, still gated by origin', () => {
  const request = (permission, requestingUrl, mediaTypes) =>
    isAllowedAudioPermissionRequest(permission, { requestingUrl, mediaTypes });

  // Camera: mediaTypes contains 'video', alone or mixed with 'audio'.
  assert.equal(request('media', TRUSTED_APP_ORIGIN, ['video']), true);
  assert.equal(request('media', TRUSTED_APP_ORIGIN, ['audio', 'video']), true);
  // Screen share: this Electron version reports it as an empty mediaTypes array.
  assert.equal(request('media', TRUSTED_APP_ORIGIN, []), true);

  // Same origin gate still applies to the widened cases.
  assert.equal(request('media', 'https://example.com', ['video']), false);
  assert.equal(request('media', 'https://example.com', []), false);
  assert.equal(
    request('media', 'https://hivelogic-live.vercel.app.evil.test', ['video']),
    false
  );
});

test('denies other permissions, untrusted origins, and unrecognized media types', () => {
  const request = (permission, requestingUrl, mediaTypes) =>
    isAllowedAudioPermissionRequest(permission, { requestingUrl, mediaTypes });

  assert.equal(request('geolocation', TRUSTED_APP_ORIGIN, ['audio']), false);
  assert.equal(request('media', 'https://example.com', ['audio']), false);
  assert.equal(request('media', 'https://hivelogic-live.vercel.app.evil.test', ['audio']), false);
  assert.equal(request('media', 'file:///offline.html', ['audio']), false);
  assert.equal(request('media', TRUSTED_APP_ORIGIN, ['screen']), false);
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
  requestHandler(
    null,
    'media',
    (allowed) => results.push(allowed),
    { requestingUrl: TRUSTED_APP_ORIGIN, mediaTypes: [] }
  );
  requestHandler(
    null,
    'media',
    (allowed) => results.push(allowed),
    { requestingUrl: 'https://example.com', mediaTypes: ['video'] }
  );
  assert.deepEqual(results, [true, true, true, false]);
  assert.equal(
    checkHandler(null, 'media', TRUSTED_APP_ORIGIN, { mediaType: 'audio' }),
    true
  );
  assert.equal(
    checkHandler(null, 'media', TRUSTED_APP_ORIGIN, { mediaType: 'video' }),
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
