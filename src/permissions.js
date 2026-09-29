'use strict';

const TRUSTED_APP_ORIGIN = 'https://hivelogic-live.vercel.app';

function readOrigin(value) {
  if (typeof value !== 'string' || value.length > 2048) return null;
  try {
    return new URL(value).origin;
  } catch (_) {
    return null;
  }
}

function isTrustedOrigin(value, trustedOrigin = TRUSTED_APP_ORIGIN) {
  return readOrigin(value) === trustedOrigin;
}

function isTrustedIpcSender(event, trustedOrigin = TRUSTED_APP_ORIGIN) {
  try {
    const senderUrl =
      (event && event.senderFrame && event.senderFrame.url) ||
      (event && event.sender && typeof event.sender.getURL === 'function'
        ? event.sender.getURL()
        : '');
    return isTrustedOrigin(senderUrl, trustedOrigin);
  } catch (_) {
    return false;
  }
}

// Audio-only stays exactly as before. Widened on top of it, still gated to
// the trusted origin:
//   - camera requests: mediaTypes includes 'video' (alone or with 'audio')
//   - screen share requests: mediaTypes is an empty array — confirmed by
//     direct testing to be how this Electron version reports a
//     getDisplayMedia() request, which has no "mediaTypes" of its own.
function isExactAudioMediaRequest(permission, details) {
  if (permission !== 'media' || !details || typeof details !== 'object') {
    return false;
  }

  if (Array.isArray(details.mediaTypes)) {
    return (
      details.mediaTypes.length === 1 &&
      details.mediaTypes[0] === 'audio'
    );
  }

  return details.mediaType === 'audio';
}

function isCameraMediaRequest(permission, details) {
  if (permission !== 'media' || !details || typeof details !== 'object') {
    return false;
  }
  return (
    Array.isArray(details.mediaTypes) && details.mediaTypes.includes('video')
  );
}

function isScreenShareMediaRequest(permission, details) {
  if (permission !== 'media' || !details || typeof details !== 'object') {
    return false;
  }
  return Array.isArray(details.mediaTypes) && details.mediaTypes.length === 0;
}

function isAllowedMediaRequest(permission, details) {
  return (
    isExactAudioMediaRequest(permission, details) ||
    isCameraMediaRequest(permission, details) ||
    isScreenShareMediaRequest(permission, details)
  );
}

function isAllowedAudioPermissionRequest(
  permission,
  details,
  trustedOrigin = TRUSTED_APP_ORIGIN
) {
  if (!isAllowedMediaRequest(permission, details)) return false;
  const requestingUrl = details.requestingUrl || details.securityOrigin || '';
  return isTrustedOrigin(requestingUrl, trustedOrigin);
}

function isAllowedAudioPermissionCheck(
  permission,
  requestingOrigin,
  details,
  trustedOrigin = TRUSTED_APP_ORIGIN
) {
  if (permission !== 'media' || !details || typeof details !== 'object') {
    return false;
  }
  const mediaType = details.mediaType;
  const allowedType = mediaType === 'audio' || mediaType === 'video';
  return allowedType && isTrustedOrigin(requestingOrigin, trustedOrigin);
}

function installAudioPermissionPolicy(
  electronSession,
  trustedOrigin = TRUSTED_APP_ORIGIN
) {
  electronSession.setPermissionRequestHandler(
    (_webContents, permission, callback, details) => {
      let allowed = false;
      try {
        allowed = isAllowedAudioPermissionRequest(
          permission,
          details,
          trustedOrigin
        );
      } catch (_) {
        allowed = false;
      }
      callback(allowed);
    }
  );

  electronSession.setPermissionCheckHandler(
    (_webContents, permission, requestingOrigin, details) => {
      try {
        return isAllowedAudioPermissionCheck(
          permission,
          requestingOrigin,
          details,
          trustedOrigin
        );
      } catch (_) {
        return false;
      }
    }
  );
}

module.exports = {
  TRUSTED_APP_ORIGIN,
  installAudioPermissionPolicy,
  isAllowedAudioPermissionCheck,
  isAllowedAudioPermissionRequest,
  isAllowedMediaRequest,
  isCameraMediaRequest,
  isExactAudioMediaRequest,
  isScreenShareMediaRequest,
  isTrustedIpcSender,
  isTrustedOrigin,
};
