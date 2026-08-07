/* Aarvex Portal — notifications popup, maps, profile tabs, compact forms */
'use strict';

// ── Map provider keys: fetched at runtime from GET /config/maps (backed by
// Lambda environment variables GOOGLE_MAPS_API_KEY / MAPPLS_API_KEY) instead
// of being hardcoded in portal.html. This keeps keys out of the static
// frontend files entirely and lets them be rotated/added from the AWS
// Console without ever touching or redeploying portal.html. loadMapKeys()
// below fetches them once on page load; everything that needs a key waits
// for that fetch via the _mapKeysLoaded promise. ──
let GOOGLE_MAPS_API_KEY = '';
let MAPPLS_API_KEY = '';
// NOTE (address-typing-blocked fix): a literal placeholder key string
// (e.g. 'PASTE_YOUR_GOOGLE_MAPS_API_KEY_HERE') would otherwise pass a naive
// truthy check and get sent to Google, which fails auth (InvalidKeyMapError)
// and its own Autocomplete widget renders an error overlay on top of the
// address field, swallowing keystrokes. Treating any placeholder-looking
// value as "no key" keeps the field a normal, fully-typable input instead.
let GOOGLE_MAPS_KEY_LOOKS_VALID = false;
let MAPPLS_KEY_LOOKS_VALID = false;

function _keyLooksValid(k) {
  return !!k && !/PASTE_YOUR|YOUR_.*KEY|_HERE$/i.test(k);
}

let _mapKeysLoaded = null;
function loadMapKeys() {
  if (_mapKeysLoaded) return _mapKeysLoaded;
  _mapKeysLoaded = (typeof LAMBDA_URL !== 'undefined' ? fetch(LAMBDA_URL + '/config/maps') : Promise.reject())
    .then(function (res) { return res.json(); })
    .then(function (data) {
      GOOGLE_MAPS_API_KEY = (data && data.google_maps_key) || '';
      MAPPLS_API_KEY = (data && data.mappls_key) || '';
      GOOGLE_MAPS_KEY_LOOKS_VALID = _keyLooksValid(GOOGLE_MAPS_API_KEY);
      MAPPLS_KEY_LOOKS_VALID = _keyLooksValid(MAPPLS_API_KEY);
    })
    .catch(function () {
      // Backend unreachable/older Lambda without this route yet — no keys,
      // app just runs on the always-free Leaflet fallback until it's deployed.
      GOOGLE_MAPS_KEY_LOOKS_VALID = false;
      MAPPLS_KEY_LOOKS_VALID = false;
    });
  return _mapKeysLoaded;
}

