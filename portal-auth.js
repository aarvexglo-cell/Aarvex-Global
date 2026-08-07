/* ══════════════════════════════════════════════════════════════
   AARVEX GLOBAL — PORTAL AUTH + PROFILE + KYC MODULE
   Extracted from portal.html (originally lines 2462-3155, inline
   <script>). Loaded via <script src="portal-auth.js"></script> in
   portal.html, in the exact same position the original inline code
   occupied — so execution order and behaviour are unchanged.

   Depends on globals declared in portal.html's own inline <script>
   tags (LAMBDA_URL, GOOGLE_CLIENT_ID, currentUser, userProfile,
   catalogue, filteredCatalogue, favouritesCatalogue,
   favouritesCatalogueAll, selectedProduct, orderType,
   customPhotoB64, googleAvailable, _reauthInFlight,
   _profileDraftTimer, _kycDraftTimer) and on functions defined
   later in portal.html (e.g. showToast, animateCountUp) — those
   are only referenced inside function bodies here, so it's fine
   that they're defined later; they're not called until the page
   has fully loaded.
   ══════════════════════════════════════════════════════════════ */
'use strict';

function getRecaptchaToken(containerId) {
  if (typeof getTurnstileToken === 'function') return getTurnstileToken(containerId);
  try {
    if (containerId) {
      const el = document.querySelector('#' + containerId + ' input[name=cf-turnstile-response], #' + containerId + ' textarea[name=cf-turnstile-response]');
      if (el && el.value) return el.value;
    }
    const order = document.querySelector('#orderRecaptcha input[name=cf-turnstile-response]');
    const sell = document.querySelector('#sellRecaptcha input[name=cf-turnstile-response]');
    const kyc = document.querySelector('#kycRecaptcha input[name=cf-turnstile-response]');
    if (order && order.value) return order.value;
    if (sell && sell.value) return sell.value;
    if (kyc && kyc.value) return kyc.value;
    return '';
  } catch (e) { return ''; }
}

// Turnstile tokens are single-use: once sent to our backend for verification
// (pass OR fail), Cloudflare invalidates that token. If the form submit fails
// for any other reason and we resubmit without resetting, the backend will
// always reject with "timeout-or-duplicate". So we MUST explicitly reset the
// widget (by its container id) after every submit attempt.
function resetRecaptchaWidget(containerId) {
  try {
    if (typeof turnstile !== 'undefined' && containerId) {
      turnstile.reset(containerId);
    }
  } catch (e) { /* widget not ready / not rendered yet — ignore */ }
}

/* Robustly (re)render a Cloudflare Turnstile widget into a container.
   WHY: Turnstile auto-renders every `.cf-turnstile` div on script load.
   #kycRecaptcha lives inside the profile panel, which is display:none at
   that moment — so Turnstile bakes an invisible, zero-size (effectively
   dead) iframe. When axOpenKycFullscreen() MOVES #kycSection into the
   fullscreen overlay, that dead iframe does not come back to life, and
   turnstile.reset() no-ops on it → the user sees an empty box.
   Fix: fully deregister the old widget and render a fresh one into the
   now-visible container. Safe to call repeatedly; retries until the
   Turnstile script has finished loading. */
function axRerenderTurnstile(containerId) {
  try {
    var el = document.getElementById(containerId);
    if (!el) return;
    if (typeof turnstile === 'undefined' || !turnstile.render) {
      setTimeout(function () { axRerenderTurnstile(containerId); }, 400);
      return;
    }
    // Deregister any existing (possibly dead) widget so render() won't
    // throw "widget already rendered".
    try {
      var wid = turnstile.getWidgetId && turnstile.getWidgetId('#' + containerId);
      if (wid) turnstile.remove(wid);
    } catch (e) { /* ignore */ }
    el.innerHTML = '';
    var sitekey = el.getAttribute('data-sitekey') || '0x4AAAAAADs_xRz679e2-ggj';
    turnstile.render('#' + containerId, {
      sitekey: sitekey,
      theme: (document.documentElement.getAttribute('data-theme') === 'dark') ? 'dark' : 'auto'
    });
  } catch (e) { /* ignore */ }
}
window.axRerenderTurnstile = axRerenderTurnstile;

function initRecaptchaWidgets() { /* Turnstile auto-renders from data-sitekey divs */ }


/* ── GOOGLE AUTH ── */
var _gsiInitialized = false;
var _googleTokenWaiters = [];

function _notifyGoogleTokenWaiters(token) {
  var waiters = _googleTokenWaiters.splice(0, _googleTokenWaiters.length);
  waiters.forEach(function (fn) {
    try { fn(token || ''); } catch (e) { /* ignore */ }
  });
}

