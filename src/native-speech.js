'use strict';

const { spawn: defaultSpawn } = require('child_process');

const MAX_TRANSCRIPT_CHARS = 1000;
const MAX_OUTPUT_BYTES = 16 * 1024;
const DEFAULT_PROCESS_TIMEOUT_MS = 15_000;
const DEFAULT_WAKE_TIMEOUT_MS = 15 * 60_000;
const CLEANUP_TIMEOUT_MS = 1_000;
const FAILURE_CODES = new Set([
  'no_speech',
  'os_microphone_denied',
  'permission_denied',
  'unavailable',
  'timeout',
  'canceled',
  'recognition_error',
]);

const POWERSHELL_SCRIPT = String.raw`
$ErrorActionPreference = 'Stop'
$recognizer = $null
try {
  Add-Type -AssemblyName System.Speech
  $culture = [Globalization.CultureInfo]::GetCultureInfo('en-US')
  $recognizer = New-Object System.Speech.Recognition.SpeechRecognitionEngine($culture)
  $recognizer.LoadGrammar((New-Object System.Speech.Recognition.DictationGrammar))
  $recognizer.InitialSilenceTimeout = [TimeSpan]::FromSeconds(6)
  $recognizer.BabbleTimeout = [TimeSpan]::FromSeconds(3)
  $recognizer.EndSilenceTimeout = [TimeSpan]::FromMilliseconds(750)
  $recognizer.EndSilenceTimeoutAmbiguous = [TimeSpan]::FromMilliseconds(1000)
  $recognizer.SetInputToDefaultAudioDevice()
  $result = $recognizer.Recognize([TimeSpan]::FromSeconds(12))
  if ($null -eq $result -or [String]::IsNullOrWhiteSpace($result.Text)) {
    [Console]::Out.Write('NO_SPEECH')
  } else {
    $bytes = [Text.Encoding]::UTF8.GetBytes($result.Text)
    [Console]::Out.Write('OK:' + [Convert]::ToBase64String($bytes))
  }
} catch [UnauthorizedAccessException] {
  [Console]::Out.Write('OS_MICROPHONE_DENIED')
} catch [System.Runtime.InteropServices.COMException] {
  if ($_.Exception.HResult -eq -2147024891) {
    [Console]::Out.Write('OS_MICROPHONE_DENIED')
  } else {
    [Console]::Out.Write('UNAVAILABLE')
  }
} catch [InvalidOperationException] {
  [Console]::Out.Write('UNAVAILABLE')
} catch [ArgumentException] {
  [Console]::Out.Write('UNAVAILABLE')
} catch [PlatformNotSupportedException] {
  [Console]::Out.Write('UNAVAILABLE')
} catch [System.IO.FileNotFoundException] {
  [Console]::Out.Write('UNAVAILABLE')
} catch {
  [Console]::Out.Write('RECOGNITION_ERROR')
} finally {
  if ($null -ne $recognizer) { $recognizer.Dispose() }
}
`;

// The wake phase is deliberately native and local: Windows listens only for
// the fixed phrase, then the same recognizer captures one following sentence.
// No audio leaves the device through this service.
const POWERSHELL_WAKE_SCRIPT = String.raw`
$ErrorActionPreference = 'Stop'
$recognizer = $null
try {
  Add-Type -AssemblyName System.Speech
  $culture = [Globalization.CultureInfo]::GetCultureInfo('en-US')
  $recognizer = New-Object System.Speech.Recognition.SpeechRecognitionEngine($culture)
  $wakeBuilder = New-Object System.Speech.Recognition.GrammarBuilder
  $wakeBuilder.Append('hey reina')
  $recognizer.LoadGrammar((New-Object System.Speech.Recognition.Grammar($wakeBuilder)))
  $recognizer.SetInputToDefaultAudioDevice()
  $wake = $recognizer.Recognize([TimeSpan]::FromMinutes(15))
  if ($null -eq $wake -or $wake.Text -ine 'hey reina') {
    [Console]::Out.Write('WAKE_TIMEOUT')
  } else {
    [Console]::Out.Write('WAKE' + [Environment]::NewLine)
    $recognizer.UnloadAllGrammars()
    $recognizer.LoadGrammar((New-Object System.Speech.Recognition.DictationGrammar))
    $recognizer.InitialSilenceTimeout = [TimeSpan]::FromSeconds(8)
    $recognizer.BabbleTimeout = [TimeSpan]::FromSeconds(4)
    $recognizer.EndSilenceTimeout = [TimeSpan]::FromMilliseconds(750)
    $question = $recognizer.Recognize([TimeSpan]::FromSeconds(15))
    if ($null -eq $question -or [String]::IsNullOrWhiteSpace($question.Text)) {
      [Console]::Out.Write('NO_SPEECH')
    } else {
      $bytes = [Text.Encoding]::UTF8.GetBytes($question.Text)
      [Console]::Out.Write('OK:' + [Convert]::ToBase64String($bytes))
    }
  }
} catch [UnauthorizedAccessException] {
  [Console]::Out.Write('OS_MICROPHONE_DENIED')
} catch [System.Runtime.InteropServices.COMException] {
  if ($_.Exception.HResult -eq -2147024891) {
    [Console]::Out.Write('OS_MICROPHONE_DENIED')
  } else {
    [Console]::Out.Write('UNAVAILABLE')
  }
} catch {
  [Console]::Out.Write('RECOGNITION_ERROR')
} finally {
  if ($null -ne $recognizer) { $recognizer.Dispose() }
}
`;

