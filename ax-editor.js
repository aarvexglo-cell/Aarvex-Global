/* Aarvex Portal — Story/Feed visual editor bridge.
 *
 * Opens the full-screen editor (story-editor.html) inside an isolated iframe so
 * its rich crop/filter/draw/text/sticker/shape/music tools never collide with
 * the app's own CSS or globals. The picked photo goes IN, and the flattened,
 * ready-to-post image comes back OUT.
 *
 *   axOpenEditor(imageDataUrl, 'story'|'feed', onDone, onCancel)
 *     onDone(finalImageDataUrl, meta)  — user pressed "Next"
 *     onCancel()                       — user closed the editor
 *
 * Load this before ax-stories.js / ax-feed.js in portal.html.
 */
(function () {
  'use strict';

  var EDITOR_URL = 'story-editor.html';
  var _open = false;

  function injectStyles() {
    if (document.getElementById('axEditorStyles')) return;
    var s = document.createElement('style');
    s.id = 'axEditorStyles';
    s.textContent =
      '.axed-embed-overlay{position:fixed;inset:0;z-index:100000;background:#06100b;' +
      'display:flex;opacity:0;transition:opacity .18s ease;}' +
      '.axed-embed-overlay.show{opacity:1;}' +
      '.axed-embed-overlay iframe{flex:1;width:100%;height:100%;border:0;display:block;background:#06100b;}' +
      '.axed-embed-spinner{position:absolute;inset:0;display:flex;align-items:center;justify-content:center;' +
      'color:#9FB3A6;font-family:system-ui,sans-serif;font-size:14px;gap:10px;pointer-events:none;}' +
      '.axed-embed-spinner .axed-dot{width:8px;height:8px;border-radius:50%;background:#3EB489;' +
      'animation:axedPulse 1s infinite ease-in-out;}' +
      '@keyframes axedPulse{0%,100%{opacity:.3;transform:scale(.8);}50%{opacity:1;transform:scale(1);}}';
    document.head.appendChild(s);
  }

  /**
   * Open the editor. Returns nothing; results arrive via callbacks.
   * @param {string} imageDataUrl  base64/data-URL of the photo to edit
   * @param {string} mode          'story' (9:16) or 'feed' (4:5)
   * @param {function} onDone       (finalImageDataUrl, meta) => void
   * @param {function} [onCancel]   () => void
   */
  function axOpenEditor(imageDataUrl, mode, onDone, onCancel) {
    if (_open) return; // one editor at a time
    _open = true;
    injectStyles();

    var overlay = document.createElement('div');
    overlay.className = 'axed-embed-overlay';
    overlay.id = 'axEditorOverlay';
    overlay.innerHTML =
      '<div class="axed-embed-spinner"><span class="axed-dot"></span> Opening editor…</div>' +
      '<iframe id="axEditorFrame" title="Aarvex editor" allow="fullscreen"></iframe>';
    document.body.appendChild(overlay);
    document.body.style.overflow = 'hidden';
    requestAnimationFrame(function () { overlay.classList.add('show'); });

    var frame = overlay.querySelector('#axEditorFrame');
    var spinner = overlay.querySelector('.axed-embed-spinner');
    var initSent = false;
    var finished = false;

    function sendInit() {
      if (initSent || !frame.contentWindow) return;
      initSent = true;
      if (spinner) spinner.remove();
      frame.contentWindow.postMessage(
        { type: 'axed:init', image: imageDataUrl, mode: mode || 'story' }, '*');
    }

    function cleanup() {
      window.removeEventListener('message', onMessage);
      overlay.classList.remove('show');
      document.body.style.overflow = '';
      setTimeout(function () { if (overlay.parentNode) overlay.remove(); }, 200);
      _open = false;
    }

    function onMessage(e) {
      // Only trust messages coming from our own editor iframe.
      if (!frame || e.source !== frame.contentWindow) return;
      var d = e.data || {};
      if (d.type === 'axed:ready') {
        sendInit();
      } else if (d.type === 'axed:done') {
        if (finished) return;
        finished = true;
        cleanup();
        if (typeof onDone === 'function') onDone(d.image, { mode: d.mode, music: d.music || '' });
      } else if (d.type === 'axed:cancel') {
        if (finished) return;
        finished = true;
        cleanup();
        if (typeof onCancel === 'function') onCancel();
      }
    }

    window.addEventListener('message', onMessage);
    // If 'ready' never arrives (cached/quirky load), push init on iframe load.
    frame.addEventListener('load', function () { setTimeout(sendInit, 60); });
    frame.src = EDITOR_URL;
  }

  window.axOpenEditor = axOpenEditor;
  window.axEditorAvailable = function () { return true; };
})();