/** Initialize Google Identity Services at most once (avoids GSI_LOGGER spam). */
function initGoogleOnce(opts) {
  opts = opts || {};
  if (typeof google === 'undefined' || !google.accounts || !google.accounts.id) return false;
  if (_gsiInitialized) return true;
  try {
    google.accounts.id.initialize({
      client_id: GOOGLE_CLIENT_ID,
      callback: handleGoogleCredential,
      auto_select: !!opts.auto_select,
      cancel_on_tap_outside: true,
      use_fedcm_for_prompt: true,
      itp_support: true,
    });
    _gsiInitialized = true;
    return true;
  } catch (e) {
    console.warn('[Google] init error:', e);
    return false;
  }
}

function initGoogle() {
  if (typeof google === 'undefined') { setTimeout(initGoogle, 300); return; }
  // HTML <div id="g_id_onload"> already initializes GIS — don't call again.
  if (document.getElementById('g_id_onload')) {
    _gsiInitialized = true;
    return;
  }
  initGoogleOnce({ auto_select: false });
}

function signInWithGoogle() {
  if (typeof google === 'undefined') {
    showToast('Google is loading, please try again…', 'warning');
    setTimeout(signInWithGoogle, 600);
    return;
  }
  initGoogleOnce({ auto_select: false });
  // Try One Tap / FedCM first; fallback to OAuth popup
  google.accounts.id.prompt(function(notification) {
    if (notification.isNotDisplayed() || notification.isSkippedMoment()) {
      _openGoogleOAuthPopup();
    }
  });
}

function _openGoogleOAuthPopup() {
  const nonce = Math.random().toString(36).substring(2);
  const redirectUri = window.location.origin + window.location.pathname;
  const authUrl =
    'https://accounts.google.com/o/oauth2/v2/auth' +
    '?client_id=' + encodeURIComponent(GOOGLE_CLIENT_ID) +
    '&redirect_uri=' + encodeURIComponent(redirectUri) +
    '&response_type=id_token' +
    '&scope=openid%20profile%20email' +
    '&nonce=' + nonce +
    '&prompt=select_account';

  const popup = window.open(authUrl, 'gLogin', 'width=500,height=620,left=200,top=80');
  if (!popup) {
    showToast('Popup blocked! Please allow popups for this site and try again.', 'warning');
    return;
  }

  const timer = setInterval(() => {
    try {
      if (popup.closed) { clearInterval(timer); return; }
      const hash = popup.location.hash;
      if (hash && hash.includes('id_token=')) {
        clearInterval(timer);
        popup.close();
        const idToken = new URLSearchParams(hash.substring(1)).get('id_token');
        if (idToken) handleGoogleCredential({ credential: idToken });
      }
    } catch(e) { /* cross-origin — keep polling */ }
  }, 400);
}

function handleGoogleCredential(response) {
  const payload = parseJwt(response.credential);
  currentUser = { sub: payload.sub, name: payload.name, email: payload.email, picture: payload.picture, provider: 'google' };
  localStorage.setItem('ax_user', JSON.stringify(currentUser));
  localStorage.setItem('ax_google_token', response.credential); // required for marketplace/KYC API auth
  window._axSessionExpiredShown = false;
  window._axAuthPollPaused = false;
  _notifyGoogleTokenWaiters(response.credential);
  onSignedIn();
}

function parseJwt(token) {
  const base64 = token.split('.')[1].replace(/-/g,'+').replace(/_/g,'/');
  return JSON.parse(decodeURIComponent(atob(base64).split('').map(c => '%' + ('00'+c.charCodeAt(0).toString(16)).slice(-2)).join('')));
}

/* ── Token-expiry fix ──────────────────────────────────────────────────
   Google ID tokens (the ones stored in ax_google_token and sent as the
   Bearer auth header) are only valid for ~1 hour. The app used to only
   check whether a token existed, never whether an *existing* one had
   expired — so after ~1hr on the page (e.g. filling in the KYC form),
   every API call started failing with "Unauthorized — valid Google token
   required" and nothing re-authenticated automatically. These two
   helpers fix that: one checks real expiry, the other does a silent
   Google re-auth (no popup, no page reload) and is used both proactively
   (before requests) and reactively (after a 401) by mpApi(). */
function isGoogleTokenExpired(bufferSeconds) {
  const token = localStorage.getItem('ax_google_token');
  if (!token) return true;
  try {
    const payload = parseJwt(token);
    const buf = (bufferSeconds || 60) * 1000;
    return !payload.exp || (payload.exp * 1000) < (Date.now() + buf);
  } catch (e) {
    return true;
  }
}
window.isGoogleTokenExpired = isGoogleTokenExpired;

