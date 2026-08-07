/* ═══════════════════════════════════════════════════════════════════════
   ax-social.js — Batch 2+3 frontend
   • View ANY user's profile (posts/followers/following/bio) + Follow / Block /
     Report / Message
   • Privacy: "what shows on my public profile" toggles + block-list
   • Audience picker (Public / Followers / Selected / Hide-from) for the post &
     story composers
   Backend: /user/profile, /user/block, /user/blocklist, /user/report,
            /privacy/update, /feed/follow, /feed/follow/stats
   ═══════════════════════════════════════════════════════════════════════ */

function axSocEsc(s) {
  if (typeof axEsc === 'function') return axEsc(s);
  return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
    return ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c];
  });
}
function axMySub() {
  return (typeof currentUser !== 'undefined' && currentUser) ? currentUser.sub : '';
}
function axSocAvatar(name, photo, cls) {
  if (typeof axAvatarHtml === 'function') return axAvatarHtml(name, photo, cls);
  return '<div class="' + (cls || '') + '">' + axSocEsc((name || '?').charAt(0).toUpperCase()) + '</div>';
}

/* ── Profile viewer ─────────────────────────────────────────────────── */
let _axProfileData = null;

async function axOpenProfile(userSub) {
  if (!userSub) return;
  let ov = document.getElementById('axProfileOverlay');
  if (ov) ov.remove();
  ov = document.createElement('div');
  ov.id = 'axProfileOverlay';
  ov.className = 'ax-profile-overlay';
  ov.innerHTML = '<div class="ax-profile-sheet"><div class="ax-profile-loading"><span class="spinner"></span></div></div>';
  ov.addEventListener('click', function (e) { if (e.target === ov) axCloseProfile(); });
  document.body.appendChild(ov);
  document.body.style.overflow = 'hidden';
  const data = await mpApi('/user/profile?user_sub=' + encodeURIComponent(userSub));
  if (!data || data.error) {
    showToast((data && data.error) || 'Could not load profile', 'error');
    axCloseProfile();
    return;
  }
  _axProfileData = data;
  _axRenderProfile(data);
}
function axCloseProfile() {
  const ov = document.getElementById('axProfileOverlay');
  if (ov) ov.remove();
  document.body.style.overflow = '';
}

function _axRenderProfile(d) {
  const sheet = document.querySelector('#axProfileOverlay .ax-profile-sheet');
  if (!sheet) return;
  const cover = d.cover_url
    ? '<div class="ax-prof-cover" style="background-image:url(\'' + axSocEsc(d.cover_url) + '\')"></div>'
    : '<div class="ax-prof-cover ax-prof-cover-empty"></div>';
  const roleBadge = d.role === 'shop' ? '<span class="ax-prof-role"><i class="fa-solid fa-store"></i> Seller</span>'
    : d.role === 'delivery' ? '<span class="ax-prof-role"><i class="fa-solid fa-truck-fast"></i> Delivery</span>' : '';

  let actions;
  if (d.is_me) {
    actions = '<button type="button" class="btn-sm-outline" onclick="axCloseProfile();switchPanel(\'profile\')"><i class="fa-solid fa-pen"></i> Edit profile</button>' +
              '<button type="button" class="btn-sm-outline" onclick="axOpenPrivacy()"><i class="fa-solid fa-shield-halved"></i> Privacy</button>';
  } else if (d.blocked_by_me) {
    actions = '<button type="button" class="btn-primary" onclick="axProfileToggleBlock(\'' + axSocEsc(d.user_sub) + '\')"><i class="fa-solid fa-user-check"></i> Unblock</button>';
  } else {
    actions =
      '<button type="button" class="ax-follow-btn ' + (d.is_following ? 'following' : '') + '" id="axProfFollowBtn" onclick="axProfileToggleFollow(\'' + axSocEsc(d.user_sub) + '\', this)">' +
        (d.is_following ? 'Following' : '<i class="fa-solid fa-plus"></i> Follow') + '</button>' +
      '<button type="button" class="btn-sm-outline" onclick="axProfileMessage(\'' + axSocEsc(d.user_sub) + '\',\'' + axSocEsc(d.user_name) + '\',\'' + axSocEsc(d.user_photo) + '\')"><i class="fa-solid fa-paper-plane"></i> Message</button>' +
      '<button type="button" class="ax-prof-menu-btn" onclick="axProfileMenu(\'' + axSocEsc(d.user_sub) + '\')" aria-label="More"><i class="fa-solid fa-ellipsis"></i></button>';
  }

  // Public personal fields (only present when the user chose to share them).
  const info = [];
  if (d.city) info.push('<span><i class="fa-solid fa-location-dot"></i> ' + axSocEsc(d.city) + '</span>');
  if (d.phone) info.push('<span><i class="fa-solid fa-phone"></i> ' + axSocEsc(d.phone) + '</span>');
  if (d.email) info.push('<span><i class="fa-solid fa-envelope"></i> ' + axSocEsc(d.email) + '</span>');
  if (d.dob) info.push('<span><i class="fa-solid fa-cake-candles"></i> ' + axSocEsc(d.dob) + '</span>');

  let body;
  if (d.blocking_me) {
    body = '<div class="ax-prof-blocked-note"><i class="fa-solid fa-ban"></i> This user is not available.</div>';
  } else if (d.blocked_by_me) {
    body = '<div class="ax-prof-blocked-note"><i class="fa-solid fa-ban"></i> You blocked this user. Unblock to see their posts.</div>';
  } else if (!d.posts || !d.posts.length) {
    body = '<div class="ax-prof-empty"><i class="fa-solid fa-camera"></i><p>No posts yet</p></div>';
  } else {
    body = '<div class="ax-prof-grid">' + d.posts.map(function (p) {
      const thumb = p.media_url
        ? (p.media_type === 'video'
            ? '<video src="' + axSocEsc(p.media_url) + '" muted></video><span class="ax-prof-vid"><i class="fa-solid fa-play"></i></span>'
            : '<img src="' + axSocEsc(p.media_url) + '" alt="" loading="lazy">')
        : '<div class="ax-prof-textpost">' + axSocEsc((p.description || '').slice(0, 80)) + '</div>';
      return '<button type="button" class="ax-prof-cell" onclick="axProfileOpenPost(\'' + axSocEsc(p.post_id) + '\')">' + thumb + '</button>';
    }).join('') + '</div>';
  }

  sheet.innerHTML =
    '<button type="button" class="ax-prof-close" onclick="axCloseProfile()" aria-label="Close"><i class="fa-solid fa-xmark"></i></button>' +
    cover +
    '<div class="ax-prof-body">' +
      '<div class="ax-prof-avatar-wrap">' + axSocAvatar(d.user_name, d.user_photo, 'ax-prof-avatar') + '</div>' +
      '<div class="ax-prof-name-row"><h2>' + axSocEsc(d.user_name) + '</h2>' + roleBadge + '</div>' +
      (d.bio ? '<p class="ax-prof-bio">' + axSocEsc(d.bio) + '</p>' : '') +
      (info.length ? '<div class="ax-prof-info">' + info.join('') + '</div>' : '') +
      '<div class="ax-prof-stats">' +
        '<div class="ax-prof-stat"><b>' + (d.post_count || 0) + '</b><span>Posts</span></div>' +
        '<button type="button" class="ax-prof-stat" onclick="axProfileFollowList(\'' + axSocEsc(d.user_sub) + '\',\'followers\')"><b>' + (d.follower_count || 0) + '</b><span>Followers</span></button>' +
        '<div class="ax-prof-stat"><b>' + (d.following_count || 0) + '</b><span>Following</span></div>' +
      '</div>' +
      '<div class="ax-prof-actions">' + actions + '</div>' +
      (d.delivery_stats ? axRenderDeliveryCard(d.delivery_stats, d.is_me) : '') +
      axRenderImporterCard(d) +
      body +
    '</div>';
}

/* Importer trust card (D4) — verified badge + orders-placed + member-since.
   The owner sees a "Get verified" button when not yet verified. */
function axRenderImporterCard(d) {
  const s = d.importer_stats || {};
  const verified = d.importer_verified;
  // Only worth showing for real buyers (some orders) or on your own profile.
  if (!d.is_me && !verified && !(s.orders_placed > 0)) return '';
  const since = s.member_since ? String(s.member_since).slice(0, 10) : '';
  return '<div class="ax-dr-card">' +
    '<div class="ax-dr-title"><i class="fa-solid fa-user-check"></i> Buyer record' +
      (verified ? ' <span class="ax-verified-badge"><i class="fa-solid fa-circle-check"></i> Verified</span>' : '') + '</div>' +
    '<div class="ax-dr-stats">' +
      '<div><b>' + (s.orders_placed || 0) + '</b><span>Orders placed</span></div>' +
      '<div><b>' + (verified ? 'Yes' : 'No') + '</b><span>Verified</span></div>' +
      (since ? '<div><b>' + axSocEsc(since) + '</b><span>Member since</span></div>' : '') +
    '</div>' +
    (d.is_me && !verified
      ? '<button type="button" class="btn-primary ax-dr-share" onclick="axImporterVerify(this)"><i class="fa-solid fa-shield-halved"></i> Get verified</button>'
      : '') +
    '</div>';
}
async function axImporterVerify(btn) {
  if (btn) { btn.disabled = true; btn.innerHTML = '<span class="spinner"></span> Verifying…'; }
  const data = await mpApi('/importer/verify', { method: 'POST', body: '{}' });
  if (data && data.success) {
    if (typeof axHaptic === 'function') axHaptic('success');
    showToast('You are now a verified buyer ✓', 'success');
    if (_axProfileData) { _axProfileData.importer_verified = true; axOpenProfile(_axProfileData.user_sub); }
  } else {
    showToast((data && data.error) || 'Could not verify — complete your profile first', 'error');
    if (data && data.needs_profile) { axCloseProfile(); switchPanel('profile'); if (typeof axProfileGoStep === 'function') axProfileGoStep(0); }
    if (btn) { btn.disabled = false; btn.innerHTML = '<i class="fa-solid fa-shield-halved"></i> Get verified'; }
  }
}

/* Delivery-partner record card (Batch 6) — shown on a delivery partner's
   profile; the owner also gets a "Share my record" button that posts it. */
