/* ═══════════════════════════════════════════════════════════════════════════
   ax-native.js — Web ↔ Capacitor native bridge (M2/M3).

   Runs on the live site (loaded by the native shell via server.url). It is a
   NO-OP in a normal browser — every native call is guarded by
   Capacitor.isNativePlatform(), so web users are never affected.

   M2 features:
     • Dark status bar, drawn below the web content (no overlap).
     • Hide the native splash on first paint (snappy launch).
     • Android hardware BACK button: close the top open overlay/menu, else a
       "press again to exit" guard — so back never abruptly kills the app.
     • Adds html.ax-native for any native-only CSS.

   Later milestones (M4 Google sign-in, M5 GPS, M6 camera, M7 push) hook in here.
   ═══════════════════════════════════════════════════════════════════════════ */
(function () {
  var Cap = window.Capacitor;

  /* Robust, late-bound "are we inside the native app WebView?" check.
     Unlike window.AX_NATIVE — which is set ONCE below and only if Capacitor was
     already injected the instant this file ran — this re-evaluates every signal
     at CALL time. A slow/late Capacitor bridge (or any single-signal miss) can
     therefore never leave the captcha bypass permanently off, which was making
     the order/sell/KYC forms hard-block with "Please complete the captcha
     verification" (Cloudflare Turnstile can't render at the app's https://localhost
     origin, so getRecaptchaToken() returns '' there).
     Safe to be liberal: the backend honours the 'native-app' captcha marker ONLY
     for an authenticated (HMAC-verified) caller, so a false positive gives a bot
     nothing, and production web (aarvexglobal.in / CloudFront) never matches. */
  window.axIsNativeApp = function () {
    try {
      if (window.AX_NATIVE === true) return true;
      var C = window.Capacitor;
      if (C && ((typeof C.isNativePlatform === 'function' && C.isNativePlatform()) ||
                (typeof C.getPlatform === 'function' && C.getPlatform() !== 'web'))) return true;
      if (document.documentElement.classList.contains('ax-native')) return true;
      // Capacitor serves the local bundle from https://localhost (androidScheme:'https').
      // Real web users are always on aarvexglobal.in / CloudFront — never localhost.
      var h = location.hostname;
      if (h === 'localhost' || h === '127.0.0.1' || location.protocol === 'capacitor:') return true;
    } catch (e) {}
    return false;
  };

  /* Hide the unusable Turnstile widget in the app even when the Capacitor bridge
     wasn't detected (CSS: html.ax-native .recaptcha-wrap{display:none}). Without
     this, a missed native-detection left a broken "Error 110200" captcha box
     visible on the order/sell/KYC forms. Runs unconditionally off axIsNativeApp(). */
  try { if (window.axIsNativeApp()) document.documentElement.classList.add('ax-native'); } catch (e) {}

  /* ── CRITICAL: confirm this bundle to Capgo (notifyAppReady) OUTSIDE the
     isNativePlatform() gate below. ────────────────────────────────────────────
     If this depended on isNativePlatform() (which can be false/late in the
     WebView), a single missed detection would leave notifyAppReady() uncalled,
     so Capgo auto-rolls-back EVERY OTA bundle after appReadyTimeout — meaning no
     update (not even this fix) could ever stick, and the app is frozen on its
     baked bundle forever. So poll for the updater plugin and confirm as soon as
     it exists, regardless of the native-detection result. No-op on the web (the
     plugin never exists there) and harmless to call more than once. */
  (function () {
    var _confirmed = false;
    function _confirm() {
      if (_confirmed) return true;
      try {
        var C = window.Capacitor;
        var CU = C && C.Plugins && C.Plugins.CapacitorUpdater;
        if (CU && CU.notifyAppReady) { _confirmed = true; CU.notifyAppReady(); return true; }
      } catch (e) {}
      return false;
    }
    if (!_confirm()) {
      var tries = 0;
      var iv = setInterval(function () { if (_confirm() || ++tries > 45) clearInterval(iv); }, 200); // ~9s < appReadyTimeout 10s
      window.addEventListener('load', _confirm);
    }
  })();

  // DIAGNOSTIC — readable state so a failing Google login can be understood straight
  // from the phone (no USB/chrome://inspect). Call window.axDiag(), or just tap
  // "Continue with Google" when the native path can't run: an alert shows what's missing.
  window.axDiag = function () {
    var native = !!(Cap && Cap.isNativePlatform && Cap.isNativePlatform());
    var plugins = (Cap && Cap.Plugins) ? Object.keys(Cap.Plugins).join(', ') : '(none)';
    var ga = !!(Cap && Cap.Plugins && Cap.Plugins.GoogleAuth && Cap.Plugins.GoogleAuth.signIn);
    return 'ax-native v15\nCapacitor=' + (!!Cap) + '  native=' + native + '  GoogleAuth=' + ga + '\nplugins: ' + plugins;
  };
  if (!Cap || typeof Cap.isNativePlatform !== 'function' || !Cap.isNativePlatform()) {
    // Not detected as a native app. If Capacitor IS present we ARE in the app but the
    // bridge/plugins didn't init — show that so we can diagnose from the phone.
    if (Cap) { window.signInWithGoogle = function () { try { alert('DIAG (not native):\n' + window.axDiag()); } catch (e) {} }; }
    return; // real browser → no-op
  }
  var P = Cap.Plugins || {};

  document.documentElement.classList.add('ax-native');
  window.AX_NATIVE = true;

  /* ── Cloudflare Turnstile can't validate the app's localhost/capacitor origin,
        so its widget renders a broken "troubleshoot" error on the order / sell /
        KYC forms. The native app ALREADY bypasses the captcha (every submit sends
        the 'native-app' marker, accepted server-side for an authenticated user),
        so neutralise the widgets: strip the auto-render class + clear + hide.
        CSS also hides .recaptcha-wrap on html.ax-native; this stops it rendering
        (and erroring) at all. Runs on load, on tap, and a few delayed passes to
        catch the forms that mount later. Web is unaffected (this file no-ops off
        native). ── */
  (function () {
    function killTurnstile() {
      var boxes = document.querySelectorAll('.cf-turnstile');
      for (var i = 0; i < boxes.length; i++) { boxes[i].classList.remove('cf-turnstile'); boxes[i].innerHTML = ''; }
      var wraps = document.querySelectorAll('.recaptcha-wrap');
      for (var j = 0; j < wraps.length; j++) { wraps[j].style.display = 'none'; }
    }
    killTurnstile();
    if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', killTurnstile);
    [300, 900, 2000].forEach(function (t) { setTimeout(killTurnstile, t); });
    document.addEventListener('click', function () { setTimeout(killTurnstile, 60); }, true);
  })();

  /* ── "Website / Visit" menu → the live marketing site. In the app the bundle's
        index.html IS the portal (build-bundle renames portal.html → index.html),
        so the menu link href="index.html" would just reload the portal home —
        which looks like "navigation bounces back to Home". Route the tap to the
        live marketing site instead (it's in the Capacitor allowNavigation list).
        Delegated + capture so it works even though the drawer is rendered later.
        Web is unaffected — this whole file is a no-op outside the native app. ── */
  document.addEventListener('click', function (e) {
    var a = e.target && e.target.closest && e.target.closest('a[data-accent="website"]');
    if (!a) return;
    e.preventDefault();
    window.location.href = 'https://aarvexglobal.in/';
  }, true);

  /* ── Capgo OTA (bundled + live-update model) ─────────────────────────────
     Tell the updater THIS bundle booted successfully, so it becomes the new
     "known-good" and is never auto-reverted. This MUST run every launch. It's
     called once the page has loaded, so a bundle that crashes before the UI
     renders is NEVER confirmed — Capgo then rolls back to the previous good
     bundle within appReadyTimeout. A missed notifyAppReady = automatic rollback,
     which is exactly the safety we want. */
  (function () {
    var CU = P.CapacitorUpdater;
    if (!CU || !CU.notifyAppReady) return;
    var _notified = false;
    function _ready() { if (_notified) return; _notified = true; try { CU.notifyAppReady(); } catch (e) {} }
    if (document.readyState === 'complete') _ready();
    else window.addEventListener('load', _ready);
    setTimeout(_ready, 4000);   // confirm well within appReadyTimeout even if load is slow

    /* OTA visibility (view in chrome://inspect -> Console). autoUpdate downloads
       a newer bundle in the BACKGROUND and applies it on the NEXT launch; these
       listeners just log what's happening so the OTA flow is easy to verify +
       tune. A tiny "Updated" flag is exposed for optional UI. */
    try {
      if (CU.addListener) {
        CU.addListener('updateAvailable', function (e) { try { console.log('[OTA] updateAvailable', (e && e.bundle && e.bundle.version) || e); } catch (_) {} });
        CU.addListener('downloadComplete', function (e) { try { console.log('[OTA] downloadComplete', (e && e.bundle && e.bundle.version) || e); window.AX_OTA_READY = true; } catch (_) {} });
        CU.addListener('noNeedUpdate', function () { try { console.log('[OTA] up to date'); } catch (_) {} });
        CU.addListener('majorAvailable', function (e) { try { console.log('[OTA] majorAvailable', e); } catch (_) {} });
        CU.addListener('updateFailed', function (e) { try { console.log('[OTA] updateFailed', e); } catch (_) {} });
        CU.addListener('downloadFailed', function (e) { try { console.log('[OTA] downloadFailed', e); } catch (_) {} });
      }
    } catch (e) {}
  })();

  /* ── Status bar: NORMAL (not edge-to-edge). The WebView sits BELOW a solid
     dark status bar, exactly like before — no overlay, no safe-area insets. ── */
  function styleStatusBar() {
    try { P.StatusBar && P.StatusBar.setOverlaysWebView && P.StatusBar.setOverlaysWebView({ overlay: false }); } catch (e) {}
    try { P.StatusBar && P.StatusBar.setBackgroundColor && P.StatusBar.setBackgroundColor({ color: '#0A0A0A' }); } catch (e) {}
    try { P.StatusBar && P.StatusBar.setStyle && P.StatusBar.setStyle({ style: 'DARK' }); } catch (e) {} // light icons on dark bar
  }
  styleStatusBar();
  // Remove any edge-to-edge CSS a previous build injected (revert to normal layout).
  (function () {
    var old = document.getElementById('axEdgeCss');
    if (old && old.parentNode) old.parentNode.removeChild(old);
    document.documentElement.style.removeProperty('--ax-nav-h');
    document.documentElement.classList.remove('ax-immersive');
  })();

  /* ── Splash: hide on first paint (with a safety in case something stalls). ── */
  var _splashHidden = false;
  function hideSplash() {
    if (_splashHidden) return; _splashHidden = true;
    try { P.SplashScreen && P.SplashScreen.hide && P.SplashScreen.hide(); } catch (e) {}
  }
  if (document.readyState === 'complete' || document.readyState === 'interactive') {
    setTimeout(hideSplash, 250);
  } else {
    document.addEventListener('DOMContentLoaded', function () { setTimeout(hideSplash, 250); });
  }
  window.addEventListener('load', function () { setTimeout(hideSplash, 100); });
  setTimeout(hideSplash, 4000); // absolute fallback

  /* ── Hardware BACK button. ── */
  function _visible(el) {
    if (!el) return false;
    if (el.offsetParent === null && getComputedStyle(el).position !== 'fixed') return false;
    var cs = getComputedStyle(el);
    return cs.display !== 'none' && cs.visibility !== 'hidden' && parseFloat(cs.opacity || '1') > 0.01;
  }

  // Best-effort: close the top-most open overlay/menu/dialog. Returns true if one closed.
  function closeTopOverlay() {
    var closed = false;

    // Slide-in menu drawer
    var sb = document.getElementById('portalSidebar');
    if (sb && _visible(sb) && /(^|\s)(open|show|active|is-open)(\s|$)/.test(sb.className)) {
      sb.classList.remove('open', 'show', 'active', 'is-open');
      document.body.classList.remove('sidebar-open', 'menu-open', 'no-scroll', 'ax-lock');
      closed = true;
    }

    // Bottom sheets / overlays (notifications, messages, etc.)
    var sheets = document.querySelectorAll('.ax-sheet-overlay.show, .ax-sheet-overlay.open, .ax-sheet-overlay.active');
    for (var i = 0; i < sheets.length; i++) {
      var ov = sheets[i];
      if (!_visible(ov)) continue;
      var btn = ov.querySelector('.ax-sheet-close, [data-close], .ax-close, .close-btn, .btn-close');
      if (btn) btn.click(); else ov.classList.remove('show', 'open', 'active');
      closed = true;
    }

    // Generic modals / dialogs / product modal
    var dlg = document.querySelector('.modal.show, .ax-modal.open, .product-modal.show, .product-modal.open, dialog[open]');
    if (dlg && _visible(dlg)) {
      var db = dlg.querySelector('[data-close], .modal-close, .close, .ax-close');
      if (db) db.click();
      else if (typeof dlg.close === 'function') { try { dlg.close(); } catch (e) {} }
      else dlg.classList.remove('show', 'open');
      closed = true;
    }
    return closed;
  }

  var _lastBack = 0;
  function onBack() {
    // Let the web app fully own back handling if it wants to.
    if (typeof window.axHandleBack === 'function') {
      try { if (window.axHandleBack() === true) return; } catch (e) {}
    }
    if (closeTopOverlay()) return;

    var now = Date.now();
    if (now - _lastBack < 2000) {
      try { P.App && P.App.exitApp && P.App.exitApp(); } catch (e) {}
    } else {
      _lastBack = now;
      showExitToast();
    }
  }
  try { P.App && P.App.addListener && P.App.addListener('backButton', onBack); } catch (e) {}

  /* Tiny self-contained toast (no dependency on the site's toast system). */
  function showExitToast() {
    var id = 'axExitToast';
    if (document.getElementById(id)) return;
    var t = document.createElement('div');
    t.id = id;
    t.textContent = 'Phir dabao to app band ho jayegi';
    t.setAttribute('style',
      'position:fixed;left:50%;bottom:calc(28px + env(safe-area-inset-bottom,0px));transform:translateX(-50%);' +
      'z-index:2147483647;background:rgba(20,20,22,.94);color:#F4F4F5;font:600 13px system-ui,sans-serif;' +
      'padding:10px 18px;border-radius:999px;box-shadow:0 6px 22px rgba(0,0,0,.5);pointer-events:none;' +
      'opacity:0;transition:opacity .2s ease');
    document.body.appendChild(t);
    requestAnimationFrame(function () { t.style.opacity = '1'; });
    setTimeout(function () { t.style.opacity = '0'; setTimeout(function () { if (t.parentNode) t.parentNode.removeChild(t); }, 250); }, 1600);
  }

  /* ── M3: network status — a thin offline banner; refresh signal on reconnect. ── */
  (function () {
    var Net = P.Network;
    if (!Net || !Net.addListener) return;
    function banner(show) {
      var id = 'axNetBanner', el = document.getElementById(id);
      if (show) {
        if (el) return;
        el = document.createElement('div');
        el.id = id;
        el.textContent = 'No internet — check your connection';
        el.setAttribute('style',
          'position:fixed;left:0;right:0;top:0;z-index:2147483646;' +
          'padding:calc(env(safe-area-inset-top,0px) + 7px) 12px 7px;text-align:center;' +
          'background:#7A141B;color:#fff;font:600 12.5px system-ui,sans-serif;letter-spacing:.01em;');
        document.body.appendChild(el);
      } else if (el) { el.parentNode.removeChild(el); }
    }
    var wasOffline = false;
    Net.addListener('networkStatusChange', function (st) {
      if (!st || !st.connected) { wasOffline = true; banner(true); document.dispatchEvent(new CustomEvent('ax:offline')); }
      else {
        banner(false);
        if (wasOffline) { wasOffline = false; document.dispatchEvent(new CustomEvent('ax:online')); }
      }
    });
    try { Net.getStatus().then(function (st) { if (st && !st.connected) { wasOffline = true; banner(true); } }); } catch (e) {}
  })();

  /* ── M3: app lifecycle — resume + deep-link events the web app can listen to. ── */
  try {
    P.App && P.App.addListener && P.App.addListener('appStateChange', function (st) {
      if (st && st.isActive) { styleStatusBar(); document.dispatchEvent(new CustomEvent('ax:resumed')); }
    });
  } catch (e) {}
  try {
    // Foundation for M8 (deep links): notification / link taps arrive here.
    P.App && P.App.addListener && P.App.addListener('appUrlOpen', function (data) {
      document.dispatchEvent(new CustomEvent('ax:deeplink', { detail: data }));
    });
  } catch (e) {}

  /* ── M3: stable native API surface. Later milestones fill the stubs:
        M4 googleSignIn · M5 startTracking · M6 pickPhoto · M7 registerPush.
        Until then they resolve to null so web code can feature-detect safely. ── */
  window.AxNative = {
    isNative: true,
    platform: (Cap.getPlatform && Cap.getPlatform()) || 'android',
    plugins: P,
    hideSplash: hideSplash,
    ready: true,
    // Per-screen TRUE immersive (hide the status bar) — full-bleed surfaces
    // (map / story / image viewers) call these; exit restores edge-to-edge.
    enterImmersive: function () {
      document.documentElement.classList.add('ax-immersive');
      try { P.StatusBar && P.StatusBar.hide && P.StatusBar.hide(); } catch (e) {}
    },
    exitImmersive: function () {
      document.documentElement.classList.remove('ax-immersive');
      try { P.StatusBar && P.StatusBar.show && P.StatusBar.show(); } catch (e) {}
    },
    // stubs (implemented in M4–M7)
    googleSignIn: function () { return Promise.resolve(null); },
    startTracking: function () { return Promise.resolve(false); },
    stopTracking: function () { return Promise.resolve(false); },
    pickPhoto: function () { return Promise.resolve(null); },
    registerPush: function () { return Promise.resolve(null); }
  };
  /* ── M4: native Google Sign-In. Google blocks OAuth inside app WebViews
        (the "400. That's an error" page), so we call the native GoogleAuth
        plugin → get a Google idToken (audience = the WEB client id the backend
        already verifies) → hand it to the existing web flow. No backend change,
        no portal-auth.js change: we just override the global signInWithGoogle. ── */
  (function () {
    var GA = P.GoogleAuth;
    if (!GA || !GA.signIn) {
      // Native app but the GoogleAuth plugin isn't registered — show the diagnostic
      // (which plugins DID load) so we can see why, instead of the broken web popup.
      window.signInWithGoogle = function () {
        try { alert('DIAG (GoogleAuth plugin missing):\n' + window.axDiag()); } catch (e) {}
      };
      return;
    }
    var WEB_CLIENT_ID = '12128965047-cuoeqc9fasttr5v9aqoekso29m86o510.apps.googleusercontent.com';
    var _inited = false;
    function ensureInit() {
      if (_inited) return; _inited = true;
      try { GA.initialize && GA.initialize({ clientId: WEB_CLIENT_ID, scopes: ['profile', 'email'], grantOfflineAccess: false }); } catch (e) {}
    }
    // In-flight guard: tapping "Continue with Google" twice (or a stuck previous
    // attempt) used to throw 12502 = SIGN_IN_CURRENTLY_IN_PROGRESS. This flag
    // blocks the duplicate call so 12502 can't be triggered by a double tap.
    var _axGSignInFlight = false;
    // If a sign-in ever gets abandoned (app backgrounded mid-pick), clear the
    // flag on resume so the button is never permanently dead.
    document.addEventListener('ax:resumed', function () { _axGSignInFlight = false; });
    window.AxNative.googleSignIn = function () {
      ensureInit();
      if (_axGSignInFlight) return Promise.reject({ code: 'ax-in-progress' });
      _axGSignInFlight = true;
      return GA.signIn().then(function (res) {
        _axGSignInFlight = false;
        var idToken = res && res.authentication && res.authentication.idToken;
        if (!idToken) throw new Error('no-id-token');
        if (typeof window.handleGoogleCredential === 'function') window.handleGoogleCredential({ credential: idToken });
        return idToken;
      }).catch(function (e) {
        _axGSignInFlight = false;
        throw e;
      });
    };
    // Route "Continue with Google" (onclick="signInWithGoogle()") to native, with
    // smart, silent recovery so the person never sees a raw Google error popup.
    function _axDoGoogle(isRetry) {
      return window.AxNative.googleSignIn().catch(function (e) {
        var code = (e && (e.code || e.errorCode)) || '';
        var s = String((e && e.message) || e || '');
        var blob = (s + ' ' + code).toLowerCase();
        // Our own duplicate-tap guard — silently ignore, the real attempt runs.
        if (code === 'ax-in-progress') return;
        // User cancelled the picker — gentle note, not an error.
        if (/cancel|popup_closed|12501|sign_in_cancelled/.test(blob)) {
          try { if (window.showToast) showToast('Google sign-in cancelled', 'info'); } catch (_) {}
          return;
        }
        // 12502 = a previous sign-in is still "in progress" (stuck state). SELF-HEAL:
        // clear the plugin state and retry ONCE, silently — so it just works on the
        // automatic second try and the person never sees the [12502] popup.
        if (!isRetry && /12502|currently.?in.?progress|in_progress/.test(blob)) {
          _axGSignInFlight = false;
          try { if (GA.signOut) GA.signOut(); } catch (_) {}
          return new Promise(function (r) { setTimeout(r, 500); }).then(function () { return _axDoGoogle(true); });
        }
        // Anything else (or a persistent 12502 after the retry): one clean,
        // non-blocking line — no alert() popup, no raw error code shown.
        var msg = /12502|in_progress/.test(blob)
          ? 'Google sign-in was busy — please tap Continue again.'
          : 'Could not sign in with Google. Please check your connection and try again.';
        try { if (window.showToast) showToast(msg, 'warning'); } catch (_) {}
      });
    }
    function _axNativeGoogle() { _axDoGoogle(false); }
    // *** THE FIX ***: portal-auth.js loads LATER (line ~3034) and its
    // `function signInWithGoogle()` DECLARATION hoists over our assignment, so tapping
    // the button ran the WEB version ("Google is loading") even though the native
    // plugin was ready. Re-apply the native override AFTER portal-auth.js has parsed.
    function _axApplyGoogle() { window.signInWithGoogle = _axNativeGoogle; }
    _axApplyGoogle();
    document.addEventListener('DOMContentLoaded', _axApplyGoogle);
    window.addEventListener('load', _axApplyGoogle);
    setTimeout(_axApplyGoogle, 600);
    setTimeout(_axApplyGoogle, 2000);

    /* ── SESSION PERSISTENCE ──────────────────────────────────────────────
       Google ID tokens expire ~1h. The web reauth (GIS prompt / OAuth popup)
       can't run inside a WebView, so the session used to die and force a
       re-login. mpApi() calls window.ensureFreshGoogleToken() before every
       request (and again after a 401) — so override it to refresh SILENTLY via
       the native plugin. Now the session lasts until the user logs out. */
    var _axRefreshInFlight = null;
    function _axEnsureFresh() {
      var cur = '';
      try { cur = localStorage.getItem('ax_google_token') || ''; } catch (e) {}
      if (!cur) return Promise.resolve('');
      var expired = true;
      try { expired = (typeof window.isGoogleTokenExpired === 'function') ? window.isGoogleTokenExpired() : false; } catch (e) {}
      if (!expired) return Promise.resolve(cur);            // still valid → nothing to do
      if (_axRefreshInFlight) return _axRefreshInFlight;
      if (!GA.refresh) return Promise.resolve(cur);
      _axRefreshInFlight = GA.refresh().then(function (res) {
        var idToken = res && res.authentication && res.authentication.idToken;
        if (idToken) { try { localStorage.setItem('ax_google_token', idToken); window._axSessionExpiredShown = false; } catch (e) {} }
        _axRefreshInFlight = null;
        try { return idToken || localStorage.getItem('ax_google_token') || ''; } catch (e) { return idToken || ''; }
      }).catch(function () {
        _axRefreshInFlight = null;
        try { return localStorage.getItem('ax_google_token') || ''; } catch (e) { return ''; }
      });
      return _axRefreshInFlight;
    }
    // Re-apply after portal-auth.js (same clobber issue as signInWithGoogle).
    function _axApplyFresh() { window.ensureFreshGoogleToken = _axEnsureFresh; }
    _axApplyFresh();
    document.addEventListener('DOMContentLoaded', _axApplyFresh);
    window.addEventListener('load', _axApplyFresh);
    setTimeout(_axApplyFresh, 700);
    setTimeout(_axApplyFresh, 2000);
    // Proactive: also refresh every 45 min and on app resume, so it never
    // expires mid-use even if no API call happens for a while.
    setInterval(function () { try { if (localStorage.getItem('ax_google_token')) _axEnsureFresh(); } catch (e) {} }, 45 * 60 * 1000);
    document.addEventListener('ax:resumed', function () { try { if (localStorage.getItem('ax_google_token')) _axEnsureFresh(); } catch (e) {} });
  })();

  /* ── M5: background GPS for delivery. Keeps posting the rider's location to
        /delivery/location even when the app is minimized (a foreground service
        keeps the app alive), which navigator.geolocation.watchPosition cannot.
        Wraps the existing mpStartGpsPush (start) + geolocation.clearWatch (stop)
        so portal-delivery.js stays untouched. ── */
  (function () {
    var BG = P.BackgroundGeolocation;
    if (!BG || !BG.addWatcher) return; // plugin not installed/synced → web watchPosition only
    var _watcherId = null, _arn = null;

    function post(loc) {
      if (!_arn || !loc || loc.latitude == null) return;
      try {
        if (typeof window.mpApi === 'function') {
          window.mpApi('/delivery/location', {
            method: 'POST',
            body: JSON.stringify({ arn: _arn, lat: loc.latitude, lng: loc.longitude })
          }).catch(function () {});
        }
      } catch (e) {}
    }

    window.AxNative.startTracking = function (arn) {
      if (arn) _arn = arn;
      if (_watcherId) return Promise.resolve(_watcherId);
      return BG.addWatcher({
        backgroundMessage: 'Delivery active - sharing your live location',
        backgroundTitle: 'Aarvex delivery',
        requestPermissions: true,
        stale: false,
        distanceFilter: 20
      }, function (location, error) {
        if (error) return;
        post(location);
      }).then(function (id) { _watcherId = id; return id; });
    };

    window.AxNative.stopTracking = function () {
      var id = _watcherId; _watcherId = null; _arn = null;
      if (!id) return Promise.resolve(false);
      return BG.removeWatcher({ id: id }).then(function () { return true; }).catch(function () { return false; });
    };

    function wireHooks() {
      if (typeof window.mpStartGpsPush === 'function' && !window.mpStartGpsPush._axWrapped) {
        var orig = window.mpStartGpsPush;
        var wrapped = function (arn) {
          try { orig.apply(this, arguments); } catch (e) {}
          try { window.AxNative.startTracking(arn); } catch (e) {}
        };
        wrapped._axWrapped = true;
        window.mpStartGpsPush = wrapped;
      }
      try {
        if (navigator.geolocation && navigator.geolocation.clearWatch && !navigator.geolocation._axClearWrapped) {
          var oc = navigator.geolocation.clearWatch.bind(navigator.geolocation);
          navigator.geolocation.clearWatch = function (id) {
            try { oc(id); } catch (e) {}
            try { window.AxNative.stopTracking(); } catch (e) {}
          };
          navigator.geolocation._axClearWrapped = true;
        }
      } catch (e) {}
    }
    wireHooks();
    window.addEventListener('load', wireHooks);
    var _t = 0, _iv = setInterval(function () {
      wireHooks();
      if (++_t > 20 || (window.mpStartGpsPush && window.mpStartGpsPush._axWrapped)) clearInterval(_iv);
    }, 500);
  })();

  /* ── M6: native share sheet + camera. Photo uploads already use <input
        type=file> which the native WebView opens (camera/gallery). Here we
        polyfill the Web Share API (absent in the Android WebView) with
        @capacitor/share so the existing `if (navigator.share)` code works. ── */
  (function () {
    var Sh = P.Share;
    if (!Sh || !Sh.share) return;
    var nativeShare = function (data) {
      data = data || {};
      var payload = { dialogTitle: 'Share' };
      if (data.title) payload.title = data.title;
      if (data.text) payload.text = data.text;
      if (data.url) payload.url = data.url;
      return Sh.share(payload);
    };
    window.AxNative.share = nativeShare;
    try {
      navigator.share = function (data) { return nativeShare(data); };
    } catch (e) {
      try { Object.defineProperty(navigator, 'share', { value: function (data) { return nativeShare(data); }, configurable: true }); } catch (_) {}
    }
  })();

  /* ── M7: push notifications (FCM). Registers the device, sends the token to
        /push/register (backend pushes order / OTP / delivery alerts even when
        the app is closed), and turns a notification tap into an ax:deeplink
        event. Requires Firebase (google-services.json) to actually deliver. ── */
  (function () {
    var Push = P.PushNotifications;
    if (!Push || !Push.register) return; // plugin not installed/synced yet
    function sendToken(token) {
      if (!token) return;
      try {
        if (typeof window.mpApi === 'function') {
          window.mpApi('/push/register', {
            method: 'POST',
            body: JSON.stringify({ token: token, platform: 'android' })
          }).catch(function () {});
        }
      } catch (e) {}
    }
    try { Push.addListener('registration', function (t) { sendToken(t && t.value); }); } catch (e) {}
    try { Push.addListener('registrationError', function () {}); } catch (e) {}
    try { Push.addListener('pushNotificationReceived', function (n) { document.dispatchEvent(new CustomEvent('ax:push', { detail: n })); }); } catch (e) {}
    try {
      Push.addListener('pushNotificationActionPerformed', function (a) {
        var data = (a && a.notification && a.notification.data) || {};
        document.dispatchEvent(new CustomEvent('ax:deeplink', { detail: { url: data.url || null, data: data } }));
      });
    } catch (e) {}

    window.AxNative.registerPush = function () {
      return Push.checkPermissions().then(function (p) {
        if (p.receive === 'granted') return Push.register();
        return Push.requestPermissions().then(function (r) { if (r.receive === 'granted') return Push.register(); });
      });
    };

    // Register once we have a signed-in user (backend ties the token to them).
    function tryRegister() { try { window.AxNative.registerPush(); } catch (e) {} }
    var signedIn = false;
    try { signedIn = !!localStorage.getItem('ax_user'); } catch (e) {}
    if (signedIn || (document.body && document.body.classList.contains('is-signed-in'))) setTimeout(tryRegister, 1500);
    document.addEventListener('ax:signed-in', function () { setTimeout(tryRegister, 800); });
  })();

  /* ── M8: deep-link router. Turns an ax:deeplink event (from a notification
        tap [M7] or an App Link / custom-scheme open [App plugin, M3]) into a
        panel switch, and opens a specific order when an ARN is present. ── */
  (function () {
    function route(detail) {
      detail = detail || {};
      var data = detail.data || detail || {};
      var url = detail.url || data.url || "";
      var panel = data.panel || "";
      var arn = data.arn || "";
      if (url) {
        try {
          var u = new URL(url);
          arn = arn || u.searchParams.get("arn") || "";
          var hash = (u.hash || "").replace(/^#/, "");
          var seg = (u.pathname || "").replace(/^\/+|\/+$/g, "").split("/")[0];
          panel = panel || hash || seg || "";
        } catch (e) {}
      }
      if (!panel && data.type) {
        var t = String(data.type);
        if (t.indexOf("delivery") === 0 || t === "order" || t === "cod_invoice") panel = "myorders";
        else if (t === "rfq") panel = "rfq";
        else if (t === "shop_status") panel = "myorders";
        else panel = "notifications";
      }
      if (arn) { try { window.AX_DEEPLINK_ARN = arn; } catch (e) {} }
      var target = panel || "notifications";
      var go = function () {
        try { if (typeof window.switchPanel === "function") window.switchPanel(target); } catch (e) {}
        if (arn) {
          try {
            if (typeof window.trackOrder === "function") setTimeout(function () { try { window.trackOrder(arn); } catch (e) {} }, 500);
          } catch (e) {}
        }
      };
      if (document.readyState === "complete") setTimeout(go, 300);
      else window.addEventListener("load", function () { setTimeout(go, 300); });
    }
    document.addEventListener("ax:deeplink", function (e) { route(e.detail); });
  })();

  document.dispatchEvent(new CustomEvent('ax:native-ready'));
})();