function success(transcript) {
  return { ok: true, transcript };
}

function failure(code) {
  return {
    ok: false,
    code: FAILURE_CODES.has(code) ? code : 'recognition_error',
  };
}

function sanitizeTranscript(value) {
  if (typeof value !== 'string') return null;
  const normalized = value
    .replace(/[\u0000-\u001f\u007f-\u009f]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  if (!normalized || normalized.length > MAX_TRANSCRIPT_CHARS) return null;
  return normalized;
}

function parseRecognizerOutput(output) {
  if (typeof output !== 'string' || output.length > MAX_OUTPUT_BYTES) {
    return failure('recognition_error');
  }

  const value = output.trim();
  if (value === 'NO_SPEECH') return failure('no_speech');
  if (value === 'PERMISSION_DENIED') return failure('permission_denied');
  if (value === 'OS_MICROPHONE_DENIED') return failure('os_microphone_denied');
  if (value === 'UNAVAILABLE') return failure('unavailable');
  if (value === 'RECOGNITION_ERROR') return failure('recognition_error');
  if (!value.startsWith('OK:')) return failure('recognition_error');

  try {
    const encoded = value.slice(3);
    if (!encoded || !/^[A-Za-z0-9+/]+={0,2}$/.test(encoded)) {
      return failure('recognition_error');
    }
    const transcript = sanitizeTranscript(
      Buffer.from(encoded, 'base64').toString('utf8')
    );
    return transcript ? success(transcript) : failure('recognition_error');
  } catch (_) {
    return failure('recognition_error');
  }
}

function encodePowerShellCommand(script) {
  return Buffer.from(script, 'utf16le').toString('base64');
}

function createNativeSpeechService(options = {}) {
  const spawn = options.spawn || defaultSpawn;
  const platform = options.platform || process.platform;
  const processTimeoutMs =
    options.processTimeoutMs || DEFAULT_PROCESS_TIMEOUT_MS;
  let active = null;

  function clearActive(current) {
    if (active === current) active = null;
  }

  function recognizeOnce() {
    if (platform !== 'win32' || active) {
      return Promise.resolve(failure('unavailable'));
    }

    return new Promise((resolve) => {
      let child;
      try {
        child = spawn(
          'powershell.exe',
          [
            '-NoLogo',
            '-NoProfile',
            '-NonInteractive',
            '-ExecutionPolicy',
            'Bypass',
            '-EncodedCommand',
            encodePowerShellCommand(POWERSHELL_SCRIPT),
          ],
          {
            windowsHide: true,
            shell: false,
            stdio: ['ignore', 'pipe', 'ignore'],
          }
        );
      } catch (_) {
        resolve(failure('unavailable'));
        return;
      }

      const current = {
        child,
        output: '',
        resolved: false,
        canceled: false,
        timeout: null,
        cleanup: null,
        resolve,
      };
      active = current;

      function resolveOnce(result) {
        if (current.resolved) return;
        current.resolved = true;
        current.resolve(result);
      }

      function terminate(result) {
        resolveOnce(result);
        try {
          current.child.kill();
        } catch (_) {}
        current.cleanup = setTimeout(() => clearActive(current), CLEANUP_TIMEOUT_MS);
        if (typeof current.cleanup.unref === 'function') current.cleanup.unref();
      }

      current.timeout = setTimeout(() => {
        terminate(failure('timeout'));
      }, processTimeoutMs);
      if (typeof current.timeout.unref === 'function') current.timeout.unref();

      child.stdout.on('data', (chunk) => {
        if (current.resolved) return;
        current.output += chunk.toString('utf8');
        if (Buffer.byteLength(current.output, 'utf8') > MAX_OUTPUT_BYTES) {
          terminate(failure('recognition_error'));
        }
      });

      child.once('error', () => {
        clearTimeout(current.timeout);
        clearTimeout(current.cleanup);
        clearActive(current);
        resolveOnce(failure('unavailable'));
      });

      child.once('close', () => {
        clearTimeout(current.timeout);
        clearTimeout(current.cleanup);
        clearActive(current);
        if (current.canceled) {
          resolveOnce(failure('canceled'));
          return;
        }
        resolveOnce(parseRecognizerOutput(current.output));
      });
    });
  }

  function listenForWakeWord(options = {}) {
    const onWake = typeof options.onWake === 'function' ? options.onWake : null;
    const wakeTimeoutMs = Number.isSafeInteger(options.wakeTimeoutMs)
      ? options.wakeTimeoutMs
      : DEFAULT_WAKE_TIMEOUT_MS;
    if (platform !== 'win32' || active) return Promise.resolve(failure('unavailable'));

    return new Promise((resolve) => {
      let child;
      try {
        child = spawn(
          'powershell.exe',
          ['-NoLogo', '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-EncodedCommand', encodePowerShellCommand(POWERSHELL_WAKE_SCRIPT)],
          { windowsHide: true, shell: false, stdio: ['ignore', 'pipe', 'ignore'] }
        );
      } catch (_) {
        resolve(failure('unavailable'));
        return;
      }

      const current = { child, output: '', resolved: false, canceled: false, timeout: null, cleanup: null, resolve, wakeSent: false };
      active = current;
      function resolveOnce(result) {
        if (current.resolved) return;
        current.resolved = true;
        current.resolve(result);
      }
      function terminate(result) {
        resolveOnce(result);
        try { current.child.kill(); } catch (_) {}
        current.cleanup = setTimeout(() => clearActive(current), CLEANUP_TIMEOUT_MS);
        if (typeof current.cleanup.unref === 'function') current.cleanup.unref();
      }
      current.timeout = setTimeout(() => terminate(failure('timeout')), wakeTimeoutMs);
      if (typeof current.timeout.unref === 'function') current.timeout.unref();

      child.stdout.on('data', (chunk) => {
        if (current.resolved) return;
        current.output += chunk.toString('utf8');
        const wakeMarker = current.output.match(/^WAKE\r?\n/);
        if (!current.wakeSent && wakeMarker) {
          current.wakeSent = true;
          current.output = current.output.slice(wakeMarker[0].length);
          try { onWake && onWake(); } catch (_) {}
        }
        if (Buffer.byteLength(current.output, 'utf8') > MAX_OUTPUT_BYTES) terminate(failure('recognition_error'));
      });
      child.once('error', () => {
        clearTimeout(current.timeout);
        clearTimeout(current.cleanup);
        clearActive(current);
        resolveOnce(failure('unavailable'));
      });
      child.once('close', () => {
        clearTimeout(current.timeout);
        clearTimeout(current.cleanup);
        clearActive(current);
        if (current.canceled) return resolveOnce(failure('canceled'));
        const output = current.output.trim();
        resolveOnce(output === 'WAKE_TIMEOUT' ? failure('timeout') : parseRecognizerOutput(output));
      });
    });
  }

  function cancelRecognition() {
    const current = active;
    if (!current || current.resolved) return Promise.resolve({ ok: false });
    current.canceled = true;
    clearTimeout(current.timeout);
    try {
      current.child.kill();
    } catch (_) {}
    current.resolve(failure('canceled'));
    current.resolved = true;
    current.cleanup = setTimeout(() => clearActive(current), CLEANUP_TIMEOUT_MS);
    if (typeof current.cleanup.unref === 'function') current.cleanup.unref();
    return Promise.resolve({ ok: true });
  }

  return Object.freeze({ recognizeOnce, listenForWakeWord, cancelRecognition });
}

module.exports = {
  FAILURE_CODES,
  MAX_TRANSCRIPT_CHARS,
  POWERSHELL_SCRIPT,
  POWERSHELL_WAKE_SCRIPT,
  createNativeSpeechService,
  parseRecognizerOutput,
  sanitizeTranscript,
};