function axRenderDeliveryCard(s, isMe) {
  const reviews = (s.reviews || []).slice(0, 3).map(function (r) {
    return '<div class="ax-dr-review"><span class="ax-dr-stars">' + '★'.repeat(Math.max(0, Math.min(5, r.rating))) + '</span>' +
      (r.comment ? '<span>' + axSocEsc(r.comment) + '</span>' : '') + '</div>';
  }).join('');
  return '<div class="ax-dr-card">' +
    '<div class="ax-dr-title"><i class="fa-solid fa-truck-fast"></i> Delivery record</div>' +
    '<div class="ax-dr-stats">' +
      '<div><b>' + (s.deliveries_done || 0) + '</b><span>Deliveries</span></div>' +
      '<div><b>' + (s.on_time_pct || 0) + '%</b><span>On-time</span></div>' +
      '<div><b>' + (s.avg_rating || 0) + '★</b><span>' + (s.total_ratings || 0) + ' ratings</span></div>' +
    '</div>' +
    (reviews ? '<div class="ax-dr-reviews">' + reviews + '</div>' : '') +
    (isMe ? '<button type="button" class="btn-sm-outline ax-dr-share" onclick="axShareDeliveryRecord()"><i class="fa-solid fa-share"></i> Share my record to feed</button>' : '') +
    '</div>';
}
async function axShareDeliveryRecord() {
  const rec = await mpApi('/delivery/record');
  if (!rec || rec.error) { showToast('Could not load your record', 'error'); return; }
  const text = '🚚 My Aarvex delivery record: ' + (rec.deliveries_done || 0) + ' deliveries, ' +
    (rec.on_time_pct || 0) + '% on-time, ' + (rec.avg_rating || 0) + '★ from ' + (rec.total_ratings || 0) + ' ratings. Need a reliable delivery partner? Message me!';
  const data = await mpApi('/feed/post', { method: 'POST', body: JSON.stringify({ description: text, visibility: 'public' }) });
  if (data && data.success) {
    showToast('Shared to the feed!', 'success');
    axCloseProfile();
    if (typeof axLoadFeed === 'function') axLoadFeed(true);
  } else showToast((data && data.error) || 'Could not share', 'error');
}

/* Live PAN↔Aadhaar↔legal-name match hint in the KYC form (Batch 5). The real
   pass/fail is computed server-side; this is just instant guidance. */
function axKycCrossHint() {
  const box = document.getElementById('axKycCrossHint');
  if (!box) return;
  const legal = (document.getElementById('kycFullName') || {}).value || '';
  const pan = (document.getElementById('kycPanName') || {}).value || '';
  const aad = (document.getElementById('kycAadhaarName') || {}).value || '';
  const norm = function (n) { return (n || '').toUpperCase().replace(/[^A-Z ]/g, ' ').split(/\s+/).filter(function (t) { return t.length > 1; }).sort().join(' '); };
  const rows = [];
  if (aad) rows.push(['Aadhaar name', norm(legal) && norm(aad) === norm(legal)]);
  if (pan) rows.push(['PAN name', norm(legal) && norm(pan) === norm(legal)]);
  if (!rows.length) { box.style.display = 'none'; return; }
  box.style.display = '';
  box.innerHTML = rows.map(function (r) {
    return '<span class="ax-kyc-chk ' + (r[1] ? 'ok' : 'warn') + '"><i class="fa-solid fa-' + (r[1] ? 'circle-check' : 'triangle-exclamation') + '"></i> ' + r[0] + (r[1] ? ' matches' : ' differs from legal name') + '</span>';
  }).join('');
}

function axProfileOpenPost(postId) {
  axCloseProfile();
  if (typeof axOpenPost === 'function') axOpenPost(postId);
}

async function axProfileToggleFollow(sub, btn) {
  if (btn) btn.disabled = true;
  const data = await mpApi('/feed/follow', { method: 'POST', body: JSON.stringify({ user_sub: sub }) });
  if (btn) btn.disabled = false;
  if (!data || data.error) { showToast((data && data.error) || 'Could not update', 'error'); return; }
  if (btn) {
    btn.classList.toggle('following', data.following);
    btn.innerHTML = data.following ? 'Following' : '<i class="fa-solid fa-plus"></i> Follow';
  }
  if (_axProfileData) {
    _axProfileData.is_following = data.following;
    _axProfileData.follower_count = Math.max(0, (_axProfileData.follower_count || 0) + (data.following ? 1 : -1));
  }
  // keep the feed's follow buttons in sync
  if (typeof _axFeedPosts !== 'undefined' && Array.isArray(_axFeedPosts)) {
    _axFeedPosts.forEach(function (p) { if (p.user_sub === sub) p.followed_by_me = data.following; });
    if (typeof axRenderFeed === 'function') axRenderFeed();
  }
}

function axProfileMenu(sub) {
  const exists = document.getElementById('axProfMenuSheet');
  if (exists) { exists.remove(); return; }
  const sheet = document.createElement('div');
  sheet.id = 'axProfMenuSheet';
  sheet.className = 'ax-actionsheet';
  sheet.innerHTML =
    '<div class="ax-actionsheet-card">' +
      '<button type="button" onclick="axProfileReport(\'' + axSocEsc(sub) + '\')"><i class="fa-solid fa-flag"></i> Report user</button>' +
      '<button type="button" class="danger" onclick="axProfileToggleBlock(\'' + axSocEsc(sub) + '\')"><i class="fa-solid fa-ban"></i> Block user</button>' +
      '<button type="button" onclick="document.getElementById(\'axProfMenuSheet\').remove()">Cancel</button>' +
    '</div>';
  sheet.addEventListener('click', function (e) { if (e.target === sheet) sheet.remove(); });
  document.body.appendChild(sheet);
}

async function axProfileToggleBlock(sub) {
  const menu = document.getElementById('axProfMenuSheet'); if (menu) menu.remove();
  const isBlocked = _axProfileData && _axProfileData.blocked_by_me;
  if (!isBlocked && !confirm('Block this user? You will no longer see each other\'s posts, stories or messages.')) return;
  const data = await mpApi('/user/block', { method: 'POST', body: JSON.stringify({ user_sub: sub, block: !isBlocked }) });
  if (!data || data.error) { showToast((data && data.error) || 'Could not update', 'error'); return; }
  showToast(data.blocked ? 'User blocked' : 'User unblocked', 'success');
  // reload profile to reflect state
  axOpenProfile(sub);
  if (typeof axLoadFeed === 'function') axLoadFeed(true);
}

function axProfileReport(sub) {
  const menu = document.getElementById('axProfMenuSheet'); if (menu) menu.remove();
  const reason = prompt('Report this user — why? (spam, scam, abuse, fake…)');
  if (reason === null) return;
  mpApi('/user/report', { method: 'POST', body: JSON.stringify({ user_sub: sub, reason: reason }) })
    .then(function (d) { showToast(d && d.success ? 'Reported. Our team will review.' : ((d && d.error) || 'Could not report'), d && d.success ? 'success' : 'error'); });
}

function axProfileMessage(sub, name, photo) {
  axCloseProfile();
  if (typeof axOpenChat === 'function') axOpenChat(sub, name, photo);
  else showToast('Messages loading…', 'info');
}

async function axProfileFollowList(sub, which) {
  const data = await mpApi('/feed/follow/stats?user_sub=' + encodeURIComponent(sub));
  if (!data || data.error) return;
  const list = data.followers || [];
  let ov = document.getElementById('axFollowListOverlay');
  if (ov) ov.remove();
  ov = document.createElement('div');
  ov.id = 'axFollowListOverlay';
  ov.className = 'ax-comments-overlay';
  ov.innerHTML = '<div class="ax-comments-box"><div class="ax-comments-head"><b>Followers</b>' +
    '<button type="button" class="ax-strip-icon-btn" onclick="document.getElementById(\'axFollowListOverlay\').remove()"><i class="fa-solid fa-xmark"></i></button></div>' +
    '<div class="ax-followlist">' + (list.length ? list.map(function (f) {
      return '<button type="button" class="ax-liker-row" onclick="document.getElementById(\'axFollowListOverlay\').remove();axOpenProfile(\'' + axSocEsc(f.user_sub) + '\')">' +
        axSocAvatar(f.user_name, f.user_photo, 'ax-liker-avatar') + '<b>' + axSocEsc(f.user_name) + '</b></button>';
    }).join('') : '<p class="ax-prof-empty-sm">No followers yet</p>') + '</div></div>';
  ov.addEventListener('click', function (e) { if (e.target === ov) ov.remove(); });
  document.body.appendChild(ov);
}

/* ── Privacy settings + block-list ──────────────────────────────────── */
async function axOpenPrivacy() {
  let ov = document.getElementById('axPrivacyOverlay');
  if (ov) ov.remove();
  ov = document.createElement('div');
  ov.id = 'axPrivacyOverlay';
  ov.className = 'ax-comments-overlay';
  ov.innerHTML = '<div class="ax-comments-box"><div class="ax-privacy-loading"><span class="spinner"></span></div></div>';
  ov.addEventListener('click', function (e) { if (e.target === ov) ov.remove(); });
  document.body.appendChild(ov);
  const data = await mpApi('/user/profile?user_sub=' + encodeURIComponent(axMySub()));
  const pf = (data && data.public_fields) || {};
  const bio = (data && data.bio) || '';
  const rows = [
    ['city', 'City', 'fa-location-dot'],
    ['phone', 'Phone number', 'fa-phone'],
    ['email', 'Email', 'fa-envelope'],
    ['dob', 'Date of birth', 'fa-cake-candles'],
    ['address', 'Address', 'fa-map'],
  ];
  const box = ov.querySelector('.ax-comments-box');
  box.innerHTML =
    '<div class="ax-comments-head"><b>Privacy</b>' +
      '<button type="button" class="ax-strip-icon-btn ax-privacy-close" onclick="document.getElementById(\'axPrivacyOverlay\').remove()" aria-label="Close"><i class="fa-solid fa-xmark"></i></button></div>' +
    '<div class="ax-privacy-scroll">' +
      '<label class="ax-privacy-field-label">Bio</label>' +
      '<textarea id="axBioInput" class="ax-story-caption-input" maxlength="280" rows="2" placeholder="Tell buyers about you / your farm / your shop…">' + axSocEsc(bio) + '</textarea>' +
      '<div class="ax-privacy-section-title">What shows on your public profile</div>' +
      rows.map(function (r) {
        return '<label class="ax-toggle-row"><span><i class="fa-solid ' + r[2] + '"></i> ' + r[1] + '</span>' +
          '<input type="checkbox" class="ax-priv-toggle" data-field="' + r[0] + '"' + (pf[r[0]] ? ' checked' : '') + '></label>';
      }).join('') +
      '<button type="button" class="btn-primary ax-privacy-save" onclick="axSavePrivacy()"><i class="fa-solid fa-check"></i> Save</button>' +
      '<div class="ax-privacy-section-title">Blocked users</div>' +
      '<div id="axBlockList" class="ax-blocklist"><div class="ax-privacy-loading-sm"><span class="spinner"></span></div></div>' +
    '</div>';
  if (window.axSheetify) window.axSheetify(ov, { boxSel: '.ax-comments-box', onClose: function () { ov.remove(); } });
  axLoadBlockList();
}

async function axSavePrivacy() {
  const pf = {};
  document.querySelectorAll('.ax-priv-toggle').forEach(function (t) { pf[t.dataset.field] = t.checked; });
  const bio = (document.getElementById('axBioInput') || {}).value || '';
  const data = await mpApi('/privacy/update', { method: 'POST', body: JSON.stringify({ public_fields: pf, bio: bio }) });
  showToast(data && data.success ? 'Privacy updated' : ((data && data.error) || 'Could not save'), data && data.success ? 'success' : 'error');
}

