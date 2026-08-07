/* Aarvex Portal — Delivery Partner tab (claim, GPS, OTP complete) */
'use strict';

let mpActiveDeliveryArn = null;
let mpGpsWatchId = null;
let mpLastGpsPosition = null;
let mpGpsSignalStrength = 'unknown';
let mpMapFullscreen = false;

function mpShowDeliveryNav(show) {
  const nav = document.getElementById('navDelivery');
  const mobile = document.getElementById('mobileNavDelivery');
  if (nav) nav.style.display = show ? '' : 'none';
  if (mobile) mobile.style.display = show ? '' : 'none';
}

async function mpLoadDeliveryDashboard() {
  const ordersEl = document.getElementById('deliveryOrdersList');
  const earnEl = document.getElementById('deliveryEarningsSummary');
  if (!ordersEl) return;
  ordersEl.innerHTML = '<p style="color:var(--c-text3);padding:16px">Loading…</p>';
  // Radius filter: partner-set radius (km) + their GPS position → the
  // backend filters partner→shop; the shop→importer leg is checked
  // client-side below against the same radius (the "delivery triangle").
  const radiusKm = parseFloat(localStorage.getItem('ax_delivery_radius_km') ||
    (window.userProfile && window.userProfile.delivery_radius_km) || '0') || 0;
  let ordersUrl = '/delivery/orders';
  if (radiusKm > 0 && window._axPartnerPos) {
    ordersUrl += '?lat=' + window._axPartnerPos.lat + '&lng=' + window._axPartnerPos.lng + '&radius_km=' + radiusKm;
  }
  const [ordersData, earnData, claimsData] = await Promise.all([
    mpApi(ordersUrl),
    mpApi('/delivery/earnings'),
    mpApi('/delivery/my-claims'),
  ]);
  const openClaims = (claimsData && claimsData.claims) || [];
  if (earnEl) {
    const completed = earnData?.completed_deliveries || 0;
    const earned = earnData?.total_earned_inr || 0;
    const pending = earnData?.pending_deliveries || 0;
    earnEl.innerHTML = `
      <div class="dash-stats">
        <div class="stat-card gold" style="border-color:rgba(199,153,58,.3)">
          <div class="stat-icon gold"><i class="fa-solid fa-indian-rupee-sign"></i></div>
          <div class="stat-value">₹${earned.toLocaleString('en-IN')}</div>
          <div class="stat-label">Total Earned</div>
        </div>
        <div class="stat-card green">
          <div class="stat-icon green"><i class="fa-solid fa-circle-check"></i></div>
          <div class="stat-value">${completed.toLocaleString('en-IN')}</div>
          <div class="stat-label">Completed</div>
        </div>
        <div class="stat-card blue">
          <div class="stat-icon blue"><i class="fa-solid fa-truck-fast"></i></div>
          <div class="stat-value">${pending.toLocaleString('en-IN')}</div>
          <div class="stat-label">In Progress</div>
        </div>
      </div>
      ${openClaims.length ? `
      <button type="button" class="btn-secondary btn-sm" onclick="mpOpenPendingClaimsPanel()" style="margin-top:12px;width:100%;border-color:rgba(217,54,68,.35);color:var(--c-red,#D93644)">
        <i class="fa-solid fa-triangle-exclamation"></i> ${openClaims.length} pending claim${openClaims.length > 1 ? 's' : ''} — close before claiming a new order
      </button>` : `
      <button type="button" class="btn-secondary btn-sm" onclick="mpOpenPendingClaimsPanel()" style="margin-top:12px;width:100%">
        <i class="fa-solid fa-list-check"></i> My pending claims
      </button>`}
    `;
  }
  let orders = ordersData.orders || [];
  // Second leg of the delivery triangle: shop → importer must ALSO be
  // inside the partner's radius (distance_km on the order is exactly that
  // leg). Orders with unknown distance are never silently hidden.
  let triangleFiltered = 0;
  if (radiusKm > 0) {
    const before = orders.length;
    orders = orders.filter(function (o) {
      const d = parseFloat(o.distance_km);
      return !d || d <= radiusKm;
    });
    triangleFiltered = before - orders.length;
  }
  const statusEl = document.getElementById('deliveryRadiusStatus');
  if (statusEl) {
    const hiddenTotal = (ordersData.outside_radius_count || 0) + triangleFiltered;
    statusEl.style.display = radiusKm > 0 ? '' : 'none';
    statusEl.innerHTML = radiusKm > 0
      ? '<i class="fa-solid fa-filter"></i> Radius ' + radiusKm + ' km active' +
        (window._axPartnerPos ? '' : ' — tap Apply to share your location') +
        (hiddenTotal ? ' · ' + hiddenTotal + ' order' + (hiddenTotal > 1 ? 's' : '') + ' hidden (outside radius)' : '')
      : '';
  }
  // Home-view door: live count on the "Available Orders" button.
  const countEl = document.getElementById('deliveryOrdersOpenCount');
  if (countEl) countEl.textContent = orders.length
    ? orders.length + ' order' + (orders.length > 1 ? 's' : '') + ' available to claim'
    : 'No claimable orders right now';
  // While a delivery is running, claims are view-only (pause mode).
  const claimLocked = !!mpActiveDeliveryArn || openClaims.length > 0;
  if (!orders.length) {
    ordersEl.innerHTML = `
      <div class="orders-empty orders-empty-delivery">
        <div class="orders-empty-icon"><i class="fa-solid fa-truck-fast"></i></div>
        <h4>No delivery orders${radiusKm > 0 ? ' in your radius' : ' yet'}</h4>
        <p>New delivery jobs appear here as soon as buyer payment is confirmed.${radiusKm > 0 ? ' Try a bigger radius.' : ''}</p>
      </div>
    `;
    return;
  }
  ordersEl.innerHTML = orders.map(function (o) {
    // B4: real product photo (bigger) instead of a generic box icon.
    const media = o.product_image
      ? '<div class="ax-claim-card-photo"><img src="' + mpEscDelivery(o.product_image) + '" alt="" loading="lazy"></div>'
      : '<div class="ax-claim-card-icon"><i class="fa-solid fa-box"></i></div>';
    // Card face shows only the pickup leg (You → Shop) — the one distance a
    // partner needs to gauge the run. The full three-sided triangle (incl. the
    // shop → importer leg) lives behind the Triangle button so the card stays
    // scannable and the importer's leg isn't advertised inline.
    const pickupLeg = (o.pickup_distance_km != null)
      ? '<span class="ax-leg"><i class="fa-solid fa-person-biking"></i> You → Shop <b>' + o.pickup_distance_km + ' km</b></span>'
      : '<span class="ax-leg ax-leg-muted"><i class="fa-solid fa-location-crosshairs"></i> Tap Apply to share GPS</span>';
    const triArgs = '{pickup_distance_km:' + (o.pickup_distance_km == null ? 'null' : Number(o.pickup_distance_km)) +
      ',shop_to_importer_km:' + (o.shop_to_importer_km == null ? 'null' : Number(o.shop_to_importer_km)) +
      ',dest_distance_km:' + (o.dest_distance_km == null ? 'null' : Number(o.dest_distance_km)) + '}';
    const triBtn = (typeof axShowOrderTriangle === 'function')
      ? '<button type="button" class="ax-tri-btn" onclick="axShowOrderTriangle(' + triArgs + ')" title="View delivery triangle" aria-label="View delivery triangle"><i class="fa-solid fa-diagram-project"></i> Triangle</button>'
      : '';
    return '<div class="ax-claim-card">' +
      '<div class="ax-claim-card-top">' + media +
        '<div class="ax-claim-card-info">' +
          '<strong>' + mpEscDelivery(o.product_name || 'Order') + '</strong>' +
          '<small>' + mpEscDelivery(o.pickup_city || '—') + ' <i class="fa-solid fa-arrow-right-long"></i> ' + mpEscDelivery(o.delivery_city || '—') + '</small>' +
        '</div>' +
        '<div class="ax-claim-card-earn">₹' + (o.estimated_earning || 0) + '<small>earning</small></div>' +
      '</div>' +
      '<div class="ax-claim-legs-grid">' + pickupLeg + triBtn + '</div>' +
      '<div class="ax-claim-card-actions">' +
        '<button type="button" class="btn-sm-outline" onclick="mpRejectDelivery(\'' + o.arn + '\')" style="color:var(--c-red,#D93644);border-color:rgba(217,54,68,.3)">Skip</button>' +
        (claimLocked
          ? '<button type="button" class="btn-primary btn-sm" disabled title="Finish your current delivery first" style="opacity:.5;cursor:not-allowed"><i class="fa-solid fa-lock"></i> Claim</button>'
          : '<button type="button" class="btn-primary btn-sm" onclick="mpClaimDelivery(\'' + o.arn + '\')"><i class="fa-solid fa-hand-pointer"></i> Claim</button>') +
      '</div>' +
    '</div>';
  }).join('');
}

