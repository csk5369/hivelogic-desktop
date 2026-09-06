'use strict';

/**
 * One transparent sheet, covering exactly one monitor.
 *
 * The marks are built and painted by the SAME engine Cowork uses in the web
 * app (vendor/draw.js, a byte-for-byte copy — see vendor/README.md). That is
 * the point: a mark Chris makes on his whole screen has to look like a mark he
 * makes inside HiveLogic, or it is visibly two products stapled together.
 *
 * Deliberately not the whole Cowork tool set. Eighteen tools, fills, dashes,
 * z-order and text entry over a live desktop is a second application, and the
 * job here is "circle the thing I am pointing at while I talk". Pen, four
 * colours, undo, clear. Every one of them has a button on the toolbar; there
 * are no hidden gestures and no keyboard-only actions.
 */
(function () {
  var D = window.CoworkDraw;
  var api = window.hlOverlay || {};
  var canvas = document.getElementById('sheet');
  var ctx = canvas.getContext('2d');
  var board = D.createBoard();

  var UID = 'screen';
  var seq = 0;
  // Thicker than Cowork's default 3. This is read from across a room on a
  // shared 4K screen that has been scaled down into a video tile, not from a
  // laptop 50cm away.
  var WIDTH = 5;
  var color = D.PALETTE[1]; // the same red the toolbar opens on
  var drawing = false;      // is the sheet armed (mouse belongs to us)
  var live = null;          // the shape currently being dragged out

  /* ---------------- canvas sizing ----------------
     Backing store in device pixels, coordinates in CSS pixels. Without the
     scale the marks are drawn at half size on a 200%-scaled monitor, which on
     a mixed-DPI desk looks like "it works on one screen and not the other". */
  function resize() {
    var dpr = window.devicePixelRatio || 1;
    var w = window.innerWidth;
    var h = window.innerHeight;
    canvas.width = Math.max(1, Math.round(w * dpr));
    canvas.height = Math.max(1, Math.round(h * dpr));
    canvas.style.width = w + 'px';
    canvas.style.height = h + 'px';
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    paint();
  }

  function paint() {
    var dpr = window.devicePixelRatio || 1;
    ctx.save();
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    ctx.restore();
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    var shapes = board.list();
    D.render(ctx, shapes);
    if (live) D.renderShape(ctx, live);
  }

  /* ---------------- drawing ---------------- */
  function point(event) {
    return { x: event.clientX, y: event.clientY };
  }

  canvas.addEventListener('pointerdown', function (event) {
    if (!drawing || event.button !== 0) return;
    seq += 1;
    live = D.makeShape(UID, seq, 'pen', { color: color, width: WIDTH, points: [point(event)] });
    try { canvas.setPointerCapture(event.pointerId); } catch (_) {}
    paint();
  });

  canvas.addEventListener('pointermove', function (event) {
    if (!live) return;
    live.points.push(point(event));
    paint();
  });

  function finish(event) {
    if (!live) return;
    var shape = live;
    live = null;
    try { canvas.releasePointerCapture(event.pointerId); } catch (_) {}
    // A single click with no drag is a dot nobody asked for — drop it rather
    // than leaving specks on the screen every time he clicks to draw.
    if (shape.points.length < 2) { paint(); return; }
    board.add(shape);
    paint();
    if (typeof api.strokeAdded === 'function') api.strokeAdded();
  }

  canvas.addEventListener('pointerup', finish);
  canvas.addEventListener('pointercancel', finish);

  /* ---------------- commands from the main process ---------------- */
  if (typeof api.onState === 'function') {
    api.onState(function (state) {
      drawing = !!(state && state.drawing);
      document.body.classList.toggle('hl-drawing', drawing);
      if (!drawing && live) { live = null; paint(); }
    });
  }
  if (typeof api.onColor === 'function') {
    api.onColor(function (value) { if (value) color = value; });
  }
  if (typeof api.onUndo === 'function') {
    api.onUndo(function () { board.undoOwn(UID); paint(); });
  }
  if (typeof api.onClear === 'function') {
    // clearAll() refuses without a presenter context, by design in the shared
    // engine. On this sheet the only person who can press Clear IS the
    // presenter — it is his own screen and his own toolbar.
    api.onClear(function () { board.clearAll({ isPresenter: true }); paint(); });
  }

  /* The local half of the escape hatch. The toolbar has a Stop button and the
     main process registers a global hotkey, but if either of those is ever
     unreachable, the sheet in front of the user still answers Escape. */
  window.addEventListener('keydown', function (event) {
    if (event.key === 'Escape' && typeof api.panicStop === 'function') api.panicStop();
  });

  window.addEventListener('resize', resize);
  resize();
})();
