'use strict';

const DEFAULT_MAX_AGE_MS = 2_000;
const TOKEN_PATTERN = /^[a-f0-9]{32}$/;

function createSpeechAuthorization(options = {}) {
  const now = options.now || Date.now;
  const maxAgeMs = options.maxAgeMs || DEFAULT_MAX_AGE_MS;
  let armed = null;

  function arm(ownerId, token) {
    armed = null;
    if (!Number.isSafeInteger(ownerId) || ownerId < 0) return false;
    if (typeof token !== 'string' || !TOKEN_PATTERN.test(token)) return false;
    armed = { ownerId, token, expiresAt: now() + maxAgeMs };
    return true;
  }

  function consume(ownerId, token) {
    const candidate = armed;
    armed = null;
    return Boolean(
      candidate &&
      candidate.ownerId === ownerId &&
      candidate.token === token &&
      candidate.expiresAt >= now()
    );
  }

  function clear() {
    armed = null;
  }

  return Object.freeze({ arm, consume, clear });
}

module.exports = {
  DEFAULT_MAX_AGE_MS,
  TOKEN_PATTERN,
  createSpeechAuthorization,
};