async function axLoadBlockList() {
  const host = document.getElementById('axBlockList');
  if (!host) return;
  const data = await mpApi('/user/blocklist');
  const list = (data && data.blocked) || [];
  if (!list.length) { host.innerHTML = '<p class="ax-prof-empty-sm">You haven\'t blocked anyone.</p>'; return; }
  host.innerHTML = list.map(function (u) {
    return '<div class="ax-block-row">' + axSocAvatar(u.user_name, u.user_photo, 'ax-liker-avatar') +
      '<b>' + axSocEsc(u.user_name) + '</b>' +
      '<button type="button" class="btn-sm-outline" onclick="axUnblock(\'' + axSocEsc(u.user_sub) + '\', this)">Unblock</button></div>';
  }).join('');
}
async function axUnblock(sub, btn) {
  if (btn) btn.disabled = true;
  const data = await mpApi('/user/block', { method: 'POST', body: JSON.stringify({ user_sub: sub, block: false }) });
  if (data && data.success) { showToast('Unblocked', 'success'); axLoadBlockList(); if (typeof axLoadFeed === 'function') axLoadFeed(true); }
  else { showToast((data && data.error) || 'Could not unblock', 'error'); if (btn) btn.disabled = false; }
}

/* ── Audience picker (Public / Followers / Selected / Hide-from) ─────── */
/* Usage: axOpenAudiencePicker({visibility, audience_subs}, function(result){ ... }) */
let _axAudienceState = { visibility: 'public', audience_subs: [] };
let _axAudienceOnDone = null;

async function axOpenAudiencePicker(current, onDone) {
  _axAudienceState = {
    visibility: (current && current.visibility) || 'public',
    audience_subs: (current && current.audience_subs) ? current.audience_subs.slice() : [],
  };
  _axAudienceOnDone = onDone;
  let ov = document.getElementById('axAudienceOverlay');
  if (ov) ov.remove();
  ov = document.createElement('div');
  ov.id = 'axAudienceOverlay';
  ov.className = 'ax-comments-overlay';
  ov.innerHTML = '<div class="ax-comments-box"><div class="ax-privacy-loading"><span class="spinner"></span></div></div>';
  ov.addEventListener('click', function (e) { if (e.target === ov) ov.remove(); });
  document.body.appendChild(ov);
  const stats = await mpApi('/feed/follow/stats');
  const people = (stats && stats.followers) || [];
  _axRenderAudience(people);
}

function _axRenderAudience(people) {
  const box = document.querySelector('#axAudienceOverlay .ax-comments-box');
  if (!box) return;
  const opts = [
    ['public', 'Public', 'fa-globe', 'Anyone on Aarvex'],
    ['followers', 'Followers', 'fa-user-group', 'Only people who follow you'],
    ['selected', 'Selected', 'fa-user-check', 'Only people you pick'],
    ['except', 'Hide from…', 'fa-user-slash', 'Everyone except people you pick'],
  ];
  const vis = _axAudienceState.visibility;
  const showList = (vis === 'selected' || vis === 'except');
  box.innerHTML =
    '<div class="ax-comments-head"><b>Who can see this?</b>' +
      '<button type="button" class="ax-strip-icon-btn" onclick="document.getElementById(\'axAudienceOverlay\').remove()"><i class="fa-solid fa-xmark"></i></button></div>' +
    '<div class="ax-privacy-scroll">' +
      opts.map(function (o) {
        return '<button type="button" class="ax-aud-opt' + (vis === o[0] ? ' active' : '') + '" onclick="axAudienceSetMode(\'' + o[0] + '\')">' +
          '<i class="fa-solid ' + o[2] + '"></i><div><b>' + o[1] + '</b><small>' + o[3] + '</small></div>' +
          (vis === o[0] ? '<i class="fa-solid fa-circle-check ax-aud-check"></i>' : '') + '</button>';
      }).join('') +
      (showList
        ? '<div class="ax-aud-people-title">' + (vis === 'selected' ? 'Show only to:' : 'Hide from:') + '</div>' +
          '<div class="ax-aud-people">' + (people.length ? people.map(function (p) {
            const on = _axAudienceState.audience_subs.indexOf(p.user_sub) !== -1;
            return '<label class="ax-aud-person"><span>' + axSocAvatar(p.user_name, p.user_photo, 'ax-liker-avatar') + axSocEsc(p.user_name) + '</span>' +
              '<input type="checkbox" data-sub="' + axSocEsc(p.user_sub) + '"' + (on ? ' checked' : '') + ' onchange="axAudienceToggle(this)"></label>';
          }).join('') : '<p class="ax-prof-empty-sm">No followers to pick from yet.</p>') + '</div>'
        : '') +
      '<button type="button" class="btn-primary ax-privacy-save" onclick="axAudienceDone()"><i class="fa-solid fa-check"></i> Done</button>' +
    '</div>';
}
function axAudienceSetMode(mode) {
  _axAudienceState.visibility = mode;
  // re-render, keeping people from last fetch if any checkboxes exist
  const people = Array.prototype.map.call(document.querySelectorAll('#axAudienceOverlay .ax-aud-person'), function () { return null; });
  // simplest: refetch people list (cached server-side, cheap)
  mpApi('/feed/follow/stats').then(function (s) { _axRenderAudience((s && s.followers) || []); });
}
function axAudienceToggle(cb) {
  const sub = cb.dataset.sub;
  const i = _axAudienceState.audience_subs.indexOf(sub);
  if (cb.checked && i === -1) _axAudienceState.audience_subs.push(sub);
  else if (!cb.checked && i !== -1) _axAudienceState.audience_subs.splice(i, 1);
}
function axAudienceDone() {
  const ov = document.getElementById('axAudienceOverlay'); if (ov) ov.remove();
  if (typeof _axAudienceOnDone === 'function') _axAudienceOnDone({
    visibility: _axAudienceState.visibility,
    audience_subs: _axAudienceState.audience_subs.slice(),
  });
}
function axAudienceLabel(vis) {
  return { public: 'Public', followers: 'Followers', selected: 'Selected', except: 'Hidden from some' }[vis] || 'Public';
}
function axAudienceIcon(vis) {
  return { public: 'fa-globe', followers: 'fa-user-group', selected: 'fa-user-check', except: 'fa-user-slash' }[vis] || 'fa-globe';
}

/* ── Shop's own delivery team (Batch 6) ─────────────────────────────── */
async function axOpenShopTeam() {
  let ov = document.getElementById('axShopTeamOverlay');
  if (ov) ov.remove();
  ov = document.createElement('div');
  ov.id = 'axShopTeamOverlay';
  ov.className = 'ax-comments-overlay';
  ov.innerHTML = '<div class="ax-comments-box"><div class="ax-privacy-loading"><span class="spinner"></span></div></div>';
  ov.addEventListener('click', function (e) { if (e.target === ov) ov.remove(); });
  document.body.appendChild(ov);
  const data = await mpApi('/shop/team');
  const box = ov.querySelector('.ax-comments-box');
  if (!data || data.error) { box.innerHTML = '<div class="ax-prof-empty"><p>' + axSocEsc((data && data.error) || 'Could not load') + '</p></div>'; return; }
  _axRenderShopTeam(box, data.members || []);
}
function _axRenderShopTeam(box, members) {
  box.innerHTML =
    '<div class="ax-comments-head"><b>My Delivery Team</b>' +
      '<button type="button" class="ax-strip-icon-btn" onclick="document.getElementById(\'axShopTeamOverlay\').remove()"><i class="fa-solid fa-xmark"></i></button></div>' +
    '<div class="ax-privacy-scroll">' +
      '<p class="ax-prof-empty-sm" style="text-align:left">Your own delivery partners get your shop\'s orders first (30-min priority) before the general pool. Add an approved delivery partner by their registered email.</p>' +
      '<div style="display:flex;gap:8px;margin:10px 0">' +
        '<input type="email" id="axShopTeamEmail" placeholder="partner@email.com" class="ax-story-caption-input" style="flex:1">' +
        '<button type="button" class="btn-primary" onclick="axShopTeamAdd()">Add</button>' +
      '</div>' +
      '<div id="axShopTeamList">' + (members.length ? members.map(function (m) {
        return '<div class="ax-block-row">' + axSocAvatar(m.user_name, m.user_photo, 'ax-liker-avatar') +
          '<b>' + axSocEsc(m.user_name) + (m.kyc_ok ? '' : ' <small style="color:#D63F5A">(KYC not approved)</small>') + '</b>' +
          '<button type="button" class="btn-sm-outline" onclick="axShopTeamRemove(\'' + axSocEsc(m.user_sub) + '\')">Remove</button></div>';
      }).join('') : '<p class="ax-prof-empty-sm">No team members yet.</p>') + '</div>' +
    '</div>';
}
async function axShopTeamAdd() {
  const email = (document.getElementById('axShopTeamEmail') || {}).value || '';
  if (!email.trim()) { showToast('Enter an email', 'error'); return; }
  const data = await mpApi('/shop/team/add', { method: 'POST', body: JSON.stringify({ email: email.trim() }) });
  if (!data || data.error) { showToast((data && data.error) || 'Could not add', 'error'); return; }
  showToast('Added to your delivery team', 'success');
  const box = document.querySelector('#axShopTeamOverlay .ax-comments-box');
  if (box) _axRenderShopTeam(box, data.members || []);
}
async function axShopTeamRemove(sub) {
  const data = await mpApi('/shop/team/remove', { method: 'POST', body: JSON.stringify({ user_sub: sub }) });
  if (!data || data.error) { showToast((data && data.error) || 'Could not remove', 'error'); return; }
  const box = document.querySelector('#axShopTeamOverlay .ax-comments-box');
  if (box) _axRenderShopTeam(box, data.members || []);
}

/* ── Geo-radius home feed filter (Batch 8) + map of user addresses ───── */
const AX_GEO_OPTS = [
  { km: 0, label: 'All areas (whole India)' },
  { km: 10, label: 'Within 10 km' },
  { km: 25, label: 'Within 25 km' },
  { km: 50, label: 'Within 50 km' },
  { km: 100, label: 'Within 100 km' },
  { km: 250, label: 'Within 250 km' },
];
let _axGeoMap = null;
let _axGeoMapLayers = [];

function axSetGeoLabel(geo) {
  const el = document.getElementById('axGeoLabel');
  if (!el) return;
  const km = geo && geo.radius_km ? parseFloat(geo.radius_km) : 0;
  el.textContent = (km > 0) ? ('Within ' + Math.round(km) + ' km') : 'All areas';
}

function axGeoMapClearLayers() {
  if (!_axGeoMap) return;
  _axGeoMapLayers.forEach(function (ly) { try { _axGeoMap.removeLayer(ly); } catch (e) { /* ignore */ } });
  _axGeoMapLayers = [];
}

function axGeoRenderAddress(profile) {
  const host = document.getElementById('axGeoAddressCard');
  if (!host) return;
  const p = profile || {};
  const address = [p.address, p.city, p.state, p.pincode].filter(Boolean).join(', ');
  const pinned = p.address_lat && p.address_lng;
  host.innerHTML = '<div class="ax-geo-address-icon"><i class="fa-solid fa-location-dot"></i></div>' +
    '<div class="ax-geo-address-copy"><small>YOUR SAVED AREA CENTRE</small><b>' +
    axSocEsc(address || 'No Personal Information address saved') + '</b><span>' +
    (pinned ? 'Map pin verified · updates your profile and shop pickup address' : 'Add a map pin for precise local results') +
    '</span></div><button type="button" class="ax-geo-address-edit" onclick="axGeoChangeAddress()"><i class="fa-solid fa-map-location-dot"></i> ' +
    (address ? 'Change' : 'Add address') + '</button>';
}