async function mpClaimDelivery(arn) {
  const radiusKm = parseFloat(localStorage.getItem('ax_delivery_radius_km') ||
    (window.userProfile && window.userProfile.delivery_radius_km) || '0') || 0;
  let claimBody = { arn: arn, radius_km: radiusKm };
  if (radiusKm > 0) {
    if (!navigator.geolocation) { showToast('Live location is required to claim within your radius', 'error'); return; }
    try {
      const pos = await new Promise(function(resolve, reject) {
        navigator.geolocation.getCurrentPosition(resolve, reject, { enableHighAccuracy: true, timeout: 12000, maximumAge: 15000 });
      });
      window._axPartnerPos = { lat: pos.coords.latitude, lng: pos.coords.longitude };
      claimBody.partner_lat = pos.coords.latitude;
      claimBody.partner_lng = pos.coords.longitude;
    } catch (e) {
      showToast('Could not confirm your live location. Enable GPS and try again.', 'error');
      return;
    }
  }
  const data = await mpApi('/delivery/claim', { method: 'POST', body: JSON.stringify(claimBody) });
  // D3: shop's own-team control — an outside partner's claim waits for the
  // shop / importer to approve. Show that clearly instead of "claimed".
  if (data && data.pending_approval) {
    if (typeof axHaptic === 'function') axHaptic('light');
    showToast('Claim sent — waiting for the shop/importer to approve you', 'info');
    if (typeof mpLoadDeliveryDashboard === 'function') mpLoadDeliveryDashboard();
    return;
  }
  if (data.success) {
    mpActiveDeliveryArn = arn;
    showToast('Claimed! Tracking key: ' + data.tracking_key, 'success');
    
    // Sync values to both map overlay and fallback form
    const mainArn = document.getElementById('deliveryActiveArn');
    const fallbackArn = document.getElementById('deliveryActiveArnFallback');
    const mainKey = document.getElementById('deliveryTrackingKey');
    const fallbackKey = document.getElementById('deliveryTrackingKeyFallback');
    
    if (mainArn) mainArn.value = arn;
    if (fallbackArn) fallbackArn.value = arn;
    if (mainKey) mainKey.value = data.tracking_key || '';
    if (fallbackKey) fallbackKey.value = data.tracking_key || '';
    
    document.getElementById('deliveryActivePanel').style.display = '';
    axCloseDeliveryClaimsView();
    const buyerBox = document.getElementById('deliveryBuyerInfo');
    if (buyerBox) {
      buyerBox.innerHTML = data.buyer_name
        ? '<i class="fa-solid fa-user"></i> Deliver to: <strong>' + data.buyer_name + '</strong>' + (data.buyer_mobile ? ' · <a href="tel:' + data.buyer_mobile + '">' + data.buyer_mobile + '</a>' : '')
        : '';
    }
    mpLoadDeliveryDashboard();
  } else if (data.pending_claims && data.pending_claims.length) {
    showToast(data.error || 'Finish your existing delivery before claiming a new one', 'error');
    mpOpenPendingClaimsPanel();
  } else showToast(data.error || 'Could not claim', 'error');
}