/** Interactive OAuth popup — when silent FedCM/One Tap fails (Brave / ITP). */
function axInteractiveGoogleReauth() {
  if (_reauthInFlight) return _reauthInFlight;
  _reauthInFlight = new Promise(function (resolve) {
    var finished = false;
    var finish = function (tok) {
      if (finished) return;
      finished = true;
      _reauthInFlight = null;
      resolve(tok || localStorage.getItem('ax_google_token') || '');
    };
    _googleTokenWaiters.push(finish);
    if (typeof showToast === 'function') {
      showToast('Session expired — Google sign-in window open karein…', 'warning');
    }
    try {
      _openGoogleOAuthPopup();
    } catch (e) {
      finish('');
      return;
    }
    setTimeout(function () { finish(localStorage.getItem('ax_google_token') || ''); }, 120000);
  });
  return _reauthInFlight;
}
window.axInteractiveGoogleReauth = axInteractiveGoogleReauth;

function ensureFreshGoogleToken(opts) {
  opts = opts || {};
  // Email users have no Google ID token — interactive upgrade for pay/address.
  if (!currentUser || currentUser.provider !== 'google') {
    if (opts.interactive && (!localStorage.getItem('ax_google_token') || isGoogleTokenExpired())) {
      return axInteractiveGoogleReauth();
    }
    return Promise.resolve(localStorage.getItem('ax_google_token') || '');
  }
  if (!isGoogleTokenExpired()) {
    return Promise.resolve(localStorage.getItem('ax_google_token') || '');
  }
  if (opts.interactive) {
    return axInteractiveGoogleReauth();
  }
  if (_reauthInFlight) return _reauthInFlight;
  _reauthInFlight = new Promise(function (resolve) {
    var settled = false;
    const finish = function () {
      if (settled) return;
      settled = true;
      _reauthInFlight = null;
      resolve(localStorage.getItem('ax_google_token') || '');
    };
    _googleTokenWaiters.push(finish);
    const tryPrompt = function () {
      if (typeof google === 'undefined' || !google.accounts || !google.accounts.id) {
        setTimeout(tryPrompt, 500);
        return;
      }
      try {
        // Never re-initialize GSI (causes "initialize() called multiple times").
        if (!initGoogleOnce({ auto_select: true })) {
          finish();
          return;
        }
        google.accounts.id.prompt(function (notification) {
          if (notification.isNotDisplayed() || notification.isSkippedMoment()) {
            if (typeof showToast === 'function' && !window._axSessionExpiredShown) {
              window._axSessionExpiredShown = true;
              showToast('Session expired — next action will ask you to sign in again.', 'warning');
            }
            finish();
          }
          // On success, handleGoogleCredential → _notifyGoogleTokenWaiters(finish)
        });
      } catch (e) {
        finish();
      }
    };
    tryPrompt();
    setTimeout(finish, 8000);
  });
  return _reauthInFlight;
}
window.ensureFreshGoogleToken = ensureFreshGoogleToken;

function showAuthFallbackNotice() {
  const notice = document.getElementById('authErrorNotice');
  if (notice) notice.classList.add('show');
}

/* ── EMAIL LOGIN ── */
function showEmailLogin() {
  document.getElementById('emailBtnSection').style.display = 'none';
  document.getElementById('googleBtnWrap').style.display = 'none';
  document.getElementById('emailLoginForm').classList.add('show');
  document.getElementById('loginNote').style.display = 'none';
  document.getElementById('authErrorNotice').classList.remove('show');
  const firstInput = document.getElementById('el_name');
  if (firstInput) setTimeout(() => firstInput.focus(), 100);
}

function hideEmailLogin() {
  document.getElementById('emailBtnSection').style.display = '';
  document.getElementById('googleBtnWrap').style.display = '';
  document.getElementById('emailLoginForm').classList.remove('show');
  document.getElementById('loginNote').style.display = '';
}