function axGeoEnsureLeaflet(cb) {
  if (typeof LocationPicker !== 'undefined' && LocationPicker.ensureLeaflet) {
    LocationPicker.ensureLeaflet(cb);
    return;
  }
  if (window.L) { cb(); return; }
  showToast('Map could not load — check your connection', 'error');
}

async function axGeoMapRefresh(previewKm) {
  const host = document.getElementById('axGeoMapHost');
  const meta = document.getElementById('axGeoMapMeta');
  if (!host) return;
  const km = previewKm === undefined || previewKm === null ? -1 : previewKm;
  axGeoEnsureLeaflet(function () {
    if (!_axGeoMap) {
      _axGeoMap = L.map(host, { zoomControl: true, attributionControl: true }).setView([20.5937, 78.9629], 5);
      L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
        maxZoom: 19,
        attribution: '&copy; OpenStreetMap',
      }).addTo(_axGeoMap);
    }
    setTimeout(function () { try { _axGeoMap.invalidateSize(); } catch (e) { /* ignore */ } }, 120);
    axGeoMapClearLayers();
    const q = km >= 0 ? ('?radius_km=' + encodeURIComponent(km)) : '';
    mpApi('/geo/users' + q).then(function (data) {
      if (!data || data.error) {
        if (meta) meta.textContent = (data && data.error) || 'Could not load map data';
        return;
      }
      const users = data.users || [];
      const radius = parseFloat(data.radius_km) || 0;
      const center = data.center;
      const bounds = [];
      if (center && center.lat && center.lng) {
        const cLat = parseFloat(center.lat);
        const cLng = parseFloat(center.lng);
        const you = L.circleMarker([cLat, cLng], {
          radius: 9,
          color: '#143026',
          fillColor: '#2E6B41',
          fillOpacity: 1,
          weight: 2,
        }).bindPopup('<b>You</b><br>Filter centre');
        you.addTo(_axGeoMap);
        _axGeoMapLayers.push(you);
        bounds.push([cLat, cLng]);
        if (radius > 0) {
          const ring = L.circle([cLat, cLng], {
            radius: radius * 1000,
            color: '#2E6B41',
            fillColor: '#2E6B41',
            fillOpacity: 0.12,
            weight: 2,
            dashArray: '4 6',
          });
          ring.addTo(_axGeoMap);
          _axGeoMapLayers.push(ring);
        }
      }
      users.forEach(function (u) {
        if (!u.lat || !u.lng) return;
        const lat = parseFloat(u.lat);
        const lng = parseFloat(u.lng);
        const m = L.circleMarker([lat, lng], {
          radius: 6,
          color: '#8B7C6A',
          fillColor: '#C4A35A',
          fillOpacity: 0.95,
          weight: 1,
        }).bindPopup('<b>' + axSocEsc(u.user_name || 'User') + '</b>' +
          (u.city ? '<br>' + axSocEsc(u.city) : ''));
        m.addTo(_axGeoMap);
        _axGeoMapLayers.push(m);
        bounds.push([lat, lng]);
        const userRadius = parseFloat(u.radius_km) || 0;
        if (userRadius > 0) {
          const uc = L.circle([lat, lng], {
            radius: userRadius * 1000,
            color: '#C4A35A',
            fillColor: '#C4A35A',
            fillOpacity: 0.06,
            weight: 1,
          });
          uc.addTo(_axGeoMap);
          _axGeoMapLayers.push(uc);
        }
      });
      if (meta) {
        meta.textContent = radius > 0
          ? (users.length + ' people with saved addresses in this ' + Math.round(radius) + ' km radius')
          : (users.length + ' people with saved addresses across India');
      }
      if (bounds.length === 1) {
        _axGeoMap.setView(bounds[0], radius > 0 ? 11 : 6);
      } else if (bounds.length > 1) {
        try { _axGeoMap.fitBounds(bounds, { padding: [28, 28], maxZoom: radius > 0 ? 12 : 6 }); } catch (e) { /* ignore */ }
      }
    }).catch(function () {
      if (meta) meta.textContent = 'Map data unavailable — try again';
    });
  });
}

function axOpenGeoPicker() {
  if (!document.body.classList.contains('is-signed-in')) {
    showToast('Sign in to filter Home by area', 'info');
    return;
  }
  let ov = document.getElementById('axGeoOverlay');
  if (ov) ov.remove();
  ov = document.createElement('div');
  ov.id = 'axGeoOverlay';
  ov.className = 'ax-comments-overlay';
  ov.innerHTML = '<div class="ax-comments-box"><div class="ax-comments-head"><b>Choose your local area</b></div>' +
    '<div class="ax-privacy-scroll">' +
    '<p class="ax-prof-empty-sm" style="text-align:left">Pins use each person\'s <b>Profile → Personal Information</b> address (map pin or pincode). Your filter draws a radius circle on the map and limits the Home feed to posts from people inside it.</p>' +
    '<div id="axGeoAddressCard" class="ax-geo-address-card"><i class="fa-solid fa-spinner fa-spin"></i> Loading your saved address…</div>' +
    '<div id="axGeoMapHost" class="ax-geo-map-host"></div>' +
    '<p id="axGeoMapMeta" class="ax-geo-map-meta">Loading map…</p>' +
    '<div class="ax-geo-manual">' +
      '<input type="number" id="axGeoKmInput" min="1" max="2000" step="1" inputmode="numeric" placeholder="Enter distance (km)">' +
      '<button type="button" class="ax-geo-apply" onclick="axGeoSetManual()" title="Apply distance" aria-label="Apply distance"><i class="fa-solid fa-check"></i></button>' +
    '</div>' +
    '<div class="ax-geo-presets-label">Quick radius</div>' +
    '<div class="ax-geo-radios">' + AX_GEO_OPTS.map(function (o) {
      var short = o.km ? (o.km + ' km') : 'All';
      return '<button type="button" class="ax-geo-radio" data-km="' + o.km + '" onclick="axGeoSet(' + o.km + ')" title="' + o.label + '">' +
        '<i class="fa-solid fa-' + (o.km ? 'circle-dot' : 'earth-asia') + '"></i><span>' + short + '</span></button>';
    }).join('') + '</div>' +
    '</div></div>';
  ov.addEventListener('click', function (e) { if (e.target === ov) axGeoClosePicker(); });
  document.body.appendChild(ov);
  if (window.axSheetify) window.axSheetify(ov, { boxSel: '.ax-comments-box', onClose: axGeoClosePicker });
  mpApi('/profile').then(function (d) {
    axGeoRenderAddress(d && d.profile);
    const km = d && d.profile && d.profile.feed_geo && d.profile.feed_geo.radius_km
      ? parseFloat(d.profile.feed_geo.radius_km) : 0;
    axGeoMapRefresh(km);
    axGeoMarkActive(km);
    const inp = document.getElementById('axGeoKmInput');
    if (inp && km > 0 && ![10, 25, 50, 100, 250].includes(Math.round(km))) inp.value = Math.round(km);
    if (inp) inp.addEventListener('keydown', function (e) {
      if (e.key === 'Enter') { e.preventDefault(); axGeoSetManual(); }
    });
  }).catch(function () { axGeoMapRefresh(0); });
}

function axGeoMarkActive(km) {
  const k = Math.round(parseFloat(km) || 0);
  document.querySelectorAll('#axGeoOverlay .ax-geo-radio').forEach(function (btn) {
    const bkm = Math.round(parseFloat(btn.getAttribute('data-km')) || 0);
    btn.classList.toggle('on', bkm === k);
  });
}

function axGeoClosePicker() {
  const ov = document.getElementById('axGeoOverlay');
  if (ov) ov.remove();
  axGeoMapClearLayers();
  if (_axGeoMap) {
    try { _axGeoMap.remove(); } catch (e) { /* ignore */ }
    _axGeoMap = null;
  }
}

function axGeoSetManual() {
  const input = document.getElementById('axGeoKmInput');
  const km = input ? Math.round(parseFloat(input.value)) : 0;
  if (!km || km < 1) { showToast('Enter a distance in km', 'error'); return; }
  axGeoSet(km);
}

async function axGeoChangeAddress() {
  if (typeof LocationPicker === 'undefined') {
    showToast('Location picker failed to load — check your connection', 'error');
    return;
  }
  let current = {};
  try { current = ((await mpApi('/profile')).profile || {}); } catch (e) { /* picker can still open */ }
  LocationPicker.open({
    label: 'Personal address · Home area centre',
    address: current.address || '', city: current.city || '', state: current.state || '',
    pincode: current.pincode || '', lat: current.address_lat || '', lng: current.address_lng || '',
    onSave: async function (a) {
      a = a || {};
      if (!a.address || !a.city || !a.pincode || !a.lat || !a.lng) {
        showToast('Choose a complete address with a map pin', 'error');
        return;
      }
      const payload = { address: a.address, city: a.city, state: a.state || '', pincode: a.pincode,
        address_lat: String(a.lat), address_lng: String(a.lng) };
      const saved = await mpApi('/profile/update', { method: 'POST', body: JSON.stringify(payload) });
      if (!saved || !saved.success) { showToast((saved && saved.error) || 'Could not update address', 'error'); return; }
      const p = saved.profile || Object.assign(current, payload);
      const fields = { p_address: p.address, p_city: p.city, p_state: p.state, p_pincode: p.pincode,
        p_address_lat: p.address_lat, p_address_lng: p.address_lng };
      Object.keys(fields).forEach(function (id) { const input = document.getElementById(id); if (input) input.value = fields[id] || ''; });
      if (window.userProfile) Object.assign(window.userProfile, p);
      if (typeof saveProfileDraft === 'function') saveProfileDraft();
      axGeoRenderAddress(p);
      const km = parseFloat((p.feed_geo || {}).radius_km || 0);
      if (km > 0) await axGeoSet(km);
      else axGeoMapRefresh(0);
      showToast('Personal address updated — Home area centre is now linked', 'success');
    },
  });
}

async function axGeoSet(km) {
  if (!document.body.classList.contains('is-signed-in')) {
    showToast('Sign in to filter by area', 'info');
    return;
  }
  if (!km) {
    const data = await mpApi('/geo/set', { method: 'POST', body: JSON.stringify({ clear: true }) });
    if (!data || data.error) {
      showToast((data && data.error) || 'Could not reset area', 'error');
      return;
    }
    axSetGeoLabel({});
    axGeoMarkActive(0);
    showToast('Showing all areas', 'success');
    axGeoMapRefresh(0);
    if (typeof axLoadFeed === 'function') axLoadFeed(true);
    return;
  }
  showToast('Applying area filter…', 'info');
  const payload = { radius_km: km, label: 'Within ' + km + ' km' };
  const data = await mpApi('/geo/set', { method: 'POST', body: JSON.stringify(payload) });
  if (!data || !data.success) {
    showToast((data && data.error) || 'Could not set area', 'error');
    return;
  }
  axSetGeoLabel(data.feed_geo);
  axGeoMarkActive(km);
  showToast('Showing activity within ' + km + ' km', 'success');
  axGeoMapRefresh(km);
  if (typeof axLoadFeed === 'function') axLoadFeed(true);
}

