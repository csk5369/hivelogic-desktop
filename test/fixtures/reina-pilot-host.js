/* public/reina-pilot-host.js
 *
 * Browser host for the existing purple Reina panel. It composes the strict
 * ReinaPilotClient, the server-bootstrap login brief, and the typed-panel
 * controller. It also composes the accepted, governed UI-intent router and the
 * existing in-app Voice stack. All navigation authority remains a correlated
 * server intent; Voice and typed input share the same strict client transport.
 *
 * Classic UMD: window.ReinaPilotHost in a browser and module.exports in Node.
 */
(function (root, factory) {
  var api = factory(root);
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.ReinaPilotHost = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function (root) {
  'use strict';

  var MAX_USER_TEXT = 4000;
  var MAX_RENDER_TEXT = 131072;
  var CONTROL_RE = /[\x00-\x08\x0B-\x1F\x7F]/;
  var SERVER_SESSION_RE = /^rp\.[0-9a-f]{64}$/;
  var CANONICAL_UTC_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/;
  var REVIEW_INTENT_VERSION = 'reina.ui-intent.v1';
  var REVIEW_DESTINATION = 'standup';
  var EXACT_REVIEW_YES_RE = /^(?:yes|yep|yeah|sure|please do|ok|okay|go ahead)[.!?]?$/i;
  var EXACT_REVIEW_NO_RE = /^(?:no|nope|not now|cancel|dismiss|later)[.!?]?$/i;
  var PAGE_KEYS = Object.freeze(['fab', 'panel', 'mode', 'close', 'feed', 'input', 'send']);
  var PAGE_IDS = Object.freeze({
    fab: 'rnaFab', panel: 'rnaPanel', mode: 'rnaMode', close: 'rnaX',
    feed: 'rnaFeed', input: 'rnaIn', send: 'rnaSend',
  });
  var FIXED_ERRORS = Object.freeze({
    auth_expired: 'Your Reina session expired. Sign in again to continue.',
    bootstrap_failed: 'Reina could not verify this signed-in session.',
    unavailable: 'Reina\'s synthetic read-only preview is unavailable right now.',
    turn_failed: 'Reina could not complete this read-only preview turn. Please try again.',
    invalid_input: 'Enter a plain-text question of 4,000 characters or fewer.',
  });

  function hasOwnValue(descriptor) {
    return descriptor != null && Object.prototype.hasOwnProperty.call(descriptor, 'value');
  }

  function ownData(object, key) {
    if (object === null || typeof object !== 'object') return { ok: false };
    try {
      var descriptor = Object.getOwnPropertyDescriptor(object, key);
      if (!hasOwnValue(descriptor)) return { ok: false };
      return { ok: true, value: descriptor.value };
    } catch (_) {
      return { ok: false };
    }
  }

  function readExactDataObject(value, keys) {
    if (value === null || typeof value !== 'object') return null;
    try {
      if (Array.isArray(value)) return null;
      var names = Object.getOwnPropertyNames(value);
      var symbols = Object.getOwnPropertySymbols(value);
      if (symbols.length !== 0 || names.length !== keys.length) return null;
      var allowed = Object.create(null);
      var output = Object.create(null);
      for (var i = 0; i < keys.length; i += 1) allowed[keys[i]] = true;
      for (var n = 0; n < names.length; n += 1) {
        var name = names[n];
        if (!allowed[name]) return null;
        var descriptor = Object.getOwnPropertyDescriptor(value, name);
        if (!hasOwnValue(descriptor) || descriptor.enumerable !== true) return null;
        output[name] = descriptor.value;
      }
      return output;
    } catch (_) {
      return null;
    }
  }

  function optionValue(options, key, fallback) {
    var result = ownData(options, key);
    return result.ok ? result.value : fallback;
  }

  function isFunction(value) { return typeof value === 'function'; }

  function captureFactory(moduleName, factoryName) {
    var moduleResult = ownData(root, moduleName);
    if (!moduleResult.ok || moduleResult.value === null || typeof moduleResult.value !== 'object') return null;
    var factoryResult = ownData(moduleResult.value, factoryName);
    return factoryResult.ok && isFunction(factoryResult.value) ? factoryResult.value : null;
  }

  function captureGlobalFunction(functionName) {
    var result = ownData(root, functionName);
    if (!result.ok || !isFunction(result.value)) return null;
    var fn = result.value;
    return function () { return fn.apply(root, arguments); };
  }

  function captureBoundMethod(receiver, methodName) {
    if (receiver === null || (typeof receiver !== 'object' && typeof receiver !== 'function')) return null;
    var cursor = receiver;
    for (var depth = 0; cursor && depth < 12; depth += 1) {
      var descriptor;
      try { descriptor = Object.getOwnPropertyDescriptor(cursor, methodName); } catch (_) { return null; }
      if (descriptor) {
        if (!('value' in descriptor) || !isFunction(descriptor.value)) return null;
        var method = descriptor.value;
        return function () { return method.apply(receiver, arguments); };
      }
      try { cursor = Object.getPrototypeOf(cursor); } catch (_) { return null; }
    }
    return null;
  }

  // The dependency scripts load immediately before this host. Pin their exact
  // factory identities now; a later page script or delayed auth event cannot
  // replace a global with a forged greeting/answer source. Explicit test DI is
  // still accepted by createReinaPilotHost.
  var CAPTURED_CREATE_CLIENT = captureFactory('ReinaPilotClient', 'createReinaPilotClient');
  var CAPTURED_CREATE_LOGIN_BRIEF = captureFactory('ReinaLoginBrief', 'createLoginBrief');
  var CAPTURED_CREATE_TYPED_PANEL = captureFactory('ReinaTypedPanel', 'createTypedPanel');
  var CAPTURED_CREATE_INTENT_ROUTER = captureFactory('ReinaUiIntentRouter', 'createUiIntentRouter');
  var CAPTURED_SHOW_VIEW = captureGlobalFunction('showView');
  var CAPTURED_GO = captureGlobalFunction('go');
  var CAPTURED_NATIVE_RECOGNITION = (function () {
    // The desktop preload is an authority boundary. Accept only the exact two
    // own data methods captured while this host loads. Accessors, inherited
    // methods, partial bridges, and late global replacements are rejected.
    var desktopResult = ownData(root, 'hivelogicDesktop');
    if (!desktopResult.ok || desktopResult.value === null
      || typeof desktopResult.value !== 'object') return null;
    var recognize = ownData(desktopResult.value, 'recognizeOnce');
    var cancel = ownData(desktopResult.value, 'cancelRecognition');
    if (!recognize.ok || !cancel.ok || !isFunction(recognize.value)
      || !isFunction(cancel.value)) return null;
    var desktop = desktopResult.value;
    var recognizeOnce = recognize.value;
    var cancelRecognition = cancel.value;
    return Object.freeze({
      recognizeOnce: function () { return recognizeOnce.call(desktop); },
      cancelRecognition: function () { return cancelRecognition.call(desktop); },
    });
  })();
  var CAPTURED_SPEECH_RECOGNITION = (function () {
    var direct = ownData(root, 'SpeechRecognition');
    var webkit = ownData(root, 'webkitSpeechRecognition');
    return direct.ok && isFunction(direct.value) ? direct.value
      : webkit.ok && isFunction(webkit.value) ? webkit.value : null;
  })();
  var CAPTURED_SPEECH_SYNTHESIS = (function () {
    var value = ownData(root, 'speechSynthesis');
    return value.ok && value.value && typeof value.value === 'object' ? value.value : null;
  })();
  var CAPTURED_UTTERANCE = (function () {
    var value = ownData(root, 'SpeechSynthesisUtterance');
    return value.ok && isFunction(value.value) ? value.value : null;
  })();

  var NATIVE_RECOGNITION_CODES = Object.freeze({
    no_speech: 'no-speech',
    permission_denied: 'not-allowed',
    unavailable: 'audio-capture',
    timeout: 'timeout',
    canceled: 'aborted',
    recognition_error: 'recognition-error',
  });
  var NATIVE_VOICE_MESSAGES = Object.freeze({
    no_speech: 'I did not hear anything. Select Enable Voice and try again.',
    permission_denied: 'Microphone access was denied. Allow microphone access and try again.',
    unavailable: 'Desktop voice input is unavailable right now. Typed Reina still works.',
    timeout: 'I did not hear you in time. Select Enable Voice and try again.',
    canceled: 'Voice listening was canceled.',
    recognition_error: 'Voice input hit a problem. Select Enable Voice and try again.',
  });

  function createNativeRecognitionFactory(nativeRecognition, onIssue) {
    var recognizeResult = ownData(nativeRecognition, 'recognizeOnce');
    var cancelResult = ownData(nativeRecognition, 'cancelRecognition');
    if (!recognizeResult.ok || !cancelResult.ok || !isFunction(recognizeResult.value)
      || !isFunction(cancelResult.value)) return null;
    var recognizeOnce = recognizeResult.value;
    var cancelRecognition = cancelResult.value;
    var issue = isFunction(onIssue) ? onIssue : function () {};
    var activeRecord = null;
    var cancellationBarrier = Promise.resolve();
    var nextRun = 0;

    function deferredSettlement() {
      var resolve;
      var promise = new Promise(function (settle) { resolve = settle; });
      return { promise: promise, resolve: resolve };
    }

    function exactCancelAck(value) {
      var exact = readExactDataObject(value, ['ok']);
      return exact && (exact.ok === true || exact.ok === false) ? exact.ok : null;
    }

    function requestNativeCancel(record) {
      if (!record || record.settled || record.cancelPromise) {
        return record && record.cancelPromise ? record.cancelPromise : Promise.resolve(false);
      }
      record.cancelRequested = true;
      var pending;
      try { pending = cancelRecognition.call(nativeRecognition); } catch (_) { pending = null; }
      record.cancelPromise = Promise.resolve(pending).then(function (value) {
        return exactCancelAck(value);
      }, function () { return null; });
      var validAckFence = record.cancelPromise.then(function (acknowledged) {
        if (acknowledged === true || acknowledged === false) return true;
        // Missing/malformed/rejected acknowledgment cannot authorize a new
        // native run. Keep the fence closed; typed Reina remains available.
        return new Promise(function () {});
      });
      // A later recognizeOnce must wait for BOTH native signals. This fences a
      // delayed cancel so it can never land on the next recognition run. If a
      // hostile/buggy preload never settles the old recognition, restart stays
      // closed instead of risking cross-run microphone control.
      cancellationBarrier = Promise.all([
        cancellationBarrier,
        validAckFence,
        record.settlement.promise,
      ]).then(function () { return true; }, function () { return false; });
      return record.cancelPromise;
    }

    return function () {
      var instance = {
        lang: 'en-US', interimResults: false, continuous: false,
        onstart: null, onresult: null, onerror: null, onend: null,
      };
      var run = 0;
      var active = false;
      var record = null;

      function callHandler(name, payload) {
        var handler;
        try { handler = instance[name]; } catch (_) { return; }
        if (!isFunction(handler)) return;
        try { handler.call(instance, payload); } catch (_) { /* adapter owns state */ }
      }

      function finish(myRun) {
        if (!active || myRun !== run) return;
        active = false;
        callHandler('onend', Object.freeze({}));
      }

      function nativeFailure(code, myRun) {
        if (!active || myRun !== run) return;
        var mapped = NATIVE_RECOGNITION_CODES[code] || NATIVE_RECOGNITION_CODES.recognition_error;
        callHandler('onerror', Object.freeze({ error: mapped }));
        finish(myRun);
        try { issue(code in NATIVE_RECOGNITION_CODES ? code : 'recognition_error'); } catch (_) {}
      }

      function exactNativeResult(value) {
        var okResult = readExactDataObject(value, ['ok', 'transcript']);
        if (okResult && okResult.ok === true
          && safePrimitiveText(okResult.transcript, 1000, false)
          && okResult.transcript.trim() === okResult.transcript
          && okResult.transcript.length > 0
          && okResult.transcript.indexOf('<') === -1
          && okResult.transcript.indexOf('>') === -1) {
          return { ok: true, transcript: okResult.transcript };
        }
        var failure = readExactDataObject(value, ['ok', 'code']);
        if (failure && failure.ok === false && typeof failure.code === 'string'
          && Object.prototype.hasOwnProperty.call(NATIVE_RECOGNITION_CODES, failure.code)) {
          return { ok: false, code: failure.code };
        }
        return { ok: false, code: 'recognition_error' };
      }

      instance.start = function () {
        if (active) throw new Error('native_recognition_active');
        active = true;
        var myRun = ++run;
        var gate = cancellationBarrier;
        // Direct callers cannot start two native recognitions concurrently,
        // even if they bypass the higher-level adapter's rapid-restart abort.
        if (activeRecord && !activeRecord.settled) {
          gate = Promise.all([gate, activeRecord.settlement.promise]);
        }
        Promise.resolve(gate).then(function () {
          if (!active || myRun !== run) return;
          var settlement = deferredSettlement();
          var nativeRun = ++nextRun;
          record = {
            id: nativeRun,
            owner: instance,
            settlement: settlement,
            settled: false,
            cancelRequested: false,
            cancelPromise: null,
          };
          activeRecord = record;
          var pending;
          try { pending = recognizeOnce.call(nativeRecognition); } catch (_) {
            record.settled = true;
            if (activeRecord === record) activeRecord = null;
            settlement.resolve(false);
            active = false;
            try { issue('recognition_error'); } catch (_) {}
            callHandler('onerror', Object.freeze({ error: NATIVE_RECOGNITION_CODES.recognition_error }));
            callHandler('onend', Object.freeze({}));
            return;
          }
          callHandler('onstart', Object.freeze({}));
          Promise.resolve(pending).then(function (raw) {
            if (record.settled) return;
            var result = exactNativeResult(raw);
            // A requested cancel wins over any late success from the old run.
            if (record.cancelRequested) result = { ok: false, code: 'canceled' };
            if (active && myRun === run) {
              if (!result.ok) {
                nativeFailure(result.code, myRun);
              } else {
                var alternative = Object.freeze({ transcript: result.transcript });
                var recognitionResult = Object.freeze({
                  0: alternative, length: 1, isFinal: true,
                });
                callHandler('onresult', Object.freeze({
                  resultIndex: 0, results: Object.freeze([recognitionResult]),
                }));
                finish(myRun);
              }
            }
            record.settled = true;
            if (activeRecord === record) activeRecord = null;
            settlement.resolve(true);
          }, function () {
            if (record.settled) return;
            if (active && myRun === run) nativeFailure('recognition_error', myRun);
            record.settled = true;
            if (activeRecord === record) activeRecord = null;
            settlement.resolve(false);
          });
        }, function () {
          if (!active || myRun !== run) return;
          active = false;
          nativeFailure('recognition_error', myRun);
        });
      };

      function stop() {
        if (!active) return;
        if (!record) {
          active = false;
          run += 1;
          callHandler('onend', Object.freeze({}));
          return;
        }
        requestNativeCancel(record);
      }

      function abort() {
        if (!active) return;
        active = false;
        run += 1;
        if (record) requestNativeCancel(record);
      }

      instance.stop = stop;
      instance.abort = abort;
      return instance;
    };
  }

  function createCapturedNativeRecognitionFactory(onIssue) {
    return CAPTURED_NATIVE_RECOGNITION
      ? createNativeRecognitionFactory(CAPTURED_NATIVE_RECOGNITION, onIssue)
      : null;
  }

  function defaultLoadVoiceModules() {
    return Promise.all([
      import('/reina-inapp-voice-host.js'),
      import('/reina-canonical-voice-transport.js'),
    ]).then(function (modules) {
      return Object.freeze({
        createVoiceHost: modules[0] && modules[0].createReinaInAppVoiceHost,
        createVoiceTransport: modules[1] && modules[1].createCanonicalVoiceTransport,
      });
    });
  }

  function safePrimitiveText(value, maximum, allowEmpty) {
    return typeof value === 'string'
      && value.length <= maximum
      && (allowEmpty || value.length > 0)
      && !CONTROL_RE.test(value);
  }

  function safeStringList(value, maximumItems, maximumText) {
    try {
      if (!Array.isArray(value) || value.length > maximumItems) return [];
      var output = [];
      for (var i = 0; i < value.length; i += 1) {
        var descriptor = Object.getOwnPropertyDescriptor(value, String(i));
        if (!hasOwnValue(descriptor) || !safePrimitiveText(descriptor.value, maximumText, true)) return [];
        output.push(descriptor.value);
      }
      return output;
    } catch (_) {
      return [];
    }
  }

  function canonicalUtc(value) {
    if (!safePrimitiveText(value, 64, false) || !CANONICAL_UTC_RE.test(value)) return false;
    var milliseconds = Date.parse(value);
    if (!Number.isFinite(milliseconds)) return false;
    var normalized = value.indexOf('.') === -1 ? value.slice(0, -1) + '.000Z' : value;
    try { return new Date(milliseconds).toISOString() === normalized; } catch (_) { return false; }
  }

  function exactDenseArray(value, maximum) {
    try {
      if (!Array.isArray(value) || value.length > maximum) return null;
      var names = Object.getOwnPropertyNames(value);
      var symbols = Object.getOwnPropertySymbols(value);
      if (symbols.length !== 0 || names.length !== value.length + 1 || names[names.length - 1] !== 'length') return null;
      var output = [];
      for (var i = 0; i < value.length; i += 1) {
        var descriptor = Object.getOwnPropertyDescriptor(value, String(i));
        if (!hasOwnValue(descriptor) || descriptor.enumerable !== true) return null;
        output.push(descriptor.value);
      }
      return output;
    } catch (_) {
      return null;
    }
  }

  // PR #87 predates the server/client honesty contract for unavailable counts:
  // the canonical wire value is null, while its validator requires an integer.
  // This is a display-only copy made after strict own-data validation. PR #87
  // filters unavailable categories from rendered totals, so only those copies
  // receive count:0. The authoritative bootstrap and router intent are never
  // changed. At least one real available source is mandatory; an all-unknown
  // result must not become a false "nothing needs attention" greeting.
  function bootstrapForLoginBrief(raw, expectedSessionId) {
    var top = readExactDataObject(raw, [
      'ok', 'sessionId', 'generatedAt', 'user', 'attention', 'review', 'uiIntent', 'executed',
    ]);
    if (!top || top.ok !== true || top.executed !== false || top.sessionId !== expectedSessionId
      || !SERVER_SESSION_RE.test(top.sessionId) || !canonicalUtc(top.generatedAt)) return null;
    var user = readExactDataObject(top.user, ['displayName']);
    var attention = readExactDataObject(top.attention, [
      'total', 'asOf', 'reviewAvailable', 'categories', 'unavailableSources',
    ]);
    if (!user || !safePrimitiveText(user.displayName, 120, false) || !attention
      || attention.reviewAvailable !== true
      || !(attention.asOf === null || canonicalUtc(attention.asOf))) return null;
    var categories = exactDenseArray(attention.categories, 24);
    var unavailable = exactDenseArray(attention.unavailableSources, 24);
    if (!categories || !unavailable) return null;
    var safeCategories = [];
    var availableCount = 0;
    var availableTotal = 0;
    var seen = Object.create(null);
    for (var i = 0; i < categories.length; i += 1) {
      var category = readExactDataObject(categories[i], [
        'key', 'label', 'count', 'available', 'asOf', 'evidence',
      ]);
      if (!category || !safePrimitiveText(category.key, 80, false)
        || !safePrimitiveText(category.label, 120, false) || seen[category.key]
        || typeof category.available !== 'boolean') return null;
      seen[category.key] = true;
      var evidence = exactDenseArray(category.evidence, 16);
      if (!evidence) return null;
      var safeEvidence = [];
      for (var e = 0; e < evidence.length; e += 1) {
        if (!safePrimitiveText(evidence[e], 1000, false)) return null;
        safeEvidence.push(evidence[e]);
      }
      var displayCount;
      var displayAsOf = null;
      if (category.available === true) {
        if (!Number.isSafeInteger(category.count) || category.count < 0 || category.count > 1000000
          || !canonicalUtc(category.asOf)) return null;
        displayCount = category.count;
        displayAsOf = category.asOf;
        availableCount += 1;
        availableTotal += category.count;
      } else {
        if (category.count !== null || category.asOf !== null) return null;
        displayCount = 0;
      }
      safeCategories.push(Object.freeze({
        key: category.key, label: category.label, count: displayCount,
        available: category.available, asOf: displayAsOf,
        evidence: Object.freeze(safeEvidence),
      }));
    }
    if (availableCount < 1 || !Number.isSafeInteger(attention.total)
      || attention.total !== availableTotal) return null;
    var safeUnavailable = [];
    for (var u = 0; u < unavailable.length; u += 1) {
      if (!safePrimitiveText(unavailable[u], 1000, false)) return null;
      safeUnavailable.push(unavailable[u]);
    }
    return Object.freeze({
      ok: true, sessionId: top.sessionId, generatedAt: top.generatedAt,
      user: Object.freeze({ displayName: user.displayName }),
      attention: Object.freeze({
        total: attention.total, asOf: attention.asOf,
        reviewAvailable: true, categories: Object.freeze(safeCategories),
        unavailableSources: Object.freeze(safeUnavailable),
      }),
      review: top.review, uiIntent: top.uiIntent, executed: false,
    });
  }

  function text(node, value) {
    try { node.textContent = typeof value === 'string' ? value : ''; } catch (_) { /* presentation stays inert */ }
  }

  function fixedClass(node, className) {
    try { node.className = className; } catch (_) { /* cosmetic only */ }
  }

  function setDisplay(node, value) {
    try { if (node && node.style) node.style.display = value; } catch (_) { /* fail-closed state is independent */ }
  }

  function setDisabled(node, value) {
    try { node.disabled = value === true; } catch (_) { /* fail-closed state is independent */ }
  }

  function addClass(node, value) {
    try { if (node && node.classList && isFunction(node.classList.add)) node.classList.add(value); } catch (_) {}
  }

  function removeClass(node, value) {
    try { if (node && node.classList && isFunction(node.classList.remove)) node.classList.remove(value); } catch (_) {}
  }

  function resolveElements(documentRef) {
    if (!documentRef || !isFunction(documentRef.getElementById)) return null;
    var resolved = {};
    try {
      for (var i = 0; i < PAGE_KEYS.length; i += 1) {
        var key = PAGE_KEYS[i];
        var element = documentRef.getElementById(PAGE_IDS[key]);
        if (!element || typeof element !== 'object') return null;
        resolved[key] = element;
      }
    } catch (_) {
      return null;
    }
    return Object.freeze(resolved);
  }

  function validateElements(raw) {
    var values = readExactDataObject(raw, PAGE_KEYS);
    if (!values) return null;
    try {
      if (!isFunction(values.feed.appendChild)) return null;
      if (!values.panel.classList || !isFunction(values.panel.classList.add) || !isFunction(values.panel.classList.remove)) return null;
      if (!isFunction(values.input.addEventListener) || !isFunction(values.input.removeEventListener)) return null;
      if (!values.fab.style) return null;
      return Object.freeze({
        fab: values.fab, panel: values.panel, mode: values.mode, close: values.close,
        feed: values.feed, input: values.input, send: values.send,
      });
    } catch (_) {
      return null;
    }
  }

  function hidePage(elements) {
    if (!elements) return;
    setDisplay(elements.fab, 'none');
    removeClass(elements.panel, 'open');
    setDisabled(elements.input, true);
    setDisabled(elements.send, true);
    text(elements.mode, 'preview unavailable');
    removeClass(elements.mode, 'live');
  }

  function createReinaPilotHost(options) {
    if (options === null || typeof options !== 'object') {
      throw new Error('createReinaPilotHost: options are required');
    }

    var documentRef = optionValue(options, 'documentRef', root && root.document ? root.document : null);
    var suppliedElements = optionValue(options, 'elements', null);
    var page = validateElements(suppliedElements || resolveElements(documentRef));
    var createClient = optionValue(options, 'createClient', null);
    var createLoginBrief = optionValue(options, 'createLoginBrief', null);
    var createTypedPanel = optionValue(options, 'createTypedPanel', null);
    var createIntentRouter = optionValue(options, 'createIntentRouter', null);
    var loadVoiceModules = optionValue(options, 'loadVoiceModules', defaultLoadVoiceModules);
    var showView = optionValue(options, 'showView', CAPTURED_SHOW_VIEW);
    var go = optionValue(options, 'go', CAPTURED_GO);
    var suppliedNewId = optionValue(options, 'newId', null);
    var getAccessToken = optionValue(options, 'getAccessToken', null);
    var onAuthExpired = optionValue(options, 'onAuthExpired', function () {});
    var onState = optionValue(options, 'onState', function () {});

    if (!isFunction(createClient)) createClient = CAPTURED_CREATE_CLIENT;
    if (!isFunction(createLoginBrief)) createLoginBrief = CAPTURED_CREATE_LOGIN_BRIEF;
    if (!isFunction(createTypedPanel)) createTypedPanel = CAPTURED_CREATE_TYPED_PANEL;
    if (!isFunction(createIntentRouter)) createIntentRouter = CAPTURED_CREATE_INTENT_ROUTER;
    var newId = isFunction(suppliedNewId) ? suppliedNewId : function () {
      var cryptoRef = root && root.crypto;
      if (!cryptoRef || !isFunction(cryptoRef.randomUUID)) throw new Error('secure_id_unavailable');
      return cryptoRef.randomUUID();
    };
    if (!documentRef || !isFunction(documentRef.createElement) || !page) {
      throw new Error('createReinaPilotHost: the exact Reina panel elements are required');
    }
    if (!isFunction(createClient) || !isFunction(createLoginBrief) || !isFunction(createTypedPanel)
      || !isFunction(createIntentRouter)) {
      throw new Error('createReinaPilotHost: Reina client, login, typed, and UI-intent factories are required');
    }
    if (!isFunction(onAuthExpired)) onAuthExpired = function () {};
    if (!isFunction(onState)) onState = function () {};

    var mounted = false;
    var disposed = false;
    var epoch = 0;
    var state = 'idle';
    var sessionId = null;
    var client = null;
    var loginBrief = null;
    var typedPanel = null;
    var intentRouter = null;
    var voiceHost = null;
    var voiceLoad = null;
    var voiceEnabled = false;
    var emergencyOff = false;
    var pendingReview = null;
    var confirmationGrant = null;
    var view = null;
    var listeners = [];
    var renderedTurns = Object.create(null);
    var expirySignaled = false;
    var retrying = false;
    var sendIdleText = 'Send';
    var pendingSession = null;
    var refreshedDuringTurn = false;

    try {
      if (safePrimitiveText(page.send.textContent, 32, false)) sendIdleText = page.send.textContent;
    } catch (_) { /* fixed fallback stays safe */ }

    hidePage(page);

    function snapshot(reason) {
      return Object.freeze({
        state: state,
        sessionId: sessionId,
        mounted: mounted,
        disposed: disposed,
        voiceEnabled: voiceEnabled,
        reviewAvailable: pendingReview !== null,
        executed: false,
        reason: typeof reason === 'string' ? reason : null,
      });
    }

    function emitState(reason) {
      var current = snapshot(reason);
      try { onState(current); } catch (_) { /* observers have no authority */ }
      return current;
    }

    function makeElement(tagName, className, initialText) {
      var node = documentRef.createElement(tagName);
      fixedClass(node, className);
      if (typeof initialText === 'string') text(node, initialText);
      return node;
    }

    function buildView() {
      if (view) return;
      try {
        text(page.feed, '');
        var notice = makeElement('p', 'rnaM q reina-pilot-notice', 'READ-ONLY PREVIEW (SYNTHETIC)');
        var greeting = makeElement('p', 'rnaM q reina-pilot-greeting');
        var attention = makeElement('p', 'rnaM q reina-pilot-attention');
        var categories = makeElement('ul', 'rnaM q reina-pilot-categories');
        var disclosures = makeElement('ul', 'rnaM q reina-pilot-disclosures');
        var reviewQuestion = makeElement('p', 'rnaM q reina-pilot-review-question');
        var reviewControls = makeElement('div', 'rnaChips reina-pilot-review-controls');
        var reviewButton = makeElement('button', 'reina-pilot-review-button', 'Review items');
        reviewButton.type = 'button';
        reviewControls.appendChild(reviewButton);
        var messages = makeElement('div', 'reina-pilot-messages');
        var voiceControls = makeElement('div', 'rnaChips reina-pilot-voice-controls');
        var voiceStart = makeElement('button', 'reina-pilot-voice-start', 'Enable Voice');
        var voiceStop = makeElement('button', 'reina-pilot-voice-stop', 'Stop Voice');
        var voiceOff = makeElement('button', 'reina-pilot-voice-off', 'Emergency OFF');
        voiceStart.type = voiceStop.type = voiceOff.type = 'button';
        voiceControls.appendChild(voiceStart);
        voiceControls.appendChild(voiceStop);
        voiceControls.appendChild(voiceOff);
        var voiceStatus = makeElement('p', 'rnaM q reina-pilot-voice-status', 'Voice is off.');
        var voiceInterim = makeElement('p', 'rnaM u reina-pilot-voice-interim');
        var voiceConfirm = makeElement('p', 'rnaM q reina-pilot-voice-confirm');
        var voiceError = makeElement('p', 'rnaM q reina-pilot-voice-error');
        var status = makeElement('p', 'rnaM q reina-pilot-status');
        var error = makeElement('p', 'rnaM q reina-pilot-error');
        page.feed.appendChild(notice);
        page.feed.appendChild(greeting);
        page.feed.appendChild(attention);
        page.feed.appendChild(categories);
        page.feed.appendChild(disclosures);
        page.feed.appendChild(reviewQuestion);
        page.feed.appendChild(reviewControls);
        page.feed.appendChild(messages);
        page.feed.appendChild(voiceControls);
        page.feed.appendChild(voiceStatus);
        page.feed.appendChild(voiceInterim);
        page.feed.appendChild(voiceConfirm);
        page.feed.appendChild(voiceError);
        page.feed.appendChild(status);
        page.feed.appendChild(error);
        view = Object.freeze({
          notice: notice, greeting: greeting, attention: attention,
          categories: categories, disclosures: disclosures, messages: messages,
          reviewQuestion: reviewQuestion, reviewControls: reviewControls, reviewButton: reviewButton,
          voiceControls: voiceControls, voiceStart: voiceStart, voiceStop: voiceStop, voiceOff: voiceOff,
          voiceStatus: voiceStatus, voiceInterim: voiceInterim,
          voiceConfirm: voiceConfirm, voiceError: voiceError,
          status: status, error: error,
        });
        setDisplay(reviewControls, 'none');
        setDisabled(reviewButton, true);
        setDisabled(voiceStart, true);
        setDisabled(voiceStop, true);
        setDisabled(voiceOff, true);
      } catch (_) {
        view = null;
        throw new Error('createReinaPilotHost: panel construction failed');
      }
    }

    function bind(node, eventName, handler) {
      if (!node || !isFunction(node.addEventListener)) return;
      node.addEventListener(eventName, handler);
      listeners.push({ node: node, eventName: eventName, handler: handler, property: false });
    }

    function bindOwnedClick(node, handler) {
      try {
        node.onclick = handler;
        listeners.push({ node: node, eventName: 'onclick', handler: handler, property: true });
      } catch (_) {
        bind(node, 'click', handler);
      }
    }

    function enableInput(enabled) {
      setDisabled(page.input, !enabled);
      setDisabled(page.send, !enabled);
    }

    function normalInput(enabled) {
      text(page.send, sendIdleText);
      enableInput(enabled);
    }

    function retryInput() {
      setDisabled(page.input, true);
      setDisabled(page.send, false);
      text(page.send, 'Retry');
    }

    function showVerifiedPanel() {
      setDisplay(page.fab, 'flex');
      addClass(page.panel, 'open');
      text(page.mode, 'synthetic · read only');
      removeClass(page.mode, 'live');
      normalInput(true);
    }

    function clearPresentation() {
      if (!view) return;
      text(view.greeting, '');
      text(view.attention, '');
      text(view.categories, '');
      text(view.disclosures, '');
      text(view.reviewQuestion, '');
      setDisplay(view.reviewControls, 'none');
      setDisabled(view.reviewButton, true);
      text(view.messages, '');
      text(view.voiceStatus, 'Voice is off.');
      text(view.voiceInterim, '');
      text(view.voiceConfirm, '');
      text(view.voiceError, '');
      setDisabled(view.voiceStart, true);
      setDisabled(view.voiceStop, true);
      setDisabled(view.voiceOff, true);
      text(view.status, '');
      text(view.error, '');
      try { page.input.value = ''; } catch (_) { /* inert */ }
      hidePage(page);
      text(page.send, sendIdleText);
      renderedTurns = Object.create(null);
      retrying = false;
    }

    function appendList(target, values) {
      text(target, '');
      for (var i = 0; i < values.length; i += 1) {
        var item = makeElement('li', 'reina-pilot-list-item', values[i]);
        target.appendChild(item);
      }
    }

    function appendMessage(role, message) {
      if (!view || !safePrimitiveText(message, MAX_RENDER_TEXT, false)) return false;
      try {
        var row = makeElement('div', role === 'user' ? 'rnaM u' : 'rnaM q');
        var label = makeElement('span', 'reina-pilot-message-label', role === 'user' ? 'You: ' : 'Reina: ');
        var body = makeElement('span', 'reina-pilot-message-body', message);
        row.appendChild(label);
        row.appendChild(body);
        view.messages.appendChild(row);
        return true;
      } catch (_) {
        return false;
      }
    }

    function trustedGesture(event) {
      try { return event !== null && typeof event === 'object' && event.isTrusted === true; } catch (_) { return false; }
    }

    function emptyOwnDataObject(value) {
      return readExactDataObject(value, []) !== null;
    }

    function reviewSnapshot(bootstrap, expectedEpoch) {
      var reviewValue = ownData(bootstrap, 'review');
      var intentValue = ownData(bootstrap, 'uiIntent');
      var review = reviewValue.ok
        ? readExactDataObject(reviewValue.value, ['intentId', 'available', 'expiresAt']) : null;
      var intent = intentValue.ok ? readExactDataObject(intentValue.value, [
        'version', 'executed', 'requiresConfirmation', 'conversationId', 'turnId',
        'intentId', 'expiresAt', 'kind', 'destination', 'parameters',
      ]) : null;
      if (!review || !intent || review.available !== true
        || !safePrimitiveText(review.intentId, 200, false)
        || !safePrimitiveText(review.expiresAt, 64, false)
        || intent.version !== REVIEW_INTENT_VERSION || intent.executed !== false
        || intent.requiresConfirmation !== true || intent.conversationId !== sessionId
        || !safePrimitiveText(intent.turnId, 200, false)
        || intent.intentId !== review.intentId || intent.expiresAt !== review.expiresAt
        || intent.kind !== 'navigate' || intent.destination !== REVIEW_DESTINATION
        || !emptyOwnDataObject(intent.parameters)) return null;
      return Object.freeze({
        epoch: expectedEpoch, sessionId: sessionId, turnId: intent.turnId,
        intentId: intent.intentId, kind: intent.kind,
        destination: intent.destination, expiresAt: intent.expiresAt,
        uiIntent: intentValue.value,
      });
    }

    function reviewStillCurrent(candidate) {
      return !disposed && candidate && candidate === pendingReview
        && candidate.epoch === epoch && candidate.sessionId === sessionId;
    }

    function revokeReview(reason, declineLogin) {
      confirmationGrant = null;
      var previousRouter = intentRouter;
      pendingReview = null;
      if (previousRouter && isFunction(previousRouter.revoke)) {
        try { previousRouter.revoke(typeof reason === 'string' ? reason : 'revoked'); } catch (_) {}
      }
      if (declineLogin === true && loginBrief && isFunction(loginBrief.decline)) {
        try { loginBrief.decline('new_turn'); } catch (_) {}
      }
      if (view) {
        text(view.reviewQuestion, '');
        setDisplay(view.reviewControls, 'none');
        setDisabled(view.reviewButton, true);
      }
    }

    function fixedReviewAllow(candidate) {
      var exact = readExactDataObject(candidate, ['kind', 'destination', 'parameters', 'intentId']);
      return !!(exact && pendingReview && reviewStillCurrent(pendingReview)
        && exact.kind === pendingReview.kind
        && exact.destination === pendingReview.destination
        && exact.intentId === pendingReview.intentId
        && emptyOwnDataObject(exact.parameters));
    }

    function applyStandupNavigation(destination, parameters) {
      var grant = confirmationGrant;
      if (!grant || grant.used !== true || !reviewStillCurrent(grant.review)
        || destination !== REVIEW_DESTINATION || !emptyOwnDataObject(parameters)
        || !isFunction(showView) || !isFunction(go)) return false;
      try {
        showView('');
        go(REVIEW_DESTINATION);
        var target = documentRef.getElementById(REVIEW_DESTINATION);
        return !!(target && target.style && target.style.display === 'block');
      } catch (_) {
        return false;
      }
    }

    function registerReviewIntent(bootstrap, expectedEpoch) {
      var expected = reviewSnapshot(bootstrap, expectedEpoch);
      if (!expected) return false;
      var frozenHandlers = Object.freeze({ navigate: applyStandupNavigation });
      var frozenParams = Object.freeze({});
      var frozenDestinationList = Object.freeze([REVIEW_DESTINATION]);
      var frozenAllowlist = Object.freeze({
        navigate: Object.freeze({ destinations: frozenDestinationList, params: frozenParams }),
      });
      var created;
      pendingReview = expected;
      try {
        created = createIntentRouter(Object.freeze({
          conversationId: sessionId,
          handlers: frozenHandlers,
          allowlist: frozenAllowlist,
          allow: fixedReviewAllow,
          navigationTimeoutMs: 1000,
        }));
      } catch (_) {
        pendingReview = null;
        return false;
      }
      if (!created || !isFunction(created.propose) || !isFunction(created.confirm)
        || !isFunction(created.revoke) || !isFunction(created.dispose)) {
        pendingReview = null;
        return false;
      }
      var proposal;
      try {
        proposal = created.propose(Object.freeze({ uiIntent: expected.uiIntent }), Object.freeze({
          turnId: expected.turnId,
          suppressConfirmRequest: true,
        }));
      } catch (_) { proposal = null; }
      if (!proposal || proposal.accepted !== true) {
        pendingReview = null;
        try { created.dispose(); } catch (_) {}
        return false;
      }
      intentRouter = created;
      return true;
    }

    function strictReviewConfirmation(intentId) {
      var grant = confirmationGrant;
      if (!grant || grant.used === true || !reviewStillCurrent(grant.review)
        || intentId !== grant.review.intentId || !intentRouter || !client
        || !isFunction(client.confirmReviewIntent)) {
        confirmationGrant = null;
        return Promise.resolve({ ok: false, reason: 'stale_intent' });
      }
      grant.used = true;
      var serverResult;
      try { serverResult = client.confirmReviewIntent(intentId); } catch (error) {
        serverResult = Promise.reject(error);
      }
      return Promise.resolve(serverResult).then(function (serverValue) {
        var serverExact = readExactDataObject(serverValue, ['ok', 'intentId', 'executed']);
        var current = confirmationGrant === grant && reviewStillCurrent(grant.review);
        if (!current) {
          if (confirmationGrant === grant) confirmationGrant = null;
          return { ok: false, reason: 'stale_intent' };
        }
        if (!serverExact || serverExact.ok !== true
          || serverExact.intentId !== grant.review.intentId || serverExact.executed !== false) {
          var denied = readExactDataObject(serverValue, ['ok', 'reason']);
          confirmationGrant = null;
          if (denied && denied.ok === false
            && (denied.reason === 'duplicate' || denied.reason === 'expired'
              || denied.reason === 'stale_intent')) {
            return { ok: false, reason: 'stale_intent' };
          }
          return { ok: false, reason: 'navigation_failed' };
        }

        var result;
        try { result = intentRouter.confirm(intentId, grant.origin); } catch (_) { result = null; }
        return Promise.resolve(result).then(function (value) {
          var exact = readExactDataObject(value, ['executed', 'intentId', 'kind', 'destination', 'source']);
          var stillCurrent = confirmationGrant === grant && reviewStillCurrent(grant.review);
          confirmationGrant = null;
          if (!stillCurrent || !exact || exact.executed !== true
            || exact.intentId !== grant.review.intentId
            || exact.kind !== grant.review.kind
            || exact.destination !== grant.review.destination
            || exact.source !== grant.origin) {
            return { ok: false, reason: stillCurrent ? 'navigation_failed' : 'stale_intent' };
          }
          pendingReview = null;
          if (view) {
            text(view.reviewQuestion, '');
            setDisplay(view.reviewControls, 'none');
            setDisabled(view.reviewButton, true);
          }
          return { ok: true };
        }, function () {
          if (confirmationGrant === grant) confirmationGrant = null;
          return { ok: false, reason: 'navigation_failed' };
        });
      }, function (error) {
        var failure = error && error.code === 'auth_expired'
          ? 'authorization_expired' : 'navigation_failed';
        if (confirmationGrant === grant) confirmationGrant = null;
        return { ok: false, reason: failure };
      });
    }

    function beginReviewConfirmation(origin) {
      if ((origin !== 'button' && origin !== 'voice') || !pendingReview
        || !reviewStillCurrent(pendingReview) || !loginBrief || confirmationGrant) {
        return Promise.resolve({ accepted: false, reason: 'review_unavailable' });
      }
      var grant = { origin: origin, review: pendingReview, used: false };
      confirmationGrant = grant;
      var work;
      try { work = loginBrief.confirmReview(origin); } catch (_) { work = null; }
      return Promise.resolve(work).then(function (result) {
        if (confirmationGrant === grant) confirmationGrant = null;
        return result;
      }, function () {
        if (confirmationGrant === grant) confirmationGrant = null;
        return { accepted: false, reason: 'navigation_failed' };
      });
    }

    function voiceControlsSnapshot(controlState) {
      if (!view) return;
      var canStart = ownData(controlState, 'canStart');
      var canStop = ownData(controlState, 'canStop');
      var off = ownData(controlState, 'off');
      setDisabled(view.voiceStart, emergencyOff || !voiceHost || !canStart.ok || canStart.value !== true);
      setDisabled(view.voiceStop, !voiceHost || !canStop.ok || canStop.value !== true);
      setDisabled(view.voiceOff, emergencyOff || !voiceHost);
      if (off.ok && off.value === true) text(view.voiceStatus, 'Voice emergency OFF is active.');
    }

    function stopVoice(reason) {
      voiceEnabled = false;
      if (voiceHost) {
        try { if (isFunction(voiceHost.interrupt)) voiceHost.interrupt(); } catch (_) {}
        try { if (isFunction(voiceHost.stop)) voiceHost.stop(); } catch (_) {}
      }
      if (view) {
        text(view.voiceInterim, '');
        text(view.voiceConfirm, '');
        if (!emergencyOff) text(view.voiceStatus, reason === 'panel_closed' ? 'Voice is off. Enable it again to listen.' : 'Voice is off.');
      }
      emitState(reason || 'voice_stopped');
    }

    function emergencyVoiceOff() {
      if (emergencyOff) return { off: true, executed: false };
      emergencyOff = true;
      voiceEnabled = false;
      if (voiceHost && isFunction(voiceHost.emergencyOff)) {
        try { voiceHost.emergencyOff(); } catch (_) {}
      }
      if (view) {
        text(view.voiceStatus, 'Voice emergency OFF is active.');
        text(view.voiceInterim, '');
        text(view.voiceConfirm, '');
        setDisabled(view.voiceStart, true);
        setDisabled(view.voiceStop, true);
        setDisabled(view.voiceOff, true);
      }
      emitState('voice_off');
      return { off: true, executed: false };
    }

    function exactVoiceEvent(meta) {
      var exact = readExactDataObject(meta, ['text', 'isFinal', 'eventId']);
      if (!exact || exact.isFinal !== true || !safePrimitiveText(exact.text, MAX_USER_TEXT, false)) return null;
      if (!((typeof exact.eventId === 'string' && safePrimitiveText(exact.eventId, 200, false))
        || (typeof exact.eventId === 'number' && Number.isFinite(exact.eventId)))) return null;
      var normalized = exact.text.trim();
      return normalized ? { text: normalized, eventId: exact.eventId } : null;
    }

    function assessVoiceTranscript(meta) {
      var exact = exactVoiceEvent(meta);
      if (!exact || !voiceEnabled || emergencyOff || disposed) return { decision: 'reject' };
      if (pendingReview && reviewStillCurrent(pendingReview) && loginBrief) {
        if (EXACT_REVIEW_YES_RE.test(exact.text)) {
          try { if (voiceHost && isFunction(voiceHost.stop)) voiceHost.stop(); } catch (_) {}
          var generation = isFunction(loginBrief.getGeneration) ? loginBrief.getGeneration() : null;
          var grant = { origin: 'voice', review: pendingReview, used: false };
          confirmationGrant = grant;
          var work;
          try {
            work = loginBrief.submitVoiceConfirmation(Object.freeze({
              source: 'reina.voice.final', final: true, generation: generation,
              eventId: exact.eventId, text: exact.text,
            }));
          } catch (_) { work = null; }
          Promise.resolve(work).then(function () {
            if (confirmationGrant === grant) confirmationGrant = null;
          }, function () {
            if (confirmationGrant === grant) confirmationGrant = null;
          });
          return { decision: 'reject' };
        }
        if (EXACT_REVIEW_NO_RE.test(exact.text)) {
          try {
            loginBrief.submitVoiceConfirmation(Object.freeze({
              source: 'reina.voice.final', final: true,
              generation: isFunction(loginBrief.getGeneration) ? loginBrief.getGeneration() : null,
              eventId: exact.eventId, text: exact.text,
            }));
          } catch (_) {}
          revokeReview('declined', false);
          return { decision: 'reject' };
        }
      }
      revokeReview('turn_replaced', true);
      appendMessage('user', exact.text);
      state = 'submitting';
      normalInput(false);
      emitState(null);
      return { decision: 'accept' };
    }

    function enableVoiceFromGesture(event) {
      if (!trustedGesture(event) || disposed || state !== 'ready' || emergencyOff
        || !voiceHost || !isFunction(voiceHost.startListening)) return false;
      var started;
      try { started = voiceHost.startListening(); } catch (_) { started = false; }
      voiceEnabled = started === true;
      if (voiceEnabled && loginBrief && isFunction(loginBrief.onVoiceEnabled)) {
        try { loginBrief.onVoiceEnabled(); } catch (_) { voiceEnabled = false; }
      }
      if (!voiceEnabled && started === true) {
        try { if (isFunction(voiceHost.stop)) voiceHost.stop(); } catch (_) {}
        started = false;
      }
      if (view) text(view.voiceStatus, started === true ? 'Listening…' : 'Voice input is unavailable in this browser.');
      emitState(started === true ? 'voice_enabled' : 'voice_unavailable');
      return started === true;
    }

    function showNativeVoiceIssue(code) {
      if (code === 'canceled' || disposed || emergencyOff) return;
      voiceEnabled = false;
      var message = Object.prototype.hasOwnProperty.call(NATIVE_VOICE_MESSAGES, code)
        ? NATIVE_VOICE_MESSAGES[code] : NATIVE_VOICE_MESSAGES.recognition_error;
      if (view) {
        text(view.voiceStatus, message);
        text(view.voiceError, message);
      }
      emitState('voice_' + (Object.prototype.hasOwnProperty.call(NATIVE_RECOGNITION_CODES, code)
        ? code : 'recognition_error'));
    }

    function installVoice(expectedEpoch, expectedClient) {
      if (!isFunction(loadVoiceModules) || voiceLoad) return;
      var pending;
      try { pending = loadVoiceModules(); } catch (_) { pending = null; }
      voiceLoad = Promise.resolve(pending).then(function (modules) {
        if (disposed || expectedEpoch !== epoch || expectedClient !== client || !sessionId) return false;
        var exact = readExactDataObject(modules, ['createVoiceHost', 'createVoiceTransport']);
        if (!exact || !isFunction(exact.createVoiceHost) || !isFunction(exact.createVoiceTransport)
          || !isFunction(client.voiceServerTransport)) return false;
        var transport;
        var created;
        try {
          transport = exact.createVoiceTransport(Object.freeze({
            serverTransport: function (request) {
              if (disposed || expectedEpoch !== epoch || expectedClient !== client) {
                return Promise.reject(new Error('auth_expired'));
              }
              return client.voiceServerTransport(request);
            },
            timeoutMs: 15000,
          }));
          if (!transport || !isFunction(transport.submitTurn)) return false;
          var nativeRecognitionFactory = createCapturedNativeRecognitionFactory(showNativeVoiceIssue);
          created = exact.createVoiceHost(Object.freeze({
            conversationId: sessionId,
            newId: newId,
            submitTurn: transport.submitTurn,
            assessTranscript: assessVoiceTranscript,
            isSpeechAllowed: function () {
              return voiceEnabled && !emergencyOff && !disposed
                && expectedEpoch === epoch && expectedClient === client;
            },
            isEmergencyOff: function () { return emergencyOff || disposed || expectedEpoch !== epoch; },
            // The desktop preload is preferred because Electron does not expose
            // Chromium's SpeechRecognition API. Ordinary browsers retain the
            // accepted browser fallback unchanged.
            recognitionFactory: nativeRecognitionFactory
              || (CAPTURED_SPEECH_RECOGNITION ? function () { return new CAPTURED_SPEECH_RECOGNITION(); } : null),
            synthesis: CAPTURED_SPEECH_SYNTHESIS,
            utteranceFactory: CAPTURED_UTTERANCE ? function (value) { return new CAPTURED_UTTERANCE(value); } : null,
            controls: Object.freeze({}),
            render: Object.freeze({
              status: function (value) { if (view && safePrimitiveText(value, 120, true)) text(view.voiceStatus, value ? 'Voice: ' + value : ''); },
              interim: function (value) { if (view && safePrimitiveText(value, MAX_USER_TEXT, true)) text(view.voiceInterim, value); },
              reply: function (value) {
                if (!view || !safePrimitiveText(value, MAX_RENDER_TEXT, false)
                  || emergencyOff || disposed || expectedEpoch !== epoch) return;
                appendMessage('assistant', value);
                state = 'ready';
                normalInput(true);
                text(view.status, 'Synthetic read-only reply. Nothing was executed.');
                emitState(null);
              },
              confirm: function (value) { if (view && safePrimitiveText(value, 500, true)) text(view.voiceConfirm, value); },
              error: function (value) {
                if (!view) return;
                var safe = value === 'error_auth_expired'
                  ? 'Your Reina session expired. Sign in again to continue.'
                  : value === 'error_permission_denied'
                    ? NATIVE_VOICE_MESSAGES.permission_denied
                    : value === 'error_no_speech'
                      ? NATIVE_VOICE_MESSAGES.no_speech
                      : value === 'error_timeout'
                        ? NATIVE_VOICE_MESSAGES.timeout
                        : 'Reina heard you, but that read-only turn did not finish. Select Retry.';
                text(view.voiceError, safe);
              },
              controls: voiceControlsSnapshot,
            }),
            onControlEvent: function (event) {
              var type = ownData(event, 'type');
              var detail = ownData(event, 'detail');
              if (type.ok && type.value === 'error' && detail.ok) {
                var reason = ownData(detail.value, 'reason');
                if (reason.ok && reason.value === 'auth_expired') expireSession();
              }
            },
          }));
        } catch (_) { return false; }
        if (!created || !isFunction(created.mount) || !isFunction(created.dispose)) return false;
        var mountedVoice;
        try { mountedVoice = created.mount(); } catch (_) { mountedVoice = false; }
        if (mountedVoice !== true) {
          try { created.dispose(); } catch (_) {}
          return false;
        }
        voiceHost = created;
        if (view) {
          setDisabled(view.voiceStart, !isFunction(created.isVoiceAvailable) || created.isVoiceAvailable() !== true);
          setDisabled(view.voiceOff, false);
          text(view.voiceStatus, isFunction(created.isVoiceAvailable) && created.isVoiceAvailable() === true
            ? 'Voice is off. Select Enable Voice to start listening.'
            : 'Voice input is unavailable in this browser.');
        }
        emitState('voice_ready');
        return true;
      }, function () { return false; });
    }

    function fixedFailure(code) {
      var message = FIXED_ERRORS[code] || FIXED_ERRORS.unavailable;
      if (view) {
        text(view.error, message);
        text(view.status, '');
      }
      return message;
    }

    function beginPendingSession(expectedEpoch) {
      var resolvePending;
      var record = {
        epoch: expectedEpoch,
        settled: false,
        promise: new Promise(function (resolve) { resolvePending = resolve; }),
        resolve: resolvePending,
      };
      pendingSession = record;
      return record;
    }

    function settlePendingSession(record, result) {
      if (!record || record.settled === true) return false;
      record.settled = true;
      if (pendingSession === record) pendingSession = null;
      record.resolve(result);
      return true;
    }

    function cancelPendingSession(reason) {
      var record = pendingSession;
      if (!record) return false;
      return settlePendingSession(record, { ok: false, reason: reason });
    }

    function stopControllers() {
      var previousLogin = loginBrief;
      var previousTyped = typedPanel;
      var previousRouter = intentRouter;
      var previousVoice = voiceHost;
      loginBrief = null;
      typedPanel = null;
      intentRouter = null;
      voiceHost = null;
      voiceLoad = null;
      confirmationGrant = null;
      pendingReview = null;
      voiceEnabled = false;
      emergencyOff = false;
      client = null;
      sessionId = null;
      if (previousRouter && isFunction(previousRouter.revoke)) {
        try { previousRouter.revoke('session_replaced'); } catch (_) {}
      }
      if (previousRouter && isFunction(previousRouter.dispose)) {
        try { previousRouter.dispose(); } catch (_) {}
      }
      if (previousVoice && isFunction(previousVoice.emergencyOff)) {
        try { previousVoice.emergencyOff(); } catch (_) {}
      }
      if (previousVoice && isFunction(previousVoice.dispose)) {
        try { previousVoice.dispose(); } catch (_) {}
      }
      if (previousTyped && isFunction(previousTyped.reset)) {
        try { previousTyped.reset(); } catch (_) { /* discarded */ }
      }
      if (previousLogin && isFunction(previousLogin.onAuthExpired)) {
        try { previousLogin.onAuthExpired(); } catch (_) { /* discarded */ }
      }
    }

    function expireSession() {
      if (disposed || state === 'auth_expired') return snapshot('auth_expired');
      var recoverAfterTurn = refreshedDuringTurn;
      refreshedDuringTurn = false;
      cancelPendingSession('auth_expired');
      epoch += 1;
      stopControllers();
      clearPresentation();
      state = 'auth_expired';
      fixedFailure('auth_expired');
      if (!expirySignaled) {
        expirySignaled = true;
        try { onAuthExpired(); } catch (_) { /* callback cannot alter reset */ }
      }
      var expired = emitState('auth_expired');
      if (recoverAfterTurn) {
        // The old-token operation has already produced its terminal 403. Let
        // the typed controller consume that rejection, then bootstrap a fresh
        // session without retrying or duplicating the semantic turn.
        Promise.resolve().then(function () { return Promise.resolve(); }).then(function () {
          if (!disposed && mounted && state === 'auth_expired') startSession();
        });
      }
      return expired;
    }

    function renderLoginView(model, expectedLogin, expectedEpoch, settle) {
      if (disposed || expectedEpoch !== epoch || expectedLogin !== loginBrief) {
        settle({ ok: false, reason: disposed ? 'disposed' : 'superseded' });
        return;
      }
      var stateValue = ownData(model, 'state');
      if (!stateValue.ok || typeof stateValue.value !== 'string') {
        refreshedDuringTurn = false;
        state = 'unavailable';
        fixedFailure('bootstrap_failed');
        hidePage(page);
        emitState('bootstrap_failed');
        settle({ ok: false, reason: 'bootstrap_failed' });
        return;
      }
      if (stateValue.value === 'loading') {
        state = 'loading';
        text(view.status, 'Loading Reina\'s read-only preview…');
        emitState(null);
        return;
      }
      if (stateValue.value === 'greeted') {
        var greeting = ownData(model, 'greeting');
        var summary = ownData(model, 'attentionSummary');
        var categories = ownData(model, 'categories');
        var disclosures = ownData(model, 'unavailableDisclosures');
        var reviewAvailable = ownData(model, 'reviewAvailable');
        var question = ownData(model, 'question');
        if (!greeting.ok || !summary.ok
          || !safePrimitiveText(greeting.value, 500, false)
          || !safePrimitiveText(summary.value, 1000, false)
          || !reviewAvailable.ok || typeof reviewAvailable.value !== 'boolean'
          || !question.ok || !safePrimitiveText(question.value, 500, true)) {
          state = 'unavailable';
          fixedFailure('bootstrap_failed');
          hidePage(page);
          emitState('bootstrap_failed');
          settle({ ok: false, reason: 'bootstrap_failed' });
          return;
        }
        var categoryLines = [];
        try {
          if (Array.isArray(categories.value)) {
            for (var i = 0; i < categories.value.length && i < 24; i += 1) {
              var category = ownData(categories.value, String(i));
              if (!category.ok) continue;
              var label = ownData(category.value, 'label');
              var count = ownData(category.value, 'count');
              var asOf = ownData(category.value, 'asOf');
              if (label.ok && count.ok && asOf.ok
                && safePrimitiveText(label.value, 120, false)
                && Number.isSafeInteger(count.value)
                && safePrimitiveText(asOf.value, 64, false)) {
                categoryLines.push(label.value + ': ' + count.value + ' (as of ' + asOf.value + ')');
              }
            }
          }
        } catch (_) { categoryLines = []; }
        var unavailable = disclosures.ok ? safeStringList(disclosures.value, 48, 1000) : [];
        if (reviewAvailable.value === false) unavailable.push('Review navigation is unavailable in this release candidate.');
        text(view.greeting, greeting.value);
        text(view.attention, summary.value);
        appendList(view.categories, categoryLines);
        appendList(view.disclosures, unavailable);
        text(view.reviewQuestion, reviewAvailable.value === true ? question.value : '');
        setDisplay(view.reviewControls, reviewAvailable.value === true ? 'flex' : 'none');
        setDisabled(view.reviewButton, reviewAvailable.value !== true);
        text(view.error, '');
        text(view.status, 'Synthetic read-only preview. Nothing can be executed.');
        refreshedDuringTurn = false;
        state = 'ready';
        showVerifiedPanel();
        emitState(null);
        settle({ ok: true, sessionId: sessionId });
        return;
      }
      if (stateValue.value === 'review_requested') {
        pendingReview = null;
        confirmationGrant = null;
        text(view.reviewQuestion, 'Opening the existing attention review surface.');
        setDisplay(view.reviewControls, 'none');
        setDisabled(view.reviewButton, true);
        text(view.error, '');
        state = 'ready';
        normalInput(true);
        emitState('review_opened');
        return;
      }
      if (stateValue.value === 'review_failed') {
        confirmationGrant = null;
        setDisplay(view.reviewControls, 'none');
        setDisabled(view.reviewButton, true);
        text(view.reviewQuestion, 'The review surface could not be opened.');
        state = 'ready';
        normalInput(true);
        emitState('review_failed');
        return;
      }
      if (stateValue.value === 'declined') {
        revokeReview('declined', false);
        text(view.reviewQuestion, 'Review was not opened.');
        state = 'ready';
        normalInput(true);
        emitState('review_declined');
        return;
      }
      if (stateValue.value === 'expired') {
        expireSession();
        settle({ ok: false, reason: 'auth_expired' });
        return;
      }
      state = 'unavailable';
      refreshedDuringTurn = false;
      fixedFailure('bootstrap_failed');
      hidePage(page);
      emitState('bootstrap_failed');
      settle({ ok: false, reason: 'bootstrap_failed' });
    }

    function assistantText(model) {
      var parts = [];
      var answer = ownData(model, 'answer');
      var evidence = ownData(model, 'evidence');
      var freshness = ownData(model, 'freshness');
      var missing = ownData(model, 'missingInformation');
      var conflicts = ownData(model, 'conflictingInformation');
      var uncertainty = ownData(model, 'uncertainty');
      var refusal = ownData(model, 'refusalReason');
      var execution = ownData(model, 'executionNotice');
      if (!answer.ok || !safePrimitiveText(answer.value, 16384, false)) return null;
      parts.push(answer.value);
      var evidenceValues = evidence.ok ? safeStringList(evidence.value, 64, 8192) : [];
      if (evidenceValues.length) parts.push('Evidence: ' + evidenceValues.join(' | '));
      if (freshness.ok && safePrimitiveText(freshness.value, 4096, true) && freshness.value) parts.push(freshness.value);
      var missingValues = missing.ok ? safeStringList(missing.value, 64, 4096) : [];
      if (missingValues.length) parts.push('Missing information: ' + missingValues.join(' | '));
      var conflictValues = conflicts.ok ? safeStringList(conflicts.value, 64, 4096) : [];
      if (conflictValues.length) parts.push('Conflicting information: ' + conflictValues.join(' | '));
      var uncertaintyValues = uncertainty.ok ? safeStringList(uncertainty.value, 64, 4096) : [];
      if (uncertaintyValues.length) parts.push('Uncertainty: ' + uncertaintyValues.join(' | '));
      if (refusal.ok && safePrimitiveText(refusal.value, 2048, true) && refusal.value) parts.push('Refusal: ' + refusal.value);
      if (!execution.ok || !safePrimitiveText(execution.value, 500, false)) return null;
      parts.push(execution.value);
      var rendered = parts.join('\n\n');
      return rendered.length <= MAX_RENDER_TEXT ? rendered : null;
    }

    function renderTypedView(model, expectedTyped, expectedEpoch) {
      if (disposed || expectedEpoch !== epoch || expectedTyped !== typedPanel) return;
      var stateValue = ownData(model, 'state');
      var turnValue = ownData(model, 'turnId');
      if (!stateValue.ok || typeof stateValue.value !== 'string') {
        refreshedDuringTurn = false;
        state = 'turn_error';
        fixedFailure('turn_failed');
        retryInput();
        emitState('turn_failed');
        return;
      }
      if (stateValue.value === 'loading') {
        state = 'submitting';
        text(view.error, '');
        text(view.status, 'Checking the synthetic read-only preview…');
        if (retrying) {
          setDisabled(page.input, true);
          setDisabled(page.send, true);
        } else normalInput(false);
        emitState(null);
        return;
      }
      if (stateValue.value === 'answered') {
        var turnId = turnValue.ok && typeof turnValue.value === 'string' ? turnValue.value : null;
        var rendered = assistantText(model);
        if (!turnId || !rendered || renderedTurns[turnId]) {
          refreshedDuringTurn = false;
          retrying = false;
          state = 'turn_error';
          fixedFailure('turn_failed');
          retryInput();
          emitState('turn_failed');
          return;
        }
        renderedTurns[turnId] = true;
        appendMessage('assistant', rendered);
        text(view.error, '');
        text(view.status, 'Synthetic read-only reply. Nothing was executed.');
        refreshedDuringTurn = false;
        retrying = false;
        state = 'ready';
        normalInput(true);
        emitState(null);
        return;
      }
      if (stateValue.value === 'auth_expired') {
        retrying = false;
        expireSession();
        return;
      }
      if (stateValue.value === 'error' || stateValue.value === 'unavailable') {
        refreshedDuringTurn = false;
        retrying = false;
        state = 'turn_error';
        fixedFailure('turn_failed');
        retryInput();
        emitState('turn_failed');
      }
    }

    function startSession() {
      if (disposed || !mounted) return Promise.resolve({ ok: false, reason: 'not_mounted' });
      if (pendingSession) return pendingSession.promise;
      refreshedDuringTurn = false;
      epoch += 1;
      var myEpoch = epoch;
      var pending = beginPendingSession(myEpoch);
      function settle(value) { settlePendingSession(pending, value); }
      stopControllers();
      clearPresentation();
      expirySignaled = false;
      state = 'loading';
      text(view.status, 'Verifying the signed-in Reina preview…');
      emitState(null);

      try {
        var clientOptions = {
          onAuthExpired: function () { if (myEpoch === epoch) expireSession(); },
        };
        if (isFunction(getAccessToken)) clientOptions.getAccessToken = getAccessToken;
        client = createClient(Object.freeze(clientOptions));
      } catch (_) {
        client = null;
      }
      if (!client || !isFunction(client.bootstrap) || !isFunction(client.submitTurn)
        || !isFunction(client.confirmReviewIntent)) {
        state = 'unavailable';
        fixedFailure('unavailable');
        hidePage(page);
        emitState('unavailable');
        settle({ ok: false, reason: 'unavailable' });
        return pending.promise;
      }

      var bootstrapPromise;
      try { bootstrapPromise = client.bootstrap(); } catch (_) { bootstrapPromise = Promise.reject(new Error('bootstrap')); }
      Promise.resolve(bootstrapPromise).then(function (result) {
        if (disposed || myEpoch !== epoch) {
          settle({ ok: false, reason: disposed ? 'disposed' : 'superseded' });
          return;
        }
        var exact = readExactDataObject(result, ['sessionId', 'bootstrap']);
        if (!exact || typeof exact.sessionId !== 'string' || !SERVER_SESSION_RE.test(exact.sessionId)) {
          state = 'unavailable';
          fixedFailure('bootstrap_failed');
          hidePage(page);
          emitState('bootstrap_failed');
          settle({ ok: false, reason: 'bootstrap_failed' });
          return;
        }
        sessionId = exact.sessionId;
        var loginBootstrap = bootstrapForLoginBrief(exact.bootstrap, sessionId);
        if (!loginBootstrap || !registerReviewIntent(exact.bootstrap, myEpoch)) {
          state = 'unavailable';
          fixedFailure('bootstrap_failed');
          hidePage(page);
          emitState('bootstrap_failed');
          settle({ ok: false, reason: 'bootstrap_failed' });
          return;
        }
        var createdLogin;
        var createdTyped;
        try {
          createdLogin = createLoginBrief({
            fetchBootstrap: function (request) {
              var requested = ownData(request, 'sessionId');
              if (!requested.ok || requested.value !== sessionId) return Promise.reject(new Error('session'));
              return Promise.resolve(loginBootstrap);
            },
            confirmIntent: strictReviewConfirmation,
            onView: function (model) { renderLoginView(model, createdLogin, myEpoch, settle); },
          });
          createdTyped = createTypedPanel({
            conversationId: sessionId,
            newId: newId,
            submitTurn: function (request) { return client.submitTurn(request); },
            onAuthExpired: function () { if (myEpoch === epoch) expireSession(); },
            onView: function (model) { renderTypedView(model, createdTyped, myEpoch); },
          });
        } catch (_) {
          revokeReview('controller_unavailable', false);
          if (intentRouter && isFunction(intentRouter.dispose)) {
            try { intentRouter.dispose(); } catch (_) {}
          }
          intentRouter = null;
          state = 'unavailable';
          fixedFailure('unavailable');
          hidePage(page);
          emitState('unavailable');
          settle({ ok: false, reason: 'unavailable' });
          return;
        }
        loginBrief = createdLogin;
        typedPanel = createdTyped;
        installVoice(myEpoch, client);
        var accepted;
        try { accepted = loginBrief.onAuthenticated(sessionId); } catch (_) { accepted = null; }
        if (!accepted || accepted.accepted !== true) {
          state = 'unavailable';
          fixedFailure('bootstrap_failed');
          hidePage(page);
          emitState('bootstrap_failed');
          settle({ ok: false, reason: 'bootstrap_failed' });
        }
      }).catch(function (error) {
        if (disposed || myEpoch !== epoch) {
          settle({ ok: false, reason: disposed ? 'disposed' : 'superseded' });
          return;
        }
        var errorCode = ownData(error, 'code');
        var code = errorCode.ok && errorCode.value === 'auth_expired' ? 'auth_expired' : 'bootstrap_failed';
        if (code === 'auth_expired') {
          expireSession();
          settle({ ok: false, reason: 'auth_expired' });
          return;
        }
        state = 'unavailable';
        fixedFailure(code);
        hidePage(page);
        emitState(code);
        settle({ ok: false, reason: code });
      });
      return pending.promise;
    }

    function submitTyped(value) {
      if (disposed || state !== 'ready' || !typedPanel) return { accepted: false, reason: 'session_unavailable' };
      if (!safePrimitiveText(value, MAX_USER_TEXT, false)) {
        fixedFailure('invalid_input');
        return { accepted: false, reason: 'invalid_input' };
      }
      var normalized = value.trim();
      if (!normalized || CONTROL_RE.test(normalized)) {
        fixedFailure('invalid_input');
        return { accepted: false, reason: 'invalid_input' };
      }
      var outcome;
      revokeReview('turn_replaced', true);
      // Typed input must not touch the Voice session before the host-owned
      // trusted-gesture latch is set. In PR #81, interrupt() deliberately
      // restarts recognition; calling it on an otherwise dormant Voice host
      // would activate the microphone without consent.
      if (voiceEnabled && voiceHost) {
        try { if (isFunction(voiceHost.interrupt)) voiceHost.interrupt(); } catch (_) {}
        try { if (isFunction(voiceHost.stop)) voiceHost.stop(); } catch (_) {}
      }
      refreshedDuringTurn = false;
      retrying = false;
      try { outcome = typedPanel.submit(normalized); } catch (_) { outcome = null; }
      if (!outcome || outcome.accepted !== true) {
        if (outcome && outcome.reason === 'busy') return { accepted: false, reason: 'busy' };
        fixedFailure('turn_failed');
        return { accepted: false, reason: 'turn_failed' };
      }
      appendMessage('user', normalized);
      try { page.input.value = ''; } catch (_) { /* inert */ }
      return { accepted: true, turnId: outcome.turnId };
    }

    function submitFromInput() {
      if (state === 'turn_error') return retryTurn();
      var value;
      try { value = page.input.value; } catch (_) { value = null; }
      return submitTyped(value);
    }

    function retryTurn() {
      if (disposed || state !== 'turn_error' || !typedPanel || !isFunction(typedPanel.retry)) {
        return { accepted: false, reason: 'nothing_to_retry' };
      }
      var outcome;
      retrying = true;
      try { outcome = typedPanel.retry(); } catch (_) { outcome = null; }
      if (!outcome || outcome.accepted !== true) {
        retrying = false;
        retryInput();
        fixedFailure('turn_failed');
        return { accepted: false, reason: 'turn_failed' };
      }
      return { accepted: true, turnId: outcome.turnId };
    }

    function mount() {
      if (disposed) return Promise.resolve({ ok: false, reason: 'disposed' });
      if (!mounted) {
        buildView();
        mounted = true;
        try { if (isFunction(page.input.setAttribute)) page.input.setAttribute('data-hl-voice-input', 'off'); } catch (_) {}
        bindOwnedClick(page.fab, function () {
          if (state !== 'ready' && state !== 'submitting' && state !== 'turn_error') return;
          try {
            if (page.panel.classList.contains('open')) {
              removeClass(page.panel, 'open');
              stopVoice('panel_closed');
            }
            else addClass(page.panel, 'open');
          } catch (_) { removeClass(page.panel, 'open'); }
        });
        bindOwnedClick(page.close, function () { removeClass(page.panel, 'open'); stopVoice('panel_closed'); });
        bindOwnedClick(page.send, function () { submitFromInput(); });
        bindOwnedClick(view.reviewButton, function (event) {
          if (!trustedGesture(event)) return;
          beginReviewConfirmation('button');
        });
        bindOwnedClick(view.voiceStart, function (event) { enableVoiceFromGesture(event); });
        bindOwnedClick(view.voiceStop, function (event) { if (trustedGesture(event)) stopVoice('voice_stopped'); });
        bindOwnedClick(view.voiceOff, function () { emergencyVoiceOff(); });
        bind(page.input, 'keydown', function (event) {
          try {
            if (event && event.key === 'Enter' && event.shiftKey !== true) {
              if (isFunction(event.preventDefault)) event.preventDefault();
              submitFromInput();
            }
          } catch (_) { /* malformed event does nothing */ }
        });
      } else if (state === 'loading' && pendingSession) {
        return pendingSession.promise;
      } else if (state === 'ready' || state === 'submitting') {
        return Promise.resolve({ ok: true, sessionId: sessionId });
      }
      return startSession();
    }

    function resetSession() {
      if (disposed || !mounted) return Promise.resolve({ ok: false, reason: 'not_mounted' });
      cancelPendingSession('superseded');
      refreshedDuringTurn = false;
      epoch += 1;
      stopControllers();
      clearPresentation();
      state = 'idle';
      emitState('session_reset');
      return startSession();
    }

    function dispose() {
      if (disposed) return { disposed: true, executed: false };
      epoch += 1;
      disposed = true;
      refreshedDuringTurn = false;
      cancelPendingSession('disposed');
      stopControllers();
      for (var i = 0; i < listeners.length; i += 1) {
        var listener = listeners[i];
        try {
          if (listener.property === true) {
            if (listener.node.onclick === listener.handler) listener.node.onclick = null;
          } else if (isFunction(listener.node.removeEventListener)) {
            listener.node.removeEventListener(listener.eventName, listener.handler);
          }
        } catch (_) { /* stale listener is inert */ }
      }
      listeners = [];
      clearPresentation();
      text(page.feed, '');
      hidePage(page);
      view = null;
      mounted = false;
      state = 'disposed';
      emitState(null);
      return { disposed: true, executed: false };
    }

    function noteAuthRefresh() {
      if (disposed || (state !== 'loading' && state !== 'submitting')) return false;
      refreshedDuringTurn = true;
      return true;
    }

    return Object.freeze({
      mount: mount,
      dispose: dispose,
      resetSession: resetSession,
      submitTyped: submitTyped,
      retryTurn: retryTurn,
      emergencyVoiceOff: emergencyVoiceOff,
      stopVoice: function () { stopVoice('voice_stopped'); return { stopped: true, executed: false }; },
      noteAuthRefresh: noteAuthRefresh,
      getState: function () { return snapshot(null); },
      getElements: function () { return page; },
      getViewElements: function () { return view; },
    });
  }

  function installReinaPilotPage(options) {
    options = options && typeof options === 'object' ? options : {};
    var documentRef = optionValue(options, 'documentRef', root && root.document ? root.document : null);
    var authClient = optionValue(options, 'authClient', root && root.sb ? root.sb : null);
    var createHost = optionValue(options, 'createHost', createReinaPilotHost);
    var page = resolveElements(documentRef);
    var authValue = ownData(authClient, 'auth');
    var auth = authValue.ok ? authValue.value : null;
    var getSession = captureBoundMethod(auth, 'getSession');
    var onAuthStateChangeMethod = captureBoundMethod(auth, 'onAuthStateChange');

    function getAccessToken() {
      if (!getSession) return Promise.reject(new Error('auth_expired'));
      var pending;
      try { pending = getSession(); } catch (_) { return Promise.reject(new Error('auth_expired')); }
      return Promise.resolve(pending).then(function (result) {
        var data = ownData(result, 'data');
        var session = data.ok ? ownData(data.value, 'session') : { ok: false };
        var user = session.ok ? ownData(session.value, 'user') : { ok: false };
        var principal = user.ok ? ownData(user.value, 'id') : { ok: false };
        var token = session.ok ? ownData(session.value, 'access_token') : { ok: false };
        if (!principal.ok || !safePrimitiveText(principal.value, 512, false)
          || principal.value !== activePrincipalId
          || !token.ok || !safePrimitiveText(token.value, 16384, false)) throw new Error('auth_expired');
        return token.value;
      }, function () { throw new Error('auth_expired'); });
    }

    var stopped = false;
    var host = null;
    var generation = 0;
    var subscription = null;
    var activePrincipalId = null;
    var authEventObserved = false;

    function sessionPrincipalId(session) {
      var user = ownData(session, 'user');
      if (!user.ok) return null;
      var id = ownData(user.value, 'id');
      return id.ok && safePrimitiveText(id.value, 512, false) ? id.value : null;
    }

    function currentHostState() {
      if (!host || !isFunction(host.getState)) return null;
      try {
        var value = host.getState();
        var stateValue = ownData(value, 'state');
        return stateValue.ok && typeof stateValue.value === 'string' ? stateValue.value : null;
      } catch (_) {
        return null;
      }
    }

    function deactivate() {
      generation += 1;
      var previous = host;
      host = null;
      activePrincipalId = null;
      if (previous && isFunction(previous.dispose)) {
        try { previous.dispose(); } catch (_) { /* presentation still hidden below */ }
      }
      hidePage(page);
      if (page) text(page.feed, '');
    }

    function makeHost() {
      if (!page || !isFunction(createHost)) return null;
      try {
        return createHost(Object.freeze({ documentRef: documentRef, elements: page, getAccessToken: getAccessToken }));
      } catch (_) {
        return null;
      }
    }

    function activate() {
      if (stopped) return;
      var myGeneration = ++generation;
      if (!host) host = makeHost();
      if (!host) {
        hidePage(page);
        return;
      }
      var work;
      try {
        work = host.mount();
      } catch (_) {
        deactivate();
        return;
      }
      Promise.resolve(work).then(function (result) {
        if (stopped || myGeneration !== generation) return;
        if (!result || result.ok !== true) hidePage(page);
      }, function () {
        if (stopped || myGeneration !== generation) return;
        deactivate();
      });
    }

    function onAuthStateChange(event, session) {
      if (stopped || typeof event !== 'string') return;
      authEventObserved = true;
      if (event === 'SIGNED_OUT' || session == null) {
        deactivate();
        return;
      }
      if (event === 'INITIAL_SESSION' || event === 'SIGNED_IN'
        || event === 'TOKEN_REFRESHED' || event === 'USER_UPDATED') {
        var nextPrincipalId = sessionPrincipalId(session);
        if (!nextPrincipalId) {
          deactivate();
          return;
        }
        if (!host) {
          activePrincipalId = nextPrincipalId;
          activate();
          return;
        }
        if (activePrincipalId && nextPrincipalId && activePrincipalId !== nextPrincipalId) {
          deactivate();
          activePrincipalId = nextPrincipalId;
          activate();
          return;
        }
        if (!activePrincipalId && nextPrincipalId) activePrincipalId = nextPrincipalId;
        var hostState = currentHostState();
        if (event === 'TOKEN_REFRESHED' && (hostState === 'loading' || hostState === 'submitting')
          && isFunction(host.noteAuthRefresh)) {
          try { host.noteAuthRefresh(); } catch (_) { /* the in-flight turn remains fenced */ }
        }
        if (hostState === 'unavailable' || hostState === 'auth_expired') activate();
      }
    }

    function refreshFromConfirmedSession(session) {
      if (stopped) return false;
      var principal = sessionPrincipalId(session);
      if (!principal) {
        deactivate();
        return false;
      }
      onAuthStateChange('INITIAL_SESSION', session);
      return true;
    }

    function stop() {
      if (stopped) return { stopped: true, executed: false };
      stopped = true;
      deactivate();
      if (subscription && isFunction(subscription.unsubscribe)) {
        try { subscription.unsubscribe(); } catch (_) { /* local teardown already complete */ }
      }
      subscription = null;
      try { if (root && root.hlReinaPilotStop === stop) root.hlReinaPilotStop = null; } catch (_) {}
      return { stopped: true, executed: false };
    }

    hidePage(page);
    if (!page || !auth || !onAuthStateChangeMethod || !getSession || !isFunction(createHost)) {
      return Object.freeze({
        installed: false,
        stop: stop,
        getHost: function () { return host; },
      });
    }

    var registered;
    try { registered = onAuthStateChangeMethod(onAuthStateChange); } catch (_) { registered = null; }
    try {
      var registeredData = ownData(registered, 'data');
      var subscriptionValue = registeredData.ok ? ownData(registeredData.value, 'subscription') : { ok: false };
      subscription = subscriptionValue.ok ? subscriptionValue.value : null;
    } catch (_) { subscription = null; }
    // Supabase normally emits INITIAL_SESSION, but a page can install after
    // that event (for example on a restored tab).  Reconcile the current
    // session explicitly so the authenticated panel cannot remain hidden just
    // because the one-shot event was missed.  This is only a lifecycle retry;
    // the host still performs its normal server-owned bootstrap and auth check.
    try {
      setTimeout(function () {
        if (stopped || authEventObserved) return;
        var current;
        try { current = getSession(); } catch (_) { return; }
        Promise.resolve(current).then(function (result) {
          if (stopped || authEventObserved) return;
          var data = ownData(result, 'data');
          var sessionValue = data.ok ? ownData(data.value, 'session') : { ok: false };
          var session = sessionValue.ok ? sessionValue.value : null;
          var principal = session ? sessionPrincipalId(session) : null;
          if (principal) onAuthStateChange('INITIAL_SESSION', session);
        }, function () { /* no session: remain hidden */ });
      }, 0);
    } catch (_) { /* no session: remain hidden */ }
    try { if (root) root.hlReinaPilotStop = stop; } catch (_) {}
    try { if (root) root.hlReinaPilotRefresh = refreshFromConfirmedSession; } catch (_) {}
    return Object.freeze({
      installed: true,
      stop: stop,
      refresh: refreshFromConfirmedSession,
      getHost: function () { return host; },
    });
  }

  return Object.freeze({
    createReinaPilotHost: createReinaPilotHost,
    installReinaPilotPage: installReinaPilotPage,
    resolveElements: resolveElements,
    createNativeRecognitionFactory: createNativeRecognitionFactory,
    createCapturedNativeRecognitionFactory: createCapturedNativeRecognitionFactory,
    nativeRecognitionAvailable: CAPTURED_NATIVE_RECOGNITION !== null,
    FIXED_ERRORS: FIXED_ERRORS,
    NATIVE_VOICE_MESSAGES: NATIVE_VOICE_MESSAGES,
    PAGE_IDS: PAGE_IDS,
  });
});
