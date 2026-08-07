/* Aarvex Portal — Marketplace, KYC, Shop, Notifications, Ads */
'use strict';

let mpKycStatus = 'none';
let mpKycRole = 'shop_owner';
let mpSubscriptionActive = false;
let mpShop = null;
let mpProducts = [];
let mpNotifUnread = 0;
let mpReviewRating = 0;
let mpCurrentOrderArn = null;

function mpAuthHeaders() {
  const h = { 'Content-Type': 'application/json' };
  const token = localStorage.getItem('ax_google_token');
  if (token) h['Authorization'] = 'Bearer ' + token;
  return h;
}

async function mpApi(path, opts = {}) {
  // Proactive: refresh the Google token BEFORE it's used if it's already
  // expired (or about to, within 60s) — silent, no popup for the person.
  if (typeof window.ensureFreshGoogleToken === 'function') {
    try { await window.ensureFreshGoogleToken(); } catch (e) { /* fall through with whatever token we have */ }
  }
  let res;
  try {
    res = await fetch(LAMBDA_URL + path, {
      ...opts,
      headers: { ...mpAuthHeaders(), ...(opts.headers || {}) },
    });
  } catch (netErr) {
    // C3 · offline / network failure — return a clear, retry-able error instead
    // of throwing (which used to leave callers hanging on a rejected promise).
    if (typeof window !== 'undefined' && typeof window.axShowOffline === 'function') window.axShowOffline();
    return {
      error: (typeof navigator !== 'undefined' && !navigator.onLine)
        ? 'No internet — tap to retry' : 'Network error — please try again',
      offline: (typeof navigator !== 'undefined' && !navigator.onLine),
      _network: true,
    };
  }
  const text = await res.text();
  let data;
  try {
    data = text.charAt(0) === '{' ? JSON.parse(text) : { error: 'Invalid response', status: res.status };
  } catch (e) {
    data = { error: 'Invalid JSON', status: res.status };
  }
  if (res.status === 401) {
    data.status = 401;
    // Pause noisy background polls (calls) until the person re-auths.
    window._axAuthPollPaused = true;
    // 1) Silent refresh retry
    if (!opts._retried && typeof window.ensureFreshGoogleToken === 'function') {
      await window.ensureFreshGoogleToken();
      if (typeof isGoogleTokenExpired === 'function' && !isGoogleTokenExpired()) {
        window._axAuthPollPaused = false;
        return mpApi(path, { ...opts, _retried: true });
      }
    }
    // 2) Interactive Google popup (Brave / expired session) — once
    if (!opts._interactiveRetried && typeof window.axInteractiveGoogleReauth === 'function'
        && typeof currentUser !== 'undefined' && currentUser) {
      await window.axInteractiveGoogleReauth();
      if (typeof isGoogleTokenExpired === 'function' && !isGoogleTokenExpired()) {
        window._axAuthPollPaused = false;
        return mpApi(path, { ...opts, _retried: true, _interactiveRetried: true });
      }
    }
  }
  return data;
}

async function mpLoadKycStatus() {
  const data = await mpApi('/kyc/status');
  // ROOT-CAUSE FIX ("Shop/Delivery/Both button disappears after a while"):
  // this call used to blindly overwrite mpKycStatus/mpKycRole/mpShop with
  // data.kyc?.* even when the request itself FAILED (401 from an expired
  // Google token, a transient network blip, etc). On failure `data` is
  // `{error: "..."}` with no `.kyc` key, so `data.kyc?.status || 'none'`
  // silently reset the role to defaults and hid the Shop nav — even though
  // the user's real KYC role never changed. Now: if the call failed, keep
  // whatever we already knew and leave every nav button exactly as it was.
  if (!data || data.error) {
    console.warn('[KYC] status fetch failed — keeping last known role/nav state', data && data.error);
    return data; // let callers (e.g. portal-delivery.js) see the failure too
  }
  mpKycStatus = data.kyc?.status || 'none';
  mpKycRole = data.kyc?.kyc_role || 'shop_owner';
  mpSubscriptionActive = !!data.subscription?.active;
  mpShop = data.shop || null;
  const shopNav = document.getElementById('navShop');
  const mobileShop = document.getElementById('mobileNavShop');
  const showShop = mpKycStatus === 'approved' && (mpKycRole === 'shop_owner' || mpKycRole === 'both');
  if (shopNav) shopNav.style.display = showShop ? '' : 'none';
  if (mobileShop) mobileShop.style.display = showShop ? '' : 'none';
  updateKycUI(data);
  updateShopUI();
  renderDashboardCta(data);
  return data;
}

function renderDashboardCta(data) {
  const container = document.getElementById('dashShopCta');
  if (!container) return;
  const showDelivery = mpKycStatus === 'approved' && (mpKycRole === 'delivery_partner' || mpKycRole === 'both');
  const showShop = mpKycStatus === 'approved' && (mpKycRole === 'shop_owner' || mpKycRole === 'both');
  const kycPending = data.kyc?.status === 'pending';
  const kycNone = data.kyc?.status === 'none';
  let html = '';
  if (showDelivery) {
    html += `
      <div class="dash-cta-grid" style="grid-template-columns:1fr;gap:var(--s3);margin-bottom:var(--s4)">
        <div class="cta-card sell-cta" onclick="switchPanel('delivery');mpLoadDeliveryDashboard()">
          <div class="cta-icon delivery" style="background:linear-gradient(135deg,#3E9159 0%,#143026 100%);"><i class="fa-solid fa-truck-fast"></i></div>
          <div>
            <div class="cta-title">Delivery Partner Dashboard</div>
            <div class="cta-desc">Your delivery jobs and earnings are ready. Claim orders, start journeys, and complete deliveries from one place.</div>
          </div>
          <div class="cta-arrow green"><i class="fa-solid fa-arrow-right"></i> Open delivery</div>
        </div>
      </div>`;
  }
  if (showShop && !mpShop) {
    html += `
      <div class="dash-cta-grid" style="grid-template-columns:1fr;gap:var(--s3);margin-bottom:var(--s4)">
        <div class="cta-card shop-cta" onclick="switchPanel('shop');mpLoadShopProducts();mpLoadShopFeedback()">
          <div class="cta-icon" style="background:linear-gradient(135deg,#E2B65C 0%,#C7993A 100%);"><i class="fa-solid fa-store"></i></div>
          <div>
            <div class="cta-title">Open Your Shop</div>
            <div class="cta-desc">Your seller account is approved. Start listing products and reach buyers across the marketplace.</div>
          </div>
          <div class="cta-arrow gold"><i class="fa-solid fa-arrow-right"></i> Open shop</div>
        </div>
      </div>`;
  }
  if (!html && (kycPending || kycNone)) {
    html = `
      <div class="section-card" style="padding:var(--s4);margin-bottom:var(--s4);background:rgba(14,30,22,.04)">
        <div class="section-header" style="margin-bottom:var(--s3)">
          <div class="section-header-icon gold"><i class="fa-solid fa-id-card"></i></div>
          <div class="section-header-title">KYC Required</div>
        </div>
        <div class="section-body" style="padding:0;">
          <p style="margin-bottom:var(--s3);color:var(--c-text3)">Choose your role and submit KYC to unlock seller or delivery features. You can manage everything from the profile section.</p>
          <button class="btn-primary" type="button" onclick="switchPanel('profile');mpGenerateCaptcha()">Complete KYC</button>
        </div>
      </div>`;
  }
  container.innerHTML = html;
  container.style.display = html ? '' : 'none';
}

function updateShopUI() {
  const createForm = document.getElementById('shopCreateForm');
  const manageArea = document.getElementById('shopManageArea');
  const hasShop = !!(mpShop && mpShop.shop_id);
  if (createForm) createForm.style.display = (mpKycStatus === 'approved' && !hasShop) ? '' : 'none';
  if (manageArea) manageArea.style.display = hasShop ? '' : 'none';
}

function updateKycUI(data) {
  const badge = document.getElementById('kycStatusBadge');
  if (badge) {
    const st = data.kyc?.status || 'none';
    badge.textContent = st === 'none' ? 'Not submitted' : st.replace('_', ' ');
    badge.className = 'kyc-badge kyc-' + st;
  }
  const reason = document.getElementById('kycRejectReason');
  if (reason && data.kyc?.rejection_reason) {
    reason.textContent = data.kyc.rejection_reason;
    reason.style.display = '';
  }
}

