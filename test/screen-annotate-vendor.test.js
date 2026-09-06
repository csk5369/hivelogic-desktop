'use strict';

/**
 * The vendored drawing engine must stay a copy, not a fork.
 *
 * src/overlay/vendor/draw.js is a byte-for-byte copy of
 * public/hiveconnect/draw.js in the hivelogic-live repo, so a mark drawn on
 * the whole screen is built and painted by exactly the same code as the same
 * mark drawn inside Cowork. The moment somebody "just tweaks" the copy, the
 * two quietly stop being the same product and nobody finds out until a stroke
 * looks different on a call.
 *
 * Known limitation, said out loud rather than buried: this repo cannot see the
 * other repo, so this pins the copy against the recorded hash of what was
 * copied. It catches an edit made HERE. It cannot notice hivelogic-live
 * changing its own draw.js — re-syncing is a manual step, documented in
 * src/overlay/vendor/README.md.
 */

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const assert = require('node:assert/strict');

const VENDOR_DIR = path.join(__dirname, '..', 'src', 'overlay', 'vendor');
const DRAW_PATH = path.join(VENDOR_DIR, 'draw.js');

// hivelogic-live @ 03ab41edfde7f208e8fad51f84099e108afc4d47.
// Changing this line without re-copying the file is the mistake this guards.
const EXPECTED_SHA256 =
  'ffc0f1d467f7e8b5d70c20ad35cafe575c226c541b5488b3c6d5bc7e80ba96ce';

test('the vendored draw.js is still the untouched hivelogic-live copy', () => {
  const bytes = fs.readFileSync(DRAW_PATH);

  // Checked separately so the failure says which of the two things went wrong.
  // Git hands a Windows checkout CRLF and a Linux checkout LF unless told
  // otherwise, and a hash mismatch caused by line endings alone would read as
  // "the drawing engine changed" when nothing changed at all. .gitattributes
  // pins this file to LF; this is the assertion that notices if that is lost.
  assert.equal(
    bytes.includes(0x0d),
    false,
    'src/overlay/vendor/draw.js has CRLF line endings. .gitattributes should '
    + 'pin it to LF (text eol=lf) so its bytes are the same on every machine.'
  );

  const actual = crypto.createHash('sha256').update(bytes).digest('hex');
  assert.equal(
    actual,
    EXPECTED_SHA256,
    'src/overlay/vendor/draw.js has drifted from the hivelogic-live original. '
    + 'Re-copy it (see src/overlay/vendor/README.md) rather than editing it here.'
  );
});

test('the vendor README records the same hash the test enforces', () => {
  // Two places to look, one answer. A README quoting a stale hash is how the
  // next person re-syncs against the wrong commit.
  const readme = fs.readFileSync(path.join(VENDOR_DIR, 'README.md'), 'utf8');
  assert.ok(readme.includes(EXPECTED_SHA256));
});

test('the overlay can build and render a mark with the vendored engine', () => {
  // Not a style check — the actual calls src/overlay/overlay.js makes. If a
  // future re-sync renames createBoard or changes makeShape's signature, this
  // fails here instead of as a pen that draws nothing on Chris's screen.
  const Draw = require(DRAW_PATH);
  assert.equal(typeof Draw.createBoard, 'function');
  assert.equal(typeof Draw.makeShape, 'function');
  assert.equal(typeof Draw.render, 'function');
  assert.equal(typeof Draw.renderShape, 'function');
  assert.ok(Array.isArray(Draw.PALETTE) && Draw.PALETTE.length >= 5);

  const board = Draw.createBoard();
  const shape = Draw.makeShape('screen', 1, 'pen', {
    color: Draw.PALETTE[1],
    width: 5,
    points: [{ x: 10, y: 10 }, { x: 40, y: 60 }],
  });
  board.add(shape);
  assert.equal(board.count(), 1);

  // A minimal 2D context stub: enough to prove render() walks the shapes and
  // strokes them, which is all the overlay asks of it.
  const calls = [];
  const ctx = new Proxy(
    { measureText: () => ({ width: 10 }) },
    {
      get(target, prop) {
        if (prop in target) return target[prop];
        return (...args) => calls.push([String(prop), args.length]);
      },
      set() {
        return true;
      },
    }
  );
  assert.equal(Draw.render(ctx, board.list()), 1);
  assert.ok(calls.some(([name]) => name === 'stroke'));

  // The toolbar's four swatches come out of this same palette, so the colour
  // of a mark on the screen matches the colour of a mark inside Cowork.
  ['#c65b4e', '#d08b4c', '#1B7A50', '#2f5d8a'].forEach((hex) => {
    assert.ok(Draw.PALETTE.includes(hex), `toolbar colour ${hex} left the shared palette`);
  });

  // Clear is presenter-only in the shared engine; the overlay is always the
  // presenter's own screen, so it passes that context. Pinned because losing
  // it turns Clear All into a silently thrown error.
  board.add(Draw.makeShape('screen', 2, 'pen', { points: [{ x: 1, y: 1 }, { x: 2, y: 2 }] }));
  assert.throws(() => board.clearAll({}), /presenter/);
  assert.equal(board.clearAll({ isPresenter: true }), true);
  assert.equal(board.count(), 0);
});