document.addEventListener('DOMContentLoaded', function () {
  setTimeout(async function () {
    if (!document.body.classList.contains('is-signed-in')) return;
    try {
      const d = await mpApi('/profile');
      if (d && d.profile && d.profile.feed_geo) axSetGeoLabel(d.profile.feed_geo);
    } catch (e) { /* ignore */ }
  }, 3500);
});

/* ═══ Profile wizard + full-screen KYC (Batch 5 final) ═══════════════ */
const AX_PROF_STEP_TITLES = ['Personal Information', 'Default Delivery Address', 'Business Information'];

function axProfileGoStep(i) {
  const panel = document.getElementById('panel-profile');
  if (!panel) return;
  const panes = panel.querySelectorAll('.ax-prof-step-pane');
  let max = 0;
  panes.forEach(function (p) { max = Math.max(max, parseInt(p.dataset.step || '0', 10)); });
  i = Math.max(0, Math.min(max, i));
  panes.forEach(function (p) {
    p.style.display = (parseInt(p.dataset.step || '0', 10) === i) ? '' : 'none';
  });
  const kycPane = panel.querySelector('.ax-prof-kyc-pane');
  if (kycPane) kycPane.style.display = 'none';
  const steps = document.getElementById('axProfSteps');
  if (steps) {
    let html = '';
    for (let n = 0; n <= max; n++) {
      if (n) html += '<span class="ax-prof-step-line"></span>';
      html += '<button type="button" class="ax-prof-step-chip' + (n === i ? ' active' : '') + (n < i ? ' done' : '') +
        '" onclick="axProfileGoStep(' + n + ')" title="' + axSocEsc(AX_PROF_STEP_TITLES[n] || '') + '">' +
        (n < i ? '<i class="fa-solid fa-check"></i>' : (n + 1)) + '</button>';
    }
    steps.innerHTML = html;
  }
  const sc = document.querySelector('.content-inner');
  if (sc) sc.scrollTo({ top: 0, behavior: 'smooth' });
}

function axProfileSectionMenu() {
  const exists = document.getElementById('axProfSectionSheet');
  if (exists) { exists.remove(); return; }
  const done = axProfileIsComplete();
  const sheet = document.createElement('div');
  sheet.id = 'axProfSectionSheet';
  sheet.className = 'ax-actionsheet';
  sheet.innerHTML =
    '<div class="ax-actionsheet-card">' +
      '<div class="ax-prof-bigrow">' +
        '<button type="button" class="ax-prof-bigbtn" onclick="document.getElementById(\'axProfSectionSheet\').remove();axProfileGoStep(0)">' +
          '<i class="fa-solid fa-user"></i><b>User Information</b>' +
          '<small class="' + (done ? 'ok' : 'warn') + '">' + (done ? 'Complete' : 'Incomplete') + '</small></button>' +
        '<button type="button" class="ax-prof-bigbtn" onclick="document.getElementById(\'axProfSectionSheet\').remove();axOpenKycFullscreen()">' +
          '<i class="fa-solid fa-id-card"></i><b>KYC Verification</b>' +
          '<small>Full screen</small></button>' +
      '</div>' +
      '<button type="button" onclick="document.getElementById(\'axProfSectionSheet\').remove()">Cancel</button>' +
    '</div>';
  sheet.addEventListener('click', function (e) { if (e.target === sheet) sheet.remove(); });
  document.body.appendChild(sheet);
}

/* KYC full-screen: the real #kycSection node is MOVED into the overlay (so all
   inputs, values and handlers survive) and put back on close. */
function axOpenKycFullscreen() {
  // Gate: Personal Information must be complete before any KYC can be started.
  if (!axRequireProfileComplete('start KYC verification')) return;
  const kyc = document.getElementById('kycSection');
  if (!kyc) { showToast('KYC section not available', 'error'); return; }
  if (document.getElementById('axKycOverlay')) return;
  const ov = document.createElement('div');
  ov.id = 'axKycOverlay';
  ov.className = 'ax-kyc-overlay';
  ov.innerHTML =
    '<div class="ax-kyc-sheet">' +
      '<div class="ax-kyc-head">' +
        '<button type="button" class="ax-chat-back" onclick="axCloseKycFullscreen()" aria-label="Back"><i class="fa-solid fa-arrow-left"></i></button>' +
        '<b>KYC Verification</b><span style="width:34px"></span>' +
      '</div>' +
      '<div class="ax-kyc-body" id="axKycBody"></div>' +
    '</div>';
  document.body.appendChild(ov);
  const ph = document.createElement('div');
  ph.id = 'axKycPlaceholder';
  kyc.parentNode.insertBefore(ph, kyc);
  document.getElementById('axKycBody').appendChild(kyc);
  kyc.style.display = '';
  document.body.style.overflow = 'hidden';
  // Re-render Turnstile AFTER the section is moved into the now-visible
  // overlay (a tick later so the container has real layout/size),
  // otherwise the widget shows as an empty box.
  setTimeout(function () {
    if (typeof axRerenderTurnstile === 'function') { try { axRerenderTurnstile('kycRecaptcha'); } catch (e) { /* ignore */ } }
    else if (typeof mpGenerateCaptcha === 'function') { try { mpGenerateCaptcha(); } catch (e) { /* ignore */ } }
  }, 80);
  if (typeof axKycCrossHint === 'function') axKycCrossHint();
}
function axCloseKycFullscreen() {
  const kyc = document.getElementById('kycSection');
  const ph = document.getElementById('axKycPlaceholder');
  if (kyc && ph && ph.parentNode) {
    ph.parentNode.insertBefore(kyc, ph);
    ph.remove();
    kyc.style.display = 'none';
  }
  const ov = document.getElementById('axKycOverlay');
  if (ov) ov.remove();
  document.body.style.overflow = '';
}

/* HARD GATE: nothing that creates an obligation (KYC, buying) is allowed until
   Personal Information is filled. Shows a blocking sheet with a direct link to
   the profile wizard. Returns true when the caller may proceed. */
function axRequireProfileComplete(action) {
  if (axProfileIsComplete()) return true;
  const exists = document.getElementById('axGateSheet');
  if (exists) exists.remove();
  const sheet = document.createElement('div');
  sheet.id = 'axGateSheet';
  sheet.className = 'ax-actionsheet';
  sheet.innerHTML =
    '<div class="ax-actionsheet-card">' +
      '<div class="ax-gate-box">' +
        '<i class="fa-solid fa-circle-exclamation"></i>' +
        '<b>Complete your profile first</b>' +
        '<p>You need to fill your <b>Personal Information</b> (name, mobile, address, city, state, pincode) before you can ' + axSocEsc(action || 'continue') + '.</p>' +
      '</div>' +
      '<button type="button" class="ax-gate-cta" onclick="document.getElementById(\'axGateSheet\').remove();switchPanel(\'profile\');setTimeout(function(){if(typeof axProfileGoStep===\'function\')axProfileGoStep(0);},250)"><i class="fa-solid fa-user-pen"></i> Complete profile now</button>' +
      '<button type="button" onclick="document.getElementById(\'axGateSheet\').remove()">Cancel</button>' +
    '</div>';
  sheet.addEventListener('click', function (e) { if (e.target === sheet) sheet.remove(); });
  document.body.appendChild(sheet);
  return false;
}

/* "Complete your profile" gate — shown on Home until the required fields are
   filled, and reflected on the 3-dot sheet. */
function axProfileIsComplete() {
  const p = (typeof userProfile !== 'undefined' && userProfile) ? userProfile : {};
  return !!(p.name && (p.mobile || p.phone) && p.address && p.city && p.state && p.pincode);
}
function axProfileAlertRefresh() {
  const host = document.getElementById('axProfileAlert');
  if (!host) return;
  if (!document.body.classList.contains('is-signed-in') || axProfileIsComplete()) {
    host.style.display = 'none';
    return;
  }
  host.style.display = '';
  host.innerHTML = '<i class="fa-solid fa-triangle-exclamation"></i>' +
    '<span>Your profile isn\'t complete yet — finish it so orders auto-fill.</span>' +
    '<button type="button" class="btn-sm-outline" onclick="switchPanel(\'profile\')">Complete now</button>';
}
document.addEventListener('DOMContentLoaded', function () {
  setTimeout(axProfileAlertRefresh, 2500);
  setInterval(axProfileAlertRefresh, 30000);
});

/* Tap-to-copy the delivery OTP. */
function axCopyOtp() {
  const el = document.getElementById('trackOtpValue');
  const code = (el && (el.textContent || '').trim()) || '';
  if (!code) return;
  if (typeof axCopyText === 'function') { axCopyText(code, el); return; }
  if (navigator.clipboard) navigator.clipboard.writeText(code).then(function () { showToast('OTP copied', 'success'); });
}

/* ═══ Order / transaction DETAIL sheet (History transparency) ═════════
   One tap on any order or transaction opens every party's contact, the
   timeline, the full charge breakdown, the payment/payout status and the
   invoice — so nothing needs digging around for. */
