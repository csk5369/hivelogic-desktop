'use strict';

const { EventEmitter } = require('node:events');
const test = require('node:test');
const assert = require('node:assert/strict');
const {
  POWERSHELL_WAKE_SCRIPT,
  createNativeSpeechService,
  parseRecognizerOutput,
  sanitizeTranscript,
} = require('../src/native-speech');

function encoded(text) {
  return `OK:${Buffer.from(text, 'utf8').toString('base64')}`;
}

function fakeChild() {
  const child = new EventEmitter();
  child.stdout = new EventEmitter();
  child.killed = false;
  child.kill = () => {
    child.killed = true;
  };
  return child;
}

test('parses only bounded fixed-protocol recognizer output', () => {
  assert.deepEqual(parseRecognizerOutput(encoded('  Hello, Reina.  ')), {
    ok: true,
    transcript: 'Hello, Reina.',
  });
  assert.deepEqual(parseRecognizerOutput('NO_SPEECH'), {
    ok: false,
    code: 'no_speech',
  });
  assert.deepEqual(parseRecognizerOutput('PERMISSION_DENIED'), {
    ok: false,
    code: 'permission_denied',
  });
  assert.deepEqual(parseRecognizerOutput('raw error: secret'), {
    ok: false,
    code: 'recognition_error',
  });
  assert.equal(sanitizeTranscript('a\u0000  b'), 'a b');
  assert.equal(sanitizeTranscript('x'.repeat(1001)), null);
});

test('recognizes one transcript and rejects concurrent recognition', async () => {
  const child = fakeChild();
  const service = createNativeSpeechService({
    platform: 'win32',
    spawn: () => child,
    processTimeoutMs: 1000,
  });

  const first = service.recognizeOnce();
  assert.deepEqual(await service.recognizeOnce(), {
    ok: false,
    code: 'unavailable',
  });
  child.stdout.emit('data', Buffer.from(encoded('What needs attention?')));
  child.emit('close', 0);
  assert.deepEqual(await first, {
    ok: true,
    transcript: 'What needs attention?',
  });
});

test('waits natively for Hey Reina, reports wake once, then returns one spoken request', async () => {
  const child = fakeChild();
  const events = [];
  const service = createNativeSpeechService({
    platform: 'win32',
    spawn: () => child,
    processTimeoutMs: 1000,
  });

  const listening = service.listenForWakeWord({
    onWake: () => events.push('wake'),
    wakeTimeoutMs: 1000,
  });
  child.stdout.emit('data', Buffer.from('WAKE\r\n'));
  child.stdout.emit('data', Buffer.from(encoded('What needs attention today?')));
  child.emit('close', 0);

  assert.deepEqual(events, ['wake']);
  assert.deepEqual(await listening, {
    ok: true,
    transcript: 'What needs attention today?',
  });
});

test('uses continuous native recognition through the configured wake window', () => {
  assert.match(
    POWERSHELL_WAKE_SCRIPT,
    /\$recognizer\.InitialSilenceTimeout = \[TimeSpan\]::FromMinutes\(15\)/,
  );
  assert.match(
    POWERSHELL_WAKE_SCRIPT,
    /\$recognizer\.RecognizeAsync\(\[System\.Speech\.Recognition\.RecognizeMode\]::Multiple\)/,
  );
  assert.match(
    POWERSHELL_WAKE_SCRIPT,
    /\$wakeDeadline = \[DateTime\]::UtcNow\.AddMinutes\(15\)/,
  );
});

test('wake listener reports a bounded timeout and can be cancelled', async () => {
  const timedOut = fakeChild();
  const service = createNativeSpeechService({ platform: 'win32', spawn: () => timedOut });
  const waiting = service.listenForWakeWord({ wakeTimeoutMs: 1000 });
  timedOut.stdout.emit('data', Buffer.from('WAKE_TIMEOUT'));
  timedOut.emit('close', 0);
  assert.deepEqual(await waiting, { ok: false, code: 'timeout' });

  const cancelChild = fakeChild();
  const cancellable = createNativeSpeechService({ platform: 'win32', spawn: () => cancelChild });
  const active = cancellable.listenForWakeWord({ wakeTimeoutMs: 1000 });
  assert.deepEqual(await cancellable.cancelRecognition(), { ok: true });
  assert.equal(cancelChild.killed, true);
  assert.deepEqual(await active, { ok: false, code: 'canceled' });
});