function submitEmailLogin() {
  const name  = (document.getElementById('el_name').value || '').trim();
  const email = (document.getElementById('el_email').value || '').trim();
  const errBox = document.getElementById('emailLoginError');
  const errMsg = document.getElementById('emailLoginErrorMsg');
  errBox.classList.remove('show');

  if (!name) { errMsg.textContent = 'Please enter your full name.'; errBox.classList.add('show'); return; }
  if (!email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    errMsg.textContent = 'Please enter a valid email address.'; errBox.classList.add('show'); return;
  }

  const sub = 'email_' + btoa(email).replace(/=/g,'').replace(/\+/g,'-').replace(/\//g,'_');
  currentUser = { sub, name, email, picture: null, provider: 'email' };
  localStorage.setItem('ax_user', JSON.stringify(currentUser));
  showToast('Welcome, ' + name.split(' ')[0] + '! 👋', 'success');
  onSignedIn();
}

/* Allow Enter key on email login form */
document.addEventListener('keydown', function(e) {
  if (e.key === 'Enter' && document.getElementById('emailLoginForm').classList.contains('show')) {
    submitEmailLogin();
  }
});

function copyARN(arn) {
  navigator.clipboard.writeText(arn)
    .then(() => showToast('ARN copied: ' + arn, 'success'))
    .catch(() => {
      const ta = document.createElement('textarea');
      ta.value = arn; ta.style.position = 'fixed'; ta.style.opacity = '0';
      document.body.appendChild(ta); ta.select(); document.execCommand('copy');
      document.body.removeChild(ta); showToast('ARN copied: ' + arn, 'success');
    });
}

function signOut() {
  localStorage.removeItem('ax_user');
  localStorage.removeItem('ax_google_token');
  currentUser = null; userProfile = {};
  if (typeof google !== "undefined") google.accounts.id.disableAutoSelect();
  showToast('Signed out successfully. Redirecting…', 'info');
  setTimeout(function() {
    window.location.href = 'index.html';
  }, 1000);
}

function deleteLocalAccountData() {
  if (!currentUser) return;
  deleteAccountPermanently();
}

async function deleteAccountPermanently() {
  if (!currentUser) return;
  let hadShop = false;
  let hadDelivery = false;
  try {
    const st = (typeof mpApi === 'function') ? await mpApi('/kyc/status') : null;
    const k = (st && st.kyc) || {};
    const shop = (st && st.shop) || {};
    const role = String(k.kyc_role || '');
    const approved = String(k.status || '') === 'approved';
    hadShop = approved && (!!shop.shop_id || role === 'shop_owner' || role === 'both');
    hadDelivery = approved && (role === 'delivery_partner' || role === 'both');
  } catch (e) { /* still allow delete */ }

  let warning =
    'Delete your Aarvex account permanently?\n\n' +
    'This will permanently remove your profile, KYC records, products, posts, and saved data from our systems. ' +
    'This action cannot be undone.\n\n' +
    'If you sign in again with the same Google account, you will start as a new user.';

  if (hadShop && hadDelivery) {
    warning =
      'Permanent account deletion\n\n' +
      'You currently have an approved Shop and Delivery partner profile. ' +
      'Deleting your account will permanently remove:\n' +
      '• Your Shop tab and all listed products\n' +
      '• Your Delivery partner tab and delivery access\n' +
      '• KYC verification, subscription, and profile data\n\n' +
      'This cannot be undone. Signing in again with the same Google account will create a brand-new empty account — you will need to complete KYC and approvals from scratch.';
  } else if (hadShop) {
    warning =
      'Permanent account deletion\n\n' +
      'You currently have an approved Shop. Deleting your account will permanently remove your Shop tab, all listed products, KYC verification, and profile data.\n\n' +
      'This cannot be undone. Signing in again with the same Google account will create a brand-new empty account.';
  } else if (hadDelivery) {
    warning =
      'Permanent account deletion\n\n' +
      'You currently have an approved Delivery partner profile. Deleting your account will permanently remove your Delivery tab, delivery access, KYC verification, and profile data.\n\n' +
      'This cannot be undone. Signing in again with the same Google account will create a brand-new empty account.';
  }

  if (!confirm(warning)) return;
  if (!confirm('Final confirmation: permanently delete this account and all connected data?')) return;

  showToast('Deleting your account…', 'info');
  try {
    const res = (typeof mpApi === 'function')
      ? await mpApi('/account/delete', { method: 'POST', body: JSON.stringify({ confirm: true }) })
      : null;
    if (!res || res.error || !res.success) {
      showToast((res && res.error) || 'Could not delete account. Please try again or contact support.', 'error');
      return;
    }
  } catch (e) {
    showToast('Could not delete account. Please try again.', 'error');
    return;
  }
  const key = profileKey(); if (key) localStorage.removeItem(key);
  const kkey = kycKey(); if (kkey) localStorage.removeItem(kkey);
  showToast('Your account has been permanently deleted.', 'success');
  setTimeout(signOut, 900);
}

/* ── ON SIGNED IN ── */
function onSignedIn() {
  // Header action buttons + bottom nav only exist for signed-in users —
  // CSS hides them while this class is absent (see portal-ui.css), so the
  // login screen gets the full viewport with no dead chrome around it.
  document.body.classList.add('is-signed-in');
  document.getElementById('loginScreen').style.display = 'none';
  document.getElementById('portalScreen').style.display = 'block';
  try { document.dispatchEvent(new CustomEvent('ax:signed-in')); } catch (e) { /* ignore */ }
  if (typeof axHideBootLoader === 'function') {
    setTimeout(axHideBootLoader, 700);
  }
  loadProfile();
  updateSidebarUser();
  loadCatalogue();
  loadMyListings();
  handlePortalDeepLink();
}

function handlePortalDeepLink() {
  const params = new URLSearchParams(window.location.search);
  const productId = params.get('product');
  const categoryId = params.get('category') || '';
  const panel = params.get('panel');
  const openForm = params.get('action') === 'order' || !!productId;
  if (panel) {
    const mapping = { order: 'trade', sell: 'trade' };
    switchPanel(mapping[panel] || panel);
    if (panel === 'order') switchTradeMode('order');
    if (panel === 'sell') switchTradeMode('sell');
  }
  if (productId) {
    switchPanel('trade');
    const tryOpen = () => {
      const p = catalogue.find(x => x.product_id === productId && (!categoryId || x.category_id === categoryId));
      if (p) {
        if (openForm) selectProductForOrder(p);
        else if (typeof ProductModal !== 'undefined') ProductModal.openModal(p);
      }
    };
    if (catalogue.length) tryOpen();
    else setTimeout(tryOpen, 1500);
  }
}

function updateSidebarUser() {
  if (!currentUser) return;
  document.getElementById('sidebarName').textContent = currentUser.name || '—';
  document.getElementById('sidebarEmail').textContent = currentUser.email || '—';
  const firstName = (currentUser.name || '').split(' ')[0];
  document.getElementById('dashWelcomeName').textContent = 'Welcome back, ' + firstName + '!';
  const tradeWelcomeEl = document.getElementById('tradeWelcomeName');
  if (tradeWelcomeEl) tradeWelcomeEl.textContent = 'Welcome, ' + firstName + '!';
  document.getElementById('ddName').textContent = currentUser.name || '—';
  document.getElementById('ddEmail').textContent = currentUser.email || '—';
  const navWrap = document.getElementById('navProfileWrap');
  if (navWrap) navWrap.style.display = currentUser ? 'flex' : 'none';
  renderAvatarEl('sidebarAvatarWrap', 60, false);
  renderAvatarEl('profilePhotoWrap', 88, true);
  renderAvatarEl('dashAvatarWrap', 72, false, true);
  renderAvatarEl('navAvatarWrap', 36, false);
  renderAvatarEl('ddAvatarWrap', 40, false);
  document.getElementById('profilePhotoName').textContent = currentUser.name || '—';
}

function renderAvatarEl(containerId, size, big, hero) {
  const wrap = document.getElementById(containerId);
  if (!wrap) return;
  const photo = customPhotoB64 || (userProfile.custom_photo) || (currentUser && currentUser.picture);
  const initials = (currentUser && currentUser.name)
    ? currentUser.name.split(' ').map(w => w[0]).join('').slice(0,2).toUpperCase() : '??';
  if (hero) {
    wrap.innerHTML = photo
      ? '<img style="width:'+size+'px;height:'+size+'px;border-radius:var(--r-sm);object-fit:cover;border:2px solid rgba(255,255,255,.15);" src="'+photo+'" alt="Avatar" onerror="this.style.display=\'none\'">'
      : '<div style="width:'+size+'px;height:'+size+'px;border-radius:var(--r-sm);background:var(--g-leaf);color:#fff;font-size:'+Math.round(size*.35)+'px;font-weight:800;display:flex;align-items:center;justify-content:center;font-family:system-ui,-apple-system,\'Segoe UI\',Roboto,Arial,sans-serif;border:2px solid rgba(255,255,255,.15);">'+initials+'</div>';
    return;
  }
  wrap.innerHTML = photo
    ? '<img class="'+(big?'profile-photo-big':(size<=40?'nav-avatar-init':'sidebar-avatar'))+'" src="'+photo+'" alt="Profile" onerror="this.style.display=\'none\'">'
    : '<div class="'+(big?'profile-photo-initials':(size<=40?'nav-avatar-init':'sidebar-avatar-initials'))+'">'+initials+'</div>';
}

/* ── PROFILE ── */
function profileKey() { return currentUser ? 'ax_profile_' + currentUser.sub : null; }

async function loadProfile() {
  const key = profileKey(); if (!key) return;
  const raw = localStorage.getItem(key);
  if (!raw) {
    userProfile = {};
  } else {
    try {
      userProfile = JSON.parse(raw) || {};
    } catch (e) {
      console.warn('Corrupted profile data, resetting:', e);
      localStorage.removeItem(key);
      userProfile = {};
    }
  }
  // Paint immediately from the local cache so the UI isn't blank while we wait on the network.
  fillProfileForm(); checkProfileComplete(); prefillForms(); loadKycDraft(); updateStats();

  // NOTE (profile-persistence fix): localStorage is only a per-browser cache.
  // DynamoDB (via GET /profile) is the real source of truth, so pull it and
  // merge it in — this is what makes the profile show up automatically on a
  // new device/browser instead of asking the user to fill it in again.
  const token = localStorage.getItem('ax_google_token');
  if (!token) return;
  try {
    const data = await mpApi('/profile');
    if (data && data.profile && Object.keys(data.profile).length) {
      const p = data.profile;
      userProfile = {
        ...userProfile,
        ...p,
        company: p.company_name || p.company || userProfile.company,
        gst: p.gst_number || p.gst || userProfile.gst,
      };
      localStorage.setItem(key, JSON.stringify(userProfile));
      fillProfileForm(); checkProfileComplete(); prefillForms(); updateStats();
    }
  } catch (e) {
    // Offline or request failed — the localStorage copy already rendered above.
  }
}

function mpSaveProfileExtras() {
  if (!currentUser) { showToast('Sign in to save settings', 'error'); return; }
  userProfile = userProfile || {};
  // Phone / DOB / gender now live under My Profile → Personal Information, so
  // only overwrite them here if those inputs are still present (guard against
  // wiping saved values now that they were removed from Settings).
  if (document.getElementById('p_phone')) userProfile.phone = gv('p_phone').trim();
  if (document.getElementById('p_dob')) userProfile.dob = gv('p_dob').trim();
  if (document.getElementById('p_gender')) userProfile.gender = gv('p_gender').trim();
  userProfile.account_status = document.getElementById('p_frozen')?.checked ? 'frozen' : 'active';
  userProfile.saved_at = new Date().toISOString();
  localStorage.setItem(profileKey(), JSON.stringify(userProfile));
  showToast('Account settings saved locally.', 'success');
}

function fillProfileForm() {
  const p = userProfile;
  sv('p_name',   p.name   || (currentUser && currentUser.name)  || '');
  sv('p_email',  p.email  || (currentUser && currentUser.email) || '');
  sv('p_mobile', p.mobile || '');
  sv('p_company',p.company|| '');
  sv('p_address',p.address|| '');
  sv('p_city',   p.city   || '');
  sv('p_state',  p.state  || '');
  sv('p_pincode',p.pincode|| '');
  sv('p_country',p.country|| 'India');
  sv('p_gst',    p.gst    || '');
  sv('p_farm_location', p.farm_location || '');
  sv('p_address_lat', p.address_lat || '');
  sv('p_address_lng', p.address_lng || '');
  fillSettingsForm();
}

function fillSettingsForm() {
  const p = userProfile;
  sv('p_phone', p.phone || '');
  sv('p_dob', p.dob || '');
  sv('p_gender', p.gender || '');
  const frozen = p.account_status === 'frozen';
  const checkbox = document.getElementById('p_frozen');
  if (checkbox) checkbox.checked = frozen;
}

function saveProfile() {
  const btn = document.getElementById('profileSaveBtn');
  const name   = gv('p_name').trim();
  const mobile = gv('p_mobile').trim();
  if (!name)   { showToast('Please enter your name', 'error'); return; }
  if (!mobile) { showToast('Please enter your mobile number', 'error'); return; }
  const mobileDigits = mobile.replace(/\D/g, '');
  if (mobileDigits.length < 10 || mobileDigits.length > 13) {
    showToast('Please enter a valid mobile number', 'error'); return;
  }

  userProfile = {
    name, mobile,
    email:         gv('p_email').trim()   || (currentUser && currentUser.email) || '',
    company:       gv('p_company').trim(),
    address:       gv('p_address').trim(),
    city:          gv('p_city').trim(),
    state:         gv('p_state').trim(),
    pincode:       gv('p_pincode').trim(),
    country:       gv('p_country').trim() || 'India',
    gst:           gv('p_gst').trim(),
    farm_location: gv('p_farm_location').trim(),
    address_lat:   gv('p_address_lat').trim(),
    address_lng:   gv('p_address_lng').trim(),
    phone:         userProfile.phone || gv('p_phone').trim(),
    dob:           userProfile.dob || gv('p_dob').trim(),
    gender:        userProfile.gender || gv('p_gender').trim(),
    account_status:userProfile.account_status || (document.getElementById('p_frozen')?.checked ? 'frozen' : 'active'),
    custom_photo:  customPhotoB64 || userProfile.custom_photo || null,
    saved_at:      new Date().toISOString(),
  };
  localStorage.setItem(profileKey(), JSON.stringify(userProfile));
  const token = localStorage.getItem('ax_google_token');
  if (token) {
    // NOTE: backend whitelist (marketplace.py handle_profile_update) expects
    // company_name/gst_number, not company/gst — map them so these fields
    // actually persist to DynamoDB instead of being silently dropped.
    fetch(LAMBDA_URL + '/profile/update', {
      method: 'POST',
      headers: {'Content-Type': 'application/json', 'Authorization': 'Bearer ' + token},
      body: JSON.stringify({
        ...userProfile,
        company_name: userProfile.company,
        gst_number: userProfile.gst,
      })
    }).catch(() => {});
  }

  btn.innerHTML = '<div class="spinner"></div> Saving…'; btn.disabled = true;
  setTimeout(() => {
    btn.innerHTML = '<i class="fa-solid fa-floppy-disk"></i> Save Profile'; btn.disabled = false;
    const fb = document.getElementById('saveFeedback');
    fb.classList.add('show'); setTimeout(() => fb.classList.remove('show'), 3500);
    checkProfileComplete(); prefillForms(); updateSidebarUser();
    renderAvatarEl('profilePhotoWrap', 88, true);
    showToast('Profile saved successfully!', 'success');
  }, 700);
}

function checkProfileComplete() {
  const complete = !!(userProfile.name && userProfile.mobile);
  const badge = document.getElementById('sidebarBadge');
  const banner = document.getElementById('profileIncompleteBanner');
  const dashBadge = document.getElementById('dashStatusBadge');
  if (badge) {
    badge.className = 'sidebar-profile-badge ' + (complete ? 'profile-badge-complete' : 'profile-badge-incomplete');
    badge.innerHTML = complete
      ? '<i class="fa-solid fa-circle-check"></i> Profile complete'
      : '<i class="fa-solid fa-circle-exclamation"></i> Profile incomplete';
  }
  // Home uses #axProfileAlert only — keep legacy banner permanently hidden
  // so incomplete profiles never show two “Complete profile” strips.
  if (banner) { banner.style.display = 'none'; banner.hidden = true; }
  if (dashBadge && complete) dashBadge.innerHTML = '<i class="fa-solid fa-circle-check"></i> Verified';
}

function prefillForms() {
  const p = userProfile; if (!p.name) return;
  sv('o_name',   p.name); sv('o_mobile', p.mobile);
  sv('o_email',  p.email || (currentUser && currentUser.email) || '');
  sv('o_company',p.company); sv('o_gst', p.gst);
  sv('o_address',p.address); sv('o_city', p.city);
  sv('o_state',  p.state); sv('o_pincode', p.pincode);
  sv('o_country',p.country || 'India');
  if (p.address_lat) sv('o_address_lat', p.address_lat);
  if (p.address_lng) sv('o_address_lng', p.address_lng);
  sv('s_name',   p.name); sv('s_mobile', p.mobile);
  sv('s_email',  p.email || (currentUser && currentUser.email) || '');
  sv('s_city',   p.city || p.farm_location || '');
  sv('s_state',  p.state); sv('s_pincode', p.pincode);
  const has = !!(p.name && p.mobile);
  const on = document.getElementById('orderPrefillNotice');
  const sn = document.getElementById('sellPrefillNotice');
  if (on) on.style.display = has ? '' : 'none';
  if (sn) sn.style.display = has ? '' : 'none';
}

function animateCountUp(el, target) {
  if (!el) return;
  target = parseInt(target, 10) || 0;
  const start = parseInt(el.textContent, 10) || 0;
  if (start === target) { el.textContent = target; return; }
  const duration = 600;
  const t0 = performance.now();
  function tick(now) {
    const p = Math.min((now - t0) / duration, 1);
    const eased = 1 - Math.pow(1 - p, 3); // ease-out cubic
    el.textContent = Math.round(start + (target - start) * eased);
    if (p < 1) requestAnimationFrame(tick);
    else el.textContent = target;
  }
  requestAnimationFrame(tick);
}

function updateStats() {
  const orders = getOrderHistory();
  const sells = parseInt(localStorage.getItem('ax_sells_' + (currentUser && currentUser.sub)) || '0');
  const statO = document.getElementById('statOrders');
  const statS = document.getElementById('statSells');
  if (statO) animateCountUp(statO, orders.length);
  if (statS) animateCountUp(statS, sells);
  const badge = document.getElementById('ordersCountBadge');
  if (badge) { badge.textContent = orders.length; badge.style.display = orders.length > 0 ? '' : 'none'; }
}

function kycKey() {
  return currentUser ? 'ax_kyc_' + currentUser.sub : null;
}

function loadKycDraft() {
  const key = kycKey(); if (!key) return;
  const raw = localStorage.getItem(key);
  if (!raw) return;
  try {
    const draft = JSON.parse(raw);
    const role = draft.kyc_role || 'shop_owner';
    const radio = document.querySelector('input[name="kycRole"][value="' + role + '"]');
    if (radio) radio.checked = true;
    sv('kycFullName', draft.full_name || currentUser?.name || '');
    sv('kycAadhaar', draft.aadhaar_number || '');
    sv('kycPan', draft.pan_number || '');
    sv('kycBankHolder', draft.bank_account_holder || '');
    sv('kycBankName', draft.bank_name || '');
    sv('kycBankAccount', draft.bank_account_number || '');
    sv('kycBankIfsc', draft.bank_ifsc || '');
    sv('kycBankBranch', draft.bank_branch || '');
  } catch (e) {
    console.warn('Failed to load KYC draft', e);
  }
}


function normalizePhoneInput(el) {
  if (!el) return;
  el.value = el.value.replace(/[^0-9+ ]/g, '');
}

function normalizeNumericInput(el) {
  if (!el) return;
  el.value = el.value.replace(/\D/g, '');
}

function normalizePanInput(el) {
  if (!el) return;
  el.value = el.value.toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 10);
}

