'use strict';

const VOICE_START_SELECTOR = 'button.reina-pilot-voice-start';
const MAX_TRANSCRIPT_CHARS = 1000;
const FAILURE_CODES = new Set([
  'no_speech',
  'os_microphone_denied',
  'permission_denied',
  'unavailable',
  'timeout',
  'canceled',
  'recognition_error',
]);

function ownData(object, key) {
  if (!object || typeof object !== 'object') return undefined;
  let descriptor;
  try {
    descriptor = Object.getOwnPropertyDescriptor(object, key);
  } catch (_) {
    return undefined;
  }
  return descriptor && Object.prototype.hasOwnProperty.call(descriptor, 'value')
    ? descriptor.value
    : undefined;
}

function hasExactOwnKeys(object, expected) {
  if (!object || typeof object !== 'object') return false;
  try {
    const prototype = Object.getPrototypeOf(object);
    if (prototype !== Object.prototype && prototype !== null) return false;
    const keys = Reflect.ownKeys(object);
    return (
      keys.length === expected.length &&
      expected.every((key) => keys.includes(key))
    );
  } catch (_) {
    return false;
  }
}

function normalizeRecognitionResult(value) {
  const ok = ownData(value, 'ok');
  if (ok === true && hasExactOwnKeys(value, ['ok', 'transcript'])) {
    const transcript = ownData(value, 'transcript');
    if (
      typeof transcript === 'string' &&
      transcript.length > 0 &&
      transcript.length <= MAX_TRANSCRIPT_CHARS &&
      transcript === transcript.trim() &&
      !/[\u0000-\u001f\u007f-\u009f]/.test(transcript)
    ) {
      return { ok: true, transcript };
    }
  }

  if (ok === false && hasExactOwnKeys(value, ['ok', 'code'])) {
    const code = ownData(value, 'code');
    if (FAILURE_CODES.has(code)) return { ok: false, code };
  }
  return { ok: false, code: 'recognition_error' };
}

function normalizeCancelResult(value) {
  if (!hasExactOwnKeys(value, ['ok'])) return { ok: false };
  return ownData(value, 'ok') === true ? { ok: true } : { ok: false };
}

function createToken(randomValues) {
  const bytes = new Uint8Array(16);
  randomValues(bytes);
  return Array.from(bytes, (value) => value.toString(16).padStart(2, '0')).join('');
}

function createPreloadSpeechBridge(options) {
  const invoke = options.invoke;
  const armSynchronously = options.armSynchronously;
  const randomValues = options.randomValues;
  let pendingToken = null;

  function armFromClick(event) {
    pendingToken = null;
    try {
      if (!event || event.isTrusted !== true || event.button !== 0) return false;
      const target = event.target;
      const button = target && target.closest(VOICE_START_SELECTOR);
      if (!button || button.disabled === true || button.isConnected !== true) {
        return false;
      }
      const token = createToken(randomValues);
      if (armSynchronously(token) !== true) return false;
      pendingToken = token;
      return true;
    } catch (_) {
      pendingToken = null;
      return false;
    }
  }

  async function recognizeOnce() {
    const token = pendingToken;
    pendingToken = null;
    if (!token) return { ok: false, code: 'permission_denied' };
    try {
      return normalizeRecognitionResult(
        await invoke('hl-native-speech-recognize-once', token)
      );
    } catch (_) {
      return { ok: false, code: 'recognition_error' };
    }
  }

  async function cancelRecognition() {
    // FIX (voice regression): see src/preload.js — a stale cancel must not
    // clear a freshly click-armed token (single-use + 2s TTL in main).
    try {
      return normalizeCancelResult(await invoke('hl-native-speech-cancel'));
    } catch (_) {
      return { ok: false };
    }
  }

  return Object.freeze({ armFromClick, recognizeOnce, cancelRecognition });
}

module.exports = {
  FAILURE_CODES,
  VOICE_START_SELECTOR,
  createPreloadSpeechBridge,
  normalizeCancelResult,
  normalizeRecognitionResult,
};
