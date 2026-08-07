/* Aarvex Portal — Delivery/Track UX module
 * Journey strip, separate claims page + pause mode, radius filter,
 * distance-triangle overlay, Track-tab strip with 3-party contacts,
 * cancel-from-track, second-ARN lookup, map fullscreen label sync.
 * Load AFTER portal-delivery.js and portal-enhancements.js.
 */
'use strict';

/* ══════════ LIVE GPS TRACKING FOR DELIVERY BOY ══════════
   Continuous watchPosition so the delivery boy's location is always
   fresh — not just a one-shot snapshot taken when Apply is tapped.
   window._axPartnerPos is read by:
     • the radius triangle filter (mpLoadDeliveryDashboard)
     • axShowTriangle() for the pre-journey claims view
     • axRenderClaimCard() distance legs
   Tracking starts when the radius is applied and stops when the
   journey ends (axDeactivateJourneyUi) or the tab is left. */
let _axPartnerWatchId = null;

function axStartLivePartnerTracking() {
  if (!navigator.geolocation) return;
  if (_axPartnerWatchId !== null) return; // already watching
  _axPartnerWatchId = navigator.geolocation.watchPosition(
    function (pos) {
      window._axPartnerPos = { lat: pos.coords.latitude, lng: pos.coords.longitude };
      // Debounced quiet refresh of the orders list so distances stay current.
      clearTimeout(window._axRadiusRefreshT);
      window._axRadiusRefreshT = setTimeout(function () {
        if (typeof mpLoadDeliveryDashboard === 'function') {
          try { mpLoadDeliveryDashboard(); } catch (e) { }
        }
      }, 4000);
    },
    function () { /* silent — stale position stays until next good fix */ },
    { enableHighAccuracy: true, maximumAge: 15000, timeout: 30000 }
  );
}

function axStopLivePartnerTracking() {
  if (_axPartnerWatchId !== null) {
    navigator.geolocation.clearWatch(_axPartnerWatchId);
    _axPartnerWatchId = null;
  }
  clearTimeout(window._axRadiusRefreshT);
}
window.axStartLivePartnerTracking = axStartLivePartnerTracking;
window.axStopLivePartnerTracking = axStopLivePartnerTracking;

/* ── Claims page (separate view inside the Delivery tab) ── */
let _axJourneyPaused = false;

function axOpenDeliveryClaimsView(viewOnly) {
  const home = document.getElementById('deliveryHomeView');
  const claims = document.getElementById('deliveryClaimsView');
  if (!home || !claims) return;
  home.style.display = 'none';
  claims.style.display = '';
  const radiusInput = document.getElementById('deliveryRadiusInput');
  if (radiusInput && !radiusInput.value) {
    radiusInput.value = localStorage.getItem('ax_delivery_radius_km') || (window.userProfile && window.userProfile.delivery_radius_km) || '';
  }
  // Prefill the saved vehicle number so the partner can see / edit it.
  const vehInput = document.getElementById('deliveryVehicleInput');
  if (vehInput && !vehInput.value) {
    vehInput.value = (window.userProfile && window.userProfile.vehicle_number) || '';
  }
  const pausedNote = document.getElementById('deliveryClaimsPausedNote');
  const resumeBtn = document.getElementById('deliveryResumeBtn');
  if (pausedNote) pausedNote.style.display = viewOnly ? '' : 'none';
  if (resumeBtn) resumeBtn.style.display = viewOnly ? '' : 'none';
  mpLoadDeliveryDashboard();
  window.scrollTo(0, 0);
}

function axCloseDeliveryClaimsView() {
  const home = document.getElementById('deliveryHomeView');
  const claims = document.getElementById('deliveryClaimsView');
  if (!home || !claims) return;
  claims.style.display = 'none';
  home.style.display = '';
}

/* Pause: journey stays fully alive (GPS keeps pushing, polling keeps
   running) — this only lets the partner LOOK at other available orders.
   Claim buttons stay locked until the current delivery closes. */
function axPauseJourneyView() {
  _axJourneyPaused = true;
  axOpenDeliveryClaimsView(true);
}
function axResumeJourneyView() {
  _axJourneyPaused = false;
  axCloseDeliveryClaimsView();
  window.scrollTo(0, 0);
}

/* ── Vehicle number (delivery partner) — persisted on the profile so it shows
   on the importer's Track strip. Empty value clears it. ── */
async function axSaveVehicleNumber() {
  const input = document.getElementById('deliveryVehicleInput');
  const val = ((input && input.value) || '').trim().toUpperCase();
  const data = await mpApi('/profile/update', { method: 'POST', body: JSON.stringify({ vehicle_number: val }) });
  if (data && (data.success || data.profile)) {
    try {
      if (window.userProfile) {
        window.userProfile.vehicle_number = val;
        if (typeof profileKey === 'function') localStorage.setItem(profileKey(), JSON.stringify(window.userProfile));
      }
    } catch (e) { }
    showToast(val ? 'Vehicle number saved — importers will see it' : 'Vehicle number cleared', 'success');
  } else {
    showToast((data && data.error) || 'Could not save vehicle number', 'error');
  }
}

/* ── Radius filter ── */
function axApplyDeliveryRadius() {
  const input = document.getElementById('deliveryRadiusInput');
  const km = parseFloat(input && input.value) || 0;
  if (km > 500) { showToast('Choose a radius between 1 and 500 km', 'error'); return; }
  if (km <= 0) {
    localStorage.removeItem('ax_delivery_radius_km');
    window._axPartnerPos = null;
    mpApi('/profile/update', { method: 'POST', body: JSON.stringify({ delivery_radius_km: 0 }) });
    if (window.userProfile) window.userProfile.delivery_radius_km = '0';
    showToast('Radius filter cleared — showing all orders', 'info');
    mpLoadDeliveryDashboard();
    return;
  }
  localStorage.setItem('ax_delivery_radius_km', String(km));
  mpApi('/profile/update', { method: 'POST', body: JSON.stringify({ delivery_radius_km: km }) });
  if (window.userProfile) window.userProfile.delivery_radius_km = String(km);
  if (!navigator.geolocation) {
    showToast('GPS not available — radius needs your location', 'warning');
    mpLoadDeliveryDashboard();
    return;
  }
  showToast('Getting your location…', 'info');
  navigator.geolocation.getCurrentPosition(function (pos) {
    window._axPartnerPos = { lat: pos.coords.latitude, lng: pos.coords.longitude };
    // Start continuous live tracking so the position never goes stale.
    axStartLivePartnerTracking();
    showToast('Radius set: all three delivery-triangle sides must be within ' + km + ' km', 'success');
    mpLoadDeliveryDashboard();
  }, function () {
    showToast('Could not get location — enable GPS and try again', 'error');
    mpLoadDeliveryDashboard();
  }, { enableHighAccuracy: true, timeout: 12000, maximumAge: 60000 });
}

/* ── Journey UI state ── */
function axActivateJourneyUi() {
  const panel = document.getElementById('panel-delivery');
  if (panel) panel.classList.add('ax-journey-active');
  const strip = document.getElementById('deliveryInfoCard');
  if (strip) strip.style.display = 'block';
  // Fullscreen sheet starts collapsed to just the OTP bar (max map area).
  const sheet = document.getElementById('deliveryMapControlsOverlay');
  if (sheet) sheet.classList.add('ax-sheet-collapsed');
  const label = document.querySelector('#deliverySheetHandle .ax-sheet-handle-label');
  if (label) label.innerHTML = '<i class="fa-solid fa-chevron-up"></i> More controls';
  axCloseDeliveryClaimsView();
  axShowJourneyBanner();
  window.scrollTo(0, 0);
}
function axDeactivateJourneyUi() {
  _axJourneyPaused = false;
  // Stop the live GPS watch — no more open deliveries.
  axStopLivePartnerTracking();
  const panel = document.getElementById('panel-delivery');
  if (panel) panel.classList.remove('ax-journey-active');
  const strip = document.getElementById('deliveryInfoCard');
  if (strip) { strip.style.display = 'none'; strip.classList.remove('collapsed'); }
  axHideJourneyBanner();
}

/* Persistent on-screen banner (above the bottom nav) shown while a journey is
   live — one tap re-opens the full-screen live map from anywhere in the app. */