function normalizeUppercaseInput(el) {
  if (!el) return;
  el.value = el.value.toUpperCase();
}

function saveProfileDraft() {
  if (!currentUser) return;
  userProfile = {
    name: gv('p_name').trim() || (currentUser && currentUser.name) || '',
    email: gv('p_email').trim() || (currentUser && currentUser.email) || '',
    mobile: gv('p_mobile').trim(),
    company: gv('p_company').trim(),
    address: gv('p_address').trim(),
    city: gv('p_city').trim(),
    state: gv('p_state').trim(),
    pincode: gv('p_pincode').trim(),
    country: gv('p_country').trim() || 'India',
    gst: gv('p_gst').trim(),
    farm_location: gv('p_farm_location').trim(),
    phone: userProfile.phone || gv('p_phone')?.trim() || '',
    dob: userProfile.dob || gv('p_dob')?.trim() || '',
    gender: userProfile.gender || gv('p_gender')?.trim() || '',
    account_status: userProfile.account_status || (document.getElementById('p_frozen')?.checked ? 'frozen' : 'active'),
    custom_photo: customPhotoB64 || userProfile.custom_photo || null,
    saved_at: new Date().toISOString(),
  };
  localStorage.setItem(profileKey(), JSON.stringify(userProfile));
}

function queueSaveProfileDraft() {
  clearTimeout(_profileDraftTimer);
  _profileDraftTimer = setTimeout(saveProfileDraft, 500);
}