async function mpStartDeliveryJourney() {
  const arn = document.getElementById('deliveryActiveArn')?.value?.trim();
  const key = document.getElementById('deliveryTrackingKey')?.value?.trim();
  if (!arn || !key) { showToast('ARN and tracking key required', 'error'); return; }
  
  // Show loading state
  showMapLoading();
  updateConnectionStatus(true);
  
  const data = await mpApi('/delivery/start', { method: 'POST', body: JSON.stringify({ arn: arn, tracking_key: key }) });
  if (data.success) {
    showToast('Journey started — GPS tracking on', 'success');
    mpActiveDeliveryArn = arn;
    axActivateJourneyUi();
    mpStartGpsPush(arn);
    
    // Show map when journey starts
    const mapWrap = document.getElementById('deliveryMapWrap');
    const fallbackForm = document.getElementById('deliveryFallbackForm');
    const fallbackButtons = document.getElementById('deliveryFallbackButtons');
    const fallbackOtp = document.getElementById('deliveryFallbackOtp');
    const fallbackCompleteBtn = document.getElementById('deliveryFallbackCompleteBtn');
    const toggleBtn = document.getElementById('deliveryMapToggleBtn');
    const mapControlButtons = document.getElementById('deliveryMapControlButtons');
    
    if (mapWrap) {
      mapWrap.style.display = 'block';
      // Trigger map resize after display to ensure proper rendering
      setTimeout(function() {
        hideMapLoading();
        // Auto-open the live map fullscreen the moment the journey starts, so
        // the driver gets the navigation view immediately (detail strip on top,
        // OTP/complete controls at the bottom, exit button bottom-right).
        if (!mapWrap.classList.contains('fullscreen') && typeof toggleDeliveryFullscreen === 'function') {
          toggleDeliveryFullscreen();
          if (typeof axSyncMapFsBtn === 'function') axSyncMapFsBtn('deliveryMapWrap', 'deliveryMapFsBtn');
        }
        if (typeof PortalEnhancements !== 'undefined' && PortalEnhancements.startDeliveryPolling) {
          PortalEnhancements.startDeliveryPolling(arn);
        }
      }, 100);
    }
    if (fallbackForm) fallbackForm.style.display = 'none';
    if (fallbackButtons) fallbackButtons.style.display = 'none';
    if (fallbackOtp) fallbackOtp.style.display = 'none';
    if (fallbackCompleteBtn) fallbackCompleteBtn.style.display = 'none';
    
    // Show toggle button and map control buttons when map is active
    if (toggleBtn) toggleBtn.style.display = 'block';
    if (mapControlButtons) mapControlButtons.style.display = 'flex';
    
    if (typeof PortalEnhancements !== 'undefined' && PortalEnhancements.startDeliveryPolling) {
      PortalEnhancements.startDeliveryPolling(arn);
    }
  } else {
    showToast(data.error || 'Start failed', 'error');
    showMapError(data.error || 'Failed to start journey');
    updateConnectionStatus(false);
  }
}

function toggleDeliveryMapControls() {
  const controls = document.getElementById('deliveryMapControlsOverlay');
  const icon = document.getElementById('deliveryMapToggleIcon');
  const text = document.getElementById('deliveryMapToggleText');
  
  if (controls) {
    const isHidden = controls.classList.toggle('hidden');
    if (icon) {
      icon.className = isHidden ? 'fa-solid fa-eye-slash' : 'fa-solid fa-eye';
    }
    if (text) {
      text.textContent = isHidden ? 'Show Controls' : 'Hide Controls';
    }
  }
}

function mpStartGpsPush(arn) {
  if (!navigator.geolocation) { 
    showToast('GPS not supported on this device', 'warning');
    updateGpsSignalStatus('offline');
    return; 
  }
  if (mpGpsWatchId) navigator.geolocation.clearWatch(mpGpsWatchId);
  mpGpsWatchId = navigator.geolocation.watchPosition(function (pos) {
    // Calculate speed if available
    const speed = pos.coords.speed ? (pos.coords.speed * 3.6).toFixed(0) : 0; // m/s to km/h
    updateSpeedIndicator(speed);
    
    // Update GPS signal strength
    const accuracy = pos.coords.accuracy;
    if (accuracy < 10) {
      updateGpsSignalStatus('strong');
    } else if (accuracy < 50) {
      updateGpsSignalStatus('weak');
    } else {
      updateGpsSignalStatus('poor');
    }
    
    // Store last position for speed calculation
    if (mpLastGpsPosition && pos.coords.speed === null) {
      const timeDiff = (pos.timestamp - mpLastGpsPosition.timestamp) / 1000; // seconds
      if (timeDiff > 0) {
        const distance = calculateDistance(mpLastGpsPosition.coords.latitude, mpLastGpsPosition.coords.longitude, pos.coords.latitude, pos.coords.longitude);
        const calculatedSpeed = (distance / timeDiff * 3600).toFixed(0); // km/h
        updateSpeedIndicator(calculatedSpeed);
      }
    }
    mpLastGpsPosition = pos;
    
    mpApi('/delivery/location', {
      method: 'POST',
      body: JSON.stringify({ arn: arn, lat: pos.coords.latitude, lng: pos.coords.longitude }),
    }).catch(function () {});
  }, function (error) {
    console.error('GPS error:', error);
    updateGpsSignalStatus('offline');
    if (error.code === 1) {
      showToast('GPS permission denied. Enable location services.', 'error');
    } else if (error.code === 2) {
      showToast('GPS unavailable. Check device location settings.', 'error');
    } else if (error.code === 3) {
      showToast('GPS timeout. Retrying...', 'warning');
    }
  }, { enableHighAccuracy: true, maximumAge: 25000, timeout: 20000 });
}

function calculateDistance(lat1, lon1, lat2, lon2) {
  const R = 6371; // Earth's radius in km
  const dLat = (lat2 - lat1) * Math.PI / 180;
  const dLon = (lon2 - lon1) * Math.PI / 180;
  const a = Math.sin(dLat/2) * Math.sin(dLat/2) +
    Math.cos(lat1 * Math.PI / 180) * Math.cos(lat2 * Math.PI / 180) *
    Math.sin(dLon/2) * Math.sin(dLon/2);
  const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1-a));
  return R * c;
}

function updateGpsSignalStatus(status) {
  mpGpsSignalStrength = status;
  const badge = document.getElementById('gpsSignalBadge');
  const icon = document.getElementById('gpsSignalIcon');
  const text = document.getElementById('gpsSignalText');
  
  if (!badge) return;
  
  badge.style.display = 'flex';
  badge.classList.remove('pulse', 'signal-weak', 'signal-offline');
  
  if (status === 'strong') {
    badge.classList.add('pulse');
    icon.className = 'fa-solid fa-satellite-dish';
    text.textContent = 'GPS: Strong';
  } else if (status === 'weak') {
    badge.classList.add('signal-weak');
    icon.className = 'fa-solid fa-satellite-dish';
    text.textContent = 'GPS: Weak';
  } else if (status === 'poor') {
    badge.classList.add('signal-weak');
    icon.className = 'fa-solid fa-satellite-dish';
    text.textContent = 'GPS: Poor';
  } else {
    badge.classList.add('signal-offline');
    icon.className = 'fa-solid fa-satellite-dish';
    text.textContent = 'GPS: Offline';
  }
}

function updateSpeedIndicator(speed) {
  const badge = document.getElementById('speedBadge');
  const text = document.getElementById('speedText');
  
  if (!badge) return;
  
  badge.style.display = 'flex';
  text.textContent = speed + ' km/h';
}

