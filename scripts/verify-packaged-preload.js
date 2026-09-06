'use strict';

const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const asar = require('@electron/asar');

const source = fs.readFileSync(path.join(__dirname, '..', 'src', 'preload.js'));
const packaged = asar.extractFile(
  path.join(__dirname, '..', 'dist', 'win-unpacked', 'resources', 'app.asar'),
  'src/preload.js'
);
const hash = (value) => crypto.createHash('sha256').update(value).digest('hex');
const packagedText = packaged.toString('utf8');

assert.equal(hash(packaged), hash(source));
assert.equal(packagedText.includes("require('./"), false);
assert.equal(packagedText.includes('require("./'), false);
assert.equal(
  packagedText.includes("exposeInMainWorld('hivelogicDesktop'"),
  true
);
assert.equal(
  packagedText.includes('recognizeOnce: speechBridge.recognizeOnce'),
  true
);

assert.equal(packagedText.includes('startScreenAnnotate'), true);

/* Screen markup is eight more files that have to be inside the asar, and the
 * failure if one is missing is silent AND stranding: the overlay opens fully
 * transparent over the whole screen with no canvas and no toolbar — meaning
 * the Stop button is among the things that did not ship. Checked here rather
 * than discovered live on a call. */
const OVERLAY_FILES = [
  'src/screen-annotate.js',
  'src/overlay/overlay.html',
  'src/overlay/overlay.js',
  'src/overlay/overlay-preload.js',
  'src/overlay/toolbar.html',
  'src/overlay/toolbar.js',
  'src/overlay/toolbar-preload.js',
  'src/overlay/vendor/draw.js',
];
for (const rel of OVERLAY_FILES) {
  const onDisk = fs.readFileSync(path.join(__dirname, '..', rel));
  const inAsar = asar.extractFile(
    path.join(__dirname, '..', 'dist', 'win-unpacked', 'resources', 'app.asar'),
    rel
  );
  assert.equal(hash(inAsar), hash(onDisk), `${rel} is missing or altered in app.asar`);
}

console.log(JSON.stringify({
  sourceHash: hash(source),
  packagedHash: hash(packaged),
  identical: true,
  localRequires: false,
  exposesDesktopBridge: true,
  exposesRecognizeOnce: true,
  exposesScreenAnnotate: true,
  overlayFilesPackaged: OVERLAY_FILES.length,
}));
