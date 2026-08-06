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

console.log(JSON.stringify({
  sourceHash: hash(source),
  packagedHash: hash(packaged),
  identical: true,
  localRequires: false,
  exposesDesktopBridge: true,
  exposesRecognizeOnce: true,
}));
