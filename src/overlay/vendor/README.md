# Vendored from hivelogic-live — kept in sync by hand

`draw.js` in this folder is a **byte-for-byte copy** of
`public/hiveconnect/draw.js` in the `csk5369/hivelogic-live` repo.

- Copied from: `hivelogic-live` commit `03ab41edfde7f208e8fad51f84099e108afc4d47`
  (`draw.js` itself last changed in `64fc580`).
- sha256 of the copy: `ffc0f1d467f7e8b5d70c20ad35cafe575c226c541b5488b3c6d5bc7e80ba96ce`

## Why it is a copy and not a dependency

The two repos ship completely differently — one is a Vercel web app, the other
is an `electron-builder` installer — and neither publishes a package the other
could depend on. The alternative to a copy was reimplementing the drawing
engine a second time, which is worse: two engines drift silently and a mark
drawn on screen would stop looking like the same mark drawn in Cowork.

`draw.js` is a good candidate for vendoring precisely because it is inert: pure
vector maths and canvas 2D, no dependencies, no DOM lookups, no network. It has
not needed a change in this direction since it was written.

## What the drift check does and does not do

`test/screen-annotate-vendor.test.js` asserts this file still hashes to the
value recorded above, and that the API the overlay actually calls
(`createBoard`, `makeShape`, `render`, `PALETTE`) is present and behaves.

**Known limitation, stated plainly:** that test can only see this repo. It
catches somebody editing the copy in place — the failure that would make the
overlay quietly diverge from Cowork. It CANNOT notice that `hivelogic-live`
changed its own `draw.js`, because it has no way to read the other repo. There
is no automated cross-repo check today.

## How to re-sync

1. Copy `public/hiveconnect/draw.js` from `hivelogic-live` over this file.
2. Re-run `node -e "const c=require('crypto'),f=require('fs');console.log(c.createHash('sha256').update(f.readFileSync('src/overlay/vendor/draw.js')).digest('hex'))"`.
3. Put the new hash and the source commit in this README **and** in
   `test/screen-annotate-vendor.test.js`.
4. Run `npm test`.
