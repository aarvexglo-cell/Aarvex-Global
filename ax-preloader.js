/* ── Aarvex logo preloader (brand SVG mark) ─────────────────────────
   Uses the lime “A” from ax-icon-foreground.svg. No Lottie/CDN. */
(function () {
  var _bootEl = null;
  var _bootShownAt = 0;

  function onReady(fn) {
    if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', fn);
    else fn();
  }

  /** Inline brand mark — same paths as ax-icon-foreground.svg */
  function logoMarkSvg() {
    return (
      '<svg viewBox="0 0 512 512" aria-hidden="true" focusable="false">' +
        '<path class="ax-a-fill" d="M332.05,342.37h0s16.34,34.04,16.34,34.04c1.06,2.21,3.29,3.61,5.74,3.61h47.92c4.69,0,7.77-4.9,5.74-9.13l-112.93-235.31c-1.06-2.21-3.29-3.61-5.74-3.61h-66.24c-2.45,0-4.68,1.41-5.74,3.61l-112.93,235.31c-2.03,4.23,1.05,9.13,5.74,9.13h47.92c2.45,0,4.68-1.41,5.74-3.61l16.34-34.03h0s24.51-51.08,24.51-51.08l43.76-91.2c1.06-2.21,3.29-3.62,5.74-3.62h4.06c2.45,0,4.68,1.41,5.74,3.62l43.76,91.2,24.51,51.07Z"/>' +
        '<path class="ax-a-fill" d="M253.97,285.21h4.06c2.45,0,4.68,1.41,5.74,3.62l39.38,82.07c2.03,4.23-1.05,9.13-5.74,9.13h-82.83c-4.69,0-7.77-4.9-5.74-9.13l39.38-82.07c1.06-2.21,3.29-3.62,5.74-3.62Z"/>' +
      '</svg>'
    );
  }

  function hostHtml(size) {
    size = size || 120;
    return (
      '<div class="ax-logo-loader" style="width:' + size + 'px;height:' + size + 'px" role="presentation">' +
        '<span class="ax-logo-loader-ring"></span>' +
        '<span class="ax-logo-loader-glow"></span>' +
        '<div class="ax-logo-loader-mark">' + logoMarkSvg() + '</div>' +
      '</div>'
    );
  }

  function hasSavedSession() {
    try { return !!localStorage.getItem('ax_user'); } catch (e) { return false; }
  }

  function shouldShowBoot() {
    if (document.body && document.body.classList.contains('is-signed-in')) return true;
    return hasSavedSession();
  }

  function mountBoot() {
    if (document.getElementById('axBootLoader')) return;
    if (!shouldShowBoot()) return;
    var el = document.createElement('div');
    el.id = 'axBootLoader';
    el.className = 'ax-boot-loader';
    el.setAttribute('aria-busy', 'true');
    el.setAttribute('aria-label', 'Loading Aarvex');
    el.innerHTML =
      '<div class="ax-boot-loader-inner">' +
        hostHtml(112) +
        '<p class="ax-boot-loader-text">Loading Aarvex…</p>' +
      '</div>';
    document.body.appendChild(el);
    _bootEl = el;
    _bootShownAt = Date.now();
  }

  function hideBoot(force) {
    var el = _bootEl || document.getElementById('axBootLoader');
    if (!el) return;
    var minMs = force ? 0 : 850;
    var wait = Math.max(0, minMs - (Date.now() - (_bootShownAt || Date.now())));
    setTimeout(function () {
      var node = _bootEl || document.getElementById('axBootLoader');
      if (!node) return;
      node.classList.add('is-done');
      setTimeout(function () {
        if (node && node.parentNode) node.parentNode.removeChild(node);
      }, 400);
      _bootEl = null;
    }, wait);
  }

  /** Plain HTML fragment (used inside overlays). */
  window.axLoaderHtml = function (label, size) {
    label = label || 'Loading…';
    size = size || 96;
    return '<div class="ax-inline-loader" role="status" aria-live="polite">' +
      hostHtml(size) +
      '<span class="ax-inline-loader-text">' + String(label).replace(/</g, '&lt;') + '</span>' +
      '</div>';
  };

  /** Blur the host's existing content and overlay the logo loader. */
  window.axShowLoader = function (host, label) {
    if (!host) return;
    host.classList.add('ax-loading-host');
    host.querySelectorAll('.ax-inline-loader-overlay').forEach(function (n) { n.remove(); });
    var ov = document.createElement('div');
    ov.className = 'ax-inline-loader-overlay';
    ov.innerHTML = window.axLoaderHtml(label || 'Loading…', 100);
    host.appendChild(ov);
  };

  window.axHideLoader = function (host) {
    if (!host) return;
    host.classList.remove('ax-loading-host');
    host.querySelectorAll('.ax-inline-loader-overlay').forEach(function (n) { n.remove(); });
  };

  window.axMountLoaders = function () { /* no-op: SVG is inline */ };
  window.axHideBootLoader = hideBoot;
  window.axShowBootLoader = function () { mountBoot(); };

  onReady(function () {
    if (shouldShowBoot()) mountBoot();
    setTimeout(function () { hideBoot(false); }, 2600);
  });

  window.addEventListener('load', function () {
    setTimeout(function () { hideBoot(false); }, 600);
  });

  document.addEventListener('ax:signed-in', function () {
    mountBoot();
    setTimeout(function () { hideBoot(false); }, 1100);
  });
})();
