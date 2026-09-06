'use strict';

/**
 * The floating control bar for screen markup.
 *
 * This window is never click-through. That is not a detail — the transparent
 * sheets over the monitors can be armed, and while they are, a click anywhere
 * else on screen goes to the drawing layer instead of to the app underneath.
 * The one thing that must always be reachable, in every state, is the way out.
 * So the bar is its own window, it is always on top, and Stop is on it.
 *
 * Colours are the first four of Cowork's own palette so a mark on the screen
 * is the same colour as the same mark made inside HiveLogic.
 */
(function () {
  var api = window.hlToolbar || {};
  var COLORS = [
    ['#c65b4e', 'Red'],
    ['#d08b4c', 'Orange'],
    ['#1B7A50', 'Green'],
    ['#2f5d8a', 'Blue'],
  ];

  var swatches = document.getElementById('swatches');
  var drawBtn = document.getElementById('draw');
  var stopBtn = document.getElementById('stop');
  var undoBtn = document.getElementById('undo');
  var clearBtn = document.getElementById('clear');
  var chosen = COLORS[0][0];

  COLORS.forEach(function (entry, index) {
    var button = document.createElement('button');
    button.type = 'button';
    button.className = 'sw' + (index === 0 ? ' on' : '');
    button.style.background = entry[0];
    button.title = entry[1];
    button.setAttribute('aria-label', entry[1] + ' pen');
    button.addEventListener('click', function () {
      chosen = entry[0];
      [].forEach.call(swatches.children, function (node) {
        node.classList.toggle('on', node === button);
      });
      if (typeof api.setColor === 'function') api.setColor(chosen);
    });
    swatches.appendChild(button);
  });

  // Send the opening colour immediately, so the pen and the lit swatch agree
  // from the first stroke rather than only after he picks a colour.
  if (typeof api.setColor === 'function') api.setColor(chosen);

  drawBtn.addEventListener('click', function () {
    if (typeof api.setDrawing === 'function') api.setDrawing(!drawBtn.classList.contains('on'));
  });
  stopBtn.addEventListener('click', function () {
    if (typeof api.stop === 'function') api.stop();
  });
  undoBtn.addEventListener('click', function () {
    if (typeof api.undo === 'function') api.undo();
  });
  clearBtn.addEventListener('click', function () {
    if (typeof api.clear === 'function') api.clear();
  });

  /* Escape works here too, not only on the sheets — this is the window with
     focus while he is using the buttons. */
  window.addEventListener('keydown', function (event) {
    if (event.key === 'Escape' && typeof api.stop === 'function') api.stop();
  });

  /* The state comes from the main process, never from this page guessing.
     Undo and Clear are disabled — visibly, with a real `disabled` — when there
     is nothing to undo or clear, because a button that is live and does
     nothing is the complaint this project keeps getting. */
  function render(state) {
    var drawing = !!(state && state.drawing);
    var marks = (state && state.marks) || 0;
    drawBtn.classList.toggle('on', drawing);
    drawBtn.setAttribute('aria-pressed', drawing ? 'true' : 'false');
    drawBtn.textContent = drawing ? 'Drawing — click to pause' : 'Draw';
    drawBtn.title = drawing
      ? 'Your clicks are drawing on the screen. Pause to use your mouse normally.'
      : 'Click to start drawing on your screen.';
    undoBtn.disabled = marks < 1;
    clearBtn.disabled = marks < 1;
  }

  if (typeof api.onState === 'function') api.onState(render);
  render({ drawing: true, marks: 0 });
})();