function updateConnectionStatus(connected) {
  const badge = document.getElementById('connectionBadge');
  const icon = document.getElementById('connectionIcon');
  const text = document.getElementById('connectionText');
  
  if (!badge) return;
  
  badge.style.display = 'flex';
  if (connected) {
    icon.className = 'fa-solid fa-wifi';
    text.textContent = 'Connected';
    badge.classList.remove('signal-offline');
  } else {
    icon.className = 'fa-solid fa-wifi';
    text.textContent = 'Reconnecting...';
    badge.classList.add('signal-offline');
  }
}

function showMapLoading() {
  const loading = document.getElementById('deliveryMapLoading');
  const error = document.getElementById('deliveryMapError');
  if (loading) loading.style.display = 'flex';
  if (error) error.style.display = 'none';
}

function hideMapLoading() {
  const loading = document.getElementById('deliveryMapLoading');
  if (loading) loading.style.display = 'none';
}

function showMapError(message) {
  const loading = document.getElementById('deliveryMapLoading');
  const error = document.getElementById('deliveryMapError');
  const errorMsg = document.getElementById('deliveryMapErrorMsg');
  
  if (loading) loading.style.display = 'none';
  if (error) error.style.display = 'flex';
  if (errorMsg) errorMsg.textContent = message || 'Unable to load map';
}

function retryDeliveryMap() {
  const arn = mpActiveDeliveryArn;
  if (!arn) return;
  
  showMapLoading();
  
  if (typeof PortalEnhancements !== 'undefined' && PortalEnhancements.startDeliveryPolling) {
    PortalEnhancements.startDeliveryPolling(arn);
  }
  
  setTimeout(function() {
    hideMapLoading();
  }, 1000);
}

function centerDeliveryMap() {
  if (typeof PortalEnhancements !== 'undefined' && PortalEnhancements._deliveryGMap) {
    const map = PortalEnhancements._deliveryGMap;
    if (mpLastGpsPosition) {
      map.setCenter({ lat: mpLastGpsPosition.coords.latitude, lng: mpLastGpsPosition.coords.longitude });
      map.setZoom(15);
    }
  }
}

function zoomInDeliveryMap() {
  if (typeof PortalEnhancements !== 'undefined' && PortalEnhancements._deliveryGMap) {
    const map = PortalEnhancements._deliveryGMap;
    map.setZoom(map.getZoom() + 1);
  }
}

function zoomOutDeliveryMap() {
  if (typeof PortalEnhancements !== 'undefined' && PortalEnhancements._deliveryGMap) {
    const map = PortalEnhancements._deliveryGMap;
    map.setZoom(Math.max(map.getZoom() - 1, 5));
  }
}

function toggleDeliveryMapFullscreen() {
  const mapWrap = document.getElementById('deliveryMapWrap');
  const fullscreenBtn = document.querySelector('#deliveryMapControlButtons button[title="Fullscreen"]');
  
  if (!mapWrap) return;
  
  mpMapFullscreen = !mpMapFullscreen;
  
  if (mpMapFullscreen) {
    mapWrap.classList.add('fullscreen');
    if (fullscreenBtn) fullscreenBtn.innerHTML = '<i class="fa-solid fa-compress"></i>';
  } else {
    mapWrap.classList.remove('fullscreen');
    if (fullscreenBtn) fullscreenBtn.innerHTML = '<i class="fa-solid fa-expand"></i>';
  }
  
  // Trigger map resize after fullscreen toggle
  setTimeout(function() {
    if (typeof PortalEnhancements !== 'undefined' && PortalEnhancements._deliveryGMap) {
      google.maps.event.trigger(PortalEnhancements._deliveryGMap, 'resize');
    }
  }, 100);
}

/* Delivery partner confirms goods collected from the shop — drives the
   importer's "Picked up from shop" timeline step. */
async function mpMarkPickedUp() {
  const arn = document.getElementById('deliveryActiveArn')?.value?.trim();
  if (!arn) { showToast('No active delivery', 'error'); return; }
  const data = await mpApi('/delivery/picked-up', { method: 'POST', body: JSON.stringify({ arn: arn }) });
  if (data && data.success) {
    showToast(data.already ? 'Already marked as picked up' : 'Picked up — importer notified', 'success');
    const b = document.getElementById('deliveryPickedUpBtn');
    if (b) { b.disabled = true; b.innerHTML = '<i class="fa-solid fa-circle-check"></i> Picked up'; b.classList.add('ax-picked'); }
    if (typeof axHaptic === 'function') axHaptic('light');
  } else showToast((data && data.error) || 'Could not mark picked up', 'error');
}

/* Optional proof-of-delivery photo: downscale to <=1200px JPEG before keeping
   it (base64) so the /delivery/complete payload stays small. */
let _mpPodPhoto = null;
function mpPodPicked(input) {
  const file = input && input.files && input.files[0];
  if (!file) return;
  const reader = new FileReader();
  reader.onload = function (e) {
    const img = new Image();
    img.onload = function () {
      const max = 1200; let w = img.width, h = img.height;
      if (w > max || h > max) { if (w >= h) { h = Math.round(h * max / w); w = max; } else { w = Math.round(w * max / h); h = max; } }
      const cv = document.createElement('canvas'); cv.width = w; cv.height = h;
      cv.getContext('2d').drawImage(img, 0, 0, w, h);
      _mpPodPhoto = cv.toDataURL('image/jpeg', 0.82);
      window._mpPodPhoto = _mpPodPhoto;
      const thumb = document.getElementById('deliveryPodThumb'); if (thumb) thumb.innerHTML = '<img src="' + _mpPodPhoto + '" alt="delivery photo">';
      const txt = document.getElementById('deliveryPodText'); if (txt) txt.textContent = 'Delivery photo added ✓';
    };
    img.src = e.target.result;
  };
  reader.readAsDataURL(file);
}

/* Clear the picked-up / POD UI state (between deliveries). */
function _mpResetPickupPod() {
  _mpPodPhoto = null; window._mpPodPhoto = null;
  const b = document.getElementById('deliveryPickedUpBtn');
  if (b) { b.disabled = false; b.innerHTML = '<i class="fa-solid fa-box-open"></i> Mark Picked Up'; b.classList.remove('ax-picked'); }
  const thumb = document.getElementById('deliveryPodThumb'); if (thumb) thumb.innerHTML = '<i class="fa-solid fa-camera"></i>';
  const txt = document.getElementById('deliveryPodText'); if (txt) txt.textContent = 'Add delivery photo (optional)';
  const inp = document.getElementById('deliveryPodInput'); if (inp) inp.value = '';
}

/* ── 6-box OTP input (auto-advance + auto-submit) ──
   Each digit lives in its own box; typing jumps to the next, Backspace jumps
   back, and paste fills all six. A complete, all-numeric code auto-submits — no
   arrow button. #deliveryCompleteOtp is a hidden mirror the rest of the flow
   still reads unchanged. */