// The catalogue search bar (.catalogue-search-sticky, right after
// #tradeBannerSlot in the DOM) should only be position:sticky when there's
// an ad banner above it to scroll behind — otherwise it stays static.
// Call this any time tradeBannerSlot's visibility/content changes.
function mpSyncSearchStickyState() {
  const banner = document.getElementById('tradeBannerSlot');
  const searchBar = document.querySelector('.catalogue-search-sticky');
  if (!searchBar) return;
  const hasAd = !!banner && !banner.hidden && banner.innerHTML.trim() !== '';
  searchBar.classList.toggle('banner-active', hasAd);
}

function mpRenderBanner(ad, targetId) {
  const banner = document.getElementById(targetId || 'dashBannerSlot');
  if (!banner || !ad || !ad.image_url) return false;
  const link = ad.link_url && ad.link_url !== '#' ? ad.link_url : '';
  const imgUrl = ad.image_url + (ad.image_url.includes('?') ? '&' : '?') + 't=' + Date.now();
  const alt = ad.alt_text || 'Advertisement';
  const sponsoredChip = link ? '<div class="dash-banner-sponsored-chip"><i class="fa-solid fa-star"></i> Sponsored</div>' : '';
  // Plain rounded box, no decorative SVG wave edges — height follows the
  // image's natural aspect ratio (see .dash-banner-rounded img in CSS).
  const media = ad.media_type === 'video'
    ? '<video autoplay muted loop playsinline poster="" aria-label="' + alt.replace(/"/g, '') + '" onerror="console.error(\'[Ad] media failed to load:\', this.currentSrc || this.src); this.style.display=\'none\';this.parentElement.classList.add(\'banner-media-failed\')"><source src="' + imgUrl + '">Your browser cannot play this video.</video>'
    : '<img src="' + imgUrl + '" alt="' + alt.replace(/"/g, '') + '" onerror="console.error(\'[Ad] media failed to load:\', this.src); this.style.display=\'none\';this.parentElement.classList.add(\'banner-media-failed\')">';
  const inner =
    '<div class="dash-banner-img-wrap" style="position:relative">' +
      sponsoredChip +
      media + '<div class="banner-media-fallback">' + alt + '</div>' +
    '</div>';
  banner.hidden = false;
  banner.className = (targetId === 'tradeBannerSlot' ? 'trade-banner' : 'dash-banner portal-bleed dash-banner-rounded');
  banner.innerHTML = link
    ? '<a href="' + link + '" target="_blank" rel="noopener sponsored">' + inner + '</a>'
    : inner;
  mpSyncSearchStickyState();
  return true;
}

async function mpLoadBanner(placement, targetId) {
  placement = placement || 'dashboard';
  targetId = targetId || 'dashBannerSlot';
  const banner = document.getElementById(targetId);
  if (!banner) return;

  try {
    const res = await fetch(LAMBDA_URL + '/banner/active?placement=' + encodeURIComponent(placement) + '&t=' + Date.now(), {
      headers: { Accept: 'application/json' },
      cache: 'no-store',
    });
    const text = await res.text();
    if (text.charAt(0) === '{') {
      const data = JSON.parse(text);
      if (data.ad && data.ad.image_url) {
        localStorage.setItem('ax_active_banner_' + placement, JSON.stringify(data.ad));
        if (mpRenderBanner(data.ad, targetId)) return;
      }
    }
  } catch (e) {
    console.warn('[Ad] API load failed', e);
  }

  try {
    const cached = JSON.parse(localStorage.getItem('ax_active_banner_' + placement) || 'null');
    if (cached && mpRenderBanner(cached, targetId)) return;
  } catch (e) { /* ignore */ }

  if (placement === 'dashboard') {
    banner.innerHTML = '<div class="dash-banner-default"><div class="dash-banner-eyebrow"><i class="fa-solid fa-leaf"></i> Aarvex Global</div><h3>Premium Agri Exports</h3><p>Your trusted partner in global agricultural trade</p><button type="button" class="dash-banner-cta-btn" onclick="switchPanel(\'trade\'); switchTradeMode(\'order\')"><i class="fa-solid fa-arrow-right"></i> Browse Products</button></div>';
    banner.className = 'dash-banner portal-bleed dash-banner-rounded';
  } else banner.hidden = true;
  mpSyncSearchStickyState();
}

/* Fetch a single placement's active ad (API first, localStorage fallback). */
async function mpFetchBannerAd(placement) {
  try {
    const res = await fetch(LAMBDA_URL + '/banner/active?placement=' + encodeURIComponent(placement) + '&t=' + Date.now(), {
      headers: { Accept: 'application/json' }, cache: 'no-store',
    });
    const text = await res.text();
    if (text.charAt(0) === '{') {
      const data = JSON.parse(text);
      if (data.ad && data.ad.image_url) {
        try { localStorage.setItem('ax_active_banner_' + placement, JSON.stringify(data.ad)); } catch (e) { /* ignore */ }
        return data.ad;
      }
    }
  } catch (e) { /* ignore */ }
  try {
    const cached = JSON.parse(localStorage.getItem('ax_active_banner_' + placement) || 'null');
    if (cached && cached.image_url) return cached;
  } catch (e) { /* ignore */ }
  return null;
}

/* Trade-mid promo: up to 3 admin-managed ads (placements trade_mid /
   trade_mid2 / trade_mid3), each with its own title + subline shown ABOVE
   the media. Rendered as a swipeable carousel — auto-advances every 4s and
   supports manual swipe + dot navigation. */
let _axMidCarouselTimer = null;
async function mpLoadTradeMidCarousel(targetId) {
  const slot = document.getElementById(targetId || 'tradeMidAdSlot');
  if (!slot) return;
  const placements = ['trade_mid', 'trade_mid2', 'trade_mid3'];
  const results = await Promise.all(placements.map(mpFetchBannerAd));
  const ads = results.filter(function (a) { return a && a.image_url; });
  if (!ads.length) { slot.hidden = true; slot.innerHTML = ''; if (typeof mpSyncSearchStickyState === 'function') mpSyncSearchStickyState(); return; }
  slot.hidden = false;

  function slideHtml(ad) {
    const alt = escS(ad.alt_text || 'Advertisement');
    const imgUrl = ad.image_url + (ad.image_url.indexOf('?') !== -1 ? '&' : '?') + 't=' + Date.now();
    const media = ad.media_type === 'video'
      ? '<video autoplay muted loop playsinline aria-label="' + alt + '"><source src="' + escS(imgUrl) + '"></video>'
      : '<img src="' + escS(imgUrl) + '" alt="' + alt + '" loading="lazy">';
    const cap = (ad.title || ad.subtitle)
      ? '<div class="ax-midad-cap">' +
          (ad.title ? '<div class="ax-midad-title">' + escS(ad.title) + '</div>' : '') +
          (ad.subtitle ? '<div class="ax-midad-sub">' + escS(ad.subtitle) + '</div>' : '') +
        '</div>'
      : '';
    const inner = cap + '<div class="ax-midad-media">' + media + '</div>';
    return ad.link_url
      ? '<a class="ax-midad-slide" href="' + escS(ad.link_url) + '" target="_blank" rel="noopener sponsored">' + inner + '</a>'
      : '<div class="ax-midad-slide">' + inner + '</div>';
  }

  const dots = ads.length > 1
    ? '<div class="ax-midad-dots">' + ads.map(function (_, i) { return '<span class="ax-midad-dot' + (i === 0 ? ' on' : '') + '" data-i="' + i + '"></span>'; }).join('') + '</div>'
    : '';
  slot.innerHTML =
    '<div class="ax-midad-carousel">' +
      '<div class="ax-midad-track" id="axMidAdTrack">' + ads.map(slideHtml).join('') + '</div>' +
      dots +
    '</div>';

  const track = document.getElementById('axMidAdTrack');
  if (!track) return;
  track.addEventListener('scroll', function () {
    const i = Math.round(track.scrollLeft / Math.max(1, track.clientWidth));
    const ds = slot.querySelectorAll('.ax-midad-dot');
    for (let k = 0; k < ds.length; k++) ds[k].classList.toggle('on', k === i);
  });
  slot.querySelectorAll('.ax-midad-dot').forEach(function (d) {
    d.addEventListener('click', function () {
      const i = parseInt(d.getAttribute('data-i'), 10) || 0;
      track.scrollTo({ left: i * track.clientWidth, behavior: 'smooth' });
    });
  });
  if (_axMidCarouselTimer) { clearInterval(_axMidCarouselTimer); _axMidCarouselTimer = null; }
  if (ads.length > 1) {
    _axMidCarouselTimer = setInterval(function () {
      if (!document.body.contains(track)) { clearInterval(_axMidCarouselTimer); _axMidCarouselTimer = null; return; }
      if (document.hidden) return;
      const cur = Math.round(track.scrollLeft / Math.max(1, track.clientWidth));
      const next = (cur + 1) % ads.length;
      track.scrollTo({ left: next * track.clientWidth, behavior: 'smooth' });
    }, 4000);
  }
  if (typeof mpSyncSearchStickyState === 'function') mpSyncSearchStickyState();
}

async function mpLoadNotifications() {
  const data = await mpApi('/notifications');
  mpNotifUnread = data.unread || 0;
  const badgeIds = ['notifBadge', 'notifBadgeMobile', 'notifBadgeDesktop', 'notifBadgeAlert', 'navNotifBadge'];
  badgeIds.forEach(id => {
    const badge = document.getElementById(id);
    if (badge) {
      // Header indicators are dots, not numeric counters. Keep legacy targets
      // empty and hidden so older renderers cannot put a number back on top.
      badge.textContent = '';
      badge.style.display = 'none';
    }
  });
  if (typeof PortalEnhancements !== 'undefined' && PortalEnhancements.updateBadges) {
    PortalEnhancements.updateBadges(mpNotifUnread);
  }
  const list = document.getElementById('notificationsList');
  if (!list) return;
  const items = data.notifications || [];
  if (!items.length) {
    list.innerHTML =
      '<div class="ax-notif-empty">' +
        '<div class="ax-notif-empty-ico" aria-hidden="true"><i class="fa-regular fa-bell"></i></div>' +
        '<p class="ax-notif-empty-title">You\'re all caught up</p>' +
        '<p class="ax-notif-empty-sub">Orders, delivery, KYC and admin alerts will show up here.</p>' +
      '</div>';
    return;
  }
  const icons = { new_lead: 'fa-wheat-awn', new_review: 'fa-star', kyc_update: 'fa-id-card', admin_message: 'fa-envelope', shop_status: 'fa-store', delivery_otp: 'fa-key' };
  list.innerHTML = items.map(n => {
    const isLead = n.type === 'new_lead' && (n.ticket_id || n.reference_id);
    const dealBtns = isLead && mpKycStatus === 'approved' ? `
      <div style="display:flex;gap:8px;margin-top:10px;flex-wrap:wrap">
        <button type="button" class="btn-primary btn-sm" onclick="mpShowDealPaymentModal('${n.ticket_id || n.reference_id}','online')"><i class="fa-solid fa-credit-card"></i> Finalize — Online</button>
        <button type="button" class="btn-sm-outline" onclick="mpShowDealPaymentModal('${n.ticket_id || n.reference_id}','cod')"><i class="fa-solid fa-money-bill"></i> Finalize — COD</button>
      </div>` : '';
    // Section 0 #4 fix: the templated card (icon + primary line + up to two
    // supporting facts + "View details") replaces the old raw n.body dump —
    // see CatalogueUI.notificationItemHtml in catalogue-ui.js for why.
    const itemHtml = typeof CatalogueUI !== 'undefined'
      ? CatalogueUI.notificationItemHtml(n, { showMarkRead: true, markReadFn: 'mpMarkRead', showDelete: true })
      : `<div class="notif-item${n.is_read ? '' : ' unread'}"><div class="notif-icon"><i class="fa-solid ${icons[n.type] || 'fa-bell'}"></i></div><div style="flex:1"><div class="notif-title">${n.title || ''}</div><div class="notif-body" style="white-space:pre-line">${n.body || ''}</div></div></div>`;
    if (!dealBtns) return itemHtml;
    // Deal-finalize buttons stay appended after the templated body (they're
    // an action, not descriptive text, so they don't belong inside the
    // template itself).
    return itemHtml.replace('</div></div>', dealBtns + '</div></div>');
  }).join('');
}

async function mpMarkRead(id) {
  await mpApi('/notifications/read', { method: 'POST', body: JSON.stringify({ notification_id: id }) });
  mpLoadNotifications();
}

async function mpMarkAllRead() {
  await mpApi('/notifications/read', { method: 'POST', body: JSON.stringify({ mark_all: true }) });
  mpLoadNotifications();
}

/* Bulk-remove every already-read notification (unread ones stay). */
async function mpClearReadNotifications() {
  if (!confirm('Remove all read notifications? Unread ones will stay.')) return;
  const data = await mpApi('/notifications/delete', { method: 'POST', body: JSON.stringify({ delete_all_read: true }) });
  if (data && data.success) {
    showToast((data.deleted || 0) + ' notification' + (data.deleted === 1 ? '' : 's') + ' removed', 'success');
    mpLoadNotifications();
  } else showToast((data && data.error) || 'Could not clear notifications', 'error');
}

/* Delete one notification — the card slides out optimistically, then the
   list refreshes from the server (and slides back on failure). */
async function mpDeleteNotification(nid, btn) {
  const card = btn && btn.closest('.notif-item');
  if (card) {
    card.style.transition = 'opacity .25s ease, transform .25s ease';
    card.style.opacity = '0';
    card.style.transform = 'translateX(16px)';
  }
  const data = await mpApi('/notifications/delete', { method: 'POST', body: JSON.stringify({ notification_id: nid }) });
  if (data && data.success) {
    showToast('Notification deleted', 'info');
    mpLoadNotifications();
    if (typeof PortalEnhancements !== 'undefined') PortalEnhancements.refreshNotifications(true);
  } else {
    if (card) { card.style.opacity = '1'; card.style.transform = 'none'; }
    showToast((data && data.error) || 'Could not delete notification', 'error');
  }
}

function toggleProfileDropdown() {
  const dd = document.getElementById('profileDropdown');
  if (!dd) return;
  const willOpen = !dd.classList.contains('open');
  if (willOpen) openProfileDropdown(); else closeProfileDropdown();
}
function openProfileDropdown() {
  const dd = document.getElementById('profileDropdown');
  if (!dd) return;
  // Backdrop first (dim + blur), THEN move the sheet onto <body> AFTER it so the
  // sheet escapes the nav's stacking context and renders sharp above the blur.
  let bd = document.getElementById('profileBackdrop');
  if (!bd) {
    bd = document.createElement('div');
    bd.id = 'profileBackdrop';
    bd.className = 'ax-profile-backdrop';
    bd.onclick = closeProfileDropdown;
    document.body.appendChild(bd);
  }
  if (window.innerWidth <= 768) document.body.appendChild(dd); // above the backdrop
  dd.classList.add('open');
  requestAnimationFrame(function () { bd.classList.add('open'); });
}
function closeProfileDropdown() {
  const dd = document.getElementById('profileDropdown');
  const bd = document.getElementById('profileBackdrop');
  if (dd) dd.classList.remove('open');
  if (bd) bd.classList.remove('open');
  // Put the sheet back inside its nav wrapper (needed for the desktop dropdown).
  const wrap = document.getElementById('navProfileWrap');
  if (dd && wrap && dd.parentElement !== wrap) {
    setTimeout(function () { if (!dd.classList.contains('open')) wrap.appendChild(dd); }, 280);
  }
}

document.addEventListener('click', e => {
  const dd = document.getElementById('profileDropdown');
  const btn = document.getElementById('navProfileBtn');
  if (dd && btn && dd.classList.contains('open') && !dd.contains(e.target) && !btn.contains(e.target)) {
    closeProfileDropdown();
  }
});

function mpShowKycSection() {
  toggleProfileDropdown();
  switchPanel('profile');
  resetRecaptchaWidget('kycRecaptcha');
  document.getElementById('kycSection')?.scrollIntoView({ behavior: 'smooth' });
}

function mpGenerateCaptcha() {
  // Prefer a full re-render (survives the KYC-fullscreen DOM move); fall
  // back to a plain reset if the helper isn't loaded for some reason.
  if (typeof axRerenderTurnstile === 'function') { axRerenderTurnstile('kycRecaptcha'); return; }
  resetRecaptchaWidget('kycRecaptcha');
}

function updateKycFileLabel(inputId) {
  const input = document.getElementById(inputId);
  const label = document.getElementById(inputId + 'Name');
  if (!input || !label) return;
  label.textContent = input.files && input.files[0] ? input.files[0].name : 'No file selected';
}

async function mpSubmitKyc() {
  if (!localStorage.getItem('ax_google_token')) {
    showToast('KYC requires Google sign-in', 'warning'); return;
  }
  const recaptchaToken = typeof getRecaptchaToken === 'function'
    ? getRecaptchaToken('kycRecaptcha')
    : '';
  if (!recaptchaToken) { showToast('Please complete the captcha verification', 'error'); return; }
  if (!document.getElementById('kycDeclare')?.checked) { showToast('Please accept declaration', 'error'); return; }

  const toB64 = (inputId) => new Promise((resolve) => {
    const f = document.getElementById(inputId)?.files?.[0];
    if (!f) { resolve(''); return; }
    if (f.size > 2 * 1024 * 1024) { showToast('File max 2MB', 'error'); resolve(''); return; }
    const r = new FileReader();
    r.onload = () => resolve(r.result);
    r.readAsDataURL(f);
  });

  const [front, back, sig] = await Promise.all([
    toB64('kycAadhaarFront'), toB64('kycAadhaarBack'), toB64('kycSignature')
  ]);
  if (!front || !back || !sig) { showToast('Upload all KYC documents', 'error'); return; }

  const fullName = document.getElementById('kycFullName')?.value.trim() || currentUser?.name || '';
  const aadhaar = (document.getElementById('kycAadhaar')?.value || '').replace(/\D/g, '');
  const pan = (document.getElementById('kycPan')?.value || '').trim().toUpperCase();
  const ifsc = (document.getElementById('kycBankIfsc')?.value || '').trim().toUpperCase();
  const bankAccount = (document.getElementById('kycBankAccount')?.value || '').trim();
  if (!fullName) { showToast('Please enter your full legal name', 'error'); return; }
  if (aadhaar.length !== 12) { showToast('Aadhaar number must be 12 digits', 'error'); return; }
  if (pan && pan.length !== 10) { showToast('PAN must be 10 characters', 'error'); return; }
  if (!bankAccount) { showToast('Please enter your account number', 'error'); return; }
  if (!ifsc || ifsc.length !== 11) { showToast('IFSC code must be 11 characters', 'error'); return; }

  const payload = {
    full_name: fullName,
    aadhaar_number: aadhaar,
    aadhaar_name: document.getElementById('kycAadhaarName')?.value.trim() || '',
    pan_number: pan,
    pan_name: document.getElementById('kycPanName')?.value.trim() || '',
    kyc_role: document.querySelector('input[name="kycRole"]:checked')?.value || 'shop_owner',
    bank_account_holder: document.getElementById('kycBankHolder')?.value || '',
    bank_name: document.getElementById('kycBankName')?.value || '',
    bank_account_number: bankAccount,
    bank_ifsc: ifsc,
    bank_branch: document.getElementById('kycBankBranch')?.value || '',
    aadhaar_front_b64: front, aadhaar_back_b64: back, signature_b64: sig,
    declaration_accepted: true,
    recaptcha_token: recaptchaToken,
  };
  const data = await mpApi('/kyc/submit', { method: 'POST', body: JSON.stringify(payload) });
  if (data.success) {
    showToast('KYC submitted — under review', 'success');
    resetRecaptchaWidget('kycRecaptcha');
    mpLoadKycStatus();
  } else {
    showToast(data.error || 'KYC submit failed', 'error');
    resetRecaptchaWidget('kycRecaptcha');
  }
}

async function mpCreateShop() {
  const shopName = document.getElementById('shopName')?.value.trim() || '';
  if (!shopName) { showToast('Please enter a shop name', 'error'); return; }
  const payload = {
    shop_name: shopName,
    shop_description: document.getElementById('shopDesc')?.value || '',
    shop_category: document.getElementById('shopCategory')?.value || 'Other',
    address_city: document.getElementById('shopCity')?.value || '',
    address_state: document.getElementById('shopState')?.value || '',
    address_pincode: document.getElementById('shopPin')?.value || '',
    gst_number: document.getElementById('shopGst')?.value || '',
    terms_accepted: document.getElementById('shopTerms')?.checked,
  };
  const data = await mpApi('/shop/create', { method: 'POST', body: JSON.stringify(payload) });
  if (data.success) {
    showToast('Shop created: ' + data.shop_name, 'success');
    mpShop = { shop_id: data.shop_id || data.shop_name };
    mpLoadKycStatus();
    mpLoadShopProducts();
  } else showToast(data.error || 'Shop creation failed', 'error');
}

async function mpToggleShop() {
  const data = await mpApi('/shop/toggle', { method: 'POST', body: '{}' });
  if (data.success) { showToast('Shop ' + data.status, 'success'); mpLoadShopProducts(); }
}

/* ── Edit / Delete own shop (Batch E) ── */
function mpOpenEditShop() {
  if (typeof axRefreshCategorySelects === 'function') axRefreshCategorySelects();
  const s = mpShop || {};
  const set = (id, v) => { const el = document.getElementById(id); if (el) el.value = v || ''; };
  set('editShopName', s.shop_name || '');
  set('editShopDesc', s.shop_description || '');
  const cat = document.getElementById('editShopCategory');
  if (cat && s.shop_category) cat.value = s.shop_category;
  ['editShopLogo', 'editShopCover'].forEach(id => { const el = document.getElementById(id); if (el) el.value = ''; });
  document.getElementById('editShopModal')?.classList.add('open');
}
function _mpFileToB64(inputId) {
  const f = document.getElementById(inputId)?.files?.[0];
  if (!f) return Promise.resolve('');
  return new Promise(r => { const fr = new FileReader(); fr.onload = () => r(fr.result); fr.onerror = () => r(''); fr.readAsDataURL(f); });
}
async function mpSaveShopEdit() {
  const body = {
    shop_name: (document.getElementById('editShopName')?.value || '').trim(),
    shop_description: document.getElementById('editShopDesc')?.value || '',
    shop_category: document.getElementById('editShopCategory')?.value || 'Other',
  };
  if (!body.shop_name) { showToast('Shop name is required', 'error'); return; }
  const [logo, cover] = await Promise.all([_mpFileToB64('editShopLogo'), _mpFileToB64('editShopCover')]);
  if (logo) body.logo_b64 = logo;
  if (cover) body.cover_b64 = cover;
  showToast('Saving…', 'info');
  const data = await mpApi('/shop/update', { method: 'POST', body: JSON.stringify(body) });
  if (data.success) {
    if (data.shop) mpShop = Object.assign(mpShop || {}, data.shop);
    document.getElementById('editShopModal')?.classList.remove('open');
    showToast('Shop updated', 'success');
    mpLoadShopProducts();
  } else showToast(data.error || 'Could not update shop', 'error');
}
async function mpDeleteShop() {
  if (!confirm('Delete your shop permanently? Your products will be unlisted. This cannot be undone.')) return;
  const data = await mpApi('/shop/delete', { method: 'POST', body: '{}' });
  if (data.success) {
    mpShop = null;
    document.getElementById('editShopModal')?.classList.remove('open');
    showToast('Shop deleted', 'success');
    // Back to the create-shop view.
    const manage = document.getElementById('shopManageArea');
    const create = document.getElementById('shopCreateForm');
    if (manage) manage.style.display = 'none';
    if (create) create.style.display = '';
  } else showToast(data.error || 'Could not delete shop', 'error');
}

async function mpLoadShopFeedback() {
  const data = await mpApi('/shop/feedback');
  const list = document.getElementById('shopFeedbackList');
  if (!list) return;
  const items = data.feedback || [];
  if (!items.length) {
    list.innerHTML = '<p style="color:var(--c-text3);font-size:13px;padding:12px 0">No private feedback yet.</p>';
    return;
  }
  list.innerHTML = items.map(f => `
    <div class="notif-item${f.is_read ? '' : ' unread'}" style="margin-bottom:8px">
      <div class="notif-icon"><i class="fa-solid fa-comment-dots"></i></div>
      <div><div class="notif-title">${f.from_name || 'Customer'}</div>
      <div class="notif-body">${f.message || ''}</div>
      <div class="notif-time">${(f.created_at||'').slice(0,16).replace('T',' ')}</div></div>
    </div>`).join('');
}

/* ── Deal finalize — the buyer (shopkeeper) picks the ORDER's delivery
   address (from their saved address book / map picker) BEFORE paying, so the
   delivery partner always gets an exact drop location. This replaced the old
   flow that silently used the buyer's personal-profile pincode — which left
   produce deals with no destination coords ("incomplete location data"). ── */
let _mpDealAddrs = [];
let _mpDealSelId = null;

async function mpShowDealPaymentModal(ticketId, paymentMode) {
  if (!ticketId) { showToast('Invalid listing reference', 'error'); return; }
  const modal = document.getElementById('dealPaymentModal');
  const body = document.getElementById('dealPaymentBody');
  if (!modal || !body) { showToast('Could not open the deal window', 'error'); return; }
  modal.dataset.ticketId = ticketId;
  modal.dataset.paymentMode = paymentMode;
  modal.classList.add('open');
  body.innerHTML = '<p class="ax-deal-loading"><i class="fa-solid fa-spinner fa-spin"></i> Loading your delivery addresses…</p>';
  await mpDealLoadAddresses();
  mpRenderDealAddressStep();
}

async function mpDealLoadAddresses() {
  const data = await mpApi('/address/list');
  _mpDealAddrs = (data && data.addresses) || [];
  if (!_mpDealSelId && _mpDealAddrs.length) {
    const def = _mpDealAddrs.find(function (a) { return a.is_default; }) || _mpDealAddrs[0];
    _mpDealSelId = def && def.address_id;
  }
}

function mpDealGetSelected() {
  return _mpDealAddrs.find(function (a) { return a.address_id === _mpDealSelId; }) || null;
}

function mpDealSelAddr(id) {
  _mpDealSelId = id;
  mpRenderDealAddressStep();
}

function mpRenderDealAddressStep() {
  const body = document.getElementById('dealPaymentBody');
  if (!body) return;
  const cards = _mpDealAddrs.length
    ? _mpDealAddrs.map(function (a) {
        const sel = a.address_id === _mpDealSelId;
        const noGps = !(+a.lat && +a.lng);
        return '<label class="ax-deal-addr' + (sel ? ' selected' : '') + '">' +
          '<input type="radio" name="mpDealAddr" ' + (sel ? 'checked' : '') + ' onchange="mpDealSelAddr(\'' + escS(a.address_id) + '\')">' +
          '<span class="ax-deal-addr-body">' +
            '<b>' + escS(a.label || 'Address') + '</b>' +
            '<small>' + escS([a.address, a.city, a.state].filter(Boolean).join(', ')) + (a.pincode ? ' - ' + escS(a.pincode) : '') + '</small>' +
            (noGps ? '<em class="ax-deal-addr-warn"><i class="fa-solid fa-triangle-exclamation"></i> No map location — delete &amp; re-add with the map picker</em>' : '') +
          '</span>' +
        '</label>';
      }).join('')
    : '<p class="ax-deal-addr-empty"><i class="fa-solid fa-map-location-dot"></i> No saved address yet. Add your delivery location to continue.</p>';

  body.innerHTML =
    '<h3 class="ax-deal-title"><i class="fa-solid fa-truck-ramp-box"></i> Deliver to</h3>' +
    '<p class="ax-deal-sub">Choose where this order is delivered — the delivery partner routes to this exact spot.</p>' +
    '<div class="ax-deal-addr-list">' + cards + '</div>' +
    '<button type="button" class="ax-add-address-btn" style="width:100%;margin-top:4px" onclick="mpDealAddNewAddress()">' +
      '<i class="fa-solid fa-map-location-dot"></i> Add new address <span class="ax-add-address-sub">(map picker)</span></button>' +
    '<div class="ax-deal-actions">' +
      '<button type="button" class="btn-primary" style="flex:1" onclick="mpDealContinueToPayment()">Continue <i class="fa-solid fa-arrow-right"></i></button>' +
      '<button type="button" class="btn-sm-outline" onclick="mpCloseDealPaymentModal()">Cancel</button>' +
    '</div>';
}

function mpDealAddNewAddress() {
  if (typeof LocationPicker === 'undefined') { showToast('Location picker failed to load — check your connection', 'error'); return; }
  LocationPicker.open({ onSave: mpDealSaveNewAddress });
}

async function mpDealSaveNewAddress(addr) {
  const data = await mpApi('/address/save', { method: 'POST', body: JSON.stringify(addr) });
  if (data && data.success) {
    showToast('Address saved', 'success');
    _mpDealSelId = data.address_id;
    await mpDealLoadAddresses();
    _mpDealSelId = data.address_id;
    mpRenderDealAddressStep();
  } else {
    showToast((data && data.error) || 'Could not save address', 'error');
  }
}

async function mpDealContinueToPayment() {
  const addr = mpDealGetSelected();
  if (!addr) { showToast('Please select or add a delivery address', 'error'); return; }
  if (!(+addr.lat && +addr.lng)) { showToast('This address has no map location — re-add it with the map picker so the driver can find it', 'error'); return; }
  const modal = document.getElementById('dealPaymentModal');
  const body = document.getElementById('dealPaymentBody');
  const ticketId = modal.dataset.ticketId;
  body.innerHTML = '<p class="ax-deal-loading"><i class="fa-solid fa-spinner fa-spin"></i> Calculating charges…</p>';
  const data = await mpApi('/listing/deal/preview', {
    method: 'POST',
    body: JSON.stringify({ ticket_id: ticketId, address_id: addr.address_id, delivery_pincode: addr.pincode || '' }),
  });
  if (!data || !data.breakdown) {
    showToast((data && data.error) || 'Could not load payment details', 'error');
    mpRenderDealAddressStep();
    return;
  }
  mpRenderDealPaymentStep(data.breakdown, addr);
}

function mpRenderDealPaymentStep(b, addr) {
  const body = document.getElementById('dealPaymentBody');
  if (!body) return;
  body.innerHTML =
    '<h3 class="ax-deal-title"><i class="fa-solid fa-receipt"></i> Payment Summary</h3>' +
    '<div class="ax-deal-addr-chip"><i class="fa-solid fa-location-dot"></i> ' +
      escS(addr.label || 'Delivery') + ' · ' + escS([addr.city, addr.state].filter(Boolean).join(', ')) +
      ' <button type="button" onclick="mpRenderDealAddressStep()">Change</button></div>' +
    '<div class="payment-breakdown">' +
      '<div class="pb-row"><span>Lot Price</span><strong>₹' + b.lot_price + '</strong></div>' +
      '<div class="pb-row"><span>Delivery (~' + b.distance_km + ' km)</span><strong>₹' + b.delivery_charge + '</strong></div>' +
      '<div class="pb-row"><span>Platform Fee (' + b.platform_fee_pct + '%)</span><strong>₹' + b.platform_fee + '</strong></div>' +
      '<div class="pb-row pb-sub"><span>Subtotal</span><strong>₹' + b.subtotal + '</strong></div>' +
      '<div class="pb-row pb-gst"><span>GST @ ' + b.gst_rate_pct + '%</span><strong>+ ₹' + b.gst_amount + '</strong></div>' +
      '<div class="pb-row pb-total"><span>Total Payable</span><strong>₹' + b.total + '</strong></div>' +
      '<p class="pb-note"><i class="fa-solid fa-circle-info"></i> GST is shown separately for invoicing. Platform service rate is ' + b.platform_fee_pct + '%.</p>' +
    '</div>' +
    '<div class="ax-deal-actions">' +
      '<button type="button" class="btn-primary" style="flex:1" onclick="mpConfirmDealPayment()"><i class="fa-solid fa-check"></i> Confirm &amp; Finalize</button>' +
      '<button type="button" class="btn-sm-outline" onclick="mpCloseDealPaymentModal()">Cancel</button>' +
    '</div>';
}

function mpCloseDealPaymentModal() {
  document.getElementById('dealPaymentModal')?.classList.remove('open');
}

async function mpConfirmDealPayment() {
  const modal = document.getElementById('dealPaymentModal');
  if (!modal) return;
  await mpFinalizeListingDeal(modal.dataset.ticketId, modal.dataset.paymentMode);
  mpCloseDealPaymentModal();
}

async function mpFinalizeListingDeal(ticketId, paymentMode) {
  if (!ticketId) { showToast('Invalid listing reference', 'error'); return; }
  const addr = mpDealGetSelected();
  if (!addr || !(+addr.lat && +addr.lng)) {
    showToast('Please choose a delivery address on the map first', 'error');
    return;
  }
  const data = await mpApi('/listing/deal', {
    method: 'POST',
    body: JSON.stringify({
      ticket_id: ticketId,
      payment_mode: paymentMode || 'online',
      address_id: addr.address_id,
      delivery_lat: addr.lat,
      delivery_lng: addr.lng,
      delivery_pincode: addr.pincode || '',
      delivery_city: addr.city || '',
    }),
  });
  if (data && data.success) {
    let msg = 'Deal finalized! Order ID: ' + data.arn;
    if (data.breakdown) msg += ' · Total ₹' + data.breakdown.total + ' (GST ₹' + data.breakdown.gst_amount + ')';
    showToast(msg, 'success');
    if (data.payment_link_url && paymentMode === 'online') window.open(data.payment_link_url, '_blank');
    mpLoadNotifications();
  } else showToast((data && data.error) || 'Deal could not be finalized', 'error');
}

/* ── My Shop helpers ──────────────────────────────────────────────── */
function escS(s) {
  return String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}
/* wa.me deep link with a ready-made intro message — 10-digit numbers get
   the +91 country code (Indian marketplace default). */
function axWaLink(phone, msg) {
  let d = String(phone || '').replace(/\D/g, '');
  if (d.length === 10) d = '91' + d;
  return 'https://wa.me/' + d + (msg ? '?text=' + encodeURIComponent(msg) : '');
}
/* One person-row inside a claim card: role + name on the left, the three
   contact actions (Call / SMS / WhatsApp-with-prefilled-message) on the
   right. */
function axContactRow(role, icon, name, phone, waMsg) {
  return '<div class="shop-claim-row">' +
    '<div class="sc-who"><i class="fa-solid ' + icon + '"></i><div><span>' + escS(role) + '</span><b>' + escS(name || '—') + '</b></div></div>' +
    (phone
      ? '<div class="sc-actions">' +
        '<a class="sc-btn sc-call" href="tel:' + escS(phone) + '" title="Call ' + escS(name || '') + '" aria-label="Call"><i class="fa-solid fa-phone"></i></a>' +
        '<a class="sc-btn sc-sms" href="sms:' + escS(phone) + '" title="Message" aria-label="SMS"><i class="fa-solid fa-comment-dots"></i></a>' +
        '<a class="sc-btn sc-wa" href="' + axWaLink(phone, waMsg) + '" target="_blank" rel="noopener" title="WhatsApp" aria-label="WhatsApp"><i class="fa-brands fa-whatsapp"></i></a>' +
        '</div>'
      : '')
    + '</div>';
}

/* Seller analytics dashboard (Phase 2) — shop performance at a glance. */
async function mpLoadAnalytics() {
  const el = document.getElementById('shopAnalytics');
  if (!el) return;
  el.innerHTML = '<div class="ax-analytics-loading"><i class="fa-solid fa-spinner fa-spin"></i> Loading…</div>';
  const d = await mpApi('/shop/analytics');
  if (!d || d.error) { el.innerHTML = ''; return; }
  const inr = n => '₹' + (Number(n) || 0).toLocaleString('en-IN', { maximumFractionDigits: 0 });
  const s = d.sales || {};
  const tile = (icon, val, label, cls) =>
    '<div class="ax-analytics-tile"><i class="fa-solid ' + icon + ' ' + (cls || '') + '"></i>' +
    '<b>' + val + '</b><span>' + label + '</span></div>';
  let html = '<div class="ax-analytics-grid">' +
    tile('fa-eye', d.total_views || 0, 'Product views') +
    tile('fa-bag-shopping', s.orders || 0, 'Orders') +
    tile('fa-indian-rupee-sign', inr(s.revenue), 'Revenue', 'pos') +
    tile('fa-hourglass-half', inr(s.pending), 'Pending payout', 'warn') +
    tile('fa-star', (d.avg_rating || 0).toFixed(1), 'Avg rating', 'gold') +
    tile('fa-heart', d.like_count || 0, 'Favourites', 'red') +
    tile('fa-box', d.product_count || 0, 'Products') +
    tile('fa-handshake', d.open_negotiations || 0, 'Open deals') +
  '</div>';
  if ((s.cod || s.online) && typeof axDonut === 'function') {
    html += '<div class="ax-analytics-chart">' + axDonut([
      { label: 'COD', value: s.cod || 0, color: '#C7993A' },
      { label: 'Online', value: s.online || 0, color: '#2E6B41' },
    ], { center: inr(s.revenue), centerSub: 'Revenue', fmt: inr }) + '</div>';
  } else if (s.cod || s.online) {
    html += '<div class="ax-analytics-split"><span><i class="fa-solid fa-hand-holding-dollar"></i> COD ' + inr(s.cod) + '</span>' +
      '<span><i class="fa-solid fa-credit-card"></i> Online ' + inr(s.online) + '</span></div>';
  }
  if ((d.top_products || []).length) {
    html += '<div class="ax-analytics-top"><div class="ax-analytics-top-title">Top products</div>' +
      d.top_products.map(p => '<div class="ax-analytics-top-row"><span>' + escS(p.product_name) + '</span>' +
        '<small><i class="fa-solid fa-eye"></i> ' + (p.views || 0) + ' · <i class="fa-solid fa-star"></i> ' + (p.avg_rating || 0) + ' (' + (p.total_reviews || 0) + ')</small></div>').join('') +
    '</div>';
  }
  el.innerHTML = html;
}

async function mpLoadShopProducts() {
  if (typeof mpLoadAnalytics === 'function') mpLoadAnalytics();   // Phase 2
  const data = await mpApi('/shop/products');
  mpProducts = data.products || [];
  const header = document.getElementById('shopHeader');
  const shopId = data.shop || mpShop?.shop_id;
  const shopName = (mpShop && mpShop.shop_name) || shopId || 'My Shop';
  if (header && shopId) {
    const status = mpShop?.status || 'active';
    header.innerHTML =
      '<h3>' + escS(shopName) + '</h3>' +
      '<p class="shop-hero-meta">' +
        '<button type="button" class="shop-id-chip" onclick="axCopyText(\'' + escS(shopId) + '\', this)" title="Copy shop ID"><i class="fa-regular fa-copy"></i> ' + escS(shopId) + '</button>' +
        '<span class="shop-hero-dot">·</span><span>' + mpProducts.length + ' products</span>' +
        '<span class="shop-hero-dot">·</span><span class="kyc-badge kyc-' + (status === 'active' ? 'approved' : 'pending') + '">' + escS(status) + '</span>' +
      '</p>';
  }
  // Show the uploaded shop logo in the hero avatar (falls back to the store icon).
  const avatar = document.querySelector('#shopManageArea .shop-hero-avatar');
  if (avatar) {
    const logo = mpShop && mpShop.shop_logo_url;
    avatar.innerHTML = logo
      ? '<img src="' + escS(logo) + '" alt="" style="width:100%;height:100%;object-fit:cover;border-radius:inherit">'
      : '<i class="fa-solid fa-store"></i>';
  }
  const grid = document.getElementById('shopProductsList');
  if (!grid) return;
  if (!shopId) {
    grid.innerHTML = document.getElementById('shopCreateForm') ? '' : '<p>Create shop after KYC approval.</p>';
    return;
  }
  grid.innerHTML = mpProducts.length ? mpProducts.map(p => {
    const avail = parseFloat(p.available_stock_kg);
    const committed = parseFloat(p.committed_kg) || 0;
    const free = parseFloat(p.free_stock_kg);
    const freeShow = !isNaN(free) ? free : ((!isNaN(avail) ? avail : 0) - committed);
    const lotLabel = !isNaN(avail)
      ? (`${Math.round(avail)} kg left` + (committed > 0 ? ` · ${Math.round(committed)} kg in open orders` : '') + (p.price_per_kg ? ` — ₹${p.price_per_kg}/kg` : ''))
      : (p.lot_size_kg ? `Lot ${p.lot_size_kg} kg — ₹${p.lot_price || (p.lot_size_kg * p.price_per_kg)}` : `₹${p.price_per_kg}/kg`);
    const isSoldOut = p.lot_status === 'sold_out' || (!isNaN(avail) && avail <= 0 && !(p.claimed_orders || []).length);
    const isFullyReserved = p.lot_status === 'reserved' || p.lot_status === 'sold';
    const paused = !!p.is_paused;
    const statusChip = isSoldOut
      ? '<span class="sp-chip sp-sold"><i class="fa-solid fa-box-open"></i> Sold out — refill</span>'
      : isFullyReserved
        ? '<span class="sp-chip sp-sold"><i class="fa-solid fa-truck-fast"></i> Out for delivery</span>'
      : paused
        ? '<span class="sp-chip sp-paused"><i class="fa-solid fa-pause"></i> Paused</span>'
        : '<span class="sp-chip sp-live"><i class="fa-solid fa-circle"></i> Live</span>';
    const claims = p.claimed_orders || [];
    const claimStatusLabel = {
      PENDING_DELIVERY: 'Order placed',
      PENDING_APPROVAL: 'Awaiting approval',
      DELIVERY_ASSIGNED: 'Claimed',
      IN_TRANSIT: 'Out for delivery',
      NEAR_DESTINATION: 'Arriving soon'
    };
    const claimedInfoHtml = claims.length ? claims.map(function (c) {
      const label = claimStatusLabel[c.status] || c.status || 'Open';
      const kg = c.ordered_kg || c.reserved_kg;
      const waIntroBuyer = 'Namaste ' + (c.buyer_name || '') + '! Main ' + shopName + ' (Aarvex Global) se aapke order ' + (c.arn || '') + ' — ' + (p.product_name || '') + ' — ke baare mein sampark kar raha/rahi hun.';
      const waIntroPartner = 'Namaste ' + (c.delivery_partner_name || '') + '! ' + shopName + ' (Aarvex Global) se — order ' + (c.arn || '') + ' (' + (p.product_name || '') + ') ki delivery ke baare mein.';
      return '<div class="shop-claim-card">' +
        '<div class="shop-claim-head">' +
          '<span class="sp-chip sp-transit">' + escS(label) + '</span>' +
          (kg ? '<span class="sc-kg">' + escS(kg) + ' kg</span>' : '') +
          (c.arn ? '<button type="button" class="sc-arn" onclick="axCopyText(\'' + escS(c.arn) + '\', this)" title="Copy order ID"><i class="fa-regular fa-copy"></i> ' + escS(c.arn) + '</button>' : '') +
        '</div>' +
        axContactRow('Buyer', 'fa-user', c.buyer_name || 'Buyer', c.buyer_mobile, waIntroBuyer) +
        (c.delivery_partner_name || c.delivery_partner_mobile
          ? axContactRow('Delivery partner', 'fa-truck-fast', c.delivery_partner_name, c.delivery_partner_mobile, waIntroPartner)
          : '<div class="sc-kg" style="opacity:.75">Waiting for a delivery partner…</div>') +
      '</div>';
    }).join('') + (isFullyReserved ? '<div class="sp-autonote">Stock updates when delivery completes.</div>' : '') : '';
    const actions = isFullyReserved
      ? ''
      : '<div class="sp-actions">' +
          '<button type="button" class="sp-btn" onclick="mpOpenEditProduct(\'' + p.product_id + '\',\'' + p.category_id + '\')"><i class="fa-solid fa-pen-to-square"></i> Modify</button>' +
          (isSoldOut ? '' :
            '<button type="button" class="sp-btn" onclick="mpToggleProductPause(\'' + p.product_id + '\',\'' + p.category_id + '\',' + (!paused) + ')"><i class="fa-solid fa-' + (paused ? 'play' : 'pause') + '"></i> ' + (paused ? 'Activate' : 'Pause') + '</button>') +
          '<button type="button" class="sp-btn sp-danger" onclick="mpDeleteProduct(\'' + p.product_id + '\',\'' + p.category_id + '\')"><i class="fa-regular fa-trash-can"></i> Delete</button>' +
        '</div>';
    const media = p.image_url
      ? '<img class="sp-img" src="' + escS(p.image_url) + '" alt="" loading="lazy" onerror="this.style.display=\'none\';this.nextElementSibling.style.display=\'grid\'"><div class="sp-img sp-img-ph" style="display:none"><i class="fa-solid fa-box-open"></i></div>'
      : '<div class="sp-img sp-img-ph"><i class="fa-solid fa-box-open"></i></div>';
    return '<div class="shop-prod-card' + (isSoldOut || isFullyReserved ? ' is-sold' : '') + '" id="shop-prod-' + escS(p.product_id) + '">' +
      '<div class="sp-media">' + media + statusChip + '</div>' +
      '<div class="sp-body">' +
        '<div class="sp-name">' + escS(p.product_name) + '</div>' +
        '<div class="sp-meta">' + escS(p.category_name || '') + ' · ' + escS(lotLabel) +
          (!isNaN(freeShow) && committed > 0 ? ' · free for new: ' + Math.round(freeShow) + ' kg' : '') + '</div>' +
        claimedInfoHtml +
        actions +
      '</div>' +
    '</div>';
  }).join('') : (typeof CatalogueUI !== 'undefined'
    ? CatalogueUI.emptyStateHtml({ icon: 'fa-box-open', message: 'No products yet — tap Add Product to list your first lot.' })
    : '<p>No products yet. Add your first lot.</p>');
}

async function mpAddProduct() {
  const imgs = document.getElementById('prodImages');
  const b64s = [];
  if (imgs?.files) {
    for (const f of imgs.files) {
      if (b64s.length >= 3) break;
      const b64 = await new Promise(r => { const fr = new FileReader(); fr.onload = () => r(fr.result); fr.readAsDataURL(f); });
      b64s.push(b64);
    }
  }
  const lotSize = parseFloat(document.getElementById('prodLotSize')?.value || document.getElementById('prodMinQty')?.value || 0);
  const priceKg = parseFloat(document.getElementById('prodPrice')?.value || 0);
  const mrpKg = parseFloat(document.getElementById('prodMrp')?.value || 0);
  const payload = {
    product_name: document.getElementById('prodName')?.value,
    category_id: (document.getElementById('prodCategory')?.value || 'other').toLowerCase().replace(/ /g,'_'),
    category_name: document.getElementById('prodCategory')?.value,
    description: document.getElementById('prodDesc')?.value,
    price_per_kg: priceKg,
    mrp_price_per_kg: mrpKg || undefined,
    lot_size_kg: lotSize,
    images_b64: b64s,
  };
  const data = await mpApi('/shop/product/add', { method: 'POST', body: JSON.stringify(payload) });
  if (data.success) {
    showToast('Product added', 'success');
    document.getElementById('addProductModal')?.classList.remove('open');
    mpLoadShopProducts();
  } else showToast(data.error || 'Failed', 'error');
}

async function mpToggleProductPause(pid, cid, pause) {
  await mpApi('/shop/product/pause', { method: 'POST', body: JSON.stringify({ product_id: pid, category_id: cid, is_paused: pause }) });
  mpLoadShopProducts();
}

async function mpDeleteProduct(pid, cid) {
  if (!confirm('Delete this product?')) return;
  await mpApi('/shop/product/delete', { method: 'POST', body: JSON.stringify({ product_id: pid, category_id: cid }) });
  mpLoadShopProducts();
}

function mpOpenEditProduct(pid, cid) {
  const p = (mpProducts || []).find(function (x) {
    return x.product_id === pid && (!cid || x.category_id === cid);
  });
  if (!p) {
    if (typeof showToast === 'function') showToast('Product not found — refresh shop', 'error');
    return;
  }
  document.getElementById('editProdId').value = p.product_id || '';
  document.getElementById('editProdCat').value = p.category_id || '';
  document.getElementById('editProdName').value = p.product_name || '';
  document.getElementById('editProdDesc').value = p.description || '';
  document.getElementById('editProdPrice').value = p.price_per_kg || '';
  document.getElementById('editProdMrp').value = p.mrp_price_per_kg || '';
  document.getElementById('editProdRefill').value = '';
  document.getElementById('editProdLotSize').value = '';
  const cat = document.getElementById('editProdCategory');
  if (cat) {
    const want = p.category_name || '';
    let matched = false;
    for (let i = 0; i < cat.options.length; i++) {
      if (cat.options[i].text === want || cat.options[i].value === want) {
        cat.selectedIndex = i; matched = true; break;
      }
    }
    if (!matched && want) {
      cat.value = want;
    }
  }
  const avail = parseFloat(p.available_stock_kg);
  const committed = parseFloat(p.committed_kg) || 0;
  const hint = document.getElementById('editProdStockHint');
  if (hint) {
    hint.innerHTML = '<b>Remaining:</b> ' + (isNaN(avail) ? '—' : Math.round(avail) + ' kg') +
      (committed > 0 ? ' · <b>In open orders:</b> ' + Math.round(committed) + ' kg (not deducted until delivery completes)' : '') +
      (p.lot_status === 'sold_out' ? '<br>This listing is archived. Refill or set a new lot to republish.' : '');
  }
  if (typeof switchPanel === 'function') {
    try { switchPanel('shop'); } catch (e) {}
  }
  document.getElementById('editProductModal')?.classList.add('open');
  setTimeout(function () {
    document.getElementById('shop-prod-' + pid)?.scrollIntoView({ behavior: 'smooth', block: 'center' });
  }, 200);
}

async function mpSaveProductEdit() {
  const pid = document.getElementById('editProdId')?.value;
  const cid = document.getElementById('editProdCat')?.value;
  if (!pid) return;
  const refill = parseFloat(document.getElementById('editProdRefill')?.value || '');
  const newLot = parseFloat(document.getElementById('editProdLotSize')?.value || '');
  if (!isNaN(newLot) && newLot > 0 && !isNaN(refill) && refill > 0) {
    if (typeof showToast === 'function') showToast('Use either Refill OR Set new lot — not both', 'error');
    return;
  }
  if (!isNaN(newLot) && newLot > 0) {
    if (!confirm('Set new lot to ' + newLot + ' kg? This resets remaining stock to that amount.')) return;
  }
  const imgs = document.getElementById('editProdImages');
  const b64s = [];
  if (imgs?.files) {
    for (const f of imgs.files) {
      if (b64s.length >= 3) break;
      const b64 = await new Promise(r => { const fr = new FileReader(); fr.onload = () => r(fr.result); fr.readAsDataURL(f); });
      b64s.push(b64);
    }
  }
  const payload = {
    product_id: pid,
    category_id: cid,
    product_name: document.getElementById('editProdName')?.value,
    category_name: document.getElementById('editProdCategory')?.value,
    description: document.getElementById('editProdDesc')?.value,
    price_per_kg: parseFloat(document.getElementById('editProdPrice')?.value || 0),
    mrp_price_per_kg: parseFloat(document.getElementById('editProdMrp')?.value || 0) || 0,
  };
  if (!isNaN(refill) && refill > 0) payload.refill_kg = refill;
  else if (!isNaN(newLot) && newLot > 0) payload.lot_size_kg = newLot;
  if (b64s.length) payload.images_b64 = b64s;
  const data = await mpApi('/shop/product/edit', { method: 'POST', body: JSON.stringify(payload) });
  if (data && data.success) {
    if (typeof showToast === 'function') showToast('Product updated', 'success');
    document.getElementById('editProductModal')?.classList.remove('open');
    mpLoadShopProducts();
    if (typeof axInvalidateCatalogue === 'function') axInvalidateCatalogue();
  } else if (typeof showToast === 'function') {
    showToast((data && data.error) || 'Update failed', 'error');
  }
}

window.mpOpenEditProduct = mpOpenEditProduct;
window.mpSaveProductEdit = mpSaveProductEdit;

function axInvalidateCatalogue() {
  try {
    if (typeof loadCatalogue === 'function') loadCatalogue();
    else if (typeof loadCatalogueSections === 'function') loadCatalogueSections();
  } catch (e) {}
  try {
    if (typeof loadFavouritesCatalogue === 'function') loadFavouritesCatalogue();
  } catch (e) {}
  try {
    if (typeof mpLoadShopProducts === 'function') mpLoadShopProducts();
  } catch (e) {}
}
window.axInvalidateCatalogue = axInvalidateCatalogue;

async function mpSaveProfile() {
  const payload = {
    name: document.getElementById('p_name')?.value,
    email: document.getElementById('p_email')?.value,
    mobile: document.getElementById('p_mobile')?.value,
    address: document.getElementById('p_address')?.value,
    city: document.getElementById('p_city')?.value,
    state: document.getElementById('p_state')?.value,
    pincode: document.getElementById('p_pincode')?.value,
    gender: document.getElementById('p_gender')?.value,
    company_name: document.getElementById('p_company')?.value,
    gst_number: document.getElementById('p_gst')?.value,
    account_status: document.getElementById('p_frozen')?.checked ? 'frozen' : 'active',
  };
  const data = await mpApi('/profile/update', { method: 'POST', body: JSON.stringify(payload) });
  if (data.success) showToast('Profile saved', 'success');
}

function mpShowGoogleKycBanner() {
  if (!currentUser || currentUser.provider === 'google') return;
  const kycSection = document.getElementById('kycSection');
  if (!kycSection || kycSection.querySelector('.google-required-banner')) return;
  const banner = document.createElement('div');
  banner.className = 'google-required-banner';
  banner.innerHTML = '<i class="fa-brands fa-google"></i><div><strong>Google sign-in required for KYC &amp; Shop</strong><br>Marketplace verification (KYC, shop creation, delivery partner) needs Google authentication for secure identity. Sign out and sign in with Google to unlock seller features.</div>';
  kycSection.insertBefore(banner, kycSection.firstChild);
}

function mpInitMarketplace() {
  if (!currentUser) return;
  const profileTrigger = document.querySelector('.profile-nav-trigger');
  if (profileTrigger && currentUser.name) {
    profileTrigger.dataset.initials = currentUser.name.split(/\s+/).filter(Boolean).slice(0, 2).map(function (part) { return part.charAt(0).toUpperCase(); }).join('');
    profileTrigger.classList.add('has-initials');
  }
  const dashboard = document.getElementById('panel-dashboard');
  const banner = document.getElementById('dashBannerSlot');
  const greeting = document.querySelector('.dash-hero');
  if (dashboard && banner && greeting) dashboard.insertBefore(banner, greeting);
  mpShowGoogleKycBanner();
  mpLoadKycStatus();
  mpLoadNotifications();
  mpLoadBanner();
  mpLoadBanner('trade', 'tradeBannerSlot');
  if (typeof syncFavourites === 'function') syncFavourites();
  mpLoadShopProducts();
  mpLoadShopFeedback();
  mpGenerateCaptcha();
  ['prodPrice', 'prodLotSize', 'prodMrp'].forEach(function (id) {
    document.getElementById(id)?.addEventListener('input', function () {
      const kg = parseFloat(document.getElementById('prodLotSize')?.value || 0);
      const rate = parseFloat(document.getElementById('prodPrice')?.value || 0);
      const mrp = parseFloat(document.getElementById('prodMrp')?.value || 0);
      const prev = document.getElementById('prodLotPreview');
      if (!prev) return;
      if (!kg || !rate) { prev.value = ''; return; }
      let text = '₹' + (kg * rate) + ' per lot';
      if (mrp > rate) {
        const pct = Math.round(((mrp - rate) / mrp) * 100);
        text += '  (MRP ₹' + (kg * mrp) + ' — ' + pct + '% off)';
      }
      prev.value = text;
    });
  });
  
  // Show cancel button if there's an active order
  if (mpCurrentOrderArn) {
    const cancelBtn = document.getElementById('orderCancelBtn');
    if (cancelBtn) cancelBtn.style.display = 'block';
  }
  
  const kycName = document.getElementById('kycFullName');
  if (kycName && currentUser.name) kycName.value = currentUser.name;
}

const _origOnSignedIn = typeof onSignedIn === 'function' ? onSignedIn : null;
onSignedIn = function() {
  if (_origOnSignedIn) _origOnSignedIn();
  setTimeout(mpInitMarketplace, 300);
  setTimeout(mpLoadBanner, 2000);
};

// Order cancellation function
async function cancelCurrentOrder() {
  if (!mpCurrentOrderArn) {
    showToast('No active order to cancel', 'error');
    return;
  }
  
  if (!confirm('Are you sure you want to cancel this order? The booking will be released and the product listing stays as it was.')) {
    return;
  }
  
  const data = await mpApi('/order/cancel', { method: 'POST', body: JSON.stringify({ arn: mpCurrentOrderArn }) });
  if (data.success) {
    showToast('Order cancelled — booking released', 'success');
    mpCurrentOrderArn = null;
    
    // Hide cancel button
    const cancelBtn = document.getElementById('orderCancelBtn');
    if (cancelBtn) cancelBtn.style.display = 'none';
    
    // Reload orders to reflect cancellation
    if (typeof mpLoadMyOrders === 'function') {
      mpLoadMyOrders();
    }
    if (typeof axInvalidateCatalogue === 'function') axInvalidateCatalogue();
    
    // Reload catalogue to show the product as available again
    if (typeof loadCatalogue === 'function') {
      loadCatalogue();
    }
  } else {
    showToast(data.error || 'Cancellation failed', 'error');
  }
}

// Store current ARN when order is placed
const _origSubmitOrder = typeof submitOrder === 'function' ? submitOrder : null;
if (_origSubmitOrder) {
  submitOrder = async function() {
    const result = await _origSubmitOrder.apply(this, arguments);
    // Store the ARN if order was successful
    if (result && result.arn) {
      mpCurrentOrderArn = result.arn;
      const cancelBtn = document.getElementById('orderCancelBtn');
      if (cancelBtn) cancelBtn.style.display = 'block';
    }
    return result;
  };
}

const _origHandleGoogle = typeof handleGoogleCredential === 'function' ? handleGoogleCredential : null;
handleGoogleCredential = function(response) {
  localStorage.setItem('ax_google_token', response.credential);
  if (_origHandleGoogle) _origHandleGoogle(response);
};

const _origSwitchPanel = typeof switchPanel === 'function' ? switchPanel : null;
switchPanel = function(panelId) {
  if (_origSwitchPanel) _origSwitchPanel(panelId);
  if (panelId === 'notifications') mpLoadNotifications();
  if (panelId === 'shop') { mpLoadShopProducts(); mpLoadShopFeedback(); }
  if (panelId === 'dashboard') mpLoadBanner();
  if (panelId === 'trade') mpLoadBanner('trade', 'tradeBannerSlot');
  if (typeof axScheduleLiveTranslate === 'function' && typeof axCurrentLang === 'function' && axCurrentLang() !== 'en') {
    axScheduleLiveTranslate(500);
  }
};

document.addEventListener('DOMContentLoaded', function () {
  mpLoadBanner();
});
