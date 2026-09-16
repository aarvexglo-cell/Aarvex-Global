/* ============================================================================
   ax-geo-district.js — District resolver for ad targeting (Phase 1)
   ----------------------------------------------------------------------------
   Figures out the viewer's district + state so the ad backend can serve a
   locally-targeted banner. Resolution order (fast, no permission prompts):

       1. Manual override the viewer picked   (localStorage ax_user_district)
       2. Their saved delivery address        (ax_addrbook_<sub> / ax_profile_<sub>)
       3. Nothing  ->  {}  ->  backend serves the national ad

   GPS is used ONLY when the viewer taps "detect" in the selector — never on a
   plain ad load — so opening the app never triggers a location prompt.

   The backend (marketplace.py) slugifies state/district itself, so here we
   just pass readable names ("Nagpur", "Maharashtra"). Everything is wrapped in
   try/catch because localStorage can throw (private mode, blocked storage).

   Public API (all attached to window):
       axDistrictContext()          -> { state, district, source } | {}
       axDistrictQS()               -> "&state=..&district=.." | ""
       axSetManualDistrict(st, dist)
       axClearManualDistrict()
       axDetectDistrictViaGps(cb)   -> async, reverse-geocodes current GPS
       axOpenDistrictSelector()     -> lightweight pick-your-area modal
   ============================================================================ */