function _axOtpBoxes() {
  return Array.prototype.slice.call(document.querySelectorAll('#axOtpBoxes .ax-otp-box'));
}
function axOtpDigit(input) {
  input.value = (input.value || '').replace(/\D/g, '').slice(0, 1);
  const boxes = _axOtpBoxes();
  const i = boxes.indexOf(input);
  if (input.value && i > -1 && i < boxes.length - 1) boxes[i + 1].focus();
  axSyncOtp(boxes);
}
function axOtpKey(input, e) {
  const boxes = _axOtpBoxes();
  const i = boxes.indexOf(input);
  if (e.key === 'Backspace' && !input.value && i > 0) {
    e.preventDefault();
    boxes[i - 1].focus();
    boxes[i - 1].value = '';
    axSyncOtp(boxes);
  } else if (e.key === 'ArrowLeft' && i > 0) {
    e.preventDefault(); boxes[i - 1].focus();
  } else if (e.key === 'ArrowRight' && i < boxes.length - 1) {
    e.preventDefault(); boxes[i + 1].focus();
  }
}
function axOtpPaste(e) {
  const txt = ((e.clipboardData || window.clipboardData).getData('text') || '').replace(/\D/g, '').slice(0, 6);
  if (!txt) return;
  e.preventDefault();
  const boxes = _axOtpBoxes();
  boxes.forEach(function (b, i) { b.value = txt[i] || ''; });
  axSyncOtp(boxes);
  (boxes[Math.min(txt.length, boxes.length - 1)] || boxes[0]).focus();
}
function axSyncOtp(boxes) {
  boxes = boxes || _axOtpBoxes();
  const val = boxes.map(function (b) { return b.value; }).join('');
  const hidden = document.getElementById('deliveryCompleteOtp');
  if (hidden) hidden.value = val;
  boxes.forEach(function (b) { b.classList.toggle('filled', !!b.value); });
  // Auto-submit the moment a full 6-digit code is present (guarded so it fires
  // exactly once per completed entry).
  if (/^\d{6}$/.test(val) && !window._axOtpSubmitting) {
    boxes.forEach(function (b) { b.blur(); });
    if (typeof mpCompleteDelivery === 'function') mpCompleteDelivery();
  }
}
function axClearOtpBoxes(focusFirst) {
  const boxes = _axOtpBoxes();
  boxes.forEach(function (b) { b.value = ''; b.classList.remove('filled'); });
  const hidden = document.getElementById('deliveryCompleteOtp');
  if (hidden) hidden.value = '';
  if (focusFirst && boxes[0]) boxes[0].focus();
}
function axSetOtpStatus(msg, kind) {
  const el = document.getElementById('axOtpStatus');
  if (!el) return;
  el.textContent = msg || '';
  el.className = 'ax-otp-status' + (kind ? ' ' + kind : '');
}
window.axOtpDigit = axOtpDigit;
window.axOtpKey = axOtpKey;
window.axOtpPaste = axOtpPaste;

/* Driver pushes the OTP to the importer on demand — the automatic send only
   fires on GPS proximity, which fails on patchy GPS or desktop testing, leaving
   the importer with no OTP and the order stuck. This calls the backend to mint
   + notify + re-anchor the OTP window right now. */
async function mpSendOtpToImporter() {
  const arn = document.getElementById('deliveryActiveArn')?.value?.trim();
  if (!arn) { showToast('No active delivery', 'error'); return; }
  const btn = document.getElementById('deliverySendOtpBtn');
  const txt = document.getElementById('deliverySendOtpText');
  if (btn) btn.disabled = true;
  if (txt) txt.textContent = 'Sending…';
  const data = await mpApi('/delivery/send-otp', { method: 'POST', body: JSON.stringify({ arn: arn }) });
  if (data && data.success) {
    const mins = data.expires_in_minutes;
    showToast('OTP sent to the importer' + (mins ? ' — valid for ' + mins + ' min' : '') + '. Ask them to read it out.', 'success');
    if (typeof axHaptic === 'function') axHaptic('light');
    if (txt) txt.textContent = 'Resend OTP to importer';
    if (typeof axSetOtpStatus === 'function') axSetOtpStatus('OTP sent — waiting for the importer to read it out', 'info');
    if (typeof axClearOtpBoxes === 'function') axClearOtpBoxes(true);
  } else {
    showToast((data && data.error) || 'Could not send OTP — try again', 'error');
    if (txt) txt.textContent = 'Send OTP to importer';
  }
  if (btn) btn.disabled = false;
}

async function mpCompleteDelivery() {
  const arn = document.getElementById('deliveryActiveArn')?.value?.trim();
  const otp = document.getElementById('deliveryCompleteOtp')?.value?.trim();
  if (!arn) { showToast('No active delivery', 'error'); return; }
  if (!otp || otp.length < 6) { if (typeof axSetOtpStatus === 'function') axSetOtpStatus('Enter all 6 digits', 'err'); return; }
  if (window._axOtpSubmitting) return;           // guard against double auto-submit
  window._axOtpSubmitting = true;
  const boxes = (typeof _axOtpBoxes === 'function') ? _axOtpBoxes() : [];
  boxes.forEach(function (b) { b.disabled = true; });
  if (typeof axSetOtpStatus === 'function') axSetOtpStatus('Verifying…', 'info');
  const _body = { arn: arn, otp: otp };
  if (window._mpPodPhoto) _body.pod_photo = window._mpPodPhoto;
  const data = await mpApi('/delivery/complete', { method: 'POST', body: JSON.stringify(_body) });
  window._axOtpSubmitting = false;
  boxes.forEach(function (b) { b.disabled = false; });
  if (data.success) {
    if (typeof axSetOtpStatus === 'function') axSetOtpStatus('Delivered ✓', 'ok');
    showToast('Delivery completed!', 'success');
    if (mpGpsWatchId) { navigator.geolocation.clearWatch(mpGpsWatchId); mpGpsWatchId = null; }
    if (typeof PortalEnhancements !== 'undefined' && PortalEnhancements.stopDeliveryPolling) {
      PortalEnhancements.stopDeliveryPolling();
    }
    
    // Hide map and reset UI
    const mapWrap = document.getElementById('deliveryMapWrap');
    const fallbackForm = document.getElementById('deliveryFallbackForm');
    const fallbackButtons = document.getElementById('deliveryFallbackButtons');
    const fallbackOtp = document.getElementById('deliveryFallbackOtp');
    const fallbackCompleteBtn = document.getElementById('deliveryFallbackCompleteBtn');
    const toggleBtn = document.getElementById('deliveryMapToggleBtn');
    const mapControlButtons = document.getElementById('deliveryMapControlButtons');
    
    if (mapWrap) mapWrap.style.display = 'none';
    if (fallbackForm) fallbackForm.style.display = 'flex';
    if (fallbackButtons) fallbackButtons.style.display = 'flex';
    if (fallbackOtp) fallbackOtp.style.display = 'block';
    if (fallbackCompleteBtn) fallbackCompleteBtn.style.display = 'inline-block';
    
    // Hide toggle button and map control buttons when map is not active
    if (toggleBtn) toggleBtn.style.display = 'none';
    if (mapControlButtons) mapControlButtons.style.display = 'none';
    
    document.getElementById('deliveryActivePanel').style.display = 'none';
    mpActiveDeliveryArn = null;
    axDeactivateJourneyUi();
    _mpResetPickupPod();
    if (typeof axClearOtpBoxes === 'function') axClearOtpBoxes(false);
    mpLoadDeliveryDashboard();
  } else {
    // Wrong / expired OTP: clear the boxes for a clean retry and surface the
    // exact reason inline; nudge a resend when the code looks expired/unsent.
    if (typeof axSetOtpStatus === 'function') axSetOtpStatus(data.error || 'OTP verification failed', 'err');
    if (typeof axClearOtpBoxes === 'function') axClearOtpBoxes(true);
    if (typeof axHaptic === 'function') axHaptic('error');
    if (data.error && /expired|contact admin|invalid/i.test(data.error)) {
      const txt = document.getElementById('deliverySendOtpText');
      if (txt) txt.textContent = 'Resend OTP to importer';
    }
  }
}