function axSocCopy(t) {
  if (navigator.clipboard) navigator.clipboard.writeText(String(t)).then(function () { showToast('Copied', 'success'); });
}
function axOdChip(label, on, warn) {
  return '<span class="ax-od-chip ' + (on ? (warn ? 'warn' : 'ok') : 'off') + '"><i class="fa-solid fa-' +
    (on ? (warn ? 'triangle-exclamation' : 'circle-check') : 'clock') + '"></i> ' + axSocEsc(label) + '</span>';
}
async function axOpenOrderDetail(arn) {
  if (!arn) return;
  let ov = document.getElementById('axOrderDetailOverlay');
  if (ov) ov.remove();
  ov = document.createElement('div');
  ov.id = 'axOrderDetailOverlay';
  ov.className = 'ax-comments-overlay';
  ov.innerHTML = '<div class="ax-comments-box ax-od-box"><div class="ax-privacy-loading"><span class="spinner"></span></div></div>';
  ov.addEventListener('click', function (e) { if (e.target === ov) ov.remove(); });
  document.body.appendChild(ov);
  const d = await mpApi('/order/detail?arn=' + encodeURIComponent(arn));
  const box = ov.querySelector('.ax-comments-box');
  if (!d || d.error) { box.innerHTML = '<div class="ax-prof-empty"><i class="fa-solid fa-circle-exclamation"></i><p>' + axSocEsc((d && d.error) || 'Could not load') + '</p></div>'; return; }
  _axRenderOrderDetail(box, d);
}
function _axRenderOrderDetail(box, d) {
  const money = function (v) { return '₹' + (Math.round((v || 0) * 100) / 100).toLocaleString('en-IN'); };
  const dt = function (s) { return s ? axSocEsc(String(s).slice(0, 16).replace('T', ' ')) : ''; };
  const party = function (p) {
    if (!p || (!p.name && !p.phone && !p.sub) || p.name === '—') return '';
    const ic = p.role === 'Shop' ? 'fa-store' : (p.role === 'Delivery partner' ? 'fa-truck-fast' : 'fa-user');
    let callBtn = '<span class="ax-od-call na">No number</span>';
    if (p.sub) {
      callBtn =
        '<button type="button" class="ax-od-call" title="App voice call" onclick="axOpenChat(\'' + axSocEsc(p.sub) + '\',\'' + axSocEsc(p.name || 'User') + '\',\'' + axSocEsc(p.photo || '') + '\');setTimeout(function(){var f=document.getElementById(\'axMsgFrame\');if(f&&f.contentWindow)f.contentWindow.postMessage({type:\'axmsg:call-cmd\',cmd:\'start-voice\'},\'*\');},800)"><i class="fa-solid fa-phone"></i></button>' +
        '<button type="button" class="ax-od-call ax-od-video" title="App video call" onclick="axOpenChat(\'' + axSocEsc(p.sub) + '\',\'' + axSocEsc(p.name || 'User') + '\',\'' + axSocEsc(p.photo || '') + '\');setTimeout(function(){var f=document.getElementById(\'axMsgFrame\');if(f&&f.contentWindow)f.contentWindow.postMessage({type:\'axmsg:call-cmd\',cmd:\'start-video\'},\'*\');},800)"><i class="fa-solid fa-video"></i></button>';
    } else if (p.phone) {
      callBtn = '<a class="ax-od-call" href="tel:' + axSocEsc(p.phone) + '" title="Phone call"><i class="fa-solid fa-phone"></i></a>';
    }
    return '<div class="ax-od-party"><span class="ax-od-party-ic"><i class="fa-solid ' + ic + '"></i></span>' +
      '<div class="ax-od-party-txt"><small>' + axSocEsc(p.role) + '</small><b>' + axSocEsc(p.name) + '</b>' +
      ((p.address || p.city) ? '<span>' + axSocEsc(p.address || p.city) + '</span>' : '') + '</div>' +
      callBtn + '</div>';
  };
  const c = d.charges || {}, pay = d.payment || {};
  const up = String(d.status || '').toUpperCase();
  const statusColor = d.delivered ? '#16A34A' : (up.indexOf('CANCEL') !== -1 ? '#DC2626' : '#E0872B');
  box.innerHTML =
    '<div class="ax-comments-head"><b>Order details</b><button type="button" class="ax-strip-icon-btn" onclick="document.getElementById(\'axOrderDetailOverlay\').remove()"><i class="fa-solid fa-xmark"></i></button></div>' +
    '<div class="ax-od-scroll">' +
      '<div class="ax-od-hero">' +
        (d.product_image ? '<img src="' + axSocEsc(d.product_image) + '" alt="">' : '<div class="ax-od-noimg"><i class="fa-solid fa-box"></i></div>') +
        '<div class="ax-od-hero-txt"><b>' + axSocEsc(d.product_name || 'Order') + '</b><small>' + axSocEsc(d.order_type || '') + ' · ' + axSocEsc(d.qty_kg || '') + ' kg</small>' +
        '<button type="button" class="ax-od-arn" onclick="axSocCopy(\'' + axSocEsc(d.arn) + '\')"><i class="fa-regular fa-copy"></i> ' + axSocEsc(d.arn) + '</button></div>' +
        '<span class="ax-od-status" style="color:' + statusColor + '">' + axSocEsc(String(d.status).replace(/_/g, ' ')) + '</span>' +
      '</div>' +
      '<div class="ax-od-section-title">People</div>' + party(d.importer) + party(d.shop) + party(d.delivery_partner) +
      '<div class="ax-od-section-title">Timeline</div>' +
      '<div class="ax-od-rows">' +
        (d.created_at ? '<div><span>Placed</span><b>' + dt(d.created_at) + '</b></div>' : '') +
        (d.claimed_at ? '<div><span>Picked up</span><b>' + dt(d.claimed_at) + '</b></div>' : '') +
        (d.completed_at ? '<div><span>Delivered</span><b>' + dt(d.completed_at) + '</b></div>' : '') +
        (d.time_taken ? '<div><span>Time taken</span><b>' + axSocEsc(d.time_taken) + '</b></div>' : '') +
        (d.cancelled_reason ? '<div><span>Cancelled</span><b style="color:#DC2626">' + axSocEsc(d.cancelled_reason) + '</b></div>' : '') +
      '</div>' +
      '<div class="ax-od-section-title">Payment</div>' +
      '<div class="ax-od-rows">' +
        '<div><span>Product / Lot</span><b>' + money(c.lot) + '</b></div>' +
        '<div><span>Delivery charge</span><b>' + money(c.delivery) + '</b></div>' +
        '<div><span>Platform fee</span><b>' + money(c.platform) + '</b></div>' +
        '<div><span>GST</span><b>' + money(c.gst) + '</b></div>' +
        '<div class="ax-od-total"><span>Total</span><b>' + money(c.total) + '</b></div>' +
      '</div>' +
      '<div class="ax-od-pay">' +
        '<div class="ax-od-pay-mode"><i class="fa-solid ' + (pay.is_cod ? 'fa-money-bill-wave' : 'fa-credit-card') + '"></i> ' + axSocEsc(pay.mode || '') + '</div>' +
        '<div class="ax-od-chips">' +
          axOdChip('Importer paid', pay.importer_paid) +
          (pay.is_cod ? axOdChip('Cash collected', pay.cash_in_hand) : axOdChip('Shop settled', pay.shop_settled)) +
          (pay.is_cod ? axOdChip('Platform fee due from partner', !!pay.platform_due_from_partner, true) : axOdChip('Delivery settled', pay.delivery_settled)) +
        '</div>' +
        (pay.is_cod ? '<p class="ax-od-note">Delivery partner collected ' + money(pay.cash_amount) + ' in cash. Shop share ' + money(pay.shop_receivable) + ' + platform fee ' + money(pay.platform_due_from_partner) + ' settle from it.</p>' : '') +
      '</div>' +
      (d.invoice_url ? '<a class="btn-primary ax-od-invoice" href="' + axSocEsc(d.invoice_url) + '" target="_blank" rel="noopener"><i class="fa-solid fa-file-invoice"></i> View / download invoice</a>' : '') +
    '</div>';
}

/* ═══ Notification bottom-sheet ═══════════════════════════════════════
   Opens the real #panel-notifications inside a draggable sheet (~78vh),
   expandable to full height, swipe-down / backdrop-tap to close. The panel
   node is MOVED in (so its tabs + list logic keep working) and restored on
   close — same proven technique as the full-screen KYC. */
let _axNotifDrag = null;
function axOpenNotifSheet() {
  const panel = document.getElementById('panel-notifications');
  if (!panel) { if (typeof switchPanel === 'function') switchPanel('notifications'); return; }
  if (document.getElementById('axNotifOverlay')) { axCloseNotifSheet(); return; }
  const unread = (typeof mpNotifUnread === 'number') ? mpNotifUnread : 0;
  const ov = document.createElement('div');
  ov.id = 'axNotifOverlay';
  ov.className = 'ax-sheet-overlay';
  ov.innerHTML =
    '<div class="ax-sheet" id="axNotifSheet">' +
      '<div class="ax-sheet-grip" id="axNotifGrip"><span></span></div>' +
      '<div class="ax-notif-pro-head">' +
        '<div class="axnh-copy">' +
          '<div class="axnh-alerts-badge" id="axNotifHeadPill">' +
            '<i class="fa-solid fa-bell"></i> ALERTS' +
            (unread ? '<span class="axnh-count">' + (unread > 99 ? '99+' : unread) + '</span>' : '') +
          '</div>' +
          '<div class="axnh-title">Notifications</div>' +
          '<div class="axnh-sub">Leads, reviews, KYC updates, and admin messages.</div>' +
        '</div>' +
      '</div>' +
      '<div class="ax-sheet-body" id="axNotifBody"></div>' +
    '</div>';
  ov.addEventListener('click', function (e) { if (e.target === ov) axCloseNotifSheet(); });
  document.body.appendChild(ov);
  const ph = document.createElement('div');
  ph.id = 'axNotifPlaceholder';
  panel.parentNode.insertBefore(ph, panel);
  const body = document.getElementById('axNotifBody');
  body.appendChild(panel);
  panel.style.display = '';
  document.body.style.overflow = 'hidden';
  document.getElementById('axNotifNavBtn')?.classList.add('is-active');
  requestAnimationFrame(function () { ov.classList.add('open'); });
  axNotifSheetDrag();
  if (window.PortalEnhancements && typeof PortalEnhancements.refreshNotifications === 'function') {
    try {
      PortalEnhancements.refreshNotifications(true).then(function (data) {
        const n = (data && data.unread) || 0;
        const pill = document.getElementById('axNotifHeadPill');
        if (pill) {
          pill.innerHTML = '<i class="fa-solid fa-bell"></i> ALERTS' +
            (n ? '<span class="axnh-count">' + (n > 99 ? '99+' : n) + '</span>' : '');
          pill.classList.toggle('zero', !n);
        }
      });
    } catch (e) { /* ignore */ }
  }
}
function axCloseNotifSheet() {
  const panel = document.getElementById('panel-notifications');
  const ph = document.getElementById('axNotifPlaceholder');
  if (panel && ph && ph.parentNode) {
    ph.parentNode.insertBefore(panel, ph);
    ph.remove();
    panel.style.display = 'none';
  }
  const ov = document.getElementById('axNotifOverlay');
  if (ov) ov.remove();
  document.body.style.overflow = '';
  document.getElementById('axNotifNavBtn')?.classList.remove('is-active');
}

/* Header helpers — keep onclick short and stable */
function axOpenNotifications() {
  if (window.PortalEnhancements && typeof PortalEnhancements.acknowledgeNotificationAttention === 'function') {
    PortalEnhancements.acknowledgeNotificationAttention();
  }
  if (window.PortalEnhancements && typeof PortalEnhancements.openNotificationPanel === 'function') {
    PortalEnhancements.openNotificationPanel();
  } else if (typeof axOpenNotifSheet === 'function') {
    axOpenNotifSheet();
  }
}
function axAcknowledgeNotificationAttention() {
  if (window.PortalEnhancements && typeof PortalEnhancements.acknowledgeNotificationAttention === 'function') {
    PortalEnhancements.acknowledgeNotificationAttention();
  }
}
window.axOpenNotifications = axOpenNotifications;
window.axAcknowledgeNotificationAttention = axAcknowledgeNotificationAttention;
function axNotifSheetDrag() {
  const sheet = document.getElementById('axNotifSheet');
  const grip = document.getElementById('axNotifGrip');
  if (!sheet || !grip) return;
  let startY = 0, startH = 0, dragging = false, expanded = false;
  function down(e) {
    dragging = true; startY = (e.touches ? e.touches[0] : e).clientY;
    startH = sheet.getBoundingClientRect().height; sheet.style.transition = 'none';
    e.preventDefault();
  }
  function move(e) {
    if (!dragging) return;
    const dy = (e.touches ? e.touches[0] : e).clientY - startY;
    let h = startH - dy; // drag up → taller
    const vh = window.innerHeight;
    h = Math.max(vh * 0.25, Math.min(vh * 0.96, h));
    sheet.style.height = h + 'px';
  }
  function up() {
    if (!dragging) return;
    dragging = false; sheet.style.transition = '';
    const h = sheet.getBoundingClientRect().height, vh = window.innerHeight;
    if (h < vh * 0.4) { axCloseNotifSheet(); return; }
    expanded = h > vh * 0.7;
    sheet.style.height = (expanded ? '96vh' : '78vh');
  }
  grip.addEventListener('mousedown', down); grip.addEventListener('touchstart', down, { passive: false });
  window.addEventListener('mousemove', move); window.addEventListener('touchmove', move, { passive: false });
  window.addEventListener('mouseup', up); window.addEventListener('touchend', up);
  // tap the grip toggles expand/collapse
  grip.addEventListener('click', function () {
    expanded = !expanded;
    sheet.style.transition = '';
    sheet.style.height = (expanded ? '96vh' : '78vh');
  });
}

