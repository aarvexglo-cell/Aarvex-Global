/* Shared catalogue UI helpers for index.html & portal.html */
(function (global) {
  'use strict';

  function esc(s) {
    if (s == null) return '';
    return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  }

  /* Escapes text, then turns any http(s) URL inside it into a clickable
     link — e.g. the COD/online invoice URL that ships inside a
     notification's plain-text body (see cod_invoice.py's _notify_buyer())
     used to render as inert text, so there was no way to actually open
     the invoice from the notification itself. */
  function linkifyText(s) {
    return esc(s).replace(/https?:\/\/[^\s<]+/g, function (url) {
      return '<a href="' + url + '" target="_blank" rel="noopener noreferrer" style="color:var(--c-leaf,#2E6B41);font-weight:700;text-decoration:underline">Open link</a>';
    });
  }

  function truncateDesc(text, maxLen) {
    var t = (text || '').replace(/^Description\s*/i, '').trim();
    if (!t) return '';
    if (t.length <= maxLen) return t;
    return t.slice(0, maxLen).replace(/\s+\S*$/, '') + '…';
  }

  function descHtml(fullText, maxLen) {
    var full = (fullText || '').replace(/^Description\s*/i, '').trim();
    if (!full) return '';
    var short = truncateDesc(full, maxLen || 120);
    var needsMore = full.length > short.replace('…', '').length + 2;
    var cls = 'product-card-desc-clamp' + (needsMore ? '' : ' expanded');
    return '<p class="' + cls + '" data-full="' + esc(full) + '" onclick="CatalogueUI.toggleDesc(this, event)" title="Click to ' + (needsMore ? 'read more' : '') + '">' +
      esc(needsMore ? short : full) +
      (needsMore ? '<span class="read-more-hint">Read more</span>' : '') + '</p>';
  }

  function toggleDesc(el, ev) {
    if (ev) ev.stopPropagation();
    if (!el) return;
    var full = el.getAttribute('data-full') || el.textContent;
    if (el.classList.contains('expanded')) {
      el.classList.remove('expanded');
      el.innerHTML = esc(truncateDesc(full, 120)) + '<span class="read-more-hint">Read more</span>';
    } else {
      el.classList.add('expanded');
      el.innerHTML = esc(full) + '<span class="read-more-hint">Show less</span>';
    }
  }

  function toggleModalDesc(el) {
    if (!el) return;
    el.classList.toggle('expanded');
    el.classList.toggle('collapsed');
    if (el.classList.contains('expanded')) el.innerHTML = esc(el.getAttribute('data-full') || '') + ' <span class="read-more-hint">Show less</span>';
    else el.innerHTML = esc(truncateDesc(el.getAttribute('data-full'), 180)) + ' <span class="read-more-hint">Read more</span>';
  }

  function initFilterDropdown(opts) {
    opts = opts || {};
    var btn = document.getElementById(opts.toggleId || 'filterToggleBtn');
    var menu = document.getElementById(opts.menuId || 'filterDropdown');
    var searchInput = document.getElementById(opts.searchId || 'catalogueSearchInput');
    var clearBtn = document.getElementById(opts.clearId || 'searchClearBtn');
    var badge = document.getElementById(opts.badgeId || 'filterActiveBadge');
    if (!menu) return;

    function closeMenu() {
      menu.classList.remove('open');
      if (btn) btn.classList.remove('open');
    }
    function openMenu() {
      menu.classList.add('open');
      if (btn) btn.classList.add('open');
    }

    if (btn) {
      btn.addEventListener('click', function (e) {
        e.stopPropagation();
        menu.classList.contains('open') ? closeMenu() : openMenu();
      });
      document.addEventListener('click', function (e) {
        if (!menu.contains(e.target) && e.target !== btn && !btn.contains(e.target)) closeMenu();
      });
    }

    if (searchInput && clearBtn) {
      function syncClear() {
        clearBtn.classList.toggle('show', !!searchInput.value.trim());
      }
      searchInput.addEventListener('input', syncClear);
      clearBtn.addEventListener('click', function () {
        searchInput.value = '';
        syncClear();
        if (typeof opts.onSearch === 'function') opts.onSearch('');
        searchInput.focus();
      });
      syncClear();
    }

    function updateBadge() {
      if (!badge) return;
      var active = menu.querySelectorAll('.filter-pill.active:not([data-cat="all"]):not([data-rating="all"])');
      var n = active.length;
      badge.textContent = n;
      badge.classList.toggle('show', n > 0);
    }

    menu.querySelectorAll('.filter-pill').forEach(function (pill) {
      pill.addEventListener('click', function () {
        var cat = pill.getAttribute('data-cat');
        var rating = pill.getAttribute('data-rating');
        if (cat !== null) {
          menu.querySelectorAll('[data-cat]').forEach(function (p) { p.classList.remove('active'); });
          pill.classList.add('active');
        }
        if (rating !== null) {
          menu.querySelectorAll('[data-rating]').forEach(function (p) { p.classList.remove('active'); });
          pill.classList.add('active');
        }
        updateBadge();
        if (typeof opts.onFilter === 'function') opts.onFilter();
      });
    });
    updateBadge();
  }

  function getFilterState(menuId) {
    var menu = document.getElementById(menuId || 'filterDropdown');
    var cat = 'all', rating = 'all';
    if (menu) {
      var cp = menu.querySelector('[data-cat].active');
      var rp = menu.querySelector('[data-rating].active');
      if (cp) cat = cp.getAttribute('data-cat') || 'all';
      if (rp) rating = rp.getAttribute('data-rating') || 'all';
    }
    return { category: cat, rating: rating };
  }

  function filterProducts(products, query, cat, rating) {
    query = (query || '').toLowerCase().trim();
    return products.filter(function (p) {
      var name = p.product_name || p.name || '';
      var category = p.category_name || p.category || '';
      var shop = p.shop_name || p.shopId || p.shop_id || '';
      var desc = p.description || '';
      var matchQ = !query || [name, category, desc, shop].join(' ').toLowerCase().indexOf(query) >= 0;
      var matchCat = cat === 'all' || category.toLowerCase() === String(cat).toLowerCase();
      var r = parseFloat(p.avg_rating != null ? p.avg_rating : p.rating) || 0;
      var matchR = rating === 'all' || (rating === '5' && r >= 4.75) || (rating === '4' && r >= 4) || (rating === '3' && r >= 3);
      return matchQ && matchCat && matchR;
    });
  }

  /* ── MRP / discount helper (Phase 1 catalogue redesign) ──
     Shared by portal.html, index.html and product-modal.js so the "was ₹X
     now ₹Y, Z% off" logic lives in exactly one place. Fully optional/
     backward-compatible: if the product has no mrp_price_per_kg (or
     discount_percent is 0), `show` is false and callers should render the
     price exactly as before — no badge, no strikethrough. */
  function priceDiscountInfo(p) {
    p = p || {};
    var usingLot = !!(p.lot_size_kg && p.lot_price);
    var mrp = parseFloat(usingLot ? p.mrp_lot_price : p.mrp_price_per_kg) || 0;
    var pct = parseInt(p.discount_percent, 10) || 0;
    var show = pct > 0 && mrp > 0;
    return {
      show: show,
      mrp: mrp,
      pct: pct,
      mrpHtml: show ? '<span class="pc-mrp">₹' + mrp + '</span>' : '',
      badgeHtml: show ? '<span class="pc-discount-badge">' + pct + '% OFF</span>' : ''
    };
  }

  /* ── Toast system (Phase 2 §7) ──────────────────────────────────────
     portal.html already ships a complete queued showToast() inline
     (portal.html:3674-3690) — that stays authoritative there and is left
     untouched. index.html has no #toast element and no showToast at all,
     so product-modal.js's guarded call (`typeof global.showToast ===
     'function'`) was silently a no-op on the marketing page: wishlist
     errors, save failures, etc. never surfaced. This adds one shared
     implementation and only installs it as window.showToast when nothing
     has already claimed that name — so portal.html's own function is
     never shadowed. */
  var _toastTimer = null;
  var _toastQueue = [];
  var _toastShowing = false;
  function _processToastQueue() {
    if (!_toastQueue.length) { _toastShowing = false; return; }
    _toastShowing = true;
    var next = _toastQueue.shift();
    var t = document.getElementById('toast');
    if (!t) { _toastShowing = false; return; }
    var icons = { success: '<i class="fa-solid fa-circle-check"></i>', error: '<i class="fa-solid fa-circle-xmark"></i>', info: '<i class="fa-solid fa-circle-info"></i>', warning: '<i class="fa-solid fa-triangle-exclamation"></i>' };
    t.innerHTML = (icons[next.type] || icons.info) + ' ' + esc(next.msg);
    t.className = 'show ' + (next.type || 'info');
    clearTimeout(_toastTimer);
    _toastTimer = setTimeout(function () {
      t.className = '';
      setTimeout(_processToastQueue, 220);
    }, 3200);
  }
  function toast(msg, type) {
    if (!document.getElementById('toast')) return; // page has no toast host — nothing to do
    _toastQueue.push({ msg: msg, type: type || 'info' });
    if (!_toastShowing) _processToastQueue();
  }
  if (typeof global.showToast !== 'function') {
    global.showToast = toast;
  }

  /* ── Notification-item template (Phase 2 §7, resolves Section 0 #4) ──
     Both mpLoadNotifications() (portal-marketplace.js, full "Alerts" panel)
     and renderAlertList() (portal-enhancements.js, bell-icon popup) used to
     dump n.body straight into the DOM with `white-space:pre-line`. That
     body string, for the two notification types that actually cause the
     reported bug, is built server-side as a raw label:value block:
       - marketplace.py notify_shopkeepers_of_listing(): "Crop: X\nQuantity:
         Y kg\nExpected price: ...\nLocation: ...\nReference: ...\n5%
         platform fee applies..."
       - delivery.py _broadcast_new_delivery_order(): "📦 New delivery
         available!\n\n<product>\n<pickup> → <dest> (~<km> km)\nEstimated
         earning: ₹<amount>\n\nOpen the Aarvex app..." — the source of the
         inline 📦 emoji next to an otherwise icon-based UI. That body is
         still sent to WhatsApp as-is (correct there — it's chat text), but
         must never be the in-app render.
     Both backends now also send structured extra fields alongside body
     (Phase 2 addition). This function renders those fields as one primary
     line + up to two supporting facts + a "View details" toggle for the
     rest, with the icon set already used elsewhere (fa-wheat-awn / fa-key
     / fa-store / fa-star / fa-id-card / fa-envelope) — no emoji, no raw
     label:value dump. Notifications created before this deploy (or of a
     type with no structured fields) don't have these extra keys, so this
     falls back to the plain body text unchanged — nothing regresses for
     already-stored records. */
  var NOTIF_ICONS = {
    delivery_otp: 'fa-key',
    kyc_update: 'fa-id-card',
    shop_status: 'fa-store',
    admin_message: 'fa-shield-halved',
    new_lead: 'fa-user-plus',
    new_review: 'fa-star',
    feed_like: 'fa-heart',
    feed_comment: 'fa-comment',
    feed_follow: 'fa-user-plus',
    order_update: 'fa-receipt',
    order_cancel: 'fa-truck',
    delivery: 'fa-truck',
    chat: 'fa-comment-dots'
  };

  function _notifOtp(body) {
    var m = String(body || '').match(/OTP:\s*(\d{6})/i);
    return m ? m[1] : '';
  }

  /* Every copyable code the message mentions — order id (ARN), tracking
     key — surfaced as one-tap copy chips instead of making the user
     select text on a phone. OTP keeps its own dedicated button below. */
  function _notifCodes(body) {
    var s = String(body || '');
    var out = [];
    var arn = s.match(/ARN-\d{4}-\d+/i);
    if (arn) out.push({ label: 'Order ID', val: arn[0] });
    var trk = s.match(/Tracking key:\s*([A-Za-z0-9-]{4,})/i);
    if (trk) out.push({ label: 'Tracking key', val: trk[1] });
    return out;
  }

  /* Server timestamps are UTC ISO strings — render them in the VIEWER'S
     timezone (IST for users in India, their own local time elsewhere)
     instead of dumping the raw UTC text. Bare strings without a zone
     suffix are treated as UTC, which is what the backend's _now() emits. */
  function _notifTimeHtml(n) {
    var raw = String(n.created_at || '');
    if (!raw) return '';
    var d = new Date(/(?:Z|[+-]\d{2}:?\d{2})$/.test(raw) ? raw : raw + 'Z');
    var txt = isNaN(d.getTime())
      ? raw.slice(0, 16).replace('T', ' ')
      : d.toLocaleString(undefined, { day: 'numeric', month: 'short', hour: 'numeric', minute: '2-digit', hour12: true });
    return '<div class="notif-time">' + esc(txt) + '</div>';
  }

  function notificationItemHtml(n, opts) {
    n = n || {};
    opts = opts || {};
    var icon = NOTIF_ICONS[n.type] || 'fa-bell';
    var unreadCls = n.is_read ? '' : ' unread';
    var otp = _notifOtp(n.body);
    var otpCls = otp ? ' otp-item' : '';
    var otpBtn = otp ? '<button type="button" class="otp-copy-btn" onclick="PortalEnhancements.copyOtp(\'' + otp + '\')"><i class="fa-regular fa-copy"></i> Copy OTP · ' + otp + '</button>' : '';

    var primary = '', facts = [], detailLines = [];

    if (n.type === 'new_lead' && n.listing_crop) {
      primary = 'New listing: ' + esc(n.listing_crop) + (n.listing_quantity_kg ? ' — ' + esc(String(n.listing_quantity_kg)) + ' kg' : '');
      if (n.listing_expected_price) facts.push('₹' + esc(String(n.listing_expected_price)) + '/kg expected');
      if (n.listing_city) facts.push(esc([n.listing_city, n.listing_state].filter(Boolean).join(', ')));
      if (n.reference_id) detailLines.push('Reference: ' + esc(n.reference_id));
      if (n.platform_fee_pct) detailLines.push(n.platform_fee_pct + '% platform fee applies on finalized deals.');
    } else if (n.type === 'shop_status' && n.delivery_product_name) {
      primary = 'New delivery: ' + esc(n.delivery_product_name);
      if (n.delivery_pickup_city || n.delivery_dest_city) facts.push(esc(n.delivery_pickup_city || '?') + ' → ' + esc(n.delivery_dest_city || '?') + (n.delivery_distance_km ? ' (~' + esc(String(n.delivery_distance_km)) + ' km)' : ''));
      if (n.delivery_earning) facts.push('Est. earning ₹' + esc(String(n.delivery_earning)));
      detailLines.push('Open the Delivery tab to claim it — first to claim gets it.');
    } else {
      // No structured fields (older record, or a type that's already a single
      // clean sentence like kyc_update/shop_status/admin_message) — render the
      // body as-is, same as before, just without the emoji-adjacent styling.
      primary = esc(n.title || 'Notification');
      facts.push(linkifyText(n.body || '').replace(/\n+/g, ' · '));
    }

    // Reuses the EXISTING .notif-item/.notif-icon/.notif-title/.notif-body/
    // .notif-time classes already styled in portal.html:1026-1032 — only the
    // facts/details/mark-read/otp pieces below are new, styled in
    // components.css.
    var factsHtml = facts.filter(Boolean).slice(0, 2).map(function (f) { return '<div class="notif-body notif-fact">' + f + '</div>'; }).join('');
    var detailsHtml = detailLines.length
      ? '<details class="notif-details"><summary>View details</summary>' + detailLines.map(function (d) { return '<div>' + esc(d) + '</div>'; }).join('') + '</details>'
      : '';
    var markReadBtn = (opts.showMarkRead && !n.is_read && n.notification_id)
      ? '<button type="button" class="notif-markread-btn" onclick="' + esc(opts.markReadFn || 'mpMarkRead') + '(\'' + esc(n.notification_id) + '\')">Mark as read</button>'
      : '';
    // One-tap copy chips for every code the message carries (order id /
    // tracking key) — guarded so pages without portal-helpers.js (which
    // defines axCopyText) simply render no chips instead of breaking.
    var codeChips = (typeof window !== 'undefined' && typeof window.axCopyText === 'function')
      ? _notifCodes(n.body).map(function (c) {
          return '<button type="button" class="notif-copy-chip" onclick="axCopyText(\'' + esc(c.val) + '\', this)" title="Copy ' + esc(c.label) + '">' +
            '<i class="fa-regular fa-copy"></i> ' + esc(c.label) + ' · ' + esc(c.val) + '</button>';
        }).join('')
      : '';
    var chipsRow = codeChips ? '<div class="notif-chips-row">' + codeChips + '</div>' : '';
    // Structured action buttons (backend sets these on delivery events):
    // call_phone → direct tel: call to the delivery partner;
    // track_arn  → one tap into the Track tab with the ARN pre-filled.
    var actionBtns = '';
    if (n.call_phone) {
      actionBtns += '<a class="notif-action-btn" href="tel:' + esc(n.call_phone) + '"><i class="fa-solid fa-phone"></i> Call ' + esc(n.call_name || 'delivery partner') + '</a>';
    }
    if (n.track_arn && typeof window !== 'undefined' && typeof window.axOpenTrackFromNotif === 'function') {
      actionBtns += '<button type="button" class="notif-action-btn notif-action-track" onclick="axOpenTrackFromNotif(\'' + esc(n.track_arn) + '\')"><i class="fa-solid fa-location-crosshairs"></i> Track live</button>';
    }
    if (n.edit_product_id && typeof window !== 'undefined' && typeof window.mpOpenEditProduct === 'function') {
      actionBtns += '<button type="button" class="notif-action-btn notif-action-open" onclick="mpOpenEditProduct(\'' +
        esc(n.edit_product_id) + '\',\'' + esc(n.edit_category_id || '') + '\')"><i class="fa-solid fa-boxes-stacked"></i> ' +
        esc(n.cta_label || 'Refill & edit product') + '</button>';
    }
    // B1: tap-to-open — routes to the notification's context (chat / profile /
    // post / order / RFQ / trade / KYC…). Skipped whenever a Track live button
    // is already present (any delivery/on-the-way notification) — that button
    // already takes the user to the live map, so a separate "Open" is just
    // redundant clutter.
    if (typeof window !== 'undefined' && typeof window.axRouteNotification === 'function'
        && typeof window.axNotifRoutable === 'function' && window.axNotifRoutable(n)
        && !n.track_arn) {
      var _lbl = n.type === 'chat' ? 'Reply' : (n.type === 'feed_follow' ? 'View profile' : 'Open');
      actionBtns += '<button type="button" class="notif-action-btn notif-action-open" onclick="axRouteNotification(\'' +
        esc(n.type || '') + '\',\'' + esc(n.link_type || '') + '\',\'' + esc(n.link_id || n.from_sub || '') + '\',\'' +
        esc(n.arn || n.track_arn || '') + '\',\'' + esc(n.post_id || '') + '\',\'' + esc(n.from_name || '') + '\',\'' +
        esc(n.from_photo || '') + '\')">' + _lbl + ' <i class="fa-solid fa-arrow-up-right-from-square"></i></button>';
    }
    var actionsRow = actionBtns ? '<div class="notif-actions-row">' + actionBtns + '</div>' : '';
    // Per-notification delete (× in the card's corner) — only rendered
    // where the host page wired a delete handler.
    var deleteBtn = (opts.showDelete && n.notification_id)
      ? '<button type="button" class="notif-del-btn" onclick="' + esc(opts.deleteFn || 'mpDeleteNotification') + '(\'' + esc(n.notification_id) + '\', this)" title="Delete notification" aria-label="Delete"><i class="fa-regular fa-trash-can"></i></button>'
      : '';
    var unreadDot = n.is_read ? '' : '<span class="notif-unread-dot" aria-hidden="true"></span>';

    return '<div class="notif-item' + unreadCls + otpCls + '" data-ntype="' + esc(n.type || '') + '">' +
      '<div class="notif-icon"><i class="fa-solid ' + icon + '"></i></div>' +
      '<div class="notif-item-content">' +
        '<div class="notif-title-row"><div class="notif-title">' + primary + '</div>' + unreadDot + '</div>' +
        factsHtml + detailsHtml + chipsRow + actionsRow + otpBtn + _notifTimeHtml(n) + markReadBtn +
      '</div>' + deleteBtn + '</div>';
  }

  /* ── Empty / error state with retry (Phase 2 §7) ── generalizes the
     loadAddressBook() retry pattern (portal-address.js) so any list/panel
     can use the same markup + behavior instead of inventing its own. */
  function emptyStateHtml(opts) {
    opts = opts || {};
    return '<div class="empty-state">' +
      '<i class="fa-solid ' + (opts.icon || 'fa-inbox') + '"></i>' +
      (opts.title ? '<b>' + esc(opts.title) + '</b>' : '') +
      '<p>' + esc(opts.message || 'Nothing here yet.') + '</p>' +
      '</div>';
  }
  function errorStateHtml(opts) {
    opts = opts || {};
    var retryAttr = opts.retryFn ? ' onclick="' + esc(opts.retryFn) + '(' + (opts.retryArgs || '') + ')"' : '';
    return '<div class="error-state">' +
      '<i class="fa-solid fa-triangle-exclamation"></i>' +
      '<span>' + esc(opts.message || 'Something went wrong.') + '</span>' +
      (opts.retryFn ? '<a class="error-state-retry"' + retryAttr + '>Retry</a>' : '') +
      '</div>';
  }

  /* ── Avatar initials fallback (Phase 2 §7 / Section 0 #10) ── portal.html
     already has its own complete renderAvatarEl() (portal.html:2647) wired
     to every avatar slot there — left untouched, it works correctly. This
     is the missing equivalent for index.html, which has two raw
     `<img src="${user.picture}">` renders (index.html:2552, 2561) with no
     fallback: a user without a Google photo gets a broken/blank image
     instead of initials. Behavior mirrors portal.html's version. */
  function avatarInitialsHtml(user, size) {
    user = user || {};
    size = size || 32;
    var name = user.name || user.given_name || user.email || '';
    var initials = name.split(/\s+/).filter(Boolean).slice(0, 2).map(function (w) { return w[0]; }).join('').toUpperCase() || '?';
    var photo = user.picture || '';
    if (photo) {
      return '<img class="avatar-initials-fallback" style="width:' + size + 'px;height:' + size + 'px;border-radius:50%;object-fit:cover;vertical-align:middle" src="' + esc(photo) + '" alt="" ' +
        'onerror="this.outerHTML=\'<span class=&quot;avatar-initials&quot; style=&quot;width:' + size + 'px;height:' + size + 'px;font-size:' + Math.round(size * 0.4) + 'px&quot;>' + initials + '</span>\'">';
    }
    return '<span class="avatar-initials" style="width:' + size + 'px;height:' + size + 'px;font-size:' + Math.round(size * 0.4) + 'px">' + initials + '</span>';
  }

  /* ── Product/shop image with placeholder fallback (Phase 2 §7 / Section 0
     #14) ── portal.html's catalogue render already does this correctly
     inline (.product-card-thumb + sibling .product-card-placeholder,
     revealed via onerror). This is the shared, reusable version for any
     new card so the pattern doesn't get reinvented ad hoc a third time. */
  function imageWithFallback(src, alt, iconClass, cssClass) {
    var hasImg = src && String(src).trim().length > 10;
    var imgSrc = hasImg ? esc(String(src).trim()) : '';
    return (hasImg
      ? '<img class="' + (cssClass || 'product-card-thumb') + '" src="' + imgSrc + '" alt="' + esc(alt || '') + '" loading="lazy" onerror="this.onerror=null;this.style.display=\'none\';this.nextElementSibling.style.display=\'flex\'">' +
        '<div class="product-card-placeholder" style="display:none"><i class="' + (iconClass || 'fa-leaf') + '"></i></div>'
      : '<div class="product-card-placeholder"><i class="' + (iconClass || 'fa-leaf') + '"></i></div>');
  }

  global.CatalogueUI = {
    esc: esc,
    truncateDesc: truncateDesc,
    descHtml: descHtml,
    toggleDesc: toggleDesc,
    toggleModalDesc: toggleModalDesc,
    initFilterDropdown: initFilterDropdown,
    getFilterState: getFilterState,
    filterProducts: filterProducts,
    priceDiscountInfo: priceDiscountInfo,
    linkifyText: linkifyText,
    toast: toast,
    notificationItemHtml: notificationItemHtml,
    emptyStateHtml: emptyStateHtml,
    errorStateHtml: errorStateHtml,
    avatarInitialsHtml: avatarInitialsHtml,
    imageWithFallback: imageWithFallback
  };
})(typeof window !== 'undefined' ? window : this);