const PortalEnhancements = (function () {
  let _lastUnread = 0;
  let _notificationAttentionAcknowledged = false;
  let _pollTimer = null;
  let _trackMap = null;
  let _deliveryMap = null;
  let _trackRoutingControl = null;
  let _deliveryRoutingControl = null;
  let _trackTruckMarker = null;
  let _deliveryTruckMarker = null;
  let _isDeliveryFullscreen = false;
  let _trackGMap = null;
  let _deliveryGMap = null;
  let _trackDirRef = {};
  let _deliveryDirRef = {};
  let _trackVehicleMarker = null;
  let _deliveryVehicleMarker = null;
  let _trackPickupGMarker = null;
  let _deliveryPickupGMarker = null;
  let _trackDestGMarker = null;
  let _deliveryDestGMarker = null;
  let _lastTrackDriverPos = null;
  let _lastDeliveryDriverPos = null;
  let _placesReady = false;
  let _googleMapsAuthFailed = false; // set true if Google reports a key/billing/referrer auth failure at runtime
  let _mapplsReady = false;
  let _mapplsAuthFailed = false;
  let _mapplsMap = null; // reused for the profile-address preview if ever added
  let _trackMapplsMap = null;
  let _deliveryMapplsMap = null;
  let _trackMapplsMarker = null;
  let _deliveryMapplsMarker = null;
  let _trackMapplsDestMarker = null;
  let _deliveryMapplsDestMarker = null;
  let _trackPollTimer = null;
  let _deliveryPollTimer = null;
  let _closeAlerted = {}; // arn -> true, so the client-side "nearby" toast fires once per delivery
  const LIVE_POLL_MS = 12000; // ~Zomato-style refresh cadence without hammering the API

  function esc(s) {
    if (s == null) return '';
    return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  }

  function extractOtp(body) {
    const m = String(body || '').match(/OTP:\s*(\d{6})/i);
    return m ? m[1] : '';
  }

  function updateBadges(count) {
    const n = count || 0;
    ['notifBadge', 'notifBadgeDesktop', 'notifBadgeAlert', 'navNotifBadge', 'notifBadgeMobile'].forEach(function (id) {
      const el = document.getElementById(id);
      if (!el) return;
      el.textContent = '';
      el.style.display = 'none';
    });
    if (n > (updateBadges._prev || 0)) _notificationAttentionAcknowledged = false;
    document.querySelectorAll('.nav-notif-pulse').forEach(function (btn) {
      btn.classList.toggle('has-unread', n > 0);
      btn.classList.toggle('has-unread-attention', n > 0 && !_notificationAttentionAcknowledged);
    });
    const pill = document.getElementById('axNotifNavCount');
    if (pill) {
      pill.textContent = n > 99 ? '99+' : String(n);
      pill.style.display = n > 0 ? '' : 'none';
    }
    updateBadges._prev = n;
  }

  function acknowledgeNotificationAttention() {
    _notificationAttentionAcknowledged = true;
    document.querySelectorAll('.nav-notif-pulse').forEach(function (btn) {
      btn.classList.remove('has-unread-attention');
    });
  }

  function spawnFlyingLetter() {
    const host = document.getElementById('flyingLetterHost');
    if (!host) return;
    const el = document.createElement('div');
    el.className = 'flying-letter';
    el.innerHTML = '<i class="fa-solid fa-envelope"></i>';
    host.appendChild(el);
    setTimeout(function () { el.remove(); }, 2200);
  }

  function copyText(text, label) {
    if (!text) return;
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(text).then(function () {
        if (typeof showToast === 'function') showToast((label || 'Copied') + ' copied', 'success');
      }).catch(fallbackCopy);
    } else fallbackCopy();
    function fallbackCopy() {
      const ta = document.createElement('textarea');
      ta.value = text;
      document.body.appendChild(ta);
      ta.select();
      try { document.execCommand('copy'); if (typeof showToast === 'function') showToast((label || 'Copied') + ' copied', 'success'); } catch (e) {}
      ta.remove();
    }
  }

  function renderAlertList(items) {
    const list = document.getElementById('notifAlertList');
    const countEl = document.getElementById('notifAlertCount');
    if (!list) return;
    const unread = (items || []).filter(function (n) { return !n.is_read; });
    if (countEl) countEl.textContent = unread.length ? unread.length + ' new' : 'All caught up';
    if (!items || !items.length) {
      list.innerHTML = '<p class="notif-alert-empty"><i class="fa-solid fa-circle-check" style="color:var(--c-leaf2,#3E9159)"></i> You\'re all caught up!</p>';
      return;
    }
    // Section 0 #4 fix: same templated card as the full Alerts panel
    // (mpLoadNotifications, portal-marketplace.js) — one source of truth
    // via CatalogueUI.notificationItemHtml instead of two divergent
    // hand-rolled renders of the same raw n.body dump.
    list.innerHTML = items.slice(0, 12).map(function (n) {
      if (typeof CatalogueUI !== 'undefined') return CatalogueUI.notificationItemHtml(n, { showMarkRead: false });
      const otp = extractOtp(n.body);
      const icons = { delivery_otp: 'fa-key', kyc_update: 'fa-id-card', shop_status: 'fa-store', admin_message: 'fa-envelope', new_lead: 'fa-wheat-awn', new_review: 'fa-star' };
      return '<div class="notif-alert-item' + (n.is_read ? '' : ' unread') + '">' +
        '<div class="notif-alert-icon"><i class="fa-solid ' + (icons[n.type] || 'fa-bell') + '"></i></div>' +
        '<div class="notif-alert-body">' +
          '<div class="notif-alert-title">' + esc(n.title || 'Notification') + '</div>' +
          '<div class="notif-alert-text">' + esc(n.body || '').replace(/\n/g, '<br>') + '</div>' +
          (otp ? '<button type="button" class="otp-copy-btn" onclick="PortalEnhancements.copyOtp(\'' + otp + '\')"><i class="fa-regular fa-copy"></i> Copy OTP · ' + otp + '</button>' : '') +
          '<div class="notif-alert-time">' + esc((n.created_at || '').slice(0, 16).replace('T', ' ')) + '</div>' +
        '</div></div>';
    }).join('');
  }

  /* ── In-app "new notification" popup card ──────────────────────────
     When a new notification lands, a card slides in near the bell (about
     a third of the screen wide on desktop, full-width strip on mobile)
     showing the actual title + message. It auto-dismisses — and BOTH
     dismiss paths (auto + the × button) animate the card shrinking and
     flying INTO the bell icon, so the eye learns exactly where the
     message went. Tapping the card body opens the Notifications tab. */
  function _escNP(s) {
    return String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  }
  function showNotifPopupCard(n) {
    if (!n) return;
    // Settings → Notifications → "In-app popups" toggle.
    try { if (localStorage.getItem('ax_notif_popup') === 'off') return; } catch (e) {}
    let el = document.getElementById('axNotifPop');
    if (!el) {
      el = document.createElement('div');
      el.id = 'axNotifPop';
      document.body.appendChild(el);
    }
    el.innerHTML =
      '<div class="axnp-icon"><i class="fa-solid fa-bell"></i></div>' +
      '<div class="axnp-body">' +
        '<div class="axnp-title">' + _escNP(n.title || 'New notification') + '</div>' +
        '<div class="axnp-text">' + _escNP(String(n.body || '').replace(/\n+/g, ' · ')) + '</div>' +
      '</div>' +
      '<button type="button" class="axnp-close" aria-label="Dismiss"><i class="fa-solid fa-xmark"></i></button>';
    el.querySelector('.axnp-close').onclick = function (e) { e.stopPropagation(); dismissNotifPopupCard(); };
    el.onclick = function () { dismissNotifPopupCard(); openNotificationPanel(); };
    el.classList.remove('fly');
    // restart the entrance animation even if the card was already showing
    void el.offsetWidth;
    el.classList.add('show');
    clearTimeout(el._axTimer);
    el._axTimer = setTimeout(dismissNotifPopupCard, 6500);
  }
  function dismissNotifPopupCard() {
    const el = document.getElementById('axNotifPop');
    if (!el || !el.classList.contains('show')) return;
    clearTimeout(el._axTimer);
    const bell = document.querySelector('.nav-btn-notifications');
    const er = el.getBoundingClientRect();
    if (bell) {
      const br = bell.getBoundingClientRect();
      el.style.setProperty('--fly-x', (br.left + br.width / 2 - (er.left + er.width / 2)) + 'px');
      el.style.setProperty('--fly-y', (br.top + br.height / 2 - (er.top + er.height / 2)) + 'px');
    } else {
      el.style.setProperty('--fly-x', '40vw');
      el.style.setProperty('--fly-y', '-20vh');
    }
    el.classList.add('fly');
    setTimeout(function () {
      el.classList.remove('show', 'fly');
      // tiny acknowledge pulse on the bell as the card lands in it
      document.querySelectorAll('.nav-notif-pulse').forEach(function (b) {
        b.classList.remove('bell-catch');
        void b.offsetWidth;
        b.classList.add('bell-catch');
      });
    }, 480);
  }

  async function refreshNotifications(silent) {
    if (typeof mpApi !== 'function') return;
    const data = await mpApi('/notifications');
    const unread = data.unread || 0;
    if (!silent && unread > _lastUnread && _lastUnread >= 0) {
      // Rich popup with the real message replaces the old generic
      // "You have N notifications" toast + flying envelope.
      const newest = (data.notifications || []).find(function (x) { return !x.is_read; });
      if (newest) showNotifPopupCard(newest);
      else spawnFlyingLetter();
      const popup = document.getElementById('notifAlertPopup');
      if (popup && popup.classList.contains('open')) renderAlertList(data.notifications || []);
    }
    _lastUnread = unread;
    if (typeof mpNotifUnread !== 'undefined') mpNotifUnread = unread;
    updateBadges(unread);
    // Importer live-track banner (parity with the delivery-partner journey
    // banner): show/hide it based on whether the buyer has an order in transit.
    if (typeof window.axUpdateImporterTrackBanner === 'function') {
      try { window.axUpdateImporterTrackBanner(data.notifications || []); } catch (e) {}
    }
    if (document.getElementById('notifAlertPopup')?.classList.contains('open')) {
      renderAlertList(data.notifications || []);
    }
    return data;
  }

  function openAlertPopup() {
    const popup = document.getElementById('notifAlertPopup');
    if (!popup) { if (typeof switchPanel === 'function') switchPanel('notifications'); return; }
    popup.classList.add('open');
    refreshNotifications(true).then(function (data) {
      if (data) renderAlertList(data.notifications || []);
    });
  }

  function closeAlertPopup() {
    document.getElementById('notifAlertPopup')?.classList.remove('open');
  }

  function openNotificationPanel() {
    closeAlertPopup();
    // Bottom-sheet (Batch: notifications) — opens at ~78% height with a drag
    // handle to expand/collapse and swipe-down / tap-backdrop to close. Falls
    // back to the full panel if the sheet helper isn't loaded.
    if (typeof axOpenNotifSheet === 'function') { axOpenNotifSheet(); return; }
    if (typeof switchPanel === 'function') switchPanel('notifications');
  }

  function startPolling() {
    if (_pollTimer) clearInterval(_pollTimer);
    _pollTimer = setInterval(function () {
      if (currentUser) refreshNotifications(false);
    }, 45000);
  }

  /* Batch 5 (final): the profile is a 3-STEP WIZARD — Personal Information →
     Default Delivery Address → Business Information — each with a Next/Back
     bar and one Save on the last step. A 3-dot button opens the two
     sub-pages (User Information / KYC Verification); KYC opens FULL-SCREEN.
     The step/menu/KYC helpers are globals defined in ax-social.js. */
  function initProfileTabs() {
    const panel = document.getElementById('panel-profile');
    if (!panel || panel.querySelector('.ax-prof-flow-bar')) return;
    const formSections = panel.querySelectorAll('.form-section:not(#kycSection)');
    if (!formSections.length) return;
    const saveRow = panel.querySelector('#profileSaveBtn')?.closest('div');
    const kyc = document.getElementById('kycSection');
    const titles = ['Personal Information', 'Default Delivery Address', 'Business Information'];

    const bar = document.createElement('div');
    bar.className = 'ax-prof-flow-bar';
    bar.innerHTML = '<div class="ax-prof-steps" id="axProfSteps"></div>' +
      '<button type="button" class="ax-prof-dots" onclick="axProfileSectionMenu()" aria-label="Profile sections"><i class="fa-solid fa-ellipsis-vertical"></i></button>';
    const hero = panel.querySelector('.profile-hero');
    if (hero) hero.after(bar); else panel.insertBefore(bar, panel.firstChild);

    formSections.forEach(function (el, i) {
      el.classList.add('ax-prof-step-pane');
      el.dataset.step = String(i);
      if (el.querySelector('.ax-prof-stepnav')) return;
      const nav = document.createElement('div');
      nav.className = 'ax-prof-stepnav';
      nav.innerHTML =
        (i > 0
          ? '<button type="button" class="btn-sm-outline" onclick="axProfileGoStep(' + (i - 1) + ')"><i class="fa-solid fa-arrow-left"></i> Back</button>'
          : '<span></span>') +
        (i < formSections.length - 1
          ? '<button type="button" class="btn-primary" onclick="axProfileGoStep(' + (i + 1) + ')">Next: ' + (titles[i + 1] || 'Next') + ' <i class="fa-solid fa-arrow-right"></i></button>'
          : '<span></span>');
      el.appendChild(nav);
    });
    if (saveRow) { saveRow.classList.add('ax-prof-step-pane'); saveRow.dataset.step = String(formSections.length - 1); }
    if (kyc) { kyc.classList.add('ax-prof-kyc-pane'); kyc.style.display = 'none'; }
    if (typeof axProfileGoStep === 'function') axProfileGoStep(0);
  }

  function buildCompactSummary(prefix, fields) {
    const p = userProfile || {};
    return fields.map(function (f) {
      const val = gv(f.id) || p[f.key] || '';
      if (!val) return '';
      return '<div class="compact-row"><span>' + f.label + '</span><strong>' + esc(val) + '</strong></div>';
    }).filter(Boolean).join('');
  }

  function initCompactOrderForm() {
    const step2 = document.getElementById('orderStep2');
    if (!step2 || document.getElementById('orderCompactWrap')) return;
    const wrap = document.createElement('div');
    wrap.id = 'orderCompactWrap';
    wrap.className = 'form-compact-shell';
    wrap.innerHTML =
      '<div class="form-compact-card">' +
        '<div class="form-compact-head"><i class="fa-solid fa-circle-check"></i> Using your saved profile</div>' +
        '<div id="orderCompactSummary" class="form-compact-summary"></div>' +
        '<button type="button" class="btn-sm-outline btn-full" id="orderExpandBtn" onclick="PortalEnhancements.toggleOrderForm(true)"><i class="fa-solid fa-pen"></i> Edit details for this order</button>' +
      '</div>';
    const firstSection = step2.querySelector('.form-section');
    if (firstSection) step2.insertBefore(wrap, firstSection);
    step2.querySelectorAll('.form-section, .order-type-grid, .recaptcha-wrap, #orderSubmitBtn, #orderError, .prefill-banner').forEach(function (el) {
      el.classList.add('order-form-expandable');
      el.style.display = 'none';
    });
  }

  function initCompactSellForm() {
    const wrapper = document.getElementById('sellFormWrapper');
    if (!wrapper || document.getElementById('sellCompactWrap')) return;
    const wrap = document.createElement('div');
    wrap.id = 'sellCompactWrap';
    wrap.className = 'form-compact-shell';
    wrap.innerHTML =
      '<div class="form-compact-card">' +
        '<div class="form-compact-head"><i class="fa-solid fa-circle-check"></i> Profile details ready</div>' +
        '<div id="sellCompactSummary" class="form-compact-summary"></div>' +
        '<button type="button" class="btn-sm-outline btn-full" id="sellExpandBtn" onclick="PortalEnhancements.toggleSellForm(true)"><i class="fa-solid fa-pen"></i> Edit listing details</button>' +
      '</div>';
    const first = wrapper.querySelector('.form-section');
    if (first) wrapper.insertBefore(wrap, first);
    wrapper.querySelectorAll('.form-section, .recaptcha-wrap, #sellSubmitBtn, #sellError, .prefill-banner, .sell-how-card').forEach(function (el) {
      el.classList.add('sell-form-expandable');
      el.style.display = 'none';
    });
  }

  function refreshCompactSummaries() {
    const orderSum = document.getElementById('orderCompactSummary');
    if (orderSum) {
      // NOTE: the order form no longer has o_city/o_address text inputs —
      // delivery location comes from the Address Book (location-picker.js
      // + portal-address.js). Reading the *selected* saved address here
      // instead of a dead field means this summary actually matches what
      // will be submitted, rather than silently falling back to the
      // buyer's profile address (which may differ from the delivery
      // address they picked for this specific order).
      let rows = buildCompactSummary('o', [
        { id: 'o_name', key: 'name', label: 'Name' },
        { id: 'o_mobile', key: 'mobile', label: 'Mobile' },
        { id: 'o_email', key: 'email', label: 'Email' },
      ]);
      const addr = typeof getSelectedAddress === 'function' ? getSelectedAddress() : null;
      if (addr) {
        rows += '<div class="compact-row"><span>Delivery to</span><strong>' + esc(addr.label ? (addr.label + ' — ' + addr.city) : addr.city || addr.address || '') + '</strong></div>';
      }
      orderSum.innerHTML = rows || '<p class="compact-empty">Complete your profile to auto-fill orders faster.</p>';
    }
    const sellSum = document.getElementById('sellCompactSummary');
    if (sellSum) {
      sellSum.innerHTML = buildCompactSummary('s', [
        { id: 's_name', key: 'name', label: 'Name' },
        { id: 's_mobile', key: 'mobile', label: 'Mobile' },
        { id: 's_city', key: 'city', label: 'City' },
      ]) || '<p class="compact-empty">Add profile info to speed up listings.</p>';
    }
  }

  function toggleOrderForm(show) {
    document.querySelectorAll('#orderStep2 .order-form-expandable').forEach(function (el) {
      el.style.display = show ? '' : 'none';
    });
    const compact = document.getElementById('orderCompactWrap');
    if (compact) compact.style.display = show ? 'none' : '';
  }

  function toggleSellForm(show) {
    document.querySelectorAll('#sellFormWrapper .sell-form-expandable').forEach(function (el) {
      el.style.display = show ? '' : 'none';
    });
    const compact = document.getElementById('sellCompactWrap');
    if (compact) compact.style.display = show ? 'none' : '';
  }

  function bindPlaces(inputId, latId, lngId, cityId, stateId, pinId) {
    if (!_placesReady || !window.google || !google.maps || !google.maps.places) return;
    const input = document.getElementById(inputId);
    if (!input || input.dataset.placesBound) return;
    input.dataset.placesBound = '1';
    const ac = new google.maps.places.Autocomplete(input, { componentRestrictions: { country: 'in' }, fields: ['formatted_address', 'geometry', 'address_components'] });
    ac.addListener('place_changed', function () {
      const place = ac.getPlace();
      if (!place || !place.geometry) return;
      const lat = place.geometry.location.lat();
      const lng = place.geometry.location.lng();
      sv(latId, String(lat));
      sv(lngId, String(lng));
      if (place.formatted_address) sv(inputId, place.formatted_address);
      (place.address_components || []).forEach(function (c) {
        if (c.types.indexOf('locality') >= 0 && cityId) sv(cityId, c.long_name);
        if (c.types.indexOf('administrative_area_level_1') >= 0 && stateId) sv(stateId, c.long_name);
        if (c.types.indexOf('postal_code') >= 0 && pinId) sv(pinId, c.long_name);
      });
    });
  }

  function initGooglePlaces() {
    _placesReady = true;
    // Only p_address (profile form) is bound — the order form's delivery
    // address is captured via the Address Book (LocationPicker modal),
    // not a text input, so an o_address autocomplete binding here was
    // silently a no-op (no matching element in the DOM).
    bindPlaces('p_address', 'p_address_lat', 'p_address_lng', 'p_city', 'p_state', 'p_pincode');
  }

  function loadGooglePlacesScript() {
    if (!GOOGLE_MAPS_KEY_LOOKS_VALID || document.getElementById('gmapsPlacesScript')) return false;
    window.initGooglePlacesCallback = initGooglePlaces;
    // NOTE: safety net for a *real* key that later fails auth (wrong HTTP
    // referrer restriction, billing disabled, revoked, etc.) — Google calls
    // this automatically. Without it, a stuck Google error overlay could
    // block typing the same way the placeholder key did. This just removes
    // any leftover Google-injected containers so the plain inputs keep working.
    window.gm_authFailure = function () {
      document.querySelectorAll('.pac-container').forEach(function (n) { n.remove(); });
      _placesReady = false;
      _googleMapsAuthFailed = true;
      unbindBrokenPlaces();
      // Any live-route map already created with the broken key is showing
      // Google's "Sorry! Something went wrong" box — drop it so the next
      // render falls through to Mappls/Leaflet instead.
      _trackGMap = null;
      _deliveryGMap = null;
      loadMapplsScript(); // second choice, before falling all the way back to Leaflet
    };
    const s = document.createElement('script');
    s.id = 'gmapsPlacesScript';
    s.src = 'https://maps.googleapis.com/maps/api/js?key=' + encodeURIComponent(GOOGLE_MAPS_API_KEY) + '&libraries=places,geometry&callback=initGooglePlacesCallback';
    s.async = true;
    s.defer = true;
    // NOTE (map-stuck fix): if the script tag itself fails to load (network
    // block, ad-blocker, DNS) or the key is enabled-but-misconfigured in
    // Google Cloud Console (API not enabled / billing off / referrer
    // restriction mismatch), Google never calls initGooglePlacesCallback and
    // _placesReady stays false forever — that's fine, inputs just stay plain.
    // The real risk is if Autocomplete DID attach before failing later; this
    // watchdog guarantees the address field is always usable no matter what.
    s.onerror = function () { _placesReady = false; unbindBrokenPlaces(); loadMapplsScript(); };
    document.head.appendChild(s);
    // Belt-and-suspenders: every 5s for the first minute, wipe any leftover
    // Google error overlay so it can never sit on top of the address field.
    let _watchdogTicks = 0;
    const watchdog = setInterval(function () {
      document.querySelectorAll('.pac-container').forEach(function (n) {
        if (n.querySelector('.pac-item') == null && n.textContent.trim()) n.remove(); // stray error/empty overlay
      });
      if (++_watchdogTicks >= 12) clearInterval(watchdog);
    }, 5000);
    return true;
  }

  // ── Mappls (India-focused, free tier) Places — used only when Google
  // isn't configured or failed. Mappls' Web SDK doesn't auto-attach a
  // dropdown to a plain <input> the way Google's does, so we build a small
  // manual suggestion list under the field ourselves, debounced on typing.
  // NOTE: exact Mappls SDK method names can change between SDK versions —
  // this targets their documented `mappls.search()` plugin. If Mappls
  // changes their API, check console for errors and https://www.mappls.com/api/advanced-maps/doc
  function mapplsSuggestBox(input) {
    let box = input._mapplsSuggestBox;
    if (box) return box;
    box = document.createElement('div');
    box.className = 'mappls-suggest-box';
    box.style.cssText = 'position:absolute;z-index:500;background:#fff;border:1px solid #ddd;border-radius:8px;box-shadow:0 6px 20px rgba(0,0,0,.12);max-height:220px;overflow:auto;display:none';
    document.body.appendChild(box);
    input._mapplsSuggestBox = box;
    return box;
  }

  function positionSuggestBox(input, box) {
    const r = input.getBoundingClientRect();
    box.style.left = (r.left + window.scrollX) + 'px';
    box.style.top = (r.bottom + window.scrollY + 4) + 'px';
    box.style.width = r.width + 'px';
  }

  function bindMapplsPlaces(inputId, latId, lngId, cityId, stateId, pinId) {
    if (!_mapplsReady || !window.mappls) return;
    const input = document.getElementById(inputId);
    if (!input || input.dataset.placesBound) return;
    input.dataset.placesBound = '1';
    const box = mapplsSuggestBox(input);
    let debounceTimer;
    input.addEventListener('input', function () {
      clearTimeout(debounceTimer);
      const q = input.value.trim();
      if (q.length < 3) { box.style.display = 'none'; return; }
      debounceTimer = setTimeout(function () {
        try {
          mappls.search({ query: q, region: 'ind' }, function (data) {
            const results = (data && (data.suggestedLocations || data.results)) || [];
            if (!results.length) { box.style.display = 'none'; return; }
            box.innerHTML = results.slice(0, 6).map(function (r, i) {
              return '<div class="mappls-suggest-item" data-i="' + i + '" style="padding:9px 12px;cursor:pointer;font-size:13px;border-bottom:1px solid #f0f0f0">' + esc(r.placeName || r.formatted_address || r.placeAddress || '') + '</div>';
            }).join('');
            positionSuggestBox(input, box);
            box.style.display = '';
            box.querySelectorAll('.mappls-suggest-item').forEach(function (item) {
              item.addEventListener('mousedown', function (e) {
                e.preventDefault();
                const r = results[parseInt(item.dataset.i, 10)];
                if (!r) return;
                const full = r.placeName || r.formatted_address || r.placeAddress || q;
                sv(inputId, full);
                if (r.latitude != null) sv(latId, String(r.latitude));
                if (r.longitude != null) sv(lngId, String(r.longitude));
                if (r.city && cityId) sv(cityId, r.city);
                if (r.state && stateId) sv(stateId, r.state);
                if (r.pincode && pinId) sv(pinId, r.pincode);
                box.style.display = 'none';
              });
            });
          });
        } catch (e) {
          // Mappls call failed/signature mismatch — fail silent, field stays
          // a normal typable input with no suggestions, never blocks typing.
          box.style.display = 'none';
        }
      }, 300);
    });
    document.addEventListener('click', function (e) {
      if (e.target !== input) box.style.display = 'none';
    });
  }

  function initMapplsPlaces() {
    _mapplsReady = true;
    // See initGooglePlaces() above — o_address has no DOM element anymore.
    bindMapplsPlaces('p_address', 'p_address_lat', 'p_address_lng', 'p_city', 'p_state', 'p_pincode');
  }

  function loadMapplsScript() {
    if (!MAPPLS_KEY_LOOKS_VALID || document.getElementById('mapplsScript')) return false;
    window.initMapplsCallback = initMapplsPlaces;
    const s = document.createElement('script');
    s.id = 'mapplsScript';
    s.src = 'https://apis.mappls.com/advancedmaps/api/' + encodeURIComponent(MAPPLS_API_KEY) + '/map_sdk?layer=vector&v=3.0&callback=initMapplsCallback';
    s.async = true;
    s.defer = true;
    s.onerror = function () { _mapplsReady = false; _mapplsAuthFailed = true; };
    document.head.appendChild(s);
    return true;
  }

  // Safety net: if Places Autocomplete ever gets into a broken state, drop
  // back to a plain, always-typable field instead of leaving it stuck.
  function unbindBrokenPlaces() {
    ['p_address'].forEach(function (id) {
      const el = document.getElementById(id);
      if (!el) return;
      el.dataset.placesBound = ''; // allow re-bind later if Places recovers
      el.style.pointerEvents = 'auto';
      el.readOnly = false;
      el.disabled = false;
    });
  }

  function ensureGoogleMaps(cb) {
    loadMapKeys().then(function () {
      // The same <script> tag (loaded once, at portal init via
      // loadGooglePlacesScript) carries maps+places+geometry — Directions
      // routing and Places autocomplete share one API key/script load.
      if (window.google && window.google.maps && window.google.maps.DirectionsService) { cb(); return; }
      if (!GOOGLE_MAPS_KEY_LOOKS_VALID) { cb(null); return; } // no valid key configured — caller falls back gracefully
      let _gaveUp = false;
      const t = setInterval(function () {
        if (window.google && window.google.maps && window.google.maps.DirectionsService) {
          clearInterval(t);
          cb();
        }
      }, 150);
      // BUGFIX: previously this just cleared the interval after 15s and did
      // nothing else — if the Google Maps script never actually loads
      // (invalid/restricted key, quota exceeded, network/ad-blocker issue),
      // cb() was NEVER called, so the map silently stayed blank forever
      // with no fallback to Mappls/Leaflet. Now we explicitly signal
      // failure via cb(null) so callers correctly fall through to the
      // next map tier instead of hanging indefinitely.
      setTimeout(function () {
        if (_gaveUp) return;
        _gaveUp = true;
        clearInterval(t);
        if (!(window.google && window.google.maps && window.google.maps.DirectionsService)) {
          cb(null);
        }
      }, 8000);
    });
  }

  /* Direction-arrow marker (Zomato/Swiggy-style): a chevron that sits on
     the actual road route and rotates to match the direction of travel,
     computed from the last two GPS points via the geometry library. */
  function _headingBetween(from, to) {
    try {
      return google.maps.geometry.spherical.computeHeading(
        new google.maps.LatLng(from.lat, from.lng),
        new google.maps.LatLng(to.lat, to.lng)
      );
    } catch (e) { return 0; }
  }

  function _vehicleIcon(heading, color) {
    return {
      path: google.maps.SymbolPath.FORWARD_CLOSED_ARROW,
      scale: 10,
      rotation: heading || 0,
      fillColor: color || '#143026',
      fillOpacity: 1,
      strokeColor: '#fff',
      strokeWeight: 3,
    };
  }

  /* ── Leaflet-side equivalent of _headingBetween/_vehicleIcon above (Google
     Maps geometry lib isn't available on the free Leaflet fallback, which is
     the path this deployment actually runs on since no Maps key is
     configured). Plain great-circle bearing formula — same Zomato/Swiggy
     "icon points the way it's driving" behaviour, just without Google. ── */
  function _leafletHeadingBetween(from, to) {
    if (!from || !to) return 0;
    const toRad = Math.PI / 180, toDeg = 180 / Math.PI;
    const lat1 = from.lat * toRad, lat2 = to.lat * toRad;
    const dLon = (to.lng - from.lng) * toRad;
    const y = Math.sin(dLon) * Math.cos(lat2);
    const x = Math.cos(lat1) * Math.sin(lat2) - Math.sin(lat1) * Math.cos(lat2) * Math.cos(dLon);
    return (Math.atan2(y, x) * toDeg + 360) % 360;
  }

  // Car icon (top-down, nose pointing "up" = 0°/north in the source art) used
  // for the live delivery marker on the free Leaflet map. Rotated per-poll to
  // match the direction of travel, exactly like the Google Maps arrow.
  const CAR_TRACKING_ICON_URL = 'assets/car-tracking-icon.png';

  function _carIconHtml(heading) {
    return '<div class="car-tracking-icon-wrap" style="width:30px;height:30px;display:flex;align-items:center;justify-content:center;">' +
      '<img src="' + CAR_TRACKING_ICON_URL + '" alt="" style="width:24px;height:auto;transform:rotate(' + (heading || 0) + 'deg);transform-origin:center center;transition:transform .6s ease-out;filter:drop-shadow(0 2px 5px rgba(0,0,0,.5));display:block;">' +
      '</div>';
  }

  function _carDivIcon(heading) {
    return L.divIcon({
      className: 'car-tracking-icon',
      html: _carIconHtml(heading),
      iconSize: [30, 30],
      iconAnchor: [15, 15],
    });
  }

  /* Theme-aware map tiles — dark (CARTO dark_all) in dark mode, clean light
     (CARTO Voyager) otherwise. Swaps live when the theme toggles. Keeps a
     reference on the map object so we can remove the old layer on re-tile. */
  function _axTileUrl() {
    const dark = document.documentElement.getAttribute('data-theme') === 'dark';
    return dark
      ? 'https://{s}.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}{r}.png'
      : 'https://{s}.basemaps.cartocdn.com/rastertiles/voyager/{z}/{x}/{y}{r}.png';
  }
  function _axAddTiles(map) {
    if (!map) return;
    if (map._axTiles) { try { map.removeLayer(map._axTiles); } catch (e) {} }
    map._axTiles = L.tileLayer(_axTileUrl(), {
      subdomains: 'abcd', maxZoom: 20,
      attribution: '© OpenStreetMap © CARTO',
    }).addTo(map);
    if (map._axTiles.setZIndex) map._axTiles.setZIndex(0);
  }
  // Re-tile both live maps when the user flips the theme.
  window.axRetileMaps = function () {
    if (_trackMap) _axAddTiles(_trackMap);
    if (_deliveryMap) _axAddTiles(_deliveryMap);
  };

  // Fullscreen nav controls (Leaflet-aware) — zoom + recenter on the driver.
  window.axMapZoom = function (which, delta) {
    const m = which === 'delivery' ? _deliveryMap : _trackMap;
    if (m && m.setZoom) { try { m.setZoom(m.getZoom() + delta); } catch (e) {} }
  };
  window.axMapRecenter = function (which) {
    const m = which === 'delivery' ? _deliveryMap : _trackMap;
    const pos = which === 'delivery'
      ? _lastDeliveryDriverPos
      : (window._axLastTrackData && window._axLastTrackData.driver_location);
    if (m && pos && pos.lat != null) {
      try { m.setView([pos.lat, pos.lng], Math.max(m.getZoom(), 15)); } catch (e) {}
    }
  };

  // Destination marker with a soft pulsing ring (live-tracking feel). Shared
  // by both the buyer Track map and the delivery-partner map.
  function _destDivIcon() {
    return L.divIcon({
      className: 'dest-icon',
      html: '<div class="ax-dest-mark"><span class="ax-dest-pulse"></span>' +
            '<i class="fa-solid fa-location-dot"></i></div>',
      iconSize: [34, 34],
      iconAnchor: [17, 30],
    });
  }

  /* Draws the actual road route (turn-by-turn, not a straight line) between
     the delivery partner's current position and the destination, using the
     Directions API — this is what makes the map feel like Zomato/Swiggy
     instead of a ruler-line between two dots. */
  function _renderRoadRoute(map, rendererRef, origin, destination, color, cb) {
    if (!origin || !destination) { if (cb) cb(null); return; }
    if (!rendererRef.svc) rendererRef.svc = new google.maps.DirectionsService();
    if (!rendererRef.renderer) {
      rendererRef.renderer = new google.maps.DirectionsRenderer({
        suppressMarkers: true,
        preserveViewport: true,
        polylineOptions: { strokeColor: color || '#2E6B41', strokeWeight: 6, strokeOpacity: 0.95 },
      });
    }
    rendererRef.renderer.setMap(map);
    rendererRef.svc.route({
      origin: origin,
      destination: destination,
      travelMode: google.maps.TravelMode.DRIVING,
      provideRouteAlternatives: false,
      optimizeWaypoints: true,
    }, function (result, status) {
      if (status === 'OK' && result) {
        rendererRef.renderer.setDirections(result);
        const leg = result.routes[0] && result.routes[0].legs[0];
        if (cb) cb(leg ? { distance: leg.distance, duration: leg.duration } : null);
      } else {
        if (cb) cb(null);
      }
    });
  }

  /* A delivery is a two-stop journey, not a direct rider→importer line.
     Before pickup, keep the shop as a mandatory waypoint; after pickup the
     route naturally becomes rider→importer. */
  function _renderDeliverySequence(map, rendererRef, origin, pickup, destination, color, cb) {
    if (!origin || !destination) { if (cb) cb(null); return; }
    if (!pickup) return _renderRoadRoute(map, rendererRef, origin, destination, color, cb);
    if (!rendererRef.svc) rendererRef.svc = new google.maps.DirectionsService();
    if (!rendererRef.renderer) rendererRef.renderer = new google.maps.DirectionsRenderer({
      suppressMarkers: true, preserveViewport: true,
      polylineOptions: { strokeColor: color || '#2563EB', strokeWeight: 6, strokeOpacity: 0.95 },
    });
    rendererRef.renderer.setMap(map);
    rendererRef.svc.route({
      origin: origin, destination: destination,
      waypoints: [{ location: pickup, stopover: true }],
      optimizeWaypoints: false, travelMode: google.maps.TravelMode.DRIVING,
      provideRouteAlternatives: false,
    }, function (result, status) {
      if (status === 'OK' && result) {
        rendererRef.renderer.setDirections(result);
        if (cb) cb(result);
      } else if (cb) cb(null);
    });
  }

  function ensureLeaflet(cb) {
    if (window.L) { cb(); return; }
    if (!document.getElementById('leafletCss')) {
      const lcss = document.createElement('link');
      lcss.id = 'leafletCss';
      lcss.rel = 'stylesheet';
      lcss.href = 'https://unpkg.com/leaflet@1.9.4/dist/leaflet.css';
      document.head.appendChild(lcss);
    }
    if (document.getElementById('leafletJs')) {
      const t = setInterval(function () { if (window.L) { clearInterval(t); cb(); } }, 100);
      return;
    }
    const js = document.createElement('script');
    js.id = 'leafletJs';
    js.src = 'https://unpkg.com/leaflet@1.9.4/dist/leaflet.js';
    js.onload = function() {
      // Load Leaflet Routing Machine CSS
      if (!document.getElementById('leafletRoutingCss')) {
        const rcss = document.createElement('link');
        rcss.id = 'leafletRoutingCss';
        rcss.rel = 'stylesheet';
        rcss.href = 'https://unpkg.com/leaflet-routing-machine@3.2.12/dist/leaflet-routing-machine.css';
        document.head.appendChild(rcss);
      }
      // Load Leaflet Routing Machine JS
      if (!document.getElementById('leafletRoutingJs')) {
        const rjs = document.createElement('script');
        rjs.id = 'leafletRoutingJs';
        rjs.src = 'https://unpkg.com/leaflet-routing-machine@3.2.12/dist/leaflet-routing-machine.js';
        rjs.onload = cb;
        document.head.appendChild(rjs);
      } else {
        cb();
      }
    };
    document.head.appendChild(js);
  }

  function timeAgoLabel(seconds) {
    if (seconds == null) return '';
    if (seconds < 60) return 'updated just now';
    if (seconds < 3600) return 'updated ' + Math.floor(seconds / 60) + ' min ago';
    return 'updated ' + Math.floor(seconds / 3600) + ' hr ago';
  }

  // Avatar for the journey/track strips: real photo when we have one, else a
  // Gmail-style colored initial circle. Colour is derived from the name so it
  // stays stable per person. Used by the Delivery strip + Track contacts.
  const _AX_AVA_COLORS = ['#2E6B41', '#2A7F7E', '#C7993A', '#8A5A2E', '#3E5F8A', '#7A3E8A'];
  window.axStripAvatarHtml = function (photo, name) {
    if (photo) {
      return '<img src="' + esc(photo) + '" alt="" class="ax-ava-img" ' +
             'onerror="this.replaceWith(Object.assign(document.createElement(\'span\'),{className:\'ax-ava-fallback\',textContent:this.getAttribute(\'data-i\')||\'?\'}))" ' +
             'data-i="' + esc((name || '?').trim().charAt(0).toUpperCase() || '?') + '">';
    }
    const initial = esc((name || '?').trim().charAt(0).toUpperCase() || '?');
    let h = 0; const s = String(name || '');
    for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) >>> 0;
    const col = _AX_AVA_COLORS[h % _AX_AVA_COLORS.length];
    return '<span class="ax-ava-fallback" style="background:' + col + '">' + initial + '</span>';
  };

  function renderLiveTrackCard(cardId, data, opts) {
    opts = opts || {};
    const card = document.getElementById(cardId);
    if (!card) return;
    const dist = data.distance_remaining_km;
    const eta = data.eta_minutes;
    const hasStats = (dist != null) || (eta != null);
    let personHtml = '';
    if (opts.person && opts.person.name) {
      const initial = esc((opts.person.name || 'D').trim().charAt(0).toUpperCase() || 'D');
      const callHtml = opts.person.phone
        ? '<a class="ltc-call" href="tel:' + esc(opts.person.phone) + '"><i class="fa-solid fa-phone"></i> Call</a>'
        : '';
      personHtml =
        '<div class="ltc-avatar">' + initial + '</div>' +
        '<div class="ltc-main"><div class="ltc-name">' + esc(opts.person.name) + '</div>' +
        '<div class="ltc-sub">' + esc(opts.personLabel || '') + '</div></div>' +
        callHtml;
    } else if (opts.personLabel) {
      personHtml = '<div class="ltc-main"><div class="ltc-sub">' + esc(opts.personLabel) + '</div></div>';
    }
    const statsHtml = hasStats
      ? '<div class="ltc-stats">' +
          (dist != null ? '<div class="ltc-stat"><strong>' + dist + ' km</strong><span>Away</span></div>' : '') +
          (eta != null && eta > 0 ? '<div class="ltc-stat"><strong>' + eta + ' min</strong><span>ETA</span></div>' : '') +
        '</div>'
      : '';
    const freshSeconds = data.driver_location ? data.driver_location.updated_seconds_ago : null;
    const freshHtml = freshSeconds != null ? '<div class="ltc-fresh"><i class="fa-solid fa-satellite-dish"></i> ' + timeAgoLabel(freshSeconds) + '</div>' : '';
    if (!personHtml && !statsHtml) { card.style.display = 'none'; return; }
    card.innerHTML = personHtml + statsHtml + freshHtml;
    card.style.display = 'flex';
  }

  function renderTrackMap(data) {
    const el = document.getElementById('trackMapCanvas');
    const wrap = document.getElementById('trackMapWrap');
    const result = document.getElementById('trackResult');
    if (!el || !wrap) return;
    // Feed the Track-tab strip + distance-triangle overlay (portal-delivery.js)
    // with every fresh /track payload — poll or manual lookup alike.
    window._axLastTrackData = data;
    if (typeof window.axRenderTrackStrip === 'function') {
      try { window.axRenderTrackStrip(data); } catch (e) { console.warn('[TrackStrip]', e); }
    }
    
    // Show the result container
    if (result) result.style.display = 'block';
    
    // Show the map wrap
    wrap.style.display = 'block';
    
    // Hide loading state when map renders
    const loading = document.getElementById('trackMapLoading');
    if (loading) loading.style.display = 'none';
    
    // Show status indicators when map renders
    const statusBadge = document.getElementById('trackDeliveryStatusBadge');
    const distanceBadge = document.getElementById('trackDistanceBadge');
    const statusText = document.getElementById('trackDeliveryStatusText');
    const distanceText = document.getElementById('trackDistanceText');
    
    // Update new track info card
    const trackInfoCard = document.getElementById('trackInfoCard');
    if (trackInfoCard) {
      trackInfoCard.style.display = 'block';
      
      // Driver info
      const driverName = document.getElementById('trackDriverName');
      const driverPhone = document.getElementById('trackDriverPhone');
      if (driverName) driverName.textContent = data.delivery_partner || 'Driver';
      if (driverPhone) driverPhone.textContent = data.driver_phone || 'Contact';
      
      // Stats
      const trackDistance = document.getElementById('trackDistance');
      const trackETA = document.getElementById('trackETA');
      const trackStatus = document.getElementById('trackStatus');
      
      if (trackDistance) trackDistance.textContent = data.distance_remaining_km ? data.distance_remaining_km.toFixed(1) + ' km' : '-- km';
      if (trackETA) trackETA.textContent = data.time_remaining_min ? data.time_remaining_min + ' min' : '-- min';
      if (trackStatus) trackStatus.textContent = data.status || 'In Transit';
    }
    
    // Hide old badges
    if (statusBadge) statusBadge.style.display = 'none';
    if (distanceBadge) distanceBadge.style.display = 'none';
    
    if (statusText) statusText.textContent = data.status || 'In Transit';
    if (distanceText) distanceText.textContent = data.distance_remaining_km ? data.distance_remaining_km.toFixed(1) + ' km' : '-- km';
    
    renderLiveTrackCard('trackLiveCard', data, {
      person: data.delivery_partner,
      personLabel: data.delivery_partner ? 'Your delivery partner' : ''
    });
    const dest = data.destination || {};
    const pickup = data.pickup || {};
    const driver = data.driver_location;

    ensureGoogleMaps(function (failed) {
      if (failed !== null && GOOGLE_MAPS_API_KEY && !_googleMapsAuthFailed) {
        // ── Google Maps path: real road route + rotating direction arrow,
        //    Zomato/Swiggy-style. ──
        if (!_trackGMap) {
          _trackGMap = new google.maps.Map(el, {
            center: { lat: 20.5937, lng: 78.9629 }, zoom: 5,
            disableDefaultUI: true, zoomControl: true, scrollwheel: false,
          });
        }
        if (dest.lat && dest.lng) {
          if (_trackDestGMarker) _trackDestGMarker.setMap(null);
          _trackDestGMarker = new google.maps.Marker({
            position: { lat: dest.lat, lng: dest.lng }, map: _trackGMap,
            title: 'Destination · ' + (dest.city || ''),
            icon: { path: google.maps.SymbolPath.CIRCLE, scale: 8, fillColor: '#C7993A', fillOpacity: 1, strokeColor: '#fff', strokeWeight: 2 },
          });
        }
        // Always show the shop stop. It makes the required sequence explicit
        // for both the rider and the importer watching the same live map.
        if (pickup.lat && pickup.lng) {
          if (_trackPickupGMarker) _trackPickupGMarker.setMap(null);
          _trackPickupGMarker = new google.maps.Marker({
            position: { lat: pickup.lat, lng: pickup.lng }, map: _trackGMap,
            title: 'Pickup · ' + (pickup.city || 'Shop'),
            icon: { path: google.maps.SymbolPath.CIRCLE, scale: 10, fillColor: '#C7993A', fillOpacity: 1, strokeColor: '#fff', strokeWeight: 3 },
            label: { text: 'Shop', color: '#74520D', fontSize: '11px', fontWeight: 'bold' },
          });
        }
        if (driver && driver.lat) {
          const heading = _lastTrackDriverPos ? _headingBetween(_lastTrackDriverPos, driver) : 0;
          _lastTrackDriverPos = { lat: driver.lat, lng: driver.lng };
          if (_trackVehicleMarker) _trackVehicleMarker.setMap(null);
          _trackVehicleMarker = new google.maps.Marker({
            position: { lat: driver.lat, lng: driver.lng }, map: _trackGMap,
            title: 'Delivery partner · ' + (data.status || ''),
            icon: _vehicleIcon(heading, '#143026'),
            zIndex: 999,
          });
          if (dest.lat && dest.lng) {
            const beforePickup = !data.picked_up_at && ['IN_TRANSIT', 'NEAR_DESTINATION', 'COMPLETED'].indexOf(data.status) === -1;
            const nextStop = beforePickup && pickup.lat && pickup.lng ? { lat: pickup.lat, lng: pickup.lng } : null;
            _renderDeliverySequence(_trackGMap, _trackDirRef, { lat: driver.lat, lng: driver.lng }, nextStop, { lat: dest.lat, lng: dest.lng }, '#2E6B41', function (route) {
              const leg = route && route.routes && route.routes[0] && route.routes[0].legs
                ? route.routes[0].legs.reduce(function (sum, item) {
                    sum.meters += (item.distance && item.distance.value) || 0;
                    sum.seconds += (item.duration && item.duration.value) || 0;
                    return sum;
                  }, { meters: 0, seconds: 0 }) : null;
              if (leg && leg.meters) {
                const card = document.getElementById('trackLiveCard');
                const statsEl = card && card.querySelector('.ltc-stats');
                if (statsEl) {
                  statsEl.innerHTML =
                    '<div class="ltc-stat"><strong>' + (leg.meters / 1000).toFixed(1) + ' km</strong><span>Road distance</span></div>' +
                    '<div class="ltc-stat"><strong>' + Math.max(1, Math.round(leg.seconds / 60)) + ' min</strong><span>ETA (live traffic)</span></div>';
                }
              }
              const bounds = new google.maps.LatLngBounds();
              bounds.extend({ lat: driver.lat, lng: driver.lng });
              if (nextStop) bounds.extend(nextStop);
              bounds.extend({ lat: dest.lat, lng: dest.lng });
              _trackGMap.fitBounds(bounds, 60);
            });
          } else {
            _trackGMap.setCenter({ lat: driver.lat, lng: driver.lng });
            _trackGMap.setZoom(13);
          }
        } else if (dest.lat && dest.lng) {
          _trackGMap.setCenter({ lat: dest.lat, lng: dest.lng });
          _trackGMap.setZoom(12);
        }
        return;
      }

      // ── Mappls tier: used when Google isn't configured/paid but a Mappls
      //    key is set. Falls through to Leaflet below if Mappls also isn't
      //    ready. NOTE: Direction-plugin call signature is best-effort per
      //    Mappls' documented pattern — wrapped in try/catch so even a
      //    version mismatch just draws a straight connecting line instead
      //    of breaking the map. ──
      if (_mapplsReady && window.mappls && !_mapplsAuthFailed) {
        try {
          if (!_trackMapplsMap) {
            _trackMapplsMap = new mappls.Map(el, { center: [20.5937, 78.9629], zoom: 5 });
          }
          if (_trackMapplsDestMarker) { try { _trackMapplsDestMarker.remove(); } catch (e) {} }
          if (dest.lat && dest.lng) {
            _trackMapplsDestMarker = new mappls.Marker({ map: _trackMapplsMap, position: { lat: dest.lat, lng: dest.lng }, popupHtml: 'Destination · ' + (dest.city || '') });
          }
          if (driver && driver.lat) {
            if (_trackMapplsMarker) { try { _trackMapplsMarker.remove(); } catch (e) {} }
            _trackMapplsMarker = new mappls.Marker({ map: _trackMapplsMap, position: { lat: driver.lat, lng: driver.lng }, popupHtml: 'Delivery partner · ' + (data.status || '') });
            if (dest.lat && dest.lng) {
              try {
                mappls.direction({
                  map: _trackMapplsMap,
                  start: driver.lng + ',' + driver.lat,
                  end: dest.lng + ',' + dest.lat,
                  resource: 'route_eta',
                }, function (routeData) {
                  const leg = routeData && routeData.routes && routeData.routes[0];
                  if (leg) {
                    const card = document.getElementById('trackLiveCard');
                    const statsEl = card && card.querySelector('.ltc-stats');
                    if (statsEl && leg.distance != null && leg.duration != null) {
                      statsEl.innerHTML =
                        '<div class="ltc-stat"><strong>' + (leg.distance / 1000).toFixed(1) + ' km</strong><span>Road distance</span></div>' +
                        '<div class="ltc-stat"><strong>' + Math.round(leg.duration / 60) + ' min</strong><span>ETA</span></div>';
                    }
                  }
                });
              } catch (e) {
                new mappls.Polyline({ map: _trackMapplsMap, path: [{ lat: driver.lat, lng: driver.lng }, { lat: dest.lat, lng: dest.lng }], strokeColor: '#2E6B41', strokeWeight: 4 });
              }
            }
          }
          return;
        } catch (e) {
          // Mappls map init itself failed — fall through to Leaflet below.
          _mapplsAuthFailed = true;
        }
      }

      // ── Fallback: no Google Maps key configured yet — Leaflet with Routing Machine
      //    for actual road routing (Zomato-style). ──
      ensureLeaflet(function () {
        console.log('[DEBUG] Leaflet loaded, initializing map...');
        if (!_trackMap) {
          _trackMap = L.map(el, { scrollWheelZoom: false, zoomControl: false }).setView([20.5937, 78.9629], 5);
          _axAddTiles(_trackMap);
          console.log('[DEBUG] Leaflet map initialized');
        }
        _trackMap.eachLayer(function (layer) {
          if (layer instanceof L.Polyline || layer instanceof L.CircleMarker || layer instanceof L.Marker) _trackMap.removeLayer(layer);
        });
        
        // Remove existing routing control if any
        if (_trackRoutingControl) {
          _trackMap.removeControl(_trackRoutingControl);
          _trackRoutingControl = null;
        }
        
        console.log('[DEBUG] Driver data:', driver);
        console.log('[DEBUG] Destination data:', dest);
        
        // Add destination marker with normal location icon only
        if (dest.lat && dest.lng) {
          console.log('[DEBUG] Adding destination marker at:', dest.lat, dest.lng);
          L.marker([dest.lat, dest.lng], { icon: _destDivIcon() }).addTo(_trackMap).bindPopup('Destination · ' + (data.buyer_name || dest.address || dest.city || 'Importer'));
        } else {
          console.log('[DEBUG] No destination data available');
        }
        
        // Rotating car icon for the delivery partner — heading is computed
        // from the last two GPS fixes so the car's nose turns to face the
        // road it's actually driving on (Zomato/Swiggy style), not just a
        // static pin.
        if (driver && driver.lat) {
          const heading = _lastTrackDriverPos ? _leafletHeadingBetween(_lastTrackDriverPos, driver) : 0;
          _lastTrackDriverPos = { lat: driver.lat, lng: driver.lng };
          _trackTruckMarker = L.marker([driver.lat, driver.lng], { icon: _carDivIcon(heading) }).addTo(_trackMap).bindPopup('Delivery partner · ' + (data.status || ''));
        } else {
          console.log('[DEBUG] No driver data available');
        }
        
        // Use Leaflet Routing Machine for road routing
        if (driver && driver.lat && dest && dest.lng) {
          console.log('[DEBUG] Attempting to add route between driver and destination');
          if (window.L.Routing) {
            console.log('[DEBUG] Leaflet Routing Machine available');
            _trackRoutingControl = L.Routing.control({
              waypoints: [
                L.latLng(driver.lat, driver.lng),
                L.latLng(dest.lat, dest.lng)
              ],
              routeWhileDragging: false,
              showAlternatives: false,
              addWaypoints: false,
              draggableWaypoints: false,
              fitSelectedRoutes: true,
              lineOptions: {
                styles: [
                  { color: '#2563EB', weight: 6, opacity: 0.95 }
                ]
              },
              createMarker: function() { return null; }, // Don't create default markers
              router: L.Routing.osrmv1({
                serviceUrl: 'https://router.project-osrm.org/route/v1'
              })
            }).addTo(_trackMap);
            
            // Hide routing instructions
            const container = _trackRoutingControl.getContainer();
            if (container) {
              container.style.display = 'none';
            }
            console.log('[DEBUG] Route added successfully');
          } else {
            console.log('[DEBUG] Leaflet Routing Machine not available, using straight line');
            // Fallback to straight line if routing not available
            L.polyline([[driver.lat, driver.lng], [dest.lat, dest.lng]], { color: '#2563EB', weight: 6, opacity: 0.95 }).addTo(_trackMap);
          }
          
          // Fit bounds to show both points
          _trackMap.fitBounds([
            [driver.lat, driver.lng],
            [dest.lat, dest.lng]
          ], { padding: [50, 50] });
        } else {
          console.log('[DEBUG] Cannot add route - missing driver or destination data');
        }
        
        setTimeout(function () { _trackMap.invalidateSize(); }, 200);
      });
    });

    // Client-side "nearby" heads-up while the buyer is actively looking at
    // the page — in addition to the server-side notification, which still
    // fires even if this tab isn't open.
    if (data.distance_remaining_km != null && data.distance_remaining_km <= 1 && data.arn && !_closeAlerted[data.arn]) {
      _closeAlerted[data.arn] = true;
      if (typeof showToast === 'function') showToast('Delivery partner is about 1 km away!', 'success');
    }
  }

  function fetchTrack(arn) {
    // BUGFIX (frozen live-location): this polls the SAME url every 12s
    // (LIVE_POLL_MS). With no cache option and no cache-busting param, the
    // browser (and on mobile, often the carrier's transparent proxy too)
    // was treating repeat GETs to an identical URL as cacheable and
    // silently replaying the very first response — so the map looked
    // "stuck" at the initial driver position even while they were actually
    // driving and the server had fresh coordinates. `cache: 'no-store'`
    // stops the browser from doing this; the `_t=` timestamp is a second,
    // stronger guard because it makes every request's URL unique, which
    // also defeats caches that ignore Cache-Control headers entirely.
    return fetch(LAMBDA_URL + '/track?arn=' + encodeURIComponent(arn) + '&_t=' + Date.now(), {
      headers: { Authorization: 'Bearer ' + (localStorage.getItem('ax_google_token') || ''), Accept: 'application/json' },
      cache: 'no-store',
    }).then(function (r) { return r.json(); });
  }

  function renderDeliveryActiveMapData(arn, data) {
    const box = document.getElementById('deliveryMapCanvas');
    if (!box) return;
    data.arn = data.arn || arn;
    // Same feed for the Delivery-tab journey strip / triangle overlay.
    window._axLastTrackData = data;
    if (typeof window.axOnDeliveryTrackData === 'function') {
      try { window.axOnDeliveryTrackData(data); } catch (e) { console.warn('[JourneyStrip]', e); }
    }
    
    // Hide loading state when map renders
    const loading = document.getElementById('deliveryMapLoading');
    if (loading) loading.style.display = 'none';
    
    // Update new delivery info card
    const deliveryInfoCard = document.getElementById('deliveryInfoCard');
    if (deliveryInfoCard) {
      deliveryInfoCard.style.display = 'block';
      
      // Importer info
      const importerName = document.getElementById('deliveryImporterName');
      const importerAddress = document.getElementById('deliveryImporterAddress');
      if (importerName) importerName.textContent = data.buyer_name || 'Importer';
      if (importerAddress) importerAddress.textContent = data.destination?.address || data.destination?.city || 'Address';

      // Real importer DP in the avatar (falls back to a Gmail-style initial
      // circle when no photo is set) — replaces the generic user icon.
      // (Call + message buttons are wired by axOnDeliveryTrackData, invoked
      // near the top of this function.)
      const importerAvatar = document.getElementById('deliveryImporterAvatar');
      if (importerAvatar) importerAvatar.innerHTML = window.axStripAvatarHtml(data.buyer_avatar, data.buyer_name);

      // Stats — API field is eta_minutes (not time_remaining_min); earnings
      // now comes straight from the track payload (delivery_charge).
      const deliveryDistance = document.getElementById('deliveryDistance');
      const deliveryETA = document.getElementById('deliveryETA');
      const deliveryEarnings = document.getElementById('deliveryEarnings');

      // "Arrived" state — once the driver is essentially at the door, the
      // "0.0 km away / 0 min ETA" reads badly; show a clear Arrived/Doorstep.
      const _km = data.distance_remaining_km;
      const _arrived = (_km != null && _km <= 0.12) ||
        ['NEAR_DESTINATION', 'ARRIVED'].indexOf(data.status) !== -1;
      deliveryInfoCard.classList.toggle('ax-arrived', _arrived);
      if (deliveryDistance) deliveryDistance.textContent = _arrived ? 'Arrived' : ((_km != null) ? _km.toFixed(1) + ' km' : '-- km');
      if (deliveryETA) deliveryETA.textContent = _arrived ? 'Doorstep' : ((data.eta_minutes != null && data.eta_minutes > 0) ? data.eta_minutes + ' min' : '-- min');
      // Earning: prefer the live track value; fall back to the amount stashed at
      // claim / restore so the chip shows a real number instead of ₹-- even
      // before the first poll lands (or if the record's charge is still 0).
      const _earn = (data.earnings != null && data.earnings > 0) ? data.earnings : (window._axActiveEarning || 0);
      if (_earn > 0) window._axActiveEarning = _earn;
      if (deliveryEarnings) deliveryEarnings.textContent = _earn > 0 ? '₹' + _earn : '₹--';
    }
    
    // Hide old badges
    const gpsBadge = document.getElementById('gpsSignalBadge');
    const connectionBadge = document.getElementById('connectionBadge');
    const speedBadge = document.getElementById('speedBadge');
    
    if (gpsBadge) gpsBadge.style.display = 'none';
    if (connectionBadge) connectionBadge.style.display = 'none';
    if (speedBadge) speedBadge.style.display = 'none';
    
    // Clean map: the floating white "Delivering to / km / ETA" card is gone —
    // that identity + distance now lives ONLY in the top journey strip
    // (single source of truth), so the map stays completely unobstructed.
    const _liveCard = document.getElementById('deliveryLiveCard');
    if (_liveCard) _liveCard.style.display = 'none';
    const dest = data.destination || {};
    const pickup = data.pickup || {};
    const driver = data.driver_location;

    ensureGoogleMaps(function (failed) {
      if (failed !== null && GOOGLE_MAPS_API_KEY && !_googleMapsAuthFailed) {
        if (!_deliveryGMap) {
          _deliveryGMap = new google.maps.Map(box, {
            center: { lat: 20.5937, lng: 78.9629 }, zoom: 11,
            disableDefaultUI: true, zoomControl: true, scrollwheel: false,
          });
        }
        if (dest.lat && dest.lng) {
          if (_deliveryDestGMarker) _deliveryDestGMarker.setMap(null);
          _deliveryDestGMarker = new google.maps.Marker({
            position: { lat: dest.lat, lng: dest.lng }, map: _deliveryGMap,
            title: 'Destination · ' + (data.buyer_name || dest.city || 'Importer'),
            icon: { path: google.maps.SymbolPath.CIRCLE, scale: 12, fillColor: '#D93644', fillOpacity: 1, strokeColor: '#fff', strokeWeight: 3 },
            label: {
              text: data.buyer_name || 'Importer',
              color: '#D93644',
              fontSize: '12px',
              fontWeight: 'bold',
              className: 'destination-label'
            }
          });
        }
        if (pickup.lat && pickup.lng) {
          if (_deliveryPickupGMarker) _deliveryPickupGMarker.setMap(null);
          _deliveryPickupGMarker = new google.maps.Marker({
            position: { lat: pickup.lat, lng: pickup.lng }, map: _deliveryGMap,
            title: 'Pickup · ' + (pickup.city || 'Shop'),
            icon: { path: google.maps.SymbolPath.CIRCLE, scale: 10, fillColor: '#C7993A', fillOpacity: 1, strokeColor: '#fff', strokeWeight: 3 },
            label: { text: 'Shop', color: '#74520D', fontSize: '11px', fontWeight: 'bold' },
          });
        }
        if (driver && driver.lat) {
          const heading = _lastDeliveryDriverPos ? _headingBetween(_lastDeliveryDriverPos, driver) : 0;
          _lastDeliveryDriverPos = { lat: driver.lat, lng: driver.lng };
          if (_deliveryVehicleMarker) _deliveryVehicleMarker.setMap(null);
          _deliveryVehicleMarker = new google.maps.Marker({
            position: { lat: driver.lat, lng: driver.lng }, map: _deliveryGMap,
            title: 'You are here', icon: _vehicleIcon(heading, '#143026'), zIndex: 999,
          });
          if (dest.lat && dest.lng) {
            const beforePickup = !data.picked_up_at && ['IN_TRANSIT', 'NEAR_DESTINATION', 'COMPLETED'].indexOf(data.status) === -1;
            const nextStop = beforePickup && pickup.lat && pickup.lng ? { lat: pickup.lat, lng: pickup.lng } : null;
            _renderDeliverySequence(_deliveryGMap, _deliveryDirRef, { lat: driver.lat, lng: driver.lng }, nextStop, { lat: dest.lat, lng: dest.lng }, '#2563EB', function (route) {
              const bounds = new google.maps.LatLngBounds();
              bounds.extend({ lat: driver.lat, lng: driver.lng });
              if (nextStop) bounds.extend(nextStop);
              bounds.extend({ lat: dest.lat, lng: dest.lng });
              _deliveryGMap.fitBounds(bounds, 50);
              
              // Update distance and time information
              if (route && route.routes && route.routes[0] && route.routes[0].legs) {
                const leg = route.routes[0].legs[0];
                const distance = leg.distance ? leg.distance.text : '-- km';
                const duration = leg.duration ? leg.duration.text : '-- min';
                updateDeliveryRouteInfo(distance, duration);
              }
            });
          }
        } else if (dest.lat && dest.lng) {
          _deliveryGMap.setCenter({ lat: dest.lat, lng: dest.lng });
        }
        return;
      }

      // ── Mappls tier: see renderTrackMap above for notes on the
      //    try/catch safety around the Direction plugin call. ──
      if (_mapplsReady && window.mappls && !_mapplsAuthFailed) {
        try {
          if (!_deliveryMapplsMap) {
            _deliveryMapplsMap = new mappls.Map(box, { center: [20.5937, 78.9629], zoom: 11 });
          }
          if (_deliveryMapplsDestMarker) { try { _deliveryMapplsDestMarker.remove(); } catch (e) {} }
          if (dest.lat && dest.lng) {
            _deliveryMapplsDestMarker = new mappls.Marker({ map: _deliveryMapplsMap, position: { lat: dest.lat, lng: dest.lng }, popupHtml: 'Buyer · ' + (data.buyer_name || dest.city || 'Destination') });
          }
          if (driver && driver.lat) {
            if (_deliveryMapplsMarker) { try { _deliveryMapplsMarker.remove(); } catch (e) {} }
            _deliveryMapplsMarker = new mappls.Marker({ map: _deliveryMapplsMap, position: { lat: driver.lat, lng: driver.lng }, popupHtml: 'You are here' });
            if (dest.lat && dest.lng) {
              try {
                mappls.direction({
                  map: _deliveryMapplsMap,
                  start: driver.lng + ',' + driver.lat,
                  end: dest.lng + ',' + dest.lat,
                  resource: 'route_eta',
                }, function () {});
              } catch (e) {
                new mappls.Polyline({ map: _deliveryMapplsMap, path: [{ lat: driver.lat, lng: driver.lng }, { lat: dest.lat, lng: dest.lng }], strokeColor: '#2563EB', strokeWeight: 4 });
              }
            }
          }
          return;
        } catch (e) {
          _mapplsAuthFailed = true;
        }
      }

      // ── Fallback: Leaflet with Routing Machine for actual road routing (Zomato-style). ──
      ensureLeaflet(function () {
        if (!_deliveryMap) {
          _deliveryMap = L.map(box, { scrollWheelZoom: false, zoomControl: false }).setView([20.5937, 78.9629], 11);
          _axAddTiles(_deliveryMap);
        }
        _deliveryMap.eachLayer(function (layer) {
          if (layer instanceof L.Polyline || layer instanceof L.Marker) _deliveryMap.removeLayer(layer);
        });
        
        // Remove existing routing control if any
        if (_deliveryRoutingControl) {
          _deliveryMap.removeControl(_deliveryRoutingControl);
          _deliveryRoutingControl = null;
        }
        
        // Add destination marker with normal location icon only
        if (dest.lat && dest.lng) {
          L.marker([dest.lat, dest.lng], { icon: _destDivIcon() }).addTo(_deliveryMap).bindPopup('Destination · ' + esc(data.buyer_name || dest.address || dest.city || 'Importer'));
        }
        
        // Rotating car icon — same heading logic as the buyer-facing map,
        // tracked against this device's own last known fix.
        if (driver && driver.lat) {
          const heading = _lastDeliveryDriverPos ? _leafletHeadingBetween(_lastDeliveryDriverPos, driver) : 0;
          _lastDeliveryDriverPos = { lat: driver.lat, lng: driver.lng };
          _deliveryTruckMarker = L.marker([driver.lat, driver.lng], { icon: _carDivIcon(heading) }).addTo(_deliveryMap).bindPopup('You are here');
        }
        
        // Use Leaflet Routing Machine for road routing
        if (driver && driver.lat && dest && dest.lng) {
          if (window.L.Routing) {
            _deliveryRoutingControl = L.Routing.control({
              waypoints: [
                L.latLng(driver.lat, driver.lng),
                L.latLng(dest.lat, dest.lng)
              ],
              routeWhileDragging: false,
              showAlternatives: false,
              addWaypoints: false,
              draggableWaypoints: false,
              fitSelectedRoutes: true,
              lineOptions: {
                styles: [
                  { color: '#2563EB', weight: 6, opacity: 0.95 }
                ]
              },
              createMarker: function() { return null; }, // Don't create default markers
              router: L.Routing.osrmv1({
                serviceUrl: 'https://router.project-osrm.org/route/v1'
              })
            }).addTo(_deliveryMap);
            
            // Hide routing instructions
            const container = _deliveryRoutingControl.getContainer();
            if (container) {
              container.style.display = 'none';
            }
          } else {
            // Fallback to straight line if routing not available
            L.polyline([[driver.lat, driver.lng], [dest.lat, dest.lng]], { color: '#2563EB', weight: 6, opacity: 0.95 }).addTo(_deliveryMap);
          }
          
          // Fit bounds to show both points
          _deliveryMap.fitBounds([
            [driver.lat, driver.lng],
            [dest.lat, dest.lng]
          ], { padding: [50, 50] });
        }
        
        setTimeout(function () { _deliveryMap.invalidateSize(); }, 150);
      });
    });
  }

  function renderDeliveryActiveMap(arn) {
    if (!arn) return;
    fetchTrack(arn).then(function (data) {
      renderDeliveryActiveMapData(arn, data || {});
    }).catch(function () {});
  }

  function startDeliveryPolling(arn) {
    stopDeliveryPolling();
    if (!arn) return;
    renderDeliveryActiveMap(arn);
    _deliveryPollTimer = setInterval(function () {
      fetchTrack(arn).then(function (data) {
        if (data && data.status === 'COMPLETED') { stopDeliveryPolling(); }
        renderDeliveryActiveMapData(arn, data || {});
      }).catch(function () {});
    }, LIVE_POLL_MS);
  }

  function stopDeliveryPolling() {
    if (_deliveryPollTimer) { clearInterval(_deliveryPollTimer); _deliveryPollTimer = null; }
  }

  function updateDeliveryRouteInfo(distance, duration) {
    const distanceBadge = document.getElementById('deliveryDistanceBadge');
    const timeBadge = document.getElementById('deliveryTimeBadge');
    const distanceText = document.getElementById('deliveryDistanceText');
    const timeText = document.getElementById('deliveryTimeText');
    
    if (distanceBadge) distanceBadge.style.display = 'flex';
    if (timeBadge) timeBadge.style.display = 'flex';
    if (distanceText) distanceText.textContent = distance;
    if (timeText) timeText.textContent = duration;
  }

  function startTrackPolling(arn) {
    stopTrackPolling();
    if (!arn) return;
    
    // Show loading state
    const loading = document.getElementById('trackMapLoading');
    if (loading) loading.style.display = 'flex';
    
    const poll = function () {
      fetchTrack(arn).then(function (data) {
        if (!data || data.error) return;
        renderTrackMap(data);
        if (data.status === 'COMPLETED') {
          stopTrackPolling();
          if (typeof mpOpenDeliveryReview === 'function') {
            mpOpenDeliveryReview(arn, data.delivery_partner && data.delivery_partner.name);
          }
        }
      }).catch(function () {
        // Show error state on failure
        const loading = document.getElementById('trackMapLoading');
        const error = document.getElementById('trackMapError');
        if (loading) loading.style.display = 'none';
        if (error) error.style.display = 'flex';
      });
    };
    poll();
    _trackPollTimer = setInterval(poll, LIVE_POLL_MS);
  }

  function stopTrackPolling() {
    if (_trackPollTimer) { clearInterval(_trackPollTimer); _trackPollTimer = null; }
  }

  // Track map control functions
  function centerTrackMap() {
    if (_trackGMap && _lastTrackDriverPos) {
      _trackGMap.setCenter({ lat: _lastTrackDriverPos.lat, lng: _lastTrackDriverPos.lng });
      _trackGMap.setZoom(15);
    }
  }

  function zoomInTrackMap() {
    if (_trackGMap) {
      _trackGMap.setZoom(_trackGMap.getZoom() + 1);
    }
  }

  function zoomOutTrackMap() {
    if (_trackGMap) {
      _trackGMap.setZoom(Math.max(_trackGMap.getZoom() - 1, 5));
    }
  }

  // Shared fullscreen driver for BOTH maps (Delivery + Track). Fullscreen =
  // the strip stays pinned on top, the map fills the whole screen below it,
  // and the details sheet is reachable by scrolling. A body class lets the
  // strip + controls (which live OUTSIDE the map wrapper) be promoted to fixed
  // overlays via CSS; a single body-level exit button drives minimize.
  function _axToggleMapFullscreen(cfg) {
    const mapWrap = document.getElementById(cfg.wrapId);
    if (!mapWrap) return false;
    const isFs = mapWrap.classList.toggle('fullscreen');
    document.body.classList.toggle(cfg.bodyClass, isFs);

    let exitBtn = document.getElementById(cfg.exitId);
    if (isFs) {
      if (!exitBtn) {
        exitBtn = document.createElement('button');
        exitBtn.id = cfg.exitId;
        exitBtn.type = 'button';
        exitBtn.className = 'ax-fs-exit-btn';
        exitBtn.setAttribute('aria-label', 'Exit fullscreen');
        exitBtn.innerHTML = '<i class="fa-solid fa-compress"></i>';
        exitBtn.onclick = cfg.toggle;
        document.body.appendChild(exitBtn);
      }
      exitBtn.style.display = '';
    } else if (exitBtn) {
      exitBtn.remove();
    }

    setTimeout(function () { try { cfg.resize(); } catch (e) {} }, 350);
    return isFs;
  }

  function toggleTrackMapFullscreen() {
    _axToggleMapFullscreen({
      wrapId: 'trackMapWrap', bodyClass: 'ax-track-fs', exitId: 'trackFsExitBtn',
      toggle: function () { window.toggleTrackMapFullscreen(); },
      resize: function () {
        if (_trackMap) _trackMap.invalidateSize();
        if (_trackGMap) google.maps.event.trigger(_trackGMap, 'resize');
      }
    });
  }

  function retryTrackMap() {
    const arn = document.getElementById('trackARN')?.value?.trim();
    if (!arn) return;
    
    const loading = document.getElementById('trackMapLoading');
    const error = document.getElementById('trackMapError');
    
    if (loading) loading.style.display = 'flex';
    if (error) error.style.display = 'none';
    
    if (typeof trackOrder === 'function') {
      trackOrder();
    }
  }

  // Expose track map functions globally
  window.centerTrackMap = centerTrackMap;
  window.zoomInTrackMap = zoomInTrackMap;
  window.zoomOutTrackMap = zoomOutTrackMap;
  window.toggleTrackMapFullscreen = toggleTrackMapFullscreen;
  window.retryTrackMap = retryTrackMap;

  // Delivery map fullscreen — shares the driver with the Track map.
  window.toggleDeliveryFullscreen = function() {
    _isDeliveryFullscreen = _axToggleMapFullscreen({
      wrapId: 'deliveryMapWrap', bodyClass: 'ax-delivery-fs', exitId: 'deliveryFsExitBtn',
      toggle: function () { window.toggleDeliveryFullscreen(); },
      resize: function () {
        // Leaflet is the actually-used map (Google only runs with a key).
        if (_deliveryMap) _deliveryMap.invalidateSize();
        if (_deliveryGMap) google.maps.event.trigger(_deliveryGMap, 'resize');
      }
    });
  };

  function patchTrackOrder() {
    if (typeof trackOrder !== 'function' || trackOrder._enhanced) return;
    const orig = trackOrder;
    trackOrder = async function () {
      await orig();
      const arn = gv('trackARN').trim();
      if (!arn) { stopTrackPolling(); return; }
      // Live, auto-refreshing tracking (like Zomato/Swiggy) while this
      // order is still on the way — stops automatically once delivered.
      startTrackPolling(arn);
    };
    trackOrder._enhanced = true;
  }

  function patchPrefillForms() {
    if (typeof prefillForms !== 'function' || prefillForms._enhanced) return;
    const orig = prefillForms;
    prefillForms = function () {
      orig();
      refreshCompactSummaries();
    };
    prefillForms._enhanced = true;
  }

  function patchSubmitOrder() {
    if (typeof submitOrder !== 'function' || submitOrder._enhanced) return;
    const orig = submitOrder;
    submitOrder = async function () {
      const lat = gv('o_address_lat') || (userProfile && userProfile.address_lat) || '';
      const lng = gv('o_address_lng') || (userProfile && userProfile.address_lng) || '';
      if (lat && lng) {
        userProfile = userProfile || {};
        userProfile.address_lat = lat;
        userProfile.address_lng = lng;
        localStorage.setItem(profileKey(), JSON.stringify(userProfile));
      }
      return orig();
    };
    submitOrder._enhanced = true;
  }

  function patchSaveProfile() {
    if (typeof saveProfile !== 'function' || saveProfile._enhanced) return;
    const orig = saveProfile;
    saveProfile = function () {
      userProfile = userProfile || {};
      userProfile.address_lat = gv('p_address_lat');
      userProfile.address_lng = gv('p_address_lng');
      return orig();
    };
    saveProfile._enhanced = true;
  }

  function patchSwitchPanel() {
    if (typeof switchPanel !== 'function' || switchPanel._enhanced) return;
    const orig = switchPanel;
    switchPanel = function (panelId) {
      if (panelId !== 'track') stopTrackPolling();
      return orig(panelId);
    };
    switchPanel._enhanced = true;
  }

  function patchRenderCatalogue() {
    if (typeof renderCatalogue !== 'function' || renderCatalogue._enhanced) return;
    const orig = renderCatalogue;
    renderCatalogue = function () {
      orig();
      if (window.innerWidth <= 768) {
        document.querySelectorAll('#productGrid .product-card').forEach(function (card) {
          card.classList.add('product-card-mini');
        });
      }
    };
    renderCatalogue._enhanced = true;
  }

  function initHiddenGeoFields() {
    [['p_address_lat', 'p_address_lng'], ['o_address_lat', 'o_address_lng']].forEach(function (pair) {
      pair.forEach(function (id) {
        if (!document.getElementById(id)) {
          const inp = document.createElement('input');
          inp.type = 'hidden';
          inp.id = id;
          document.body.appendChild(inp);
        }
      });
    });
    const p = userProfile || {};
    if (p.address_lat) sv('p_address_lat', p.address_lat);
    if (p.address_lng) sv('p_address_lng', p.address_lng);
  }

  function initDeliveryMapPanel() {
    const panel = document.getElementById('deliveryActivePanel');
    if (!panel || document.getElementById('deliveryMapCanvas')) return;
    const mapBlock = document.createElement('div');
    mapBlock.className = 'delivery-map-block';
    mapBlock.innerHTML = '<div class="form-section-title"><i class="fa-solid fa-map-location-dot"></i> Live route</div><div id="deliveryMapCanvas"></div>';
    panel.insertBefore(mapBlock, panel.querySelector('.form-grid'));
  }

  function init() {
    initHiddenGeoFields();
    initProfileTabs();
    initCompactOrderForm();
    initCompactSellForm();
    initDeliveryMapPanel();
    patchTrackOrder();
    patchPrefillForms();
    patchSubmitOrder();
    patchSaveProfile();
    patchRenderCatalogue();
    patchSwitchPanel();
    loadMapKeys().then(function () {
      if (!loadGooglePlacesScript()) loadMapplsScript();
    });
    document.getElementById('notifAlertPopup')?.addEventListener('click', function (e) {
      if (e.target.id === 'notifAlertPopup') closeAlertPopup();
    });
  }

  document.addEventListener('DOMContentLoaded', init);

  const _origEnhOnSignedIn = typeof onSignedIn === 'function' ? onSignedIn : null;
  onSignedIn = function () {
    if (_origEnhOnSignedIn) _origEnhOnSignedIn();
    refreshCompactSummaries();
    startPolling();
    setTimeout(function () { refreshNotifications(true); }, 800);
  };

  return {
    openAlertPopup: openAlertPopup,
    closeAlertPopup: closeAlertPopup,
    openNotificationPanel: openNotificationPanel,
    acknowledgeNotificationAttention: acknowledgeNotificationAttention,
    showNotifPopupCard: showNotifPopupCard,
    dismissNotifPopupCard: dismissNotifPopupCard,
    copyOtp: function (otp) { copyText(otp, 'OTP'); },
    copyText: copyText,
    refreshNotifications: refreshNotifications,
    toggleOrderForm: toggleOrderForm,
    toggleSellForm: toggleSellForm,
    renderDeliveryActiveMap: renderDeliveryActiveMap,
    renderTrackMap: renderTrackMap,
    updateBadges: updateBadges,
    startTrackPolling: startTrackPolling,
    stopTrackPolling: stopTrackPolling,
    startDeliveryPolling: startDeliveryPolling,
    stopDeliveryPolling: stopDeliveryPolling,
  };
})();