/* ── Shared bottom-sheet behaviour for the simpler overlays (cart, new-post
   composer, geo picker, comments): a grip handle + drag-down-to-close, matching
   the notifications sheet. Tap-outside-to-close is already wired per-overlay.
   Call axSheetify(overlayEl) right after appending the overlay to the body. ── */
window.axSheetify = function (overlayEl, opts) {
  if (!overlayEl) return;
  opts = opts || {};
  const box = overlayEl.querySelector(opts.boxSel || '.ax-comments-box, .ax-composer-box, .ax-cart-box');
  if (!box || box.querySelector('.ax-sheet-grip')) return;
  const grip = document.createElement('div');
  grip.className = 'ax-sheet-grip ax-sheet-grip-drag';
  grip.innerHTML = '<span></span>';
  box.insertBefore(grip, box.firstChild);
  const close = opts.onClose || function () {
    overlayEl.remove();
    document.body.style.overflow = '';
  };
  axSheetDragClose(box, grip, close);
};
function axSheetDragClose(box, grip, close) {
  let startY = 0, dy = 0;
  function move(e) {
    dy = (e.touches ? e.touches[0] : e).clientY - startY;
    if (dy > 0) box.style.transform = 'translateY(' + dy + 'px)';
  }
  function up() {
    document.removeEventListener('touchmove', move);
    document.removeEventListener('mousemove', move);
    document.removeEventListener('touchend', up);
    document.removeEventListener('mouseup', up);
    box.style.transition = '';
    if (dy > 110) { close(); } else { box.style.transform = ''; }
    dy = 0;
  }
  function down(e) {
    startY = (e.touches ? e.touches[0] : e).clientY;
    box.style.transition = 'none';
    document.addEventListener('touchmove', move, { passive: true });
    document.addEventListener('mousemove', move);
    document.addEventListener('touchend', up);
    document.addEventListener('mouseup', up);
  }
  grip.addEventListener('touchstart', down, { passive: true });
  grip.addEventListener('mousedown', down);
}

/* ── A1: map address picker for Personal Information ──────────────────
   Reuses the exact LocationPicker the order form / address book uses, and
   fills address + city + state + pincode + lat/lng in one shot. */
function axPickPersonalAddress() {
  if (typeof LocationPicker === 'undefined') {
    showToast('Location picker failed to load — check your connection', 'error');
    return;
  }
  const g = function (id) { const el = document.getElementById(id); return el ? el.value : ''; };
  LocationPicker.open({
    label: 'Personal address',
    address: g('p_address'),
    city: g('p_city'),
    state: g('p_state'),
    pincode: g('p_pincode'),
    lat: g('p_address_lat'),
    lng: g('p_address_lng'),
    onSave: function (a) {
      a = a || {};
      const s = function (id, v) {
        const el = document.getElementById(id);
        if (el && v !== undefined && v !== null && v !== '') el.value = v;
      };
      s('p_address', a.address);
      s('p_city', a.city);
      s('p_state', a.state);
      s('p_pincode', a.pincode);
      s('p_address_lat', a.lat);
      s('p_address_lng', a.lng);
      const hint = document.getElementById('axPersonalGpsHint');
      if (hint && a.lat && a.lng) {
        hint.innerHTML = '<i class="fa-solid fa-circle-check" style="color:#16A34A"></i> Location pinned — ' +
          axSocEsc(String(a.lat).slice(0, 9)) + ', ' + axSocEsc(String(a.lng).slice(0, 9)) +
          ' · this is also your shop\'s pickup address.';
      }
      if (typeof queueSaveProfileDraft === 'function') queueSaveProfileDraft();
      showToast('Address set from map', 'success');
    },
  });
}

/* ═══ Voice search (Hindi / Marathi / English) — low-literacy friendly ══
   Uses the browser SpeechRecognition (Android Chrome). Fills the target input
   and triggers its normal search. Silently unavailable on unsupported devices. */
function axVoiceLang() {
  let l = '';
  try { l = localStorage.getItem('ax_lang') || localStorage.getItem('ax_lang') || ''; } catch (e) { l = ''; }
  return ({ en: 'en-IN', hi: 'hi-IN', mr: 'mr-IN' })[l] || 'hi-IN';
}
function axVoiceSearch(inputId, onResult) {
  const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
  if (!SR) { showToast('Voice search is not supported on this device', 'info'); return; }
  const rec = new SR();
  rec.lang = axVoiceLang();
  rec.interimResults = false; rec.maxAlternatives = 1;
  const btn = document.querySelector('[data-voice-for="' + inputId + '"]');
  if (btn) btn.classList.add('listening');
  if (typeof axHaptic === 'function') axHaptic('light');
  showToast('🎤 Suoto hoon… boliye', 'info');
  rec.onresult = function (e) {
    const t = ((e.results[0] && e.results[0][0] && e.results[0][0].transcript) || '').trim();
    const inp = document.getElementById(inputId);
    if (inp && t) {
      inp.value = t;
      if (typeof onResult === 'function') onResult(t);
      else inp.dispatchEvent(new Event('input', { bubbles: true }));
    }
  };
  rec.onerror = function () { showToast('Sun nahi paya — dobara try karo', 'error'); };
  rec.onend = function () { if (btn) btn.classList.remove('listening'); };
  try { rec.start(); } catch (e) { if (btn) btn.classList.remove('listening'); }
}

/* ── User search (Batch 1) — Home search bar + related recommendations ── */
let _axUserSearchTimer = null;
function axUserSearch(q) {
  clearTimeout(_axUserSearchTimer);
  const box = document.getElementById('axUserSearchResults');
  if (!box) return;
  q = (q || '').trim();
  if (q.length < 2) { box.style.display = 'none'; box.innerHTML = ''; return; }
  box.style.display = '';
  box.innerHTML = (typeof axLoaderHtml === 'function')
    ? '<div style="padding:18px">' + axLoaderHtml('Searching people…', 72) + '</div>'
    : '<div class="ax-user-search-empty"><i class="fa-solid fa-spinner fa-spin"></i> Searching…</div>';
  if (typeof axMountLoaders === 'function') axMountLoaders(box);
  _axUserSearchTimer = setTimeout(async function () {
    const data = await mpApi('/user/search?q=' + encodeURIComponent(q));
    const users = (data && data.users) || [];
    if (!users.length) { box.style.display = ''; box.innerHTML = '<div class="ax-user-search-empty">No people found</div>'; return; }
    box.style.display = '';
    box.innerHTML = '<div class="ax-search-suggest-label" style="padding:10px 14px 2px">People</div>' + users.map(function (u) {
      return '<button type="button" class="ax-user-search-row" onclick="axUserSearchOpen(\'' + axSocEsc(u.user_sub) + '\')">' +
        axSocAvatar(u.user_name, u.user_photo, 'ax-liker-avatar') + '<b>' + axSocEsc(u.user_name) + '</b></button>';
    }).join('');
  }, 280);
}
function axUserSearchOpen(sub) {
  const box = document.getElementById('axUserSearchResults');
  if (box) { box.style.display = 'none'; box.innerHTML = ''; }
  const input = document.getElementById('axUserSearchInput'); if (input) input.value = '';
  axOpenProfile(sub);
}

/* ── Back-to-top button (feed / favourite / track / any scrolled panel) ── */
function axScrollToTop() {
  const sc = document.querySelector('.content-inner');
  if (sc) sc.scrollTo({ top: 0, behavior: 'smooth' });
  window.scrollTo({ top: 0, behavior: 'smooth' });
}
document.addEventListener('DOMContentLoaded', function () {
  const btn = document.getElementById('axScrollTopBtn');
  const sc = document.querySelector('.content-inner');
  if (!btn) return;
  function onScroll() {
    const top = (sc ? sc.scrollTop : 0) || window.scrollY || document.documentElement.scrollTop || 0;
    btn.classList.toggle('show', top > 500);
  }
  if (sc) sc.addEventListener('scroll', onScroll, { passive: true });
  window.addEventListener('scroll', onScroll, { passive: true });
});

/* ═══ C3 · Offline resilience ═════════════════════════════════════════
   Shows a banner when the connection drops, hides + refreshes on reconnect,
   and gives a Retry that re-loads the current view. */
function axShowOffline() {
  const b = document.getElementById('axOfflineBanner');
  if (b) b.classList.add('show');
}
function axHideOffline() {
  const b = document.getElementById('axOfflineBanner');
  if (b) b.classList.remove('show');
}
function axRetryNow() {
  if (typeof navigator !== 'undefined' && !navigator.onLine) { showToast('Still no internet', 'error'); return; }
  axHideOffline();
  showToast('Reconnecting…', 'info');
  // Re-load whatever the active panel shows.
  const active = document.querySelector('.portal-panel.active');
  const id = active ? active.id.replace('panel-', '') : '';
  try {
    if (id === 'dashboard' && typeof axLoadFeed === 'function') axLoadFeed(true);
    else if (id === 'trade' && typeof mpLoadCatalogue === 'function') mpLoadCatalogue();
    else if (id === 'delivery' && typeof mpLoadDeliveryDashboard === 'function') mpLoadDeliveryDashboard();
    else if (typeof switchPanel === 'function' && id) switchPanel(id);
  } catch (e) { /* ignore */ }
}
window.axShowOffline = axShowOffline;
window.axRetryNow = axRetryNow;
document.addEventListener('DOMContentLoaded', function () {
  window.addEventListener('offline', axShowOffline);
  window.addEventListener('online', function () {
    axHideOffline();
    showToast('Back online', 'success');
    axRetryNow();
  });
  if (typeof navigator !== 'undefined' && !navigator.onLine) axShowOffline();
});

/* ═══ C2 · Sunlight / high-contrast mode ══════════════════════════════
   A third theme ("bright") for outdoor daytime use — pure-white bg, near-black
   text, stronger borders, bolder weight. Toggled separately from dark mode. */
function axApplyTheme(name) {
  const html = document.documentElement;
  if (name === 'dark' || name === 'bright') html.setAttribute('data-theme', name);
  else html.removeAttribute('data-theme');
  try { localStorage.setItem('ax_theme', name || 'light'); } catch (e) {}
  const meta = document.querySelector('meta[name="theme-color"]');
  if (meta) meta.setAttribute('content', name === 'dark' ? '#121714' : (name === 'bright' ? '#ffffff' : '#143026'));
  if (typeof axSyncThemeUi === 'function') try { axSyncThemeUi(); } catch (e) {}
  axSyncSunlightUi();
}
function axToggleSunlight() {
  const cur = document.documentElement.getAttribute('data-theme');
  axApplyTheme(cur === 'bright' ? 'light' : 'bright');
  if (typeof axHaptic === 'function') axHaptic('light');
}
function axSyncSunlightUi() {
  const on = document.documentElement.getAttribute('data-theme') === 'bright';
  const row = document.getElementById('axSunlightRow');
  if (row) row.classList.toggle('active', on);
}
document.addEventListener('DOMContentLoaded', function () {
  let t = '';
  try { t = localStorage.getItem('ax_theme') || ''; } catch (e) { t = ''; }
  if (t === 'bright') axApplyTheme('bright');
  setTimeout(axSyncSunlightUi, 500);
});