function axShowJourneyBanner() {
  if (document.getElementById('axJourneyBanner')) return;
  const b = document.createElement('div');
  b.id = 'axJourneyBanner';
  b.className = 'ax-journey-banner';
  b.innerHTML =
    '<span class="ax-jb-dot" aria-hidden="true"></span>' +
    '<div class="ax-jb-txt"><b>Delivery in progress</b><small>Your journey has started</small></div>' +
    '<button type="button" class="ax-jb-btn" onclick="axOpenJourneyMap()"><i class="fa-solid fa-map-location-dot"></i> Open live map</button>';
  document.body.appendChild(b);
  axSyncBottomStack();
}
function axHideJourneyBanner() {
  const b = document.getElementById('axJourneyBanner');
  if (b) b.remove();
  axSyncBottomStack();
}

/* Keep the shared bottom-stack tokens in sync: the body carries
   `ax-has-bottom-banner` whenever EITHER the delivery-partner journey banner or
   the importer live-track banner is on screen, so the cart FAB and back-to-top
   button always lift clear of whichever banner is showing. */
function axSyncBottomStack() {
  const has = !!(document.getElementById('axJourneyBanner') || document.getElementById('axImporterTrackBanner'));
  document.body.classList.toggle('ax-has-bottom-banner', has);
}
window.axSyncBottomStack = axSyncBottomStack;

/* ── Importer live-track banner (parity with the delivery-partner journey
   banner) ── The buyer whose order is out for delivery gets the SAME persistent
   bottom notice: one line of status + a "Track live" button that opens exactly
   what the notification's Track-live button opens (axOpenTrackFromNotif → Track
   tab + live map). Driven by refreshNotifications() (portal-enhancements.js),
   which knows the buyer's active tracking ARN. */