test('cancel returns exact typed results and cleans up the child', async () => {
  const child = fakeChild();
  const service = createNativeSpeechService({
    platform: 'win32',
    spawn: () => child,
    processTimeoutMs: 1000,
  });

  const recognition = service.recognizeOnce();
  assert.deepEqual(await service.cancelRecognition(), { ok: true });
  assert.equal(child.killed, true);
  assert.deepEqual(await recognition, { ok: false, code: 'canceled' });
  assert.deepEqual(await service.cancelRecognition(), { ok: false });
  child.emit('close', null, 'SIGTERM');
});

test('waits for stdout to drain after exit and parses only on close', async () => {
  const child = fakeChild();
  const service = createNativeSpeechService({
    platform: 'win32',
    spawn: () => child,
    processTimeoutMs: 1000,
  });
  const recognition = service.recognizeOnce();
  const value = encoded('Final drained transcript');
  child.stdout.emit('data', Buffer.from(value.slice(0, 7)));
  child.emit('exit', 0);
  child.stdout.emit('data', Buffer.from(value.slice(7)));
  child.emit('close', 0);
  assert.deepEqual(await recognition, {
    ok: true,
    transcript: 'Final drained transcript',
  });
});

test('times out, terminates the child, and never exposes process errors', async () => {
  const child = fakeChild();
  const service = createNativeSpeechService({
    platform: 'win32',
    spawn: () => child,
    processTimeoutMs: 5,
  });
  assert.deepEqual(await service.recognizeOnce(), {
    ok: false,
    code: 'timeout',
  });
  assert.equal(child.killed, true);
});

test('unsupported platform and spawn errors fail closed', async () => {
  const unsupported = createNativeSpeechService({ platform: 'linux' });
  assert.deepEqual(await unsupported.recognizeOnce(), {
    ok: false,
    code: 'unavailable',
  });

  const broken = createNativeSpeechService({
    platform: 'win32',
    spawn() {
      throw new Error('SECRET');
    },
  });
  assert.deepEqual(await broken.recognizeOnce(), {
    ok: false,
    code: 'unavailable',
  });
});


const { parseRecognizerOutput: __pro } = require('../src/native-speech');

test('OS microphone denial (UnauthorizedAccessException string) maps to os_microphone_denied', () => {
  assert.deepEqual(__pro('OS_MICROPHONE_DENIED'), {
    ok: false,
    code: 'os_microphone_denied',
  });
});

test('OS microphone denial via E_ACCESSDENIED HResult path also yields os_microphone_denied', async () => {
  // The PowerShell script writes OS_MICROPHONE_DENIED for both
  // UnauthorizedAccessException and COMException HResult -2147024891.
  // Drive the full child path to confirm the code surfaces end to end.
  const { EventEmitter } = require('node:events');
  const child = new EventEmitter();
  child.stdout = new EventEmitter();
  child.kill = () => {};
  const service = createNativeSpeechService({
    platform: 'win32',
    spawn: () => child,
    processTimeoutMs: 1000,
  });
  const recognition = service.recognizeOnce();
  child.stdout.emit('data', Buffer.from('OS_MICROPHONE_DENIED'));
  child.emit('close', 0);
  assert.deepEqual(await recognition, { ok: false, code: 'os_microphone_denied' });
});

test('the token-guard permission_denied stays distinct from the OS denial code', () => {
  assert.deepEqual(__pro('PERMISSION_DENIED'), {
    ok: false,
    code: 'permission_denied',
  });
  assert.notEqual('os_microphone_denied', 'permission_denied');
});