/* ═══ B1 · Notification deep-link routing ═════════════════════════════
   Tapping a notification jumps straight to its context (chat, profile,
   post, order-detail, track, RFQ, trade, KYC…). */
function axNotifRoutable(n) {
  if (!n) return false;
  if (n.link_type || n.arn || n.track_arn || n.post_id) return true;
  return ['chat', 'feed_follow', 'feed_like', 'feed_comment', 'new_lead', 'order',
    'delivery_assigned', 'delivery_rating', 'cod_invoice', 'dispute', 'rfq',
    'price_alert', 'kyc_update', 'shop_status', 'referral'].indexOf(n.type || '') !== -1;
}
function axRouteNotification(type, linkType, linkId, arn, postId, fromName, fromPhoto) {
  if (typeof axCloseNotifSheet === 'function') axCloseNotifSheet();
  const go = function (p) { if (typeof switchPanel === 'function') switchPanel(p); };
  const lt = linkType || '';
  if ((lt === 'chat' || type === 'chat') && linkId && typeof axOpenChat === 'function') {
    axOpenChat(linkId, fromName || 'Chat', fromPhoto || ''); return;
  }
  if ((lt === 'profile' || type === 'feed_follow') && linkId && typeof axOpenProfile === 'function') {
    axOpenProfile(linkId); return;
  }
  if ((lt === 'post' || postId) && postId && typeof axOpenPost === 'function') { axOpenPost(postId); return; }
  if ((lt === 'delivery_approval' || type === 'delivery_approval') && arn && typeof axOpenDeliveryApproval === 'function') {
    axOpenDeliveryApproval(arn); return;
  }
  if (arn) {
    if (type === 'delivery_assigned' && typeof axOpenTrackFromNotif === 'function') { axOpenTrackFromNotif(arn); return; }
    if (typeof axOpenOrderDetail === 'function') { axOpenOrderDetail(arn); return; }
  }
  if (type === 'rfq') { go('rfq'); if (typeof axLoadRfqInbox === 'function') try { axLoadRfqInbox(); } catch (e) {} return; }
  if (type === 'referral') { go('referral'); return; }
  if (type === 'price_alert') { go('trade'); return; }
  if (type === 'low_stock') {
    go('shop');
    if (linkId && typeof mpOpenEditProduct === 'function') {
      try { mpOpenEditProduct(linkId, arn || ''); } catch (e) {}
    }
    return;
  }
  if (type === 'kyc_update') { go('profile'); return; }
  if (type === 'new_lead' || type === 'shop_status') { go('shop'); return; }
  go('dashboard');
}

/* ═══ D3 · Delivery-partner approval sheet (shop / importer) ══════════
   Opened from the "Approve delivery partner?" notification — shows the partner's
   record so the shop/importer can Approve or Reject the pending claim. */
async function axOpenDeliveryApproval(arn) {
  let ov = document.getElementById('axApprovalOverlay');
  if (ov) ov.remove();
  ov = document.createElement('div');
  ov.id = 'axApprovalOverlay';
  ov.className = 'ax-comments-overlay';
  ov.innerHTML = '<div class="ax-comments-box"><div class="ax-privacy-loading"><span class="spinner"></span></div></div>';
  ov.addEventListener('click', function (e) { if (e.target === ov) ov.remove(); });
  document.body.appendChild(ov);
  const od = await mpApi('/order/detail?arn=' + encodeURIComponent(arn));
  const box = ov.querySelector('.ax-comments-box');
  if (!od || od.error) { box.innerHTML = '<div class="ax-prof-empty"><p>' + axSocEsc((od && od.error) || 'Could not load') + '</p></div>'; return; }
  const partner = (od.delivery_partner && od.delivery_partner.sub) || '';
  const dn = (od.delivery_partner && od.delivery_partner.name) || 'Delivery partner';
  const rec = partner ? await mpApi('/delivery/record?user_sub=' + encodeURIComponent(partner)) : null;
  const pending = String(od.status || '').toUpperCase() === 'PENDING_APPROVAL';
  box.innerHTML =
    '<div class="ax-comments-head"><b>Approve delivery partner?</b><button type="button" class="ax-strip-icon-btn" onclick="document.getElementById(\'axApprovalOverlay\').remove()"><i class="fa-solid fa-xmark"></i></button></div>' +
    '<div class="ax-privacy-scroll">' +
      '<p class="ax-prof-empty-sm" style="text-align:left">Order ' + axSocEsc(arn) + ' · ' + axSocEsc(od.product_name || '') + '</p>' +
      '<div class="ax-od-party"><span class="ax-od-party-ic"><i class="fa-solid fa-truck-fast"></i></span>' +
        '<div class="ax-od-party-txt"><small>Delivery partner</small><b>' + axSocEsc(dn) + '</b></div></div>' +
      (rec && !rec.error
        ? '<div class="ax-dr-stats"><div><b>' + (rec.deliveries_done || 0) + '</b><span>Deliveries</span></div>' +
          '<div><b>' + (rec.on_time_pct || 0) + '%</b><span>On-time</span></div>' +
          '<div><b>' + (rec.avg_rating || 0) + '★</b><span>' + (rec.total_ratings || 0) + ' ratings</span></div></div>' : '') +
      (pending
        ? '<div style="display:flex;gap:8px;margin-top:16px">' +
            '<button type="button" class="btn-sm-outline" style="flex:1" onclick="axApproveReject(\'' + axSocEsc(arn) + '\', false)">Reject</button>' +
            '<button type="button" class="btn-primary" style="flex:1" onclick="axApproveReject(\'' + axSocEsc(arn) + '\', true)">Approve</button>' +
          '</div>'
        : '<p class="ax-prof-empty-sm" style="margin-top:14px">This claim is no longer pending.</p>') +
    '</div>';
}
async function axApproveReject(arn, approve) {
  const data = await mpApi(approve ? '/delivery/approve' : '/delivery/reject-claim',
    { method: 'POST', body: JSON.stringify({ arn: arn }) });
  if (data && data.success) {
    if (typeof axHaptic === 'function') axHaptic('success');
    showToast(approve ? 'Delivery partner approved ✓' : 'Rejected — order back in pool', 'success');
    const ov = document.getElementById('axApprovalOverlay'); if (ov) ov.remove();
  } else showToast((data && data.error) || 'Could not update', 'error');
}

/* ═══ A2 · Haptic feedback (Android) ══════════════════════════════════
   iOS Safari has no navigator.vibrate → silently no-ops there. Patterns are
   short so they read as a tap, not a buzz. */
function axHaptic(kind) {
  try {
    if (!('vibrate' in navigator)) return;
    const p = { light: 12, medium: 22, success: [14, 40, 14], warning: [10, 30, 10, 30, 10], error: [40, 30, 40] }[kind || 'light'] || 12;
    navigator.vibrate(p);
  } catch (e) { /* ignore */ }
}
window.axHaptic = axHaptic;

/* ═══ A3 · Blur-up image loading ══════════════════════════════════════
   Images in these containers start softly blurred and sharpen when they
   finish loading — big perceived-speed win on slow rural networks. A
   capture-phase 'load' listener catches every <img> (load doesn't bubble);
   a sweep marks already-cached images so they never stay blurred. */
document.addEventListener('load', function (e) {
  const t = e.target;
  if (t && t.tagName === 'IMG') t.classList.add('ax-img-loaded');
}, true);
function axBlurUpSweep() {
  document.querySelectorAll('.ax-post-media, .ax-carousel-slide img, .ax-promo-cell img, .product-card img, .ax-prof-cell img, .ax-story-thumb, .ax-claim-card-photo img, .ax-od-hero img')
    .forEach(function (img) {
      if (img.tagName !== 'IMG') return;
      if (img.complete && img.naturalWidth) img.classList.add('ax-img-loaded');
      else {
        img.addEventListener('load', function () { img.classList.add('ax-img-loaded'); }, { once: true });
        img.addEventListener('error', function () { img.classList.add('ax-img-loaded'); }, { once: true });
      }
    });
}
document.addEventListener('DOMContentLoaded', function () {
  axBlurUpSweep();
  // Feed / catalogue re-render often — sweep again periodically (cheap).
  setInterval(axBlurUpSweep, 2500);
});

/* ═══ A5 · Session persistence — last panel + scroll position ══════════
   Saved to localStorage (survives sign-out), restored on next load AFTER
   the panel's data has had a moment to render so scroll lands correctly. */
const AX_SESSION_KEY = 'ax_last_view';
let _axScrollSaveTimer = null;
function axSaveView() {
  try {
    const active = document.querySelector('.portal-panel.active');
    const panel = active ? active.id.replace('panel-', '') : '';
    const sc = document.querySelector('.content-inner');
    const top = sc ? sc.scrollTop : (window.scrollY || 0);
    if (panel) localStorage.setItem(AX_SESSION_KEY, JSON.stringify({ panel: panel, top: top, at: Date.now() }));
  } catch (e) { /* ignore */ }
}
function axRestoreView() {
  let v = null;
  try { v = JSON.parse(localStorage.getItem(AX_SESSION_KEY) || 'null'); } catch (e) { v = null; }
  if (!v || !v.panel || v.panel === 'dashboard') return; // dashboard is default, skip
  // Only restore recent sessions (within 7 days) to avoid stale jumps.
  if (v.at && Date.now() - v.at > 7 * 24 * 3600 * 1000) return;
  if (typeof switchPanel === 'function') {
    try { switchPanel(v.panel); } catch (e) { return; }
    const sc = document.querySelector('.content-inner');
    // Restore scroll after content has had time to render.
    let tries = 0;
    const iv = setInterval(function () {
      tries++;
      if (sc && sc.scrollHeight > v.top + 50) { sc.scrollTop = v.top; clearInterval(iv); }
      if (tries > 12) clearInterval(iv);
    }, 250);
  }
}
document.addEventListener('DOMContentLoaded', function () {
  const sc = document.querySelector('.content-inner');
  if (sc) sc.addEventListener('scroll', function () {
    clearTimeout(_axScrollSaveTimer);
    _axScrollSaveTimer = setTimeout(axSaveView, 400);
  }, { passive: true });
  // Re-save on panel changes (poll the active panel id cheaply).
  let lastPanel = '';
  setInterval(function () {
    const active = document.querySelector('.portal-panel.active');
    const p = active ? active.id : '';
    if (p && p !== lastPanel) { lastPanel = p; axSaveView(); }
  }, 800);
  // Restore once signed in + panels exist.
  setTimeout(function () {
    if (document.body.classList.contains('is-signed-in')) axRestoreView();
  }, 1400);
});