function axShowImporterTrackBanner(arn, message) {
  if (!arn) return;
  // The partner's own journey banner always wins — never stack two.
  if (document.getElementById('axJourneyBanner')) { axHideImporterTrackBanner(); return; }
  const msg = message || 'Your order is on the way';
  let b = document.getElementById('axImporterTrackBanner');
  if (!b) {
    b = document.createElement('div');
    b.id = 'axImporterTrackBanner';
    b.className = 'ax-journey-banner ax-importer-banner';
    document.body.appendChild(b);
  }
  const safeArn = String(arn).replace(/'/g, '');
  b.dataset.arn = safeArn;
  b.innerHTML =
    '<span class="ax-jb-dot" aria-hidden="true"></span>' +
    '<div class="ax-jb-txt"><b>' + mpEscDelivery(msg) + '</b></div>' +
    '<button type="button" class="ax-jb-btn" onclick="axOpenTrackFromNotif(\'' + safeArn + '\')"><i class="fa-solid fa-location-crosshairs"></i> Track live</button>';
  axSyncBottomStack();
}
function axHideImporterTrackBanner() {
  const b = document.getElementById('axImporterTrackBanner');
  if (b) b.remove();
  axSyncBottomStack();
}
window.axShowImporterTrackBanner = axShowImporterTrackBanner;
window.axHideImporterTrackBanner = axHideImporterTrackBanner;

/* From a fresh /notifications payload, work out whether the buyer currently has
   an order out for delivery and, if so, show the importer track banner for it.
   Notifications arrive newest-first, so the first track_arn we see whose latest
   event isn't a completion/cancellation is the live one. */
window.axUpdateImporterTrackBanner = function (notifications) {
  if (!Array.isArray(notifications)) return;
  const resolved = {};
  let activeArn = null, activeMsg = '';
  for (let i = 0; i < notifications.length; i++) {
    const n = notifications[i];
    if (!n || !n.track_arn) continue;
    const blob = ((n.type || '') + ' ' + (n.title || '') + ' ' + (n.body || '')).toLowerCase();
    if (/deliver(ed|y complete)|completed|cancel|refund/.test(blob)) {
      resolved[n.track_arn] = true;      // this order's latest state is closed
      continue;
    }
    if (!resolved[n.track_arn]) {
      activeArn = n.track_arn;
      activeMsg = n.title && n.title.length < 46 ? n.title : 'Your order is on the way';
      break;
    }
  }
  if (activeArn) axShowImporterTrackBanner(activeArn, activeMsg);
  else axHideImporterTrackBanner();
};
function axOpenJourneyMap() {
  if (typeof switchPanel === 'function') switchPanel('delivery');
  if (typeof mpLoadDeliveryDashboard === 'function') { try { mpLoadDeliveryDashboard(); } catch (e) { } }
  const wrap = document.getElementById('deliveryMapWrap');
  if (wrap) {
    wrap.style.display = 'block';
    if (!wrap.classList.contains('fullscreen') && typeof toggleDeliveryFullscreen === 'function') {
      toggleDeliveryFullscreen();
      if (typeof axSyncMapFsBtn === 'function') axSyncMapFsBtn('deliveryMapWrap', 'deliveryMapFsBtn');
    }
  }
}

/* Fresh /track data for the partner's own journey → keep the strip's call
   button live (renderDeliveryActiveMapData fills the name/km/ETA ids). */
window.axOnDeliveryTrackData = function (data) {
  const phone = (data && data.buyer_mobile) || '';
  const sub = (data && data.buyer_sub) || '';
  const callBtn = document.getElementById('deliveryImporterCallBtn');
  if (callBtn) {
    callBtn.style.display = phone ? '' : 'none';
    if (phone) callBtn.href = 'tel:' + phone;
  }
  // In-app message button to the importer (own messenger, no SMS cost).
  const msgBtn = document.getElementById('deliveryImporterMsgBtn');
  if (msgBtn) {
    msgBtn.style.display = sub ? '' : 'none';
    msgBtn.onclick = function () { axMsgContact(sub, (data && data.buyer_name) || 'Importer', (data && data.buyer_avatar) || ''); };
  }

  // Two-leg mini progress: shop pickup → importer drop. Reflects picked_up /
  // in-transit so the partner always sees which leg they're on.
  const legEl = document.getElementById('deliveryLegProgress');
  if (legEl) {
    const pickedUp = !!(data && (data.picked_up_at ||
      ['IN_TRANSIT', 'NEAR_DESTINATION', 'ARRIVED', 'COMPLETED'].indexOf(data.status) !== -1));
    const delivered = !!(data && data.status === 'COMPLETED');
    legEl.style.display = '';
    legEl.innerHTML =
      '<span class="ax-leg ' + (pickedUp ? 'done' : 'active') + '">' +
      '<i class="fa-solid ' + (pickedUp ? 'fa-circle-check' : 'fa-store') + '"></i> Pickup</span>' +
      '<span class="ax-leg-line ' + (pickedUp ? 'done' : '') + '"></span>' +
      '<span class="ax-leg ' + (delivered ? 'done' : (pickedUp ? 'active' : '')) + '">' +
      '<i class="fa-solid ' + (delivered ? 'fa-circle-check' : 'fa-house') + '"></i> Drop</span>';
  }

  // Shop keeper (pickup) contact row — the delivery boy needs the shop's
  // number too, not just the importer's. Filled into the strip's contacts slot.
  const shopWrap = document.getElementById('deliveryStripContacts');
  if (shopWrap) {
    const sc = data && data.seller_contact;
    if (sc && (sc.name || sc.phone || sc.sub)) {
      shopWrap.style.display = '';
      shopWrap.innerHTML =
        '<div class="ax-contact-row">' +
        '<span class="ax-contact-icon"><i class="fa-solid fa-store"></i></span>' +
        '<span class="ax-contact-text"><small>Pickup · Shop keeper</small><b>' + mpEscDelivery(sc.name || '—') + '</b>' +
        ((data.pickup && (data.pickup.address || data.pickup.city)) ? '<span class="ax-contact-meta"><span class="ax-cmeta"><i class="fa-solid fa-location-dot"></i> ' + mpEscDelivery(data.pickup.address || data.pickup.city) + '</span></span>' : '') +
        '</span>' +
        axContactActions({ name: sc.name, phone: sc.phone || '', sub: sc.sub || '', photo: sc.photo || '' }) +
        '</div>';
    } else {
      shopWrap.style.display = 'none';
      shopWrap.innerHTML = '';
    }
  }

  // Navigate button → Google-Maps turn-by-turn. Target = the shop until the
  // goods are picked up, then the importer's drop point.
  const navBtn = document.getElementById('deliveryNavBtn');
  if (navBtn) {
    const inTransit = data && ['IN_TRANSIT', 'NEAR_DESTINATION', 'COMPLETED'].indexOf(data.status) !== -1;
    const pickedUp = !!(data && data.picked_up_at);
    const dest = data && data.destination;
    const pick = data && data.pickup;
    let tgt = null, label = 'Navigate';
    if ((inTransit || pickedUp) && dest && dest.lat) { tgt = dest; label = 'Navigate to drop'; }
    else if (pick && pick.lat) { tgt = pick; label = 'Navigate to shop'; }
    else if (dest && dest.lat) { tgt = dest; label = 'Navigate to drop'; }
    if (tgt && tgt.lat) {
      navBtn.style.display = '';
      navBtn.href = axNavHref(tgt.lat, tgt.lng);
      const lbl = navBtn.querySelector('.ax-nav-label');
      if (lbl) lbl.textContent = label;
    } else {
      navBtn.style.display = 'none';
    }
  }
};

/* ── ₹ chip → live earning / trip details popover ──
   The ₹ chip used to be a dead "₹--". Tapping it now shows the partner the live
   breakdown for this trip — payout, distance left, ETA and who it's going to —
   pulled from the latest /track payload (window._axLastTrackData). Toggles. */
function axShowDeliveryEarningInfo(ev) {
  if (ev) ev.stopPropagation();
  const existing = document.getElementById('axEarnPop');
  if (existing) { existing.remove(); document.removeEventListener('click', axCloseEarnPop, true); return; }
  const d = window._axLastTrackData || {};
  const earn = (d.earnings != null && d.earnings > 0) ? d.earnings : (window._axActiveEarning || 0);
  const km = d.distance_remaining_km;
  const eta = d.eta_minutes;
  const arrived = (km != null && km <= 0.12) || ['NEAR_DESTINATION', 'ARRIVED'].indexOf(d.status) !== -1;
  const row = function (label, val) { return '<div class="ax-earn-pop-row"><span>' + label + '</span><b>' + val + '</b></div>'; };
  const pop = document.createElement('div');
  pop.id = 'axEarnPop';
  pop.className = 'ax-earn-pop';
  pop.innerHTML =
    '<div class="ax-earn-pop-head"><i class="fa-solid fa-indian-rupee-sign"></i> Delivery earning</div>' +
    row('Your payout', earn > 0 ? axRupee(earn) : 'Confirmed on delivery') +
    row('Distance left', arrived ? 'At the door' : (km != null ? km.toFixed(1) + ' km' : '—')) +
    row('ETA', arrived ? 'Doorstep' : (eta != null && eta > 0 ? eta + ' min' : '—')) +
    row('Deliver to', mpEscDelivery(d.buyer_name || 'Importer'));
  document.body.appendChild(pop);
  // Anchor under the tapped chip, clamped to the viewport.
  const chip = ev && (ev.currentTarget || ev.target.closest('.ax-journey-chip-btn'));
  if (chip) {
    const r = chip.getBoundingClientRect();
    const w = pop.offsetWidth || 240;
    let left = r.left + r.width / 2 - w / 2;
    left = Math.max(10, Math.min(left, window.innerWidth - w - 10));
    pop.style.left = left + 'px';
    pop.style.top = (r.bottom + 8) + 'px';
  }
  setTimeout(function () { document.addEventListener('click', axCloseEarnPop, true); }, 0);
}
function axCloseEarnPop(e) {
  const pop = document.getElementById('axEarnPop');
  if (!pop) { document.removeEventListener('click', axCloseEarnPop, true); return; }
  if (e && (pop.contains(e.target) || (e.target.closest && e.target.closest('.ax-journey-chip-btn')))) return;
  pop.remove();
  document.removeEventListener('click', axCloseEarnPop, true);
}
window.axShowDeliveryEarningInfo = axShowDeliveryEarningInfo;

/* ── Strip collapse (shared by delivery + track strips) ── */
function axToggleJourneyStrip(btn) {
  const strip = btn && btn.closest('.ax-journey-strip');
  if (!strip) return;
  const collapsed = strip.classList.toggle('collapsed');
  const icon = btn.querySelector('i');
  if (icon) icon.className = collapsed ? 'fa-solid fa-chevron-down' : 'fa-solid fa-chevron-up';
}

/* ── Delivery fullscreen bottom-sheet: collapsed = just the OTP bar; expanded
   = ARN / Mark Picked Up / tracking key / photo. Only meaningful in fullscreen
   (CSS scopes it to body.ax-delivery-fs). ── */
function axToggleDeliverySheet() {
  const sheet = document.getElementById('deliveryMapControlsOverlay');
  if (!sheet) return;
  const collapsed = sheet.classList.toggle('ax-sheet-collapsed');
  const handle = document.getElementById('deliverySheetHandle');
  const label = handle && handle.querySelector('.ax-sheet-handle-label');
  if (label) {
    label.innerHTML = collapsed
      ? '<i class="fa-solid fa-chevron-up"></i> More controls'
      : '<i class="fa-solid fa-chevron-down"></i> Hide controls';
  }
  if (handle) handle.setAttribute('aria-label', collapsed ? 'Expand controls' : 'Collapse controls');
}

function axSetDeliverySheet(collapsed) {
  const sheet = document.getElementById('deliveryMapControlsOverlay');
  if (!sheet) return;
  if (sheet.classList.contains('ax-sheet-collapsed') === collapsed) return; // no-op
  axToggleDeliverySheet();
}

/* Swipe the handle up to expand / down to collapse the fullscreen sheet
   (in addition to tapping). Suppresses the click that a tap-swipe would
   otherwise also fire. */
function axWireDeliverySheetSwipe() {
  const handle = document.getElementById('deliverySheetHandle');
  if (!handle || handle._axSwipeWired) return;
  handle._axSwipeWired = true;
  let startY = null, moved = false;
  handle.addEventListener('touchstart', function (e) {
    startY = e.touches && e.touches[0] ? e.touches[0].clientY : null;
    moved = false;
  }, { passive: true });
  handle.addEventListener('touchmove', function (e) {
    if (startY == null) return;
    const y = e.touches && e.touches[0] ? e.touches[0].clientY : startY;
    if (Math.abs(y - startY) > 24) moved = true;
  }, { passive: true });
  handle.addEventListener('touchend', function (e) {
    if (startY == null) return;
    const y = e.changedTouches && e.changedTouches[0] ? e.changedTouches[0].clientY : startY;
    const dy = y - startY;
    if (Math.abs(dy) > 24) {
      axSetDeliverySheet(dy > 0);      // drag down → collapse, up → expand
      if (moved && e.cancelable) e.preventDefault(); // swallow the tap-click
    }
    startY = null;
  });
}
document.addEventListener('DOMContentLoaded', axWireDeliverySheetSwipe);

/* ── Map fullscreen button label sync ── */
function axSyncMapFsBtn(wrapId, btnId) {
  const wrap = document.getElementById(wrapId);
  const btn = document.getElementById(btnId);
  if (!wrap || !btn) return;
  const fs = wrap.classList.contains('fullscreen');
  // Icon-only — the map stays clean; label text was unreadable over the map.
  btn.innerHTML = fs
    ? '<i class="fa-solid fa-compress"></i>'
    : '<i class="fa-solid fa-expand"></i>';
}

/* ══════════ CLAIM CARD RENDERER — colour-coded triangle legs ══════════
   Called by portal-enhancements.js / mpLoadDeliveryDashboard to build each
   order card in the "Available Orders" list.  Replaces the old single
   "Shop → Importer: N km" line with three colour-coded distance legs
   (matching the triangle SVG colours) and a small △ button that opens the
   full triangle overlay.

   ADDRESS SOURCES (per design spec):
     • Delivery boy  → window._axPartnerPos (live GPS watchPosition)
     • Shopkeeper    → order.pickup.lat / pickup.lng
                       (shopkeeper's permanent profile address, set on shop creation)
     • Importer      → order.dest_lat / dest_lng
                       (the address selected in the order form's location picker,
                        NOT the importer's personal profile address)

   If the importer's coordinates are missing (0 / null) the card shows a soft
   amber warning and disables Claim — never a hard red block — because the
   order is still visible and can be claimed once the importer updates their
   address.  */

/* Haversine distance helper (standalone — calculateDistance may not be
   loaded yet when this file inits). */
function axHaversine(lat1, lng1, lat2, lng2) {
  var R = 6371;
  var dLat = (lat2 - lat1) * Math.PI / 180;
  var dLng = (lng2 - lng1) * Math.PI / 180;
  var a = Math.sin(dLat / 2) * Math.sin(dLat / 2) +
    Math.cos(lat1 * Math.PI / 180) * Math.cos(lat2 * Math.PI / 180) *
    Math.sin(dLng / 2) * Math.sin(dLng / 2);
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

/* Format a km value the same way the triangle overlay does. */
function axFmtKm(km) {
  if (km == null) return '—';
  return (km < 10 ? km.toFixed(1) : Math.round(km)) + ' km';
}

/* Build the three-leg distance HTML shown on each claim card.
   Returns { legsHtml, dBoyShop, dShopImp, dImpBoy, hasAllCoords }. */
function axBuildLegs(order) {
  var boy = window._axPartnerPos || null;
  // Pickup = shopkeeper's permanent profile address
  var shop = (order.pickup && +order.pickup.lat && +order.pickup.lng)
    ? { lat: +order.pickup.lat, lng: +order.pickup.lng } : null;
  // Destination = importer's order-form address (dest_lat / dest_lng)
  var dest = (+order.dest_lat && +order.dest_lng)
    ? { lat: +order.dest_lat, lng: +order.dest_lng } : null;

  var dBoyShop = (boy && shop) ? axHaversine(boy.lat, boy.lng, shop.lat, shop.lng) : null;
  var dShopImp = (shop && dest) ? axHaversine(shop.lat, shop.lng, dest.lat, dest.lng) : null;
  var dImpBoy = (dest && boy) ? axHaversine(dest.lat, dest.lng, boy.lat, boy.lng) : null;
  var hasAllCoords = !!(boy && shop && dest);

  // Colour palette mirrors the triangle SVG nodes.
  var legs = [
    { col: '#2E6B41', icon: 'fa-person-biking', label: 'You → Shop', km: dBoyShop },
    { col: '#C7993A', icon: 'fa-store', label: 'Shop → Importer', km: dShopImp },
    { col: '#2A7F7E', icon: 'fa-location-dot', label: 'Imp → You', km: dImpBoy }
  ];

  var html = '<div class="ax-tri-legs">';
  legs.forEach(function (leg) {
    html += '<span class="ax-tri-leg" style="color:' + leg.col + '">' +
      '<i class="fa-solid ' + leg.icon + '"></i>' +
      '<b>' + axFmtKm(leg.km) + '</b>' +
      '</span>';
  });
  html += '</div>';

  return { legsHtml: html, dBoyShop: dBoyShop, dShopImp: dShopImp, dImpBoy: dImpBoy, hasAllCoords: hasAllCoords };
}

/* Render a single claim card and inject it into `container`.
   `order` shape (from portal-enhancements / mpLoadDeliveryDashboard):
   { arn, product_name, product_image, dest_city, dest_lat, dest_lng,
     pickup: { lat, lng, city }, earning, is_paused,
     seller_contact: { name }, buyer_name } */
function axRenderClaimCard(order, container, opts) {
  opts = opts || {};
  var legs = axBuildLegs(order);
  var arn = mpEscDelivery(order.arn || '');
  var name = mpEscDelivery(order.product_name || 'Order');
  var city = mpEscDelivery(order.dest_city || (order.pickup && order.pickup.city) || '');
  var earn = order.earning != null ? axRupee(order.earning) : '—';
  var img = order.product_image || '';

  // Importer address missing → soft amber warning, Claim disabled.
  var locMissing = !(+order.dest_lat && +order.dest_lng);
  // Delivery boy position unknown → show "Tap Apply" hint.
  var boyMissing = !window._axPartnerPos;

  var warnHtml = '';
  if (locMissing) {
    warnHtml = '<div class="ax-loc-warn">' +
      '<i class="fa-solid fa-triangle-exclamation"></i> ' +
      'Importer hasn\'t set a delivery address yet — visible but cannot be claimed until they update it.' +
      '</div>';
  } else if (boyMissing) {
    warnHtml = '<div class="ax-loc-warn ax-loc-warn--info">' +
      '<i class="fa-solid fa-location-crosshairs"></i> ' +
      'Tap <b>Apply</b> above to share your GPS and see exact distances.' +
      '</div>';
  }

  var claimDisabled = locMissing || !!opts.journeyActive ? ' disabled' : '';

  var html =
    '<div class="ax-claim-card" data-arn="' + arn + '">' +
    '<div class="ax-claim-card-top">' +
    (img
      ? '<img src="' + mpEscDelivery(img) + '" class="ax-claim-card-icon" style="object-fit:cover;border-radius:12px;" alt="">'
      : '<div class="ax-claim-card-icon"><i class="fa-solid fa-box"></i></div>') +
    '<div class="ax-claim-card-info">' +
    '<strong>' + name + '</strong>' +
    (city ? '<small><i class="fa-solid fa-location-dot"></i> ' + city + '</small>' : '') +
    legs.legsHtml +
    '</div>' +
    '<div class="ax-claim-card-earn">' +
    earn +
    '<small>EARNING</small>' +
    '</div>' +
    '</div>' +
    warnHtml +
    '<div class="ax-claim-card-actions">' +
    '<button type="button" class="btn-sm-outline ax-tri-open-btn" ' +
    'onclick="axShowTriangleForOrder(' + JSON.stringify(order).replace(/"/g, '&quot;') + ')" ' +
    'title="View delivery triangle" aria-label="View triangle">' +
    '<i class="fa-solid fa-diagram-project"></i>' +
    '</button>' +
    '<button type="button" class="btn-sm-outline" ' +
    'onclick="axSkipClaimCard(\'' + arn + '\')">' +
    'Skip' +
    '</button>' +
    '<button type="button" class="btn-primary btn-sm ax-claim-btn"' + claimDisabled + ' ' +
    'onclick="axClaimOrder(\'' + arn + '\')">' +
    '<i class="fa-solid fa-hand-pointer"></i> Claim' +
    '</button>' +
    '</div>' +
    '</div>';

  if (container) container.insertAdjacentHTML('beforeend', html);
  return html;
}

/* Show the triangle overlay pre-populated from the raw order object
   (before a journey starts — delivery boy position from live GPS). */
function axShowTriangleForOrder(order) {
  var boy = window._axPartnerPos;
  var shop = (order.pickup && +order.pickup.lat) ? { lat: +order.pickup.lat, lng: +order.pickup.lng } : null;
  var dest = (+order.dest_lat) ? { lat: +order.dest_lat, lng: +order.dest_lng } : null;

  // Temporarily inject into _axLastTrackData shape so axShowTriangle() reuses it.
  var synthetic = {
    product_name: order.product_name || 'Order',
    buyer_name: order.buyer_name || 'Importer',
    seller_contact: order.seller_contact || null,
    pickup: order.pickup || null,
    destination: dest ? { lat: dest.lat, lng: dest.lng, city: order.dest_city || '' } : null,
    driver_location: boy ? { lat: boy.lat, lng: boy.lng } : null,
    delivery_partner: { name: (window.userProfile && window.userProfile.name) || 'You' }
  };
  var prev = window._axLastTrackData;
  window._axLastTrackData = synthetic;
  axShowTriangle();
  // Restore previous track data after the overlay is built.
  window._axLastTrackData = prev;
}
window.axRenderClaimCard = axRenderClaimCard;
window.axShowTriangleForOrder = axShowTriangleForOrder;
window.axBuildLegs = axBuildLegs;

/* Compact delivery triangle for a CLAIM card — built straight from the three
   distances the backend already sends (partner→shop, shop→importer,
   partner→importer). No raw coordinates are used, so the importer's exact
   address stays private until the order is claimed. Role labels only (You /
   Shop / Imp) — no names — per the delivery-card spec. */
function axShowOrderTriangle(order) {
  order = order || {};
  var aBoyShop = order.pickup_distance_km != null ? +order.pickup_distance_km : null; // DB↔SH
  var bShopImp = order.shop_to_importer_km != null ? +order.shop_to_importer_km : null; // SH↔IM
  var cImpBoy = order.dest_distance_km != null ? +order.dest_distance_km : null;       // IM↔DB
  var fmt = function (km) { return km == null ? '—' : (km < 10 ? km.toFixed(1) : Math.round(km)) + ' km'; };

  var W = 320, H = 240, M = 46;
  var tri = (aBoyShop && bShopImp && cImpBoy) ? axTriProportional(aBoyShop, bShopImp, cImpBoy, W, H, M) : null;
  var proportional = !!tri;
  var L = tri || { db: { x: 160, y: 46 }, sh: { x: 46, y: 200 }, im: { x: 274, y: 200 } };
  function midPt(p, q, dx, dy) { return { x: (p.x + q.x) / 2 + (dx || 0), y: (p.y + q.y) / 2 + (dy || 0) }; }
  function line(p, q, col) { return '<line x1="' + p.x.toFixed(1) + '" y1="' + p.y.toFixed(1) + '" x2="' + q.x.toFixed(1) + '" y2="' + q.y.toFixed(1) + '" stroke="' + col + '" stroke-width="2.5" stroke-dasharray="6 5"/>'; }
  function node(p, col, lbl) {
    return '<circle cx="' + p.x.toFixed(1) + '" cy="' + p.y.toFixed(1) + '" r="22" fill="' + col + '"/>' +
      '<text x="' + p.x.toFixed(1) + '" y="' + (p.y + 4.5).toFixed(1) + '" text-anchor="middle" font-size="11" fill="#fff" font-weight="800">' + lbl + '</text>';
  }
  function dtxt(p, col, v) { return '<text x="' + p.x.toFixed(1) + '" y="' + p.y.toFixed(1) + '" text-anchor="middle" font-size="12" font-weight="700" fill="' + col + '">' + fmt(v) + '</text>'; }
  var lBS = midPt(L.db, L.sh, -14, 0), lSI = midPt(L.sh, L.im, 0, 18), lIB = midPt(L.im, L.db, 14, 0);

  var svg = '<svg viewBox="0 0 ' + W + ' ' + H + '" class="ax-triangle-svg" aria-hidden="true">' +
    line(L.db, L.sh, '#2E6B41') + line(L.sh, L.im, '#C7993A') + line(L.im, L.db, '#2A7F7E') +
    node(L.db, '#2E6B41', 'You') + node(L.sh, '#C7993A', 'Shop') + node(L.im, '#2A7F7E', 'Imp') +
    dtxt(lBS, '#2E6B41', aBoyShop) + dtxt(lSI, '#8A6B2E', bShopImp) + dtxt(lIB, '#236866', cImpBoy) +
    '</svg>';

  var overlay = document.getElementById('axTriangleOverlay');
  if (overlay) overlay.remove();
  overlay = document.createElement('div');
  overlay.id = 'axTriangleOverlay';
  overlay.className = 'ax-triangle-overlay';
  overlay.innerHTML =
    '<div class="ax-triangle-box">' +
      '<div class="ax-triangle-head">' +
        '<h3><i class="fa-solid fa-diagram-project"></i> Delivery Triangle</h3>' +
        '<button type="button" class="ax-strip-icon-btn ax-sheet-close" id="axTriangleCloseBtn" aria-label="Close"><i class="fa-solid fa-xmark"></i></button>' +
      '</div>' +
      svg +
      (proportional
        ? '<p class="ax-triangle-scale"><i class="fa-solid fa-ruler"></i> Drawn to scale — the longer a side, the greater the distance.</p>'
        : '<p class="ax-triangle-scale" style="color:#C7993A"><i class="fa-solid fa-location-crosshairs"></i> Tap <b>Apply</b> on the orders page to share your GPS and see all three sides.</p>') +
      '<div class="ax-triangle-rows">' +
        '<div><span><i class="fa-solid fa-person-biking" style="color:#2E6B41;margin-right:6px"></i>You → Shop</span><b>' + fmt(aBoyShop) + '</b></div>' +
        '<div><span><i class="fa-solid fa-store" style="color:#C7993A;margin-right:6px"></i>Shop → Importer</span><b>' + fmt(bShopImp) + '</b></div>' +
        '<div><span><i class="fa-solid fa-location-dot" style="color:#2A7F7E;margin-right:6px"></i>Importer → You</span><b>' + fmt(cImpBoy) + '</b></div>' +
      '</div>' +
    '</div>';
  overlay.addEventListener('click', function (e) { if (e.target === overlay) overlay.remove(); });
  document.body.appendChild(overlay);
  var closeBtn = document.getElementById('axTriangleCloseBtn');
  if (closeBtn) closeBtn.addEventListener('click', function () { overlay.remove(); });
}
window.axShowOrderTriangle = axShowOrderTriangle;

/* ══════════ DISTANCE TRIANGLE (delivery boy / shop / importer) ══════════
   One overlay for all three roles — opened from the delivery strip or the
   track strip. Uses the latest /track payload (pushed by
   portal-enhancements.js into window._axLastTrackData). */
/* Build a triangle whose SIDE LENGTHS are proportional to the three real
   distances (a=DB↔SH, b=SH↔IM, c=IM↔DB), fitted into the WxH SVG box. So if
   Shop→Importer is twice DB→Shop, that side is drawn twice as long. Returns
   null (→ fixed equilateral fallback) when a leg is missing or the triangle
   is degenerate. */
function axTriProportional(a, b, c, W, H, M) {
  if (!(a > 0 && b > 0 && c > 0)) return null;
  if (a + b <= c || b + c <= a || a + c <= b) return null; // triangle inequality
  var dbx = (a * a - c * c + b * b) / (2 * b);
  var dyy = a * a - dbx * dbx;
  if (dyy <= 0) return null;
  var dby = Math.sqrt(dyy);
  var xs = [0, b, dbx], ys = [0, 0, dby];
  var minX = Math.min.apply(null, xs), maxX = Math.max.apply(null, xs);
  var minY = Math.min.apply(null, ys), maxY = Math.max.apply(null, ys);
  var s = Math.min((maxX - minX) ? (W - 2 * M) / (maxX - minX) : 1e9,
    (maxY - minY) ? (H - 2 * M) / (maxY - minY) : 1e9);
  if (!isFinite(s) || s <= 0) return null;
  var usedW = (maxX - minX) * s, offX = M + (W - 2 * M - usedW) / 2;
  var P = function (x, y) { return { x: offX + (x - minX) * s, y: M + (maxY - y) * s }; };
  return { sh: P(0, 0), im: P(b, 0), db: P(dbx, dby) };
}

function axShowTriangle() {
    const data = window._axLastTrackData;
    if (!data) { showToast('Track an order first to see the distance triangle', 'info'); return; }
    const shop = data.pickup && data.pickup.lat ? { lat: +data.pickup.lat, lng: +data.pickup.lng } : null;
    const dest = data.destination && data.destination.lat ? { lat: +data.destination.lat, lng: +data.destination.lng } : null;
    // Prefer live GPS for delivery boy; fall back to last track payload location.
    const boyLive = window._axPartnerPos;
    const boyTrack = data.driver_location && data.driver_location.lat ? { lat: +data.driver_location.lat, lng: +data.driver_location.lng } : null;
    const boy = boyLive || boyTrack;

    const fmt = function (km) { return km == null ? '—' : (km < 10 ? km.toFixed(1) : Math.round(km)) + ' km'; };
    const dist = function (a, b) {
      if (!a || !b) return null;
      if (typeof calculateDistance === 'function') return calculateDistance(a.lat, a.lng, b.lat, b.lng);
      return axHaversine(a.lat, a.lng, b.lat, b.lng);
    };
    const dBoyShop = dist(boy, shop);
    const dShopImp = dist(shop, dest);
    const dImpBoy = dist(dest, boy);

    // First-name helpers keep SVG node labels short.
    function firstName(full) {
      if (!full) return '';
      var f = String(full).trim().split(/\s+/)[0];
      return f.length > 8 ? f.slice(0, 7) + '\u2026' : f;
    }
    const partnerFull = (data.delivery_partner && data.delivery_partner.name) || 'You';
    const buyerFull = data.buyer_name || 'Importer';
    const shopFull = (data.seller_contact && data.seller_contact.name) || (data.pickup && data.pickup.city) || 'Shop';
    const partnerLabel = firstName(partnerFull);
    const buyerLabel = firstName(buyerFull);
    const shopLabel = firstName(shopFull);

    // Missing-coordinates list for the hint note.
    var missingNotes = [];
    if (!boy) missingNotes.push('delivery boy\'s live location');
    if (!shop) missingNotes.push('shop\'s pickup address');
    if (!dest) missingNotes.push('importer\'s delivery address');

    let overlay = document.getElementById('axTriangleOverlay');
    if (overlay) overlay.remove();
    overlay = document.createElement('div');
    overlay.id = 'axTriangleOverlay';
    overlay.className = 'ax-triangle-overlay';
    overlay.innerHTML =
      '<div class="ax-triangle-box">' +
      '<div class="ax-triangle-head">' +
      '<h3><i class="fa-solid fa-diagram-project"></i> Delivery Triangle</h3>' +
      '<button type="button" class="ax-strip-icon-btn ax-sheet-close" id="axTriangleCloseBtn" aria-label="Close"><i class="fa-solid fa-xmark"></i></button>' +
      '</div>' +
      (function () {
        var W = 320, H = 250, M = 50;
        var L = axTriProportional(dBoyShop, dShopImp, dImpBoy, W, H, M) ||
          { db: { x: 160, y: 50 }, sh: { x: 50, y: 210 }, im: { x: 270, y: 210 } };
        var proportional = !!(dBoyShop && dShopImp && dImpBoy && axTriProportional(dBoyShop, dShopImp, dImpBoy, W, H, M));
        function midPt(p, q, dx, dy) { return { x: (p.x + q.x) / 2 + (dx || 0), y: (p.y + q.y) / 2 + (dy || 0) }; }
        var lBS = midPt(L.db, L.sh, -14, 0), lSI = midPt(L.sh, L.im, 0, 18), lIB = midPt(L.im, L.db, 14, 0);
        function line(p, q, col) { return '<line x1="' + p.x.toFixed(1) + '" y1="' + p.y.toFixed(1) + '" x2="' + q.x.toFixed(1) + '" y2="' + q.y.toFixed(1) + '" stroke="' + col + '" stroke-width="2.5" stroke-dasharray="6 5"/>'; }
        function node(p, col, lbl) {
          return '<circle cx="' + p.x.toFixed(1) + '" cy="' + p.y.toFixed(1) + '" r="22" fill="' + col + '"/>' +
            '<text x="' + p.x.toFixed(1) + '" y="' + (p.y + 4.5).toFixed(1) + '" text-anchor="middle" font-size="11" fill="#fff" font-weight="800">' + lbl + '</text>';
        }
        function dtxt(p, col, v) { return '<text x="' + p.x.toFixed(1) + '" y="' + p.y.toFixed(1) + '" text-anchor="middle" font-size="12" font-weight="700" fill="' + col + '">' + fmt(v) + '</text>'; }
        return '<svg viewBox="0 0 ' + W + ' ' + H + '" class="ax-triangle-svg" aria-hidden="true">' +
          line(L.db, L.sh, '#2E6B41') + line(L.sh, L.im, '#C7993A') + line(L.im, L.db, '#2A7F7E') +
          node(L.db, '#2E6B41', partnerLabel || 'You') +
          node(L.sh, '#C7993A', shopLabel || 'Shop') +
          node(L.im, '#2A7F7E', buyerLabel || 'Imp') +
          dtxt(lBS, '#2E6B41', dBoyShop) + dtxt(lSI, '#8A6B2E', dShopImp) + dtxt(lIB, '#236866', dImpBoy) +
          '</svg>' +
          (proportional
            ? '<p class="ax-triangle-scale"><i class="fa-solid fa-ruler"></i> Drawn to scale — longer side = greater distance.</p>'
            : (missingNotes.length
              ? '<p class="ax-triangle-scale" style="color:#C7993A"><i class="fa-solid fa-triangle-exclamation"></i> Approximate — missing: ' + missingNotes.join(', ') + '.</p>'
              : ''));
      })() +
      '<div class="ax-triangle-legend">' +
      '<div><span class="ax-tri-dot" style="background:#2E6B41"></span> <b>' + mpEscDelivery(partnerFull) + '</b> <span style="opacity:.7">(delivery boy · live GPS)</span></div>' +
      '<div><span class="ax-tri-dot" style="background:#C7993A"></span> <b>' + mpEscDelivery(shopFull) + '</b> <span style="opacity:.7">(shop · permanent address)</span></div>' +
      '<div><span class="ax-tri-dot" style="background:#2A7F7E"></span> <b>' + mpEscDelivery(buyerFull) + '</b> <span style="opacity:.7">(importer · order address)</span></div>' +
      '</div>' +
      '<div class="ax-triangle-rows">' +
      '<div><span><i class="fa-solid fa-person-biking" style="color:#2E6B41;margin-right:6px"></i>You \u2192 Shop</span><b>' + fmt(dBoyShop) + '</b></div>' +
      '<div><span><i class="fa-solid fa-store" style="color:#C7993A;margin-right:6px"></i>Shop \u2192 Importer</span><b>' + fmt(dShopImp) + '</b></div>' +
      '<div><span><i class="fa-solid fa-location-dot" style="color:#2A7F7E;margin-right:6px"></i>Importer \u2192 You</span><b>' + fmt(dImpBoy) + '</b></div>' +
      '</div>' +
      (missingNotes.length
        ? '<p class="ax-triangle-note"><i class="fa-solid fa-circle-info"></i> ' +
        (!boy ? 'Tap <b>Apply</b> in the radius card to share your live GPS. ' : '') +
        (!dest ? 'Importer needs to update their delivery address. ' : '') +
        (!shop ? 'Shop pickup address is not set yet. ' : '') +
        '</p>'
        : '') +
      '</div>';
    overlay.addEventListener('click', function (e) { if (e.target === overlay) overlay.remove(); });
    document.body.appendChild(overlay);
    const closeBtn = document.getElementById('axTriangleCloseBtn');
    if (closeBtn) closeBtn.addEventListener('click', function () { overlay.remove(); });
  }

  /* Circular call + in-app message buttons for a contact row / strip. Call is a
     tel: link; message opens our own messenger (axOpenChat) so there is no SMS
     cost and the chat history is kept. Buttons only render when we have the data
     to make them work (a phone for call, a user sub for message). */
  function axContactActions(c) {
    var html = '<span class="ax-contact-actions">';
    if (c.phone) {
      html += '<a class="ax-contact-btn ax-contact-btn-call" href="tel:' + mpEscDelivery(c.phone) + '" title="Call ' + mpEscDelivery(c.name) + '" aria-label="Call"><i class="fa-solid fa-phone"></i></a>';
    }
    if (c.sub) {
      html += '<button type="button" class="ax-contact-btn ax-contact-btn-msg" title="Message ' + mpEscDelivery(c.name) + '" aria-label="Message" onclick="axMsgContact(\'' + mpEscDelivery(c.sub) + '\',\'' + mpEscDelivery((c.name || '').replace(/'/g, '')) + '\',\'' + mpEscDelivery(c.photo || '') + '\')"><i class="fa-solid fa-comment-dots"></i></button>';
    }
    if (!c.phone && !c.sub) {
      html += '<span class="ax-contact-btn ax-contact-btn-na" title="No contact yet"><i class="fa-solid fa-user-slash"></i></span>';
    }
    return html + '</span>';
  }

  /* Trust meta for a delivery partner: star rating + vehicle number. Shown under
     the delivery-boy name on the importer's Track strip (Zomato/Swiggy-style). */
  function axDriverMeta(dp) {
    if (!dp) return '';
    var parts = [];
    var r = Number(dp.rating || 0);
    if (r > 0) parts.push('<span class="ax-cmeta"><i class="fa-solid fa-star"></i> ' + r.toFixed(1) + (dp.rating_count ? ' (' + dp.rating_count + ')' : '') + '</span>');
    if (dp.vehicle) parts.push('<span class="ax-cmeta"><i class="fa-solid fa-motorcycle"></i> ' + mpEscDelivery(dp.vehicle) + '</span>');
    return parts.length ? '<span class="ax-contact-meta">' + parts.join('') + '</span>' : '';
  }

  /* Google-Maps turn-by-turn deep link (opens the Maps app on mobile). */
  function axNavHref(lat, lng) {
    return 'https://www.google.com/maps/dir/?api=1&destination=' + lat + ',' + lng + '&travelmode=driving';
  }

  /* Open the in-app messenger thread with a party. */
  function axMsgContact(sub, name, photo) {
    if (!sub) { if (typeof showToast === 'function') showToast('This user is not reachable yet', 'info'); return; }
    if (typeof axOpenChat === 'function') { axOpenChat(sub, name || 'Chat', photo || ''); return; }
    if (typeof axOpenMessages === 'function') { axOpenMessages(); return; }
    if (typeof showToast === 'function') showToast('Messenger is loading — try again', 'info');
  }

  /* Short, friendly timestamp for the tracking timeline: "26 Jul, 2:02 PM". */
  function axFmtTime(iso) {
    if (!iso) return '';
    var d = new Date(iso);
    if (isNaN(d.getTime())) return '';
    try {
      return d.toLocaleString('en-IN', { day: 'numeric', month: 'short', hour: 'numeric', minute: '2-digit', hour12: true });
    } catch (e) { return d.toLocaleString(); }
  }

  function axRupee(n) {
    var v = Number(n || 0);
    try { return '₹' + v.toLocaleString('en-IN', { maximumFractionDigits: 2 }); }
    catch (e) { return '₹' + v; }
  }

  /* Amount + payment card for the importer's Track view. Replaces the old
     duplicate product card (product / ARN / status already live in the strip) —
     this instead surfaces the ONE thing that was missing: how much, and whether
     it's already paid or due on delivery (COD). */
  window.axTrackAmountCard = function (pay) {
    if (!pay) return '';
    var isCod = !!pay.is_cod;
    var badge = isCod
      ? '<span class="ax-tam-badge ax-tam-cod"><i class="fa-solid fa-money-bill-wave"></i> Cash on Delivery' +
      (pay.amount_due ? ' — ' + axRupee(pay.amount_due) + ' due' : '') + '</span>'
      : '<span class="ax-tam-badge ax-tam-paid"><i class="fa-solid fa-circle-check"></i> Paid online</span>';
    var b = pay.breakdown || {};
    var rows = [
      ['Item value', b.item], ['GST', b.gst], ['Delivery', b.delivery], ['Platform fee', b.platform]
    ].filter(function (r) { return Number(r[1] || 0) > 0; });
    var details = rows.length
      ? '<details class="ax-tam-details"><summary>Price breakdown</summary>' +
      rows.map(function (r) { return '<div class="ax-tam-brow"><span>' + r[0] + '</span><b>' + axRupee(r[1]) + '</b></div>'; }).join('') +
      '</details>'
      : '';
    return '<div class="ax-track-amount">' +
      '<div class="ax-tam-top">' +
      '<span class="ax-tam-label"><i class="fa-solid fa-wallet"></i> Order amount</span>' +
      '<span class="ax-tam-value">' + axRupee(pay.amount) + '</span>' +
      '</div>' + badge + details +
      '</div>';
  };

  /* Vertical stepper timeline with per-stage timestamps (replaces the flat dot
     list). Done steps are filled green with a connector line; pending are hollow. */
  window.axRenderTrackTimeline = function (steps) {
    if (!Array.isArray(steps) || !steps.length) return '';
    return '<div class="ax-tl">' + steps.map(function (s) {
      var t = axFmtTime(s.at);
      return '<div class="ax-tl-step' + (s.done ? ' done' : '') + '">' +
        '<span class="ax-tl-dot"><i class="fa-solid ' + (s.done ? 'fa-check' : 'fa-circle') + '"></i></span>' +
        '<div class="ax-tl-body"><b>' + mpEscDelivery(s.step) + '</b>' +
        (t ? '<small>' + t + '</small>' : '') + '</div>' +
        '</div>';
    }).join('') + '</div>';
  };

  /* ══════════ TRACK-TAB STRIP (importer / shop keeper / delivery boy) ══════════ */
  window.axRenderTrackStrip = function (data) {
    const strip = document.getElementById('axTrackStrip');
    if (!strip || !data) return;
    strip.style.display = 'block';
    const set = function (id, txt) { const el = document.getElementById(id); if (el) el.textContent = txt; };
    set('axTrackStripProduct', data.product_name || 'Order');
    set('axTrackStripArn', data.arn || '');
    set('axTrackStripStatus', String(data.status || '—').replace(/_/g, ' '));
    // "Arrived" once the partner is at the door (same threshold as the driver
    // strip) — avoids the awkward "0 km away / 0 min ETA".
    var _km = data.distance_remaining_km;
    var _arrived = (_km != null && _km <= 0.12) ||
      ['NEAR_DESTINATION', 'ARRIVED'].indexOf(data.status) !== -1;
    strip.classList.toggle('ax-arrived', _arrived);
    set('axTrackStripKm', _arrived ? 'Arrived' : (_km != null ? _km + ' km' : '-- km'));
    set('axTrackStripEta', _arrived ? 'Doorstep' : (data.eta_minutes != null ? data.eta_minutes + ' min' : '-- min'));
    // The importer is the one viewing this Track tab — showing them their OWN
    // contact is pointless, so only the OTHER two parties appear here:
    // shop keeper + delivery boy. Each gets a circular call button and an
    // in-app message button (our own messenger — no SMS cost).
    const contacts = [];
    if (data.seller_contact) contacts.push({ icon: 'fa-store', label: 'Shop keeper', name: data.seller_contact.name || '—', phone: data.seller_contact.phone || '', sub: data.seller_contact.sub || '', photo: data.seller_contact.photo || '', meta: (data.pickup && (data.pickup.address || data.pickup.city)) ? '<span class="ax-contact-meta"><span class="ax-cmeta"><i class="fa-solid fa-location-dot"></i> ' + mpEscDelivery(data.pickup.address || data.pickup.city) + '</span></span>' : '' });
    if (data.delivery_partner) contacts.push({ icon: 'fa-truck-fast', label: 'Delivery boy', name: data.delivery_partner.name || '—', phone: data.delivery_partner.phone || '', sub: data.delivery_partner.sub || '', photo: data.delivery_partner.photo || '', meta: axDriverMeta(data.delivery_partner) });
    const wrap = document.getElementById('axTrackStripContacts');
    if (wrap) {
      wrap.innerHTML = contacts.map(function (c) {
        return '<div class="ax-contact-row">' +
          '<span class="ax-contact-icon"><i class="fa-solid ' + c.icon + '"></i></span>' +
          '<span class="ax-contact-text"><small>' + c.label + '</small><b>' + mpEscDelivery(c.name) + '</b>' + (c.meta || '') + '</span>' +
          axContactActions(c) +
          '</div>';
      }).join('') || '<div class="ax-contact-row"><span class="ax-contact-text"><small>Contacts appear once a delivery partner claims this order.</small></span></div>';
    }
    // Cancel makes no sense once delivered/cancelled.
    const cancelBtn = document.getElementById('axTrackCancelBtn');
    if (cancelBtn) cancelBtn.style.display = (data.status === 'COMPLETED' || data.status === 'CANCELLED') ? 'none' : '';
  };

  /* Cancel from the Track tab — the backend decides which of the three
     parties you are (importer / shop keeper / delivery partner) and
     notifies the others. Falls back to /order/cancel for pre-claim
     importer cancels. */
  async function axCancelTrackedOrder() {
    const input = document.getElementById('trackARN');
    const arn = ((input && input.value) || (window._axLastTrackData && window._axLastTrackData.arn) || '').trim();
    if (!arn) { showToast('Track an order first', 'error'); return; }
    if (!confirm('Cancel order ' + arn + '? All parties will be notified.')) return;
    let data = await mpApi('/delivery/cancel', { method: 'POST', body: JSON.stringify({ arn: arn }) });
    if (!data || !data.success) {
      const fallback = await mpApi('/order/cancel', { method: 'POST', body: JSON.stringify({ arn: arn }) });
      if (fallback && fallback.success) data = fallback;
      else if (fallback && fallback.error) data = fallback;
    }
    if (data && data.success) {
      showToast('Order cancelled — booking released', 'success');
      if (typeof trackOrder === 'function') trackOrder();
      if (typeof axInvalidateCatalogue === 'function') axInvalidateCatalogue();
    } else {
      showToast((data && data.error) || 'Could not cancel this order', 'error');
    }
  }

  /* Second product? Reset the lookup so another ARN can be tracked without
     reloading the page. */
  function axTrackAnother() {
    const input = document.getElementById('trackARN');
    const result = document.getElementById('trackResult');
    const strip = document.getElementById('axTrackStrip');
    if (result) result.style.display = 'none';
    if (strip) strip.style.display = 'none';
    if (typeof PortalEnhancements !== 'undefined' && PortalEnhancements.stopTrackPolling) {
      try { PortalEnhancements.stopTrackPolling(); } catch (e) { }
    }
    if (input) { input.value = ''; input.focus(); }
    window.scrollTo(0, 0);
  }

  /* Notification "Track live" button — closes the notification panel/sheet and
     jumps straight into the Track tab with the ARN filled in and the live map
     opening (used by catalogue-ui.js). */
  function axOpenTrackFromNotif(arn) {
    // Close whatever notification surface is open so the user lands directly on
    // the live map instead of the map appearing behind the notification sheet.
    try { if (typeof axCloseNotifSheet === 'function') axCloseNotifSheet(); } catch (e) { }
    try {
      if (typeof PortalEnhancements !== 'undefined' && typeof PortalEnhancements.closeNotificationPanel === 'function') {
        PortalEnhancements.closeNotificationPanel();
      }
    } catch (e) { }
    const ov = document.getElementById('axNotifOverlay'); if (ov) ov.remove();
    const pop = document.getElementById('notifAlertPopup'); if (pop) pop.style.display = 'none';
    document.body.style.overflow = '';
    if (typeof switchPanel === 'function') switchPanel('track');
    const input = document.getElementById('trackARN');
    if (input) input.value = arn || '';
    if (typeof trackOrder === 'function') trackOrder();
    // Open straight into the full-screen live map (same view the map's own
    // expand icon gives). Wait until the map wrap is actually shown, then
    // toggle once — guarded so we never double-fire or get stuck retrying.
    axAutoFullscreenTrackMap();
  }

  function axAutoFullscreenTrackMap() {
    let tries = 0;
    const timer = setInterval(function () {
      tries++;
      const wrap = document.getElementById('trackMapWrap');
      const visible = wrap && wrap.offsetParent !== null &&
        getComputedStyle(wrap).display !== 'none';
      if (visible && !wrap.classList.contains('fullscreen')) {
        clearInterval(timer);
        if (typeof toggleTrackMapFullscreen === 'function') {
          toggleTrackMapFullscreen();
          if (typeof axSyncMapFsBtn === 'function') axSyncMapFsBtn('trackMapWrap', 'trackMapFsBtn');
        }
      } else if (wrap && wrap.classList.contains('fullscreen')) {
        clearInterval(timer);           // already fullscreen — nothing to do
      } else if (tries > 40) {
        clearInterval(timer);           // ~10s guard: order may have no live map
      }
    }, 250);
  }

  /* ══════════ CLAIM CARD ACTIONS (skip / claim) ══════════
     These are lightweight stubs; the real claim logic lives in
     portal-enhancements.js / mpClaimOrder.  We only expose the names
     so axRenderClaimCard's onclick attributes resolve. */
  function axSkipClaimCard(arn) {
    // Hide the card optimistically; portal-enhancements will rebuild the list.
    var card = document.querySelector('.ax-claim-card[data-arn="' + arn + '"]');
    if (card) card.remove();
    if (typeof mpSkipOrder === 'function') { try { mpSkipOrder(arn); } catch (e) { } }
  }
  function axClaimOrder(arn) {
    if (typeof mpClaimOrder === 'function') { try { mpClaimOrder(arn); } catch (e) { } }
    else if (typeof claimOrder === 'function') { try { claimOrder(arn); } catch (e) { } }
    else showToast('Claim order: ' + arn, 'info');
  }
  window.axSkipClaimCard = axSkipClaimCard;
  window.axClaimOrder = axClaimOrder;

  /* ══════════ FULLSCREEN HELPER — expose state for CSS class toggle ══════════
     body.ax-delivery-fs is already managed by toggleDeliveryFullscreen()
     (portal-enhancements.js).  This util lets any caller query / force the
     header-suppression class without duplicating that logic. */
  function axIsDeliveryFullscreen() {
    return document.body.classList.contains('ax-delivery-fs');
  }
  function axSyncDeliveryFsHeader() {
    // In fullscreen, collapse the journey-strip to just the status bar so
    // the map gets maximum screen space.  The CSS rule for
    //   body.ax-delivery-fs #deliveryInfoCard .ax-journey-name-row
    // handles the visual hide; this function just ensures the strip isn't
    // force-expanded in JS while fullscreen.
    const strip = document.getElementById('deliveryInfoCard');
    if (!strip) return;
    if (axIsDeliveryFullscreen()) {
      strip.classList.add('ax-fs-strip');
    } else {
      strip.classList.remove('ax-fs-strip');
    }
  }
  window.axSyncDeliveryFsHeader = axSyncDeliveryFsHeader;

  /* Patch toggleDeliveryFullscreen (if loaded) to also call our sync. */
  (function () {
    var _orig = window.toggleDeliveryFullscreen;
    if (typeof _orig === 'function') {
      window.toggleDeliveryFullscreen = function () {
        _orig.apply(this, arguments);
        axSyncDeliveryFsHeader();
      };
    }
  })();

  /* ── Dark mode ── head inline script applied the saved theme pre-paint;
     this just flips + persists it and keeps the drawer row's label live. */
  function axSyncThemeUi() {
    const dark = document.documentElement.getAttribute('data-theme') === 'dark';
    const icon = document.getElementById('axThemeIcon');
    const label = document.getElementById('axThemeLabel');
    if (icon) icon.className = dark ? 'fa-solid fa-sun' : 'fa-solid fa-moon';
    if (label) label.textContent = dark ? 'Light' : 'Dark';
    const meta = document.querySelector('meta[name="theme-color"]');
    if (meta) meta.setAttribute('content', dark ? '#121714' : '#143026');
  }
  function axToggleTheme() {
    const dark = document.documentElement.getAttribute('data-theme') === 'dark';
    if (dark) document.documentElement.removeAttribute('data-theme');
    else document.documentElement.setAttribute('data-theme', 'dark');
    try { localStorage.setItem('ax_theme', dark ? 'light' : 'dark'); } catch (e) { }
    axSyncThemeUi();
    // Live delivery/track maps swap to matching light/dark tiles.
    try { if (typeof window.axRetileMaps === 'function') window.axRetileMaps(); } catch (e) { }
  }
  document.addEventListener('DOMContentLoaded', axSyncThemeUi);

/* ---------- EXPORT ALL MISSING FUNCTIONS TO WINDOW ---------- */
window.axOpenDeliveryClaimsView = axOpenDeliveryClaimsView;
window.axCloseDeliveryClaimsView = axCloseDeliveryClaimsView;
window.axPauseJourneyView = axPauseJourneyView;
window.axResumeJourneyView = axResumeJourneyView;
window.axSaveVehicleNumber = axSaveVehicleNumber;
window.axApplyDeliveryRadius = axApplyDeliveryRadius;
window.axToggleTheme = axToggleTheme;
window.axToggleJourneyStrip = axToggleJourneyStrip;
window.axActivateJourneyUi = axActivateJourneyUi;
window.axDeactivateJourneyUi = axDeactivateJourneyUi;
window.axOpenJourneyMap = axOpenJourneyMap;
window.axShowTriangle = axShowTriangle;
window.axToggleDeliverySheet = axToggleDeliverySheet;
window.axSetDeliverySheet = axSetDeliverySheet;
window.axCancelTrackedOrder = axCancelTrackedOrder;
window.axTrackAnother = axTrackAnother;
window.axOpenTrackFromNotif = axOpenTrackFromNotif;

/* ---------- EXPORT ALL MISSING FUNCTIONS TO WINDOW ---------- */
window.axOpenDeliveryClaimsView = axOpenDeliveryClaimsView;
window.axCloseDeliveryClaimsView = axCloseDeliveryClaimsView;
window.axPauseJourneyView = axPauseJourneyView;
window.axResumeJourneyView = axResumeJourneyView;
window.axSaveVehicleNumber = axSaveVehicleNumber;
window.axApplyDeliveryRadius = axApplyDeliveryRadius;
window.axToggleTheme = axToggleTheme;
window.axToggleJourneyStrip = axToggleJourneyStrip;
window.axActivateJourneyUi = axActivateJourneyUi;
window.axDeactivateJourneyUi = axDeactivateJourneyUi;
window.axOpenJourneyMap = axOpenJourneyMap;
window.axShowTriangle = axShowTriangle;
window.axToggleDeliverySheet = axToggleDeliverySheet;
window.axSetDeliverySheet = axSetDeliverySheet;
window.axCancelTrackedOrder = axCancelTrackedOrder;
window.axTrackAnother = axTrackAnother;
window.axOpenTrackFromNotif = axOpenTrackFromNotif;