function saveKycDraft() {
  if (!currentUser) return;
  const key = kycKey(); if (!key) return;
  const draft = {
    kyc_role: document.querySelector('input[name="kycRole"]:checked')?.value || 'shop_owner',
    full_name: gv('kycFullName').trim(),
    aadhaar_number: gv('kycAadhaar').trim(),
    pan_number: gv('kycPan').trim().toUpperCase(),
    bank_account_holder: gv('kycBankHolder').trim(),
    bank_name: gv('kycBankName').trim(),
    bank_account_number: gv('kycBankAccount').trim(),
    bank_ifsc: gv('kycBankIfsc').trim().toUpperCase(),
    bank_branch: gv('kycBankBranch').trim(),
    saved_at: new Date().toISOString(),
  };
  localStorage.setItem(key, JSON.stringify(draft));
}

function queueSaveKycDraft() {
  clearTimeout(_kycDraftTimer);
  _kycDraftTimer = setTimeout(saveKycDraft, 500);
}

function initProfileKycAutoSave() {
  const profileIds = ['p_name','p_mobile','p_company','p_address','p_city','p_state','p_pincode','p_country','p_gst','p_farm_location'];
  profileIds.forEach(id => {
    const el = document.getElementById(id);
    if (el) el.addEventListener('input', queueSaveProfileDraft);
  });
  const kycIds = ['kycFullName','kycAadhaar','kycPan','kycBankHolder','kycBankName','kycBankAccount','kycBankIfsc','kycBankBranch'];
  kycIds.forEach(id => {
    const el = document.getElementById(id);
    if (el) el.addEventListener('input', queueSaveKycDraft);
  });
  document.querySelectorAll('input[name="kycRole"]').forEach(el => {
    el.addEventListener('change', queueSaveKycDraft);
  });
}

/* ── PHOTO UPLOAD ── */
function uploadPhoto(input) {
  if (!input.files || !input.files[0]) return;
  const file = input.files[0];
  if (file.size > 2 * 1024 * 1024) { showToast('Photo must be under 2 MB', 'error'); return; }
  const reader = new FileReader();
  reader.onload = (e) => {
    customPhotoB64 = e.target.result;
    renderAvatarEl('sidebarAvatarWrap', 60, false);
    renderAvatarEl('profilePhotoWrap', 88, true);
    renderAvatarEl('dashAvatarWrap', 72, false, true);
    showToast('Photo updated — save profile to keep it', 'info');
  };
  reader.readAsDataURL(file);
}
function removeCustomPhoto() {
  customPhotoB64 = null;
  if (userProfile) userProfile.custom_photo = null;
  renderAvatarEl('sidebarAvatarWrap', 60, false);
  renderAvatarEl('profilePhotoWrap', 88, true);
  renderAvatarEl('dashAvatarWrap', 72, false, true);
  showToast('Custom photo removed', 'info');
}
