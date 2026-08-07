/* ═══════════════════════════════════════════════════════════════════════
   ax-telemetry.js — Portal Health + Command Center client
   - Captures errors with tab/feature context
   - Ignores benign noise
   - Safe auto-fixes ONLY (no payment/order/auth changes without permission)
   - Cloud sync → POST /telemetry/report
   - Local buffer for Admin (same-origin) + health checks
   ═══════════════════════════════════════════════════════════════════════ */
(function () {
  var KEY = 'ax_client_error_log_v1';
  var QUEUE_KEY = 'ax_telemetry_queue_v1';
  var MAX = 100;
  var flushTimer = null;

  var SETUP = {
    version: 1,
    tabs: {
      dashboard: { label: 'Home', features: ['banner', 'search_people', 'stories', 'feed', 'geo', 'messages_fab'] },
      trade: { label: 'Trade', features: ['search_products', 'category_grid', 'product_sections', 'shops_mode', 'cart'] },
      favourites: { label: 'Favourites', features: ['fav_products', 'fav_shops'] },
      delivery: { label: 'Delivery', features: ['claims', 'live_map', 'otp'] },
      account: { label: 'Account', features: ['orders', 'invoice'] },
      profile: { label: 'Profile', features: ['kyc', 'address'] }
    },
    neverAutofix: ['payment', 'order', 'invoice', 'auth', 'otp', 'account_delete', 'admin']
  };

  function load(key) {
    try { return JSON.parse(localStorage.getItem(key) || '[]'); } catch (e) { return []; }
  }
  function save(key, arr) {
    try { localStorage.setItem(key, JSON.stringify((arr || []).slice(0, MAX))); } catch (e) {
      try { localStorage.removeItem(key); } catch (e2) {}
    }
  }

  function activeTab() {
    // Portal keeps dynamic per-panel tabs; other pages set window.AX_TAB_HINT.
    var p = document.querySelector('.portal-panel.active');
    if (p && p.id) return String(p.id).replace(/^panel-/, '') || (window.AX_TAB_HINT || 'unknown');
    return window.AX_TAB_HINT || 'unknown';
  }

  function guessFeature(msg, stack) {
    var t = (msg + ' ' + stack).toLowerCase();
    if (/lottie|preloader|car-loader/.test(t)) return 'preloader';
    if (/story|ax-story/.test(t)) return 'stories';
    if (/feed|ax-feed/.test(t)) return 'feed';
    if (/catalogue|productgrid|category/.test(t)) return 'catalogue';
    if (/search|dock|ax-search/.test(t)) return 'search';
    if (/messenger|chat|webrtc/.test(t)) return 'messenger';
    if (/payment|cashfree|razorpay|invoice|cod/.test(t)) return 'checkout';
    if (/delivery|otp|geo/.test(t)) return 'delivery';
    return 'general';
  }

  function isBenign(msg, stack) {
    var t = String(msg || '') + ' ' + String(stack || '');
    return /ResizeObserver loop|Script error\.|chrome-extension:|moz-extension:|safari-extension:|Blocked a frame|Loading CSS chunk|Non-Error promise rejection|AbortError|The operation was aborted|ResizeObserver loop limit exceeded|idb-backend|__gCrWeb/i.test(t);
  }

  function classify(msg, stack, type) {
    var m = String(msg || '');
    var s = String(stack || '');
    var feature = guessFeature(m, s);
    var tab = activeTab();

    if (isBenign(m, s)) {
      return {
        severity: 'ignore', critical: false, needs_permission: false,
        auto_action: 'ignore', cause: 'Benign browser/extension noise — ignored.',
        tab: tab, feature: feature
      };
    }

    // Safe auto-fixable small issues
    if (/lottie|car-loader|ax-lottie|dotlottie/i.test(m + s)) {
      return {
        severity: 'warn', critical: false, needs_permission: false,
        auto_action: 'remount_lottie', cause: 'Preloader animation failed — safe remount.',
        tab: tab, feature: 'preloader'
      };
    }
    if (/QuotaExceeded|localStorage/i.test(m)) {
      return {
        severity: 'warn', critical: false, needs_permission: false,
        auto_action: 'trim_buffer', cause: 'Storage full — trim local telemetry buffer.',
        tab: tab, feature: feature
      };
    }
    if (/ChunkLoadError|Loading chunk [\d]+ failed|dynamically imported module/i.test(m + s)) {
      return {
        severity: 'warn', critical: false, needs_permission: false,
        auto_action: 'reload_once', cause: 'Stale JS chunk — one safe reload allowed.',
        tab: tab, feature: feature
      };
    }

    // Small syntax / missing-symbol issues: soft reload only — NEVER rewrite code
    if (/SyntaxError|Unexpected token/i.test(m)) {
      return {
        severity: 'error', critical: true, needs_permission: true,
        auto_action: 'reload_once', cause: 'Syntax/parse error — one soft reload; code changes need permission.',
        tab: tab, feature: feature
      };
    }
    if (/is not defined|ReferenceError/i.test(m)) {
      return {
        severity: 'error', critical: true, needs_permission: true,
        auto_action: 'reload_once', cause: 'Missing symbol (cache/deploy?) — soft reload; code changes need permission.',
        tab: tab, feature: feature
      };
    }
    if (/Failed to fetch|NetworkError|net::ERR|Load failed|503|502/i.test(m + s)) {
      return {
        severity: 'error', critical: true, needs_permission: true,
        auto_action: 'none', cause: 'API/network failure — investigate Lambda/CORS; no silent code rewrite.',
        tab: tab, feature: feature
      };
    }
    if (/payment|cashfree|razorpay|invoice|otp|order place|account\/delete/i.test(m + s + ' ' + feature)) {
      return {
        severity: 'critical', critical: true, needs_permission: true,
        auto_action: 'none', cause: 'Checkout/auth/delivery critical path — changes require explicit permission.',
        tab: tab, feature: feature
      };
    }
    if (/Cannot read prop|undefined is not|null is not|TypeError/i.test(m)) {
      return {
        severity: 'error', critical: false, needs_permission: true,
        auto_action: 'none', cause: 'Null access — likely race/UI before data; report only.',
        tab: tab, feature: feature
      };
    }

    return {
      severity: 'error', critical: false, needs_permission: true,
      auto_action: 'none', cause: 'Unclassified client error — logged for Admin Command Center.',
      tab: tab, feature: feature
    };
  }

  function pushLocal(entry) {
    var arr = load(KEY);
    arr.unshift(entry);
    save(KEY, arr);
    try { document.dispatchEvent(new CustomEvent('ax:client-error', { detail: entry })); } catch (e) {}
  }

  function enqueueCloud(entry) {
    if (entry.severity === 'ignore') return;
    var q = load(QUEUE_KEY);
    q.push(entry);
    save(QUEUE_KEY, q);
    scheduleFlush();
  }

  function scheduleFlush() {
    if (flushTimer) return;
    flushTimer = setTimeout(function () {
      flushTimer = null;
      flushCloud();
    }, 1800);
  }

  function flushCloud() {
    var q = load(QUEUE_KEY);
    if (!q.length) return;
    var batch = q.slice(0, 20);
    save(QUEUE_KEY, q.slice(20));
    var base = (typeof LAMBDA_URL !== 'undefined' && LAMBDA_URL) ? LAMBDA_URL : '';
    if (!base) return;
    var headers = { 'Content-Type': 'application/json' };
    try {
      var tok = localStorage.getItem('ax_google_token');
      if (tok) headers.Authorization = 'Bearer ' + tok;
    } catch (e) {}
    fetch(base + '/telemetry/report', {
      method: 'POST',
      headers: headers,
      body: JSON.stringify({ events: batch }),
      keepalive: true
    }).catch(function () {
      // put back on failure
      var again = batch.concat(load(QUEUE_KEY));
      save(QUEUE_KEY, again);
    });
  }

  /** Only these run automatically. Payment/order/auth code is NEVER rewritten. */
  var SAFE_AUTO = {
    ignore: 1,
    remount_lottie: 1,
    trim_buffer: 1,
    clear_stale_dock: 1,
    reload_once: 1
  };

  function runSafeAutofix(action) {
    if (!action || action === 'none' || !SAFE_AUTO[action]) return 'skipped';
    if (action === 'ignore') return 'ignored';
    try {
      if (action === 'remount_lottie') {
        document.querySelectorAll('.ax-lottie-host').forEach(function (h) {
          try {
            h.removeAttribute('data-ax-mounted');
            while (h.firstChild) h.removeChild(h.firstChild);
            var wrap = h.closest('.ax-lottie-wrap');
            if (wrap) wrap.classList.remove('is-playing');
          } catch (e) {}
        });
        if (typeof axMountLoaders === 'function') axMountLoaders(document);
        return 'remount_lottie';
      }
      if (action === 'trim_buffer') {
        save(KEY, load(KEY).slice(0, 30));
        save(QUEUE_KEY, load(QUEUE_KEY).slice(0, 20));
        return 'trim_buffer';
      }
      if (action === 'clear_stale_dock') {
        document.querySelectorAll('.portal-panel:not(.active) .catalogue-search-sticky.is-docked').forEach(function (el) {
          el.classList.remove('is-docked');
        });
        return 'clear_stale_dock';
      }
      if (action === 'reload_once') {
        var flag = 'ax_chunk_reload_once';
        if (!sessionStorage.getItem(flag)) {
          sessionStorage.setItem(flag, '1');
          location.reload();
          return 'reload_once';
        }
        return 'reload_suppressed';
      }
    } catch (e) {
      return 'autofix_failed';
    }
    return 'unknown';
  }

  function report(err, meta) {
    var msg = (err && err.message) ? err.message : String(err || 'Error');
    var stack = (err && err.stack) ? err.stack : ((meta && meta.stack) || '');
    var type = (meta && meta.type) || 'manual';
    var info = classify(msg, stack, type);

    // Periodic UI hygiene (safe)
    runSafeAutofix('clear_stale_dock');

    // Soft recovery only from SAFE_AUTO whitelist — big issues stay report-only
    var applied = 'none';
    if (info.auto_action && SAFE_AUTO[info.auto_action]) {
      applied = runSafeAutofix(info.auto_action);
    }

    var entry = {
      id: 'e_' + Date.now().toString(36) + '_' + Math.random().toString(36).slice(2, 7),
      ts: new Date().toISOString(),
      type: type,
      message: String(msg).slice(0, 500),
      stack: String(stack).slice(0, 1200),
      cause: info.cause,
      critical: !!info.critical,
      severity: info.severity,
      needs_permission: !!info.needs_permission,
      auto_action: info.auto_action,
      auto_applied: applied,
      tab: info.tab,
      feature: info.feature,
      href: (location && location.href) || '',
      ua: (navigator && navigator.userAgent) || '',
      meta: meta || null
    };

    if (info.severity !== 'ignore') pushLocal(entry);
    enqueueCloud(entry);
    return entry;
  }

  /* ── Health checks (design + logic signals) ───────────────────────── */
  function runHealthChecks() {
    var findings = [];
    function add(sev, feature, message, cause, needsPerm) {
      findings.push({
        severity: sev, feature: feature, message: message, cause: cause,
        needs_permission: !!needsPerm, critical: sev === 'critical'
      });
    }

    // Story ring should not spin
    var spinning = false;
    try {
      document.querySelectorAll('.ax-story-ring.unseen').forEach(function (el) {
        var an = getComputedStyle(el).animationName || '';
        if (an && an !== 'none') spinning = true;
      });
    } catch (e) {}
    if (spinning) add('warn', 'stories', 'Story ring still animating', 'Design rule: static IG/WA ring only', true);

    // Trade search should open category grid on focus wiring
    var tradeInp = document.getElementById('catalogueSearchInput');
    if (tradeInp && !/openCategoryQuickGrid/.test(String(tradeInp.getAttribute('onfocus') || ''))) {
      add('error', 'search', 'Trade search missing category-grid onfocus', 'Restore onfocus=openCategoryQuickGrid(trade)', true);
    }

    // Docked bar under inactive panel
    if (document.querySelector('.portal-panel:not(.active) .catalogue-search-sticky.is-docked')) {
      add('warn', 'search', 'Stale docked search on hidden panel', 'Safe autofix clear_stale_dock', false);
      runSafeAutofix('clear_stale_dock');
    }

    // Preloader asset presence (best-effort)
    // Shop modal empty products while open — soft signal
    var shopTitle = document.querySelector('.shop-products-title');
    if (shopTitle && /Products \(0\)/.test(shopTitle.textContent || '')) {
      add('info', 'shop_profile', 'Shop profile shows 0 products', 'Check API shop products / category_name', true);
    }

    findings.forEach(function (f) {
      if (f.severity === 'info') return;
      report(f.message, { type: 'health_check', stack: '', feature: f.feature });
    });
    return findings;
  }

  // Public API (compat with ax-error-log.js)
  window.axLogError = function (err, meta) { return report(err, meta); };
  window.axGetClientErrors = function () { return load(KEY); };
  window.axClearClientErrors = function () { save(KEY, []); save(QUEUE_KEY, []); };
  window.axGetSetupMap = function () { return SETUP; };
  window.axRunHealthChecks = runHealthChecks;
  window.axFlushTelemetry = flushCloud;

  window.addEventListener('error', function (e) {
    report(e.error || e.message, {
      type: 'window.onerror',
      source: e.filename,
      line: e.lineno,
      col: e.colno,
      stack: e.error && e.error.stack
    });
  });
  window.addEventListener('unhandledrejection', function (e) {
    report(e.reason || 'Unhandled rejection', { type: 'unhandledrejection' });
  });

  document.addEventListener('DOMContentLoaded', function () {
    setTimeout(runHealthChecks, 3500);
    setInterval(function () { runSafeAutofix('clear_stale_dock'); }, 15000);
    setInterval(flushCloud, 20000);
  });

  window.addEventListener('online', flushCloud);
  document.addEventListener('visibilitychange', function () {
    if (document.visibilityState === 'hidden') flushCloud();
  });
})();