(function () {
  'use strict';

  var MANUAL_KEY = 'ax_user_district';
  var NOMINATIM_REVERSE = 'https://nominatim.openstreetmap.org/reverse';

  function _lsGet(key) { try { return localStorage.getItem(key); } catch (e) { return null; } }
  function _lsSet(key, val) { try { localStorage.setItem(key, val); } catch (e) { /* ignore */ } }
  function _lsDel(key) { try { localStorage.removeItem(key); } catch (e) { /* ignore */ } }

  function _currentSub() {
    try { var u = JSON.parse(_lsGet('ax_user') || 'null'); return u && u.sub ? u.sub : null; }
    catch (e) { return null; }
  }

  /* The portal's live selected delivery address (portal-address.js keeps it in
     AX_ADDRESSES and exposes getSelectedAddress()). This is the real, current
     address on the Order form, so it wins over anything persisted. */
  function _portalSelected() {
    try {
      if (typeof window.getSelectedAddress === 'function') {
        var a = window.getSelectedAddress();
        if (a && (a.district || a.city || a.state)) {
          return { state: a.state || '', district: a.district || a.city || '' };
        }
      }
    } catch (e) { /* ignore */ }
    return null;
  }

  /* Persist the resolved area so a later cold load has it before the address
     list finishes loading from the backend. */
  function _persistArea(ctx) {
    var sub = _currentSub();
    if (!sub || !ctx || !(ctx.district || ctx.state)) return;
    try {
      localStorage.setItem('ax_user_area_' + sub, JSON.stringify({
        state: ctx.state || '', district: ctx.district || '', ts: Date.now()
      }));
    } catch (e) { /* ignore */ }
  }

  /* Stable "current area" persisted from a previous session/selection. */
  function _savedArea() {
    var sub = _currentSub();
    if (!sub) return null;
    try {
      var a = JSON.parse(_lsGet('ax_user_area_' + sub) || 'null');
      if (a && (a.district || a.city || a.state)) {
        return { state: a.state || '', district: a.district || a.city || '' };
      }
    } catch (e) { /* ignore */ }
    return null;
  }

  /* Fallback for older data: dig the district out of the saved address list or
     the profile cache directly. Newest address is at index 0 (unshift on save). */
  function _savedLocation() {
    var sub = _currentSub();
    if (sub) {
      try {
        var list = JSON.parse(_lsGet('ax_addrbook_' + sub) || '[]');
        if (Array.isArray(list) && list.length) {
          var a = list[0];
          if (a && (a.district || a.city || a.state)) {
            return { state: a.state || '', district: a.district || a.city || '' };
          }
        }
      } catch (e) { /* ignore */ }
      try {
        var p = JSON.parse(_lsGet('ax_profile_' + sub) || 'null');
        if (p && (p.district || p.city || p.state)) {
          return { state: p.state || '', district: p.district || p.city || '' };
        }
      } catch (e) { /* ignore */ }
    }
    return null;
  }

  function _manual() {
    try {
      var m = JSON.parse(_lsGet(MANUAL_KEY) || 'null');
      if (m && (m.district || m.state)) return { state: m.state || '', district: m.district || '' };
    } catch (e) { /* ignore */ }
    return null;
  }

  /* ---- Public: resolved context (sync, no prompts) ----
     Precedence: manual override → portal's live selected address →
     persisted area → older saved-address data → nothing (national ad). */
  function axDistrictContext() {
    var m = _manual();
    if (m) { m.source = 'manual'; return m; }
    var p = _portalSelected();
    if (p) { _persistArea(p); p.source = 'selected'; return p; }
    var a = _savedArea();
    if (a) { a.source = 'area'; return a; }
    var s = _savedLocation();
    if (s) { s.source = 'address'; return s; }
    return {};
  }

  /* ---- Public: query string to append to /banner/active ---- */
  function axDistrictQS() {
    var ctx = axDistrictContext();
    var qs = '';
    if (ctx.state) qs += '&state=' + encodeURIComponent(ctx.state);
    if (ctx.district) qs += '&district=' + encodeURIComponent(ctx.district);
    return qs;
  }

  /* ---- Public: manual override ---- */
  function axSetManualDistrict(state, district) {
    _lsSet(MANUAL_KEY, JSON.stringify({ state: state || '', district: district || '', ts: Date.now() }));
    _reloadAds();
  }
  function axClearManualDistrict() { _lsDel(MANUAL_KEY); _reloadAds(); }

  /* ---- Public: GPS detect (only on explicit user action) ---- */
  function axDetectDistrictViaGps(cb) {
    cb = cb || function () {};
    if (!navigator.geolocation) { cb(null, 'GPS not supported on this device'); return; }
    navigator.geolocation.getCurrentPosition(function (pos) {
      var lat = pos.coords.latitude, lng = pos.coords.longitude;
      var url = NOMINATIM_REVERSE + '?format=json&addressdetails=1&lat=' +
        encodeURIComponent(lat) + '&lon=' + encodeURIComponent(lng);
      fetch(url, { headers: { Accept: 'application/json' } })
        .then(function (r) { return r.json(); })
        .then(function (data) {
          var a = (data && data.address) || {};
          // Nominatim's district field is state_district (falls back to county).
          var district = a.state_district || a.county || a.city || a.town || a.village || a.suburb || '';
          var state = a.state || '';
          if (!district) { cb(null, 'Could not find your district'); return; }
          axSetManualDistrict(state, district);
          cb({ state: state, district: district, source: 'gps' }, null);
        })
        .catch(function () { cb(null, 'Location lookup failed, try again'); });
    }, function () {
      cb(null, 'Location permission denied');
    }, { enableHighAccuracy: false, timeout: 10000, maximumAge: 600000 });
  }

  /* Re-fetch banners after the area changes, if the portal exposes the loaders. */
  function _reloadAds() {
    try {
      if (typeof mpLoadBanner === 'function') { mpLoadBanner('dashboard', 'dashBannerSlot'); mpLoadBanner('trade', 'tradeBannerSlot'); }
      if (typeof mpLoadTradeMidCarousel === 'function') mpLoadTradeMidCarousel('tradeMidAdSlot');
      if (typeof mpLoadBanner === 'function') mpLoadBanner('trade_bottom', 'tradeBottomAdSlot');
    } catch (e) { /* ignore */ }
  }

  /* ---- Public: minimal "pick your area" modal ---- */
  function axOpenDistrictSelector() {
    if (document.getElementById('axDistrictModal')) return;
    var ctx = axDistrictContext();
    var wrap = document.createElement('div');
    wrap.id = 'axDistrictModal';
    wrap.setAttribute('role', 'dialog');
    wrap.setAttribute('aria-modal', 'true');
    wrap.style.cssText = 'position:fixed;inset:0;z-index:99999;background:rgba(10,15,25,.55);' +
      'display:flex;align-items:center;justify-content:center;padding:18px;font-family:inherit';
    wrap.innerHTML =
      '<div style="background:#fff;color:#141a2e;max-width:380px;width:100%;border-radius:16px;' +
      'padding:22px;box-shadow:0 20px 60px rgba(0,0,0,.35)">' +
      '<h3 style="margin:0 0 4px;font-size:19px">अपना इलाका चुनें</h3>' +
      '<p style="margin:0 0 16px;font-size:13.5px;color:#59607a">इससे आपको अपने ज़िले के हिसाब से ad और deals दिखेंगे।</p>' +
      '<label style="font-size:12px;color:#59607a;text-transform:uppercase;letter-spacing:.04em">State</label>' +
      '<input id="axDistState" type="text" placeholder="जैसे Maharashtra" value="' + _escAttr(ctx.state || '') + '" ' +
      'style="width:100%;margin:5px 0 12px;padding:11px 12px;border:1px solid #dde2ee;border-radius:9px;font-size:15px">' +
      '<label style="font-size:12px;color:#59607a;text-transform:uppercase;letter-spacing:.04em">District / City</label>' +
      '<input id="axDistDistrict" type="text" placeholder="जैसे Nagpur" value="' + _escAttr(ctx.district || '') + '" ' +
      'style="width:100%;margin:5px 0 16px;padding:11px 12px;border:1px solid #dde2ee;border-radius:9px;font-size:15px">' +
      '<button id="axDistGps" type="button" style="width:100%;margin-bottom:10px;padding:11px;border:1px solid #dde2ee;' +
      'background:#f5f7fc;border-radius:9px;font-size:14px;cursor:pointer">📍 GPS से अपने आप पता करें</button>' +
      '<div style="display:flex;gap:10px">' +
      '<button id="axDistSave" type="button" style="flex:1;padding:12px;border:0;background:#2f4fc8;color:#fff;' +
      'border-radius:9px;font-size:15px;font-weight:600;cursor:pointer">Save</button>' +
      '<button id="axDistCancel" type="button" style="padding:12px 16px;border:1px solid #dde2ee;background:#fff;' +
      'border-radius:9px;font-size:15px;cursor:pointer">Cancel</button>' +
      '</div>' +
      '<button id="axDistClear" type="button" style="width:100%;margin-top:10px;padding:6px;border:0;background:none;' +
      'color:#59607a;font-size:12.5px;cursor:pointer;text-decoration:underline">choice हटाओ (auto पर छोड़ दो)</button>' +
      '</div>';
    document.body.appendChild(wrap);

    function close() { var el = document.getElementById('axDistrictModal'); if (el) el.remove(); }
    wrap.addEventListener('click', function (e) { if (e.target === wrap) close(); });
    document.getElementById('axDistCancel').onclick = close;
    document.getElementById('axDistClear').onclick = function () { axClearManualDistrict(); close(); };
    document.getElementById('axDistSave').onclick = function () {
      var st = document.getElementById('axDistState').value.trim();
      var di = document.getElementById('axDistDistrict').value.trim();
      if (!di) { document.getElementById('axDistDistrict').focus(); return; }
      axSetManualDistrict(st, di);
      close();
    };
    document.getElementById('axDistGps').onclick = function () {
      var b = document.getElementById('axDistGps');
      b.textContent = 'ढूँढ रहे हैं…'; b.disabled = true;
      axDetectDistrictViaGps(function (res, err) {
        if (res) {
          document.getElementById('axDistState').value = res.state || '';
          document.getElementById('axDistDistrict').value = res.district || '';
          b.textContent = '✓ मिल गया: ' + (res.district || '');
        } else {
          b.textContent = '📍 GPS से अपने आप पता करें'; b.disabled = false;
          if (typeof toast === 'function') toast(err || 'नहीं मिला', 'warning');
        }
      });
    };
  }

  function _escAttr(s) { return String(s).replace(/"/g, '&quot;').replace(/</g, '&lt;'); }

  window.axDistrictContext = axDistrictContext;
  window.axDistrictQS = axDistrictQS;
  window.axReloadAdsForArea = _reloadAds;
  window.axSetManualDistrict = axSetManualDistrict;
  window.axClearManualDistrict = axClearManualDistrict;
  window.axDetectDistrictViaGps = axDetectDistrictViaGps;
  window.axOpenDistrictSelector = axOpenDistrictSelector;
})();