/* Cancel is destructive (strike + product goes back to catalogue) so it gets a
   proper styled confirmation sheet instead of a bare browser confirm(). */
function mpCancelDelivery() {
  const arn = document.getElementById('deliveryActiveArn')?.value?.trim();
  if (!arn) { showToast('ARN required', 'error'); return; }
  let ov = document.getElementById('axCancelConfirm');
  if (ov) ov.remove();
  ov = document.createElement('div');
  ov.id = 'axCancelConfirm';
  ov.className = 'ax-confirm-overlay';
  ov.innerHTML =
    '<div class="ax-confirm-box" role="alertdialog" aria-labelledby="axCancelTitle">' +
      '<div class="ax-confirm-icon"><i class="fa-solid fa-triangle-exclamation"></i></div>' +
      '<h3 id="axCancelTitle" class="ax-confirm-title">Cancel this delivery?</h3>' +
      '<p class="ax-confirm-text">The product goes back to the seller\'s live catalogue and the buyer is notified. <b>This counts as a cancellation strike</b> — too many can suspend your delivery access.</p>' +
      '<div class="ax-confirm-actions">' +
        '<button type="button" class="ax-confirm-keep" onclick="document.getElementById(\'axCancelConfirm\').remove()"><i class="fa-solid fa-arrow-left"></i> Keep delivering</button>' +
        '<button type="button" class="ax-confirm-danger" onclick="_mpCancelDeliveryConfirmed(\'' + String(arn).replace(/'/g, '') + '\')"><i class="fa-solid fa-xmark"></i> Cancel delivery</button>' +
      '</div>' +
    '</div>';
  ov.addEventListener('click', function (e) { if (e.target === ov) ov.remove(); });
  document.body.appendChild(ov);
}

async function _mpCancelDeliveryConfirmed(arn) {
  const ov = document.getElementById('axCancelConfirm'); if (ov) ov.remove();
  arn = arn || document.getElementById('deliveryActiveArn')?.value?.trim();
  if (!arn) { showToast('ARN required', 'error'); return; }
  const data = await mpApi('/delivery/cancel', { method: 'POST', body: JSON.stringify({ arn: arn }) });
  if (data.success) {
    showToast('Delivery cancelled — the product is back in the seller\'s live catalogue.', 'success');
    
    if (data.suspended) {
      showToast('You have reached the cancellation limit. Your delivery partner access has been revoked.', 'error');
      // Reload KYC status to reflect the revocation
      if (typeof mpLoadKycStatus === 'function') {
        mpLoadKycStatus();
      }
    }
    
    // Stop GPS tracking
    if (mpGpsWatchId) { navigator.geolocation.clearWatch(mpGpsWatchId); mpGpsWatchId = null; }
    if (typeof PortalEnhancements !== 'undefined' && PortalEnhancements.stopDeliveryPolling) {
      PortalEnhancements.stopDeliveryPolling();
    }
    
    // Hide map and reset UI
    const mapWrap = document.getElementById('deliveryMapWrap');
    const fallbackForm = document.getElementById('deliveryFallbackForm');
    const fallbackButtons = document.getElementById('deliveryFallbackButtons');
    const fallbackOtp = document.getElementById('deliveryFallbackOtp');
    const fallbackCompleteBtn = document.getElementById('deliveryFallbackCompleteBtn');
    const toggleBtn = document.getElementById('deliveryMapToggleBtn');
    const mapControlButtons = document.getElementById('deliveryMapControlButtons');
    
    if (mapWrap) mapWrap.style.display = 'none';
    if (fallbackForm) fallbackForm.style.display = 'flex';
    if (fallbackButtons) fallbackButtons.style.display = 'flex';
    if (fallbackOtp) fallbackOtp.style.display = 'block';
    if (fallbackCompleteBtn) fallbackCompleteBtn.style.display = 'inline-block';
    
    // Hide toggle button and map control buttons when map is not active
    if (toggleBtn) toggleBtn.style.display = 'none';
    if (mapControlButtons) mapControlButtons.style.display = 'none';
    
    document.getElementById('deliveryActivePanel').style.display = 'none';
    mpActiveDeliveryArn = null;
    axDeactivateJourneyUi();
    _mpResetPickupPod();
    mpLoadDeliveryDashboard();
  } else {
    showToast(data.error || 'Cancellation failed', 'error');
  }
}

const _origMpLoadKyc = typeof mpLoadKycStatus === 'function' ? mpLoadKycStatus : null;
mpLoadKycStatus = async function () {
  if (!_origMpLoadKyc) return;
  // ROOT-CAUSE FIX ("Shop/Delivery/Both button disappears after a while"):
  // this used to make a *second*, independent /kyc/status call here, on
  // top of the one the base mpLoadKycStatus (portal-marketplace.js) already
  // makes. Two problems with that: (1) it doubled the request volume, and
  // (2) more importantly, the base function used to reset the whole
  // role/nav state to defaults ('none' / 'shop_owner') on ANY failure,
  // including this file's own separate failure path only patching the
  // Delivery button while the base call had already wiped the Shop button
  // and other role state seconds earlier on an expired token. Both
  // functions are now fixed at the source: a failed fetch never resets
  // state anywhere. This wrapper simply reuses the single fetch's result
  // instead of calling the API twice.
  const data = await _origMpLoadKyc();
  if (!data || data.error || !data.kyc) return; // failed call — nav/state already left untouched upstream
  const role = data.kyc?.kyc_role || 'shop_owner';
  const suspended = !!data.kyc?.delivery_suspended;
  mpShowDeliveryNav(data.kyc?.status === 'approved' && !suspended && (role === 'delivery_partner' || role === 'both'));
  const subBox = document.getElementById('shopSubscriptionBox');
  if (subBox) {
    const active = data.subscription?.active;
    subBox.style.display = (data.kyc?.status === 'approved' && !active && (role === 'shop_owner' || role === 'both')) ? '' : 'none';
    if (active) subBox.innerHTML = '<p class="kyc-badge kyc-approved"><i class="fa-solid fa-check"></i> Shop subscription active</p>';
  }
  // ── Restore-on-refresh: if this partner has an in-progress delivery,
  //    rebuild the active-delivery UI automatically — no re-claim needed,
  //    and it won't disappear no matter how many times the page reloads. ──
  if (role === 'delivery_partner' || role === 'both') {
    mpRestoreActiveDelivery();
  }
};

async function mpSubscribeShop() {
  // Payment session needs a valid Google token — refresh interactively if expired.
  if (typeof window.ensureFreshGoogleToken === 'function'
      && typeof isGoogleTokenExpired === 'function' && isGoogleTokenExpired()) {
    await window.ensureFreshGoogleToken({ interactive: true });
  }
  if (typeof isGoogleTokenExpired === 'function' && isGoogleTokenExpired()) {
    showToast('Google sign-in required before payment', 'error');
    return;
  }
  const data = await mpApi('/shop/subscribe', { method: 'POST', body: '{}' });
  if (data.already_active) { showToast('Subscription already active', 'success'); return; }
  if (!data.payment_session_id && !data.payment_link_url) {
    showToast(data.error || 'Subscription failed', 'error');
    return;
  }
  // In-app Cashfree modal. The subscription only becomes ACTIVE once the
  // Cashfree webhook confirms payment — so we show success ONLY when the buyer
  // actually completes payment, never on cancel/close.
  const pay = data.payment_session_id
    ? await axCashfreeCheckout(data.payment_session_id, data.payment_mode)
    : { available: false, paid: false };
  if (pay.paid) {
    showToast('Payment received! Aapki shop subscription activate ho rahi hai…', 'success');
    // Webhook may lag a moment — refresh shop/subscription state shortly after.
    if (typeof mpLoadKycStatus === 'function') {
      mpLoadKycStatus();
      setTimeout(function () { mpLoadKycStatus(); }, 3000);
    }
  } else if (pay.available === false && data.payment_link_url) {
    // SDK/session unavailable → hosted page in a new tab as a fallback.
    window.open(data.payment_link_url, '_blank');
    showToast('Payment page opened in a new tab. Complete ₹' + data.amount + '/month payment to unlock shop creation.', 'info');
  } else {
    showToast('Payment not completed — subscription active nahi hui. Aap dobara try kar sakte hain.', 'error');
  }
}

/* ── Restore-on-refresh: rebuild the active-delivery UI on load ── */
let _mpActiveRestoreDone = false;
async function mpRestoreActiveDelivery() {
  if (_mpActiveRestoreDone) return;
  const data = await mpApi('/delivery/active');
  if (!data || !data.active) { _mpActiveRestoreDone = true; return; }
  _mpActiveRestoreDone = true;
  mpActiveDeliveryArn = data.arn;
  if (data.estimated_earning) window._axActiveEarning = data.estimated_earning;
  const arnEl = document.getElementById('deliveryActiveArn');
  const keyEl = document.getElementById('deliveryTrackingKey');
  const panel = document.getElementById('deliveryActivePanel');
  if (arnEl) arnEl.value = data.arn || '';
  if (keyEl) keyEl.value = data.tracking_key || '';
  if (panel) panel.style.display = '';
  if (data.status === 'IN_TRANSIT' || data.status === 'NEAR_DESTINATION') {
    axActivateJourneyUi();
    const mapWrap = document.getElementById('deliveryMapWrap');
    if (mapWrap) mapWrap.style.display = 'block';
    mpStartGpsPush(data.arn);
    if (typeof PortalEnhancements !== 'undefined' && PortalEnhancements.startDeliveryPolling) {
      PortalEnhancements.startDeliveryPolling(data.arn);
    }
  }
  showToast('Resuming your active delivery — ' + data.arn, 'info');
}

/* ── Reject an available order (fraud-prevention counter on the backend) ── */
async function mpRejectDelivery(arn) {
  if (!confirm('Skip this order? Repeatedly rejecting orders may suspend your delivery access.')) return;
  const data = await mpApi('/delivery/reject', { method: 'POST', body: JSON.stringify({ arn: arn }) });
  if (data.success) {
    if (data.suspended) {
      showToast('Delivery access suspended due to repeated rejections. Contact support.', 'error');
    } else {
      showToast('Order skipped', 'info');
    }
    mpLoadDeliveryDashboard();
  } else showToast(data.error || 'Could not skip order', 'error');
}

/* ── Buyer-side: rate the delivery partner after a completed delivery ── */
let _mpDeliveryReviewRating = 0;
function mpOpenDeliveryReview(arn, partnerName) {
  if (document.getElementById('deliveryReviewModal')) return; // already shown this session
  _mpDeliveryReviewRating = 0;
  const modal = document.createElement('div');
  modal.id = 'deliveryReviewModal';
  modal.className = 'modal-overlay open';
  modal.style.cssText = 'position:fixed;inset:0;background:rgba(14,30,22,.55);z-index:9999;display:flex;align-items:center;justify-content:center;padding:16px';
  modal.innerHTML =
    '<div style="background:#fff;border-radius:16px;padding:24px;max-width:360px;width:100%;text-align:center">' +
    '<h3 style="margin:0 0 6px;font-family:inherit">Rate your delivery partner</h3>' +
    '<p style="color:var(--c-text3,#667);margin:0 0 16px;font-size:14px">How was your experience with ' + (partnerName || 'your delivery partner') + '?</p>' +
    '<div id="deliveryReviewStars" style="font-size:28px;letter-spacing:6px;margin-bottom:16px;cursor:pointer">★★★★★</div>' +
    '<textarea id="deliveryReviewComment" placeholder="Optional comment…" style="width:100%;min-height:60px;border-radius:10px;border:1px solid #ddd;padding:8px;margin-bottom:14px;font-family:inherit"></textarea>' +
    '<div style="display:flex;gap:10px">' +
    '<button type="button" onclick="document.getElementById(\'deliveryReviewModal\').remove()" style="flex:1;padding:10px;border-radius:10px;border:1px solid #ddd;background:#fff;cursor:pointer">Skip</button>' +
    '<button type="button" onclick="mpSubmitDeliveryReview(\'' + arn + '\')" style="flex:1;padding:10px;border-radius:10px;border:none;background:var(--c-leaf,#2E6B41);color:#fff;font-weight:700;cursor:pointer">Submit</button>' +
    '</div></div>';
  document.body.appendChild(modal);
  const starsEl = document.getElementById('deliveryReviewStars');
  function renderStars() {
    starsEl.innerHTML = Array.from({ length: 5 }, function (_, i) {
      return '<span style="color:' + (i < _mpDeliveryReviewRating ? '#C7993A' : '#ddd') + '">★</span>';
    }).join('');
  }
  renderStars();
  starsEl.querySelectorAll('span').forEach(function (span, i) {
    span.addEventListener('click', function () { _mpDeliveryReviewRating = i + 1; renderStars(); });
  });
}

async function mpSubmitDeliveryReview(arn) {
  if (!_mpDeliveryReviewRating) { showToast('Select a star rating', 'error'); return; }
  const comment = (document.getElementById('deliveryReviewComment')?.value || '').trim();
  const data = await mpApi('/delivery/review/submit', {
    method: 'POST',
    body: JSON.stringify({ arn: arn, rating: _mpDeliveryReviewRating, comment: comment }),
  });
  document.getElementById('deliveryReviewModal')?.remove();
  if (data.success) showToast('Thanks for rating your delivery partner!', 'success');
  else showToast(data.error || 'Could not submit rating', 'error');
}

/* ── Delivery-partner side: "My pending claims" ──
 * A partner can only have one open claim at a time (enforced server-side
 * in handle_delivery_claim) — this panel is where they go to see it and
 * close it (complete it from the active-delivery panel, or cancel it
 * here) so they're unblocked to claim a new order. Also surfaces any
 * legacy multi-claim data from before that restriction existed. */
function mpEscDelivery(s) {
  if (s == null) return '';
  return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

async function mpOpenPendingClaimsPanel() {
  let modal = document.getElementById('deliveryPendingClaimsModal');
  if (!modal) {
    modal = document.createElement('div');
    modal.id = 'deliveryPendingClaimsModal';
    modal.style.cssText = 'position:fixed;inset:0;background:rgba(14,30,22,.55);z-index:9999;display:flex;align-items:center;justify-content:center;padding:16px';
    modal.innerHTML =
      '<div style="background:#fff;border-radius:16px;padding:24px;max-width:420px;width:100%;max-height:80vh;overflow-y:auto">' +
      '<div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:6px">' +
      '<h3 style="margin:0;font-family:inherit">My pending claims</h3>' +
      '<button type="button" onclick="document.getElementById(\'deliveryPendingClaimsModal\').remove()" style="border:none;background:none;font-size:18px;cursor:pointer;color:var(--c-text3,#667)"><i class="fa-solid fa-xmark"></i></button>' +
      '</div>' +
      '<p style="color:var(--c-text3,#667);margin:0 0 14px;font-size:13.5px">You can only claim a new order once every existing claim below is completed or cancelled.</p>' +
      '<div id="deliveryPendingClaimsList"><p style="color:var(--c-text3,#667);font-size:13px">Loading…</p></div>' +
      '</div>';
    document.body.appendChild(modal);
  }
  const listEl = document.getElementById('deliveryPendingClaimsList');
  listEl.innerHTML = '<p style="color:var(--c-text3,#667);font-size:13px">Loading…</p>';
  const data = await mpApi('/delivery/my-claims');
  const claims = (data && data.claims) || [];
  if (!claims.length) {
    listEl.innerHTML = '<p style="color:var(--c-text3,#667);font-size:13.5px;padding:8px 0">No open claims — you\'re free to claim a new order.</p>';
    return;
  }
  listEl.innerHTML = claims.map(function (c) {
    return '<div style="border:1px solid var(--c-border,#E4DBCA);border-radius:12px;padding:12px;margin-bottom:10px">' +
      '<strong style="font-size:14px">' + mpEscDelivery(c.product_name || c.arn) + '</strong><br>' +
      '<span style="font-size:12.5px;color:var(--c-text3,#667)">' + mpEscDelivery(c.pickup_city || '—') + ' → ' + mpEscDelivery(c.delivery_city || '—') + ' · ' + mpEscDelivery(c.status || '') + '</span><br>' +
      '<span style="font-size:12px;color:var(--c-text3,#667)">ARN: ' + mpEscDelivery(c.arn) + '</span>' +
      '<div style="display:flex;gap:8px;margin-top:10px">' +
      '<button type="button" class="btn-sm-outline" style="flex:1;color:var(--c-red,#D93644);border-color:rgba(217,54,68,.3)" onclick="mpCancelClaimFromPanel(\'' + c.arn + '\')">Cancel this claim</button>' +
      '<button type="button" class="btn-primary btn-sm" style="flex:1" onclick="document.getElementById(\'deliveryPendingClaimsModal\').remove();_mpActiveRestoreDone=false;mpRestoreActiveDelivery();">Resume delivery</button>' +
      '</div></div>';
  }).join('');
}

async function mpCancelClaimFromPanel(arn) {
  if (!confirm('Cancel this delivery? The product will go back to the seller\'s live catalogue and the buyer will be notified. This counts as a cancellation strike.')) return;
  const data = await mpApi('/delivery/cancel', { method: 'POST', body: JSON.stringify({ arn: arn }) });
  if (data.success) {
    showToast('Claim cancelled — the product is back in the seller\'s live catalogue.', 'success');
    if (data.suspended) {
      showToast('You have reached the cancellation limit. Your delivery partner access has been revoked.', 'error');
      if (typeof mpLoadKycStatus === 'function') mpLoadKycStatus();
    }
    if (mpActiveDeliveryArn === arn) {
      mpActiveDeliveryArn = null;
      if (mpGpsWatchId) { navigator.geolocation.clearWatch(mpGpsWatchId); mpGpsWatchId = null; }
      const activePanel = document.getElementById('deliveryActivePanel');
      if (activePanel) activePanel.style.display = 'none';
    }
    mpOpenPendingClaimsPanel();
    mpLoadDeliveryDashboard();
  } else {
    showToast(data.error || 'Could not cancel this claim', 'error');
  }
}
