// Frontend/js/player/gestures.js — Phase 4.2 (Item 4) mobile interaction model.
//
// Replaces the touchstart/touchend/synthetic-click logic with Pointer Events
// only and a single gesture state machine:
//
//   pointerup on video surface
//     ├ controls hidden → SHOW controls (consume the tap, do nothing else)
//     ├ controls visible → HIDE controls
//     └ NEVER toggles playback
//   double-tap left/right third → seek ∓10 s, ripple feedback
//   pointerup on a control → that control's action only (stopPropagation)
//   pause → only the pause button, keyboard Space/K, or headset media key
//
// Also sets touch-action: manipulation on the surface and preventDefault() on
// the tap that consumes control-showing so no 300 ms synthetic click fires.
//
// No global state — explicit init contract. The page wires:
//   gestures.init({ surface, controlsEl, onSeek, onShowControls, onHideControls, onTap })
(function () {
  'use strict';

  function init(opts) {
    var surface = opts.surface;
    var controlsEl = opts.controlsEl;
    var onShowControls = opts.onShowControls || function () {};
    var onHideControls = opts.onHideControls || function () {};
    var onSeek = opts.onSeek || function () {};   // onSeek(deltaSec)
    var onTap = opts.onTap || function () {};     // surface tap (show/hide handled internally)

    if (!surface) return;

    // touch-action: manipulation — prevents double-tap zoom + 300 ms delay.
    surface.style.touchAction = 'manipulation';

    var controlsVisible = true;
    var lastTapTime = 0;
    var lastTapX = 0;
    var keys = {};

    function isControlsVisible() { return controlsVisible; }
    function setControlsVisible(v) {
      controlsVisible = v;
      if (v) onShowControls(); else onHideControls();
    }

    // Pointer events only.
    surface.addEventListener('pointerdown', function (e) {
      keys.pointerDown = true;
      keys.x = e.clientX;
      keys.y = e.clientY;
      keys.t = Date.now();
      keys.started = true;
    });

    surface.addEventListener('pointerup', function (e) {
      if (!keys.started) return;
      keys.started = false;

      var width = surface.clientWidth;
      var x = e.clientX;
      var now = Date.now();

      // Double-tap detection (within 300 ms, near position).
      var isDoubleTap = (now - lastTapTime) < 300 && Math.abs(x - lastTapX) < 40;
      lastTapTime = now;
      lastTapX = x;

      if (isDoubleTap) {
        // Double-tap left/right third → seek ∓10 s.
        var third = width / 3;
        if (x < third) {
          onSeek(-10);
          ripple(surface, e.clientX, e.clientY, -10);
        } else if (x > third * 2) {
          onSeek(10);
          ripple(surface, e.clientX, e.clientY, 10);
        }
        e.preventDefault(); // consume so no synthetic click fires
        return;
      }

      // Single tap on video surface: toggles controls ONLY, never playback.
      // preventDefault() on the tap that consumes control-showing prevents the
      // 300 ms synthetic click.
      e.preventDefault();
      if (controlsVisible) {
        setControlsVisible(false);
      } else {
        setControlsVisible(true);
      }
      onTap();
    });

    // Controls: pointerup on a control = that control's action only.
    if (controlsEl) {
      controlsEl.addEventListener('pointerup', function (e) {
        // stopPropagation so the surface handler doesn't also fire.
        e.stopPropagation();
        setControlsVisible(true); // interacting with controls shows them
      });
      controlsEl.addEventListener('pointerdown', function (e) {
        e.stopPropagation();
      });
    }

    return {
      isControlsVisible: isControlsVisible,
      setControlsVisible: setControlsVisible,
      destroy: function () {
        surface.removeEventListener('pointerdown', null);
        surface.removeEventListener('pointerup', null);
      },
    };
  }

  // Ripple feedback on the video surface.
  function ripple(surface, x, y, delta) {
    if (!surface) return;
    var el = document.createElement('div');
    el.textContent = (delta < 0 ? '-10' : '+10') + 's';
    el.style.cssText = 'position:absolute;left:' + x + 'px;top:' + y + 'px;transform:translate(-50%,-50%);' +
      'color:#fff;background:rgba(108,43,217,0.8);border-radius:20px;padding:8px 16px;font-size:1rem;font-weight:700;' +
      'pointer-events:none;z-index:50;animation:rippleFade 0.8s forwards;';
    surface.appendChild(el);
    setTimeout(function () { if (el.parentNode) el.parentNode.removeChild(el); }, 800);
  }

  // Inject ripple animation once.
  if (!document.getElementById('ripple-style')) {
    var style = document.createElement('style');
    style.id = 'ripple-style';
    style.textContent = '@keyframes rippleFade{0%{opacity:1;transform:translate(-50%,-50%) scale(1)}100%{opacity:0;transform:translate(-50%,-50%) scale(1.4)}}';
    document.head.appendChild(style);
  }

  window.PlayerGestures = { init: init };
})();