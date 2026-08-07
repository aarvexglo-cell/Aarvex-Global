/* Shared product detail modal — index.html (browse) & portal.html (buy) */
(function (global) {
  'use strict';

  var selectedProduct = null;
  var reviewRating = 0;
  var LISTING_MODIFY_MS = 30 * 60 * 1000;

  // Modal stacking: both the product-detail modal and the shop-profile modal
  // share z-index 9000 in CSS, so whichever comes LATER in the DOM always
  // covered the other. That's why opening a product from inside a shop profile
  // (or a shop from inside a product) happened "behind" the one already open.
  // Bumping an incrementing z-index on each open guarantees the last-opened
  // surface is always on top, in both directions.
  var _pdModalZ = 9000;
  function _raiseModal(el) { if (el) el.style.zIndex = ++_pdModalZ; }
  // The shop whose profile is currently open — used so a Buy launched from a
  // shop card can return the user to that exact shop afterwards.
  var _currentShopId = null;

  function esc(s) {
    if (s == null) return '';
    return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  }

  function starsHtml(rating, size) {
    var r = Math.round(parseFloat(rating) || 0);
    if (!r) {
      // §0-5: no reviews yet — an empty 5-star row reads as "rated zero".
      // Show a plain "New" label instead of grey stars.
      return '<span class="rating-count-new" style="font-size:' + (size || 14) + 'px;font-weight:700;color:var(--c-gold,#C7993A)">New</span>';
    }
    var out = '';
    for (var i = 1; i <= 5; i++) {
      out += '<i class="fa-solid fa-star' + (i <= r ? '' : '-half-stroke') + '" style="color:' + (i <= r ? '#C7993A' : '#D5C9B6') + ';font-size:' + (size || 14) + 'px"></i>';
    }
    return out;
  }

  function apiUrl(path) {
    // portal.html declares `const LAMBDA_URL` (a lexical global, NOT on window),
    // so prefer the bare identifier via scope chain; fall back to window/global
    // for the standalone pages that set window.LAMBDA_URL directly.
    var raw = (typeof LAMBDA_URL !== 'undefined' && LAMBDA_URL)
      ? LAMBDA_URL
      : (global.LAMBDA_URL || window.LAMBDA_URL || '');
    var base = String(raw).replace(/\/$/, '');
    return base + path;
  }

  async function safeApiJson(path) {
    var url = apiUrl(path);
    if (!url || url === path) {
      throw new Error('API URL missing — reload the page and try again.');
    }
    var headers = { Accept: 'application/json' };
    try {
      var tok = localStorage.getItem('ax_google_token');
      if (tok) headers.Authorization = 'Bearer ' + tok;
    } catch (e) {}
    var res;
    try {
      res = await fetch(url, {
        headers: headers,
        cache: 'no-store',
        mode: 'cors',
        signal: (typeof AbortSignal !== 'undefined' && AbortSignal.timeout)
          ? AbortSignal.timeout(28000) : undefined
      });
    } catch (netErr) {
      var msg = (netErr && netErr.name === 'TimeoutError')
        ? 'Shop profile timed out — please try again.'
        : ('Network error loading shop (' + (netErr && netErr.message ? netErr.message : 'Failed to fetch') + ')');
      throw new Error(msg);
    }
    var text = await res.text();
    if (!text || text.trim().charAt(0) !== '{') {
      throw new Error('Server returned non-JSON (HTTP ' + res.status + '). Please deploy the latest Lambda code.');
    }
    var data = JSON.parse(text);
    if (!res.ok && data && data.error) {
      throw new Error(data.error);
    }
    return data;
  }

  function getUser() {
    try { return JSON.parse(localStorage.getItem('ax_user') || 'null'); } catch (e) { return null; }
  }

  function toast(msg, type) {
    if (typeof global.showToast === 'function') global.showToast(msg, type || 'info');
    else if (typeof global.toast === 'function') global.toast(msg, type || 'success');
  }

  function renderStars(rating) {
    if (typeof global.renderStarRating === 'function') return global.renderStarRating(rating);
    return starsHtml(rating, 14);
  }

  function getProductIcon(p) {
    if (typeof global.getProductIcon === 'function') return global.getProductIcon(p);
    return 'fa-solid fa-seedling';
  }

  function truncateDesc(text, max) {
    if (typeof global.CatalogueUI !== 'undefined') return global.CatalogueUI.truncateDesc(text, max || 180);
    var t = (text || '').trim();
    if (t.length <= max) return t;
    return t.slice(0, max).replace(/\s+\S*$/, '') + '…';
  }

  function buildPriceHtml(product) {
    var disc = (typeof global.CatalogueUI !== 'undefined')
      ? global.CatalogueUI.priceDiscountInfo(product)
      : { show: false, mrpHtml: '', badgeHtml: '' };
    var usingLot = product.lot_size_kg && product.lot_price;
    var mainPrice = usingLot
      ? '₹' + product.lot_price + '<span> / lot (' + product.lot_size_kg + ' kg)</span>'
      : (product.price_per_kg ? '₹' + product.price_per_kg + '<span>/kg</span>' : '');
    if (!mainPrice) return '<div class="pd-modal-price pd-price-contact">Contact for price</div>';
    return '<div class="product-card-price-wrap"><div class="pd-modal-price">' + mainPrice + '</div>' + disc.mrpHtml + '</div>' + disc.badgeHtml;
  }

  function findProduct(productId, categoryId) {
    var list = global.catalogueProducts || global.catalogue || global.filteredCatalogue || [];
    return list.find(function (x) {
      return x.product_id === productId && (!categoryId || x.category_id === categoryId);
    });
  }

  function openById(productId, categoryId) {
    var p = findProduct(productId, categoryId);
    if (p) openModal(p);
  }

  function closeModal() {
    var el = document.getElementById('productDetailModal');
    if (el) el.classList.remove('open');
    selectedProduct = null;
    reviewRating = 0;
    if (_lastFocusedEl && typeof _lastFocusedEl.focus === 'function') _lastFocusedEl.focus();
    _lastFocusedEl = null;
  }

  function redirectToPortalOrder(product) {
    var q = 'product=' + encodeURIComponent(product.product_id || '') +
      '&category=' + encodeURIComponent(product.category_id || '') +
      '&action=order';
    window.location.href = 'portal.html?' + q;
  }

  function normalizeShopId(q) {
    var s = (q || '').trim().toUpperCase().replace(/\s+/g, '');
    if (/^\d{4,5}$/.test(s)) return 'SHOP-AX-' + s.replace(/^0+/, '').padStart(5, '0').slice(-5);
    var m = s.match(/^SHOP[-\s]?AX[-\s]?(\d+)/);
    if (m) return 'SHOP-AX-' + m[1].padStart(5, '0').slice(-5);
    return s;
  }

  function portalBuyProduct(product) {
    closeModal();
    if (typeof global.selectProductForOrder === 'function') {
      global.selectProductForOrder(product);
    }
  }

  function buildInfoHtml(product) {
    var hasImg = product.image_url && product.image_url.length > 10;
    var icon = getProductIcon(product);
    var desc = product.description || '';
    var shopLine = product.shop_id
      ? '<button type="button" class="shop-badge shop-badge-link" onclick="ProductModal.openShopProfile(\'' + esc(product.shop_id).replace(/'/g, "\\'") + '\')"><i class="fa-solid fa-store"></i> ' + esc(product.shop_name || 'Unnamed Shop') + '</button>'
      : (product.shop_name ? '<div class="shop-badge"><i class="fa-solid fa-store"></i> ' + esc(product.shop_name) + '</div>' : '');
    // Product media: a video (if the seller uploaded one) takes the hero;
    // otherwise the image opens a zoomable gallery of ALL the product's images.
    var imgs = (product.image_urls && product.image_urls.length ? product.image_urls : (hasImg ? [product.image_url] : []))
      .filter(function (u) { return u && String(u).length > 10; });
    var imgsJson = esc(JSON.stringify(imgs)).replace(/'/g, '&#39;');
    var video = product.video_url && product.video_url.length > 10;
    var heroInner;
    if (video) {
      heroInner = '<video class="pd-modal-video" src="' + esc(product.video_url) + '" controls playsinline preload="metadata" poster="' + esc(product.image_url || '') + '"></video>';
    } else if (imgs.length) {
      // Inline swipeable gallery (scroll-snap) — swipe through every photo
      // right in the product view; tapping any one opens the full-screen
      // zoomable lightbox at that image.
      var slides = imgs.map(function (u, idx) {
        return '<div class="pd-swipe-slide"><img class="pd-swipe-img" src="' + esc(u) + '" alt="' + esc(product.product_name) +
          '" onclick="axLightbox(JSON.parse(this.closest(\'.pd-swipe\').dataset.imgs),' + idx + ')"></div>';
      }).join('');
      var dots = imgs.length > 1
        ? '<div class="pd-swipe-dots">' + imgs.map(function (_, i) { return '<span class="pd-swipe-dot' + (i === 0 ? ' on' : '') + '"></span>'; }).join('') + '</div>'
        : '';
      heroInner =
        '<div class="pd-swipe" data-imgs=\'' + imgsJson + '\'>' +
          '<div class="pd-swipe-track" onscroll="ProductModal.swipeScroll(this)">' + slides + '</div>' +
          dots +
          (imgs.length > 1 ? '<span class="pd-img-count"><i class="fa-solid fa-images"></i> ' + imgs.length + '</span>' : '') +
        '</div>';
    } else {
      heroInner = '<div class="pd-modal-img-fallback"><i class="' + icon + '"></i></div>';
    }
    return (
      // Hero image is flush to the modal's top + side edges; the product name
      // sits ON the image (bottom scrim) and the close button floats top-right.
      '<div class="pd-modal-hero">' + heroInner +
        '<button type="button" class="pd-modal-close-float" onclick="ProductModal.closeModal()" aria-label="Close"><i class="fa-solid fa-xmark"></i></button>' +
        '<div class="pd-hero-overlay"><div class="pd-hero-name">' + esc(product.product_name) + '</div></div>' +
      '</div>' +
      '<div class="pd-modal-info">' +
        shopLine +
        '<div class="pd-modal-rating">' + renderStars(product.avg_rating) +
          (product.total_reviews ? ' <span class="pd-review-count">(' + product.total_reviews + ' reviews)</span>' : '') +
        '</div>' +
        '<div class="pd-modal-meta">' + esc(product.category_name || '') + ' · Min ' + (product.min_order_kg || 1) + ' kg · ' + esc(product.available_stock || 'In Stock') + '</div>' +
        (desc ? '<p class="pd-modal-desc" data-full="' + esc(desc) + '" onclick="ProductModal.toggleDesc(this)">' + esc(truncateDesc(desc, 180)) + (desc.length > 180 ? ' <span class="read-more-hint">Read more</span>' : '') + '</p>' : '') +
        buildPriceHtml(product) +
      '</div>'
    );
  }

  function toggleDesc(el) {
    if (!el) return;
    var full = el.getAttribute('data-full') || '';
    if (el.classList.contains('expanded')) {
      el.classList.remove('expanded');
      el.innerHTML = esc(truncateDesc(full, 180)) + ' <span class="read-more-hint">Read more</span>';
    } else {
      el.classList.add('expanded');
      el.innerHTML = esc(full) + ' <span class="read-more-hint">Show less</span>';
    }
  }

  async function loadShopReactions(shopId) {
    var wrap = document.getElementById('pdShopReactions');
    if (!wrap || !shopId) return;
    try {
      var data = await safeApiJson('/shop/public?shop_id=' + encodeURIComponent(shopId));
      var shop = data.shop || {};
      var likes = shop.likes || 0;
      var dislikes = shop.dislikes || 0;
      wrap.innerHTML =
        '<div class="pd-reaction-bar">' +
          '<button type="button" class="pd-react-btn like" onclick="ProductModal.reactShop(\'' + esc(shopId).replace(/'/g, "\\'") + '\',\'like\')"><i class="fa-solid fa-thumbs-up"></i> ' + likes + '</button>' +
          '<button type="button" class="pd-react-btn dislike" onclick="ProductModal.reactShop(\'' + esc(shopId).replace(/'/g, "\\'") + '\',\'dislike\')"><i class="fa-solid fa-thumbs-down"></i> ' + dislikes + '</button>' +
          '<span class="pd-react-hint">Public ratings — visible to everyone</span>' +
        '</div>';
    } catch (e) {
      wrap.innerHTML = '';
    }
  }

  async function reactShop(shopId, reaction) {
    var user = getUser();
    var token = localStorage.getItem('ax_google_token');
    if (!user) {
      toast('Sign in to rate shops', 'warning');
      setTimeout(function () { window.location.href = 'portal.html'; }, 1200);
      return;
    }
    try {
      var headers = { 'Content-Type': 'application/json' };
      if (token) headers.Authorization = 'Bearer ' + token;
      var res = await fetch(apiUrl('/shop/react'), {
        method: 'POST', headers: headers,
        body: JSON.stringify({ shop_id: shopId, reaction: reaction, user_sub: user.sub })
      });
      var data = await res.json();
      if (data.success) {
        // Update counts in both product modal and shop profile modal
        loadShopReactions(shopId);
        // Also refresh shop profile counts if open
        var likeEl = document.getElementById('shopLikeCount');
        var dislikeEl = document.getElementById('shopDislikeCount');
        if (likeEl && data.likes != null) likeEl.textContent = data.likes;
        if (dislikeEl && data.dislikes != null) dislikeEl.textContent = data.dislikes;
        toast(reaction === 'like' ? 'Thanks for your support! 👍' : 'Feedback noted 👎', 'success');
      } else toast(data.error || 'Could not save reaction', 'error');
    } catch (e) { toast('Network error', 'error'); }
  }

  async function loadReviews(product) {
    var listEl = document.getElementById('pdReviewsList');
    var formWrap = document.getElementById('pdReviewForm');
    if (!listEl) return;
    listEl.innerHTML = '<p class="pd-muted">Loading reviews…</p>';
    try {
      var res = await fetch(apiUrl('/reviews?product_id=' + encodeURIComponent(product.product_id)), { headers: { Accept: 'application/json' } });
      var text = await res.text();
      var data = text.charAt(0) === '{' ? JSON.parse(text) : { reviews: [] };
      var reviews = data.reviews || [];
      listEl.innerHTML = reviews.length
        ? reviews.map(function (r) {
          return '<div class="pd-review-item"><div class="pd-review-head">' + renderStars(r.rating) +
            ' <strong>' + esc(r.reviewer_name || 'Customer') + '</strong> · ' + esc((r.created_at || '').slice(0, 10)) +
            '</div><div class="pd-review-body">' + esc(r.comment || '') + '</div></div>';
        }).join('')
        : '<p class="pd-muted">No reviews yet. Be the first to share your experience.</p>';
    } catch (e) {
      listEl.innerHTML = '<p class="pd-muted">Reviews are temporarily unavailable.</p>';
    }

    if (!formWrap) return;
    var user = getUser();
    var token = localStorage.getItem('ax_google_token');
    if (user && token) {
      formWrap.innerHTML =
        '<div class="pd-review-form">' +
          '<strong>Write a Review</strong>' +
          '<div class="star-picker" id="pdReviewStars">' +
            [1, 2, 3, 4, 5].map(function (n) {
              return '<button type="button" data-v="' + n + '" onclick="ProductModal.setReviewStar(' + n + ')">★</button>';
            }).join('') +
          '</div>' +
          '<textarea id="pdReviewComment" class="form-input" rows="3" maxlength="300" placeholder="Share your experience with this product…"></textarea>' +
          '<button type="button" class="pd-btn-primary" onclick="ProductModal.submitReview()"><i class="fa-solid fa-paper-plane"></i> Submit Review</button>' +
        '</div>';
      reviewRating = 0;
    } else {
      formWrap.innerHTML =
        '<p class="pd-muted"><a href="portal.html" class="pd-link">Sign in with Google</a> to write a review.</p>';
    }
  }

  function setReviewStar(n) {
    reviewRating = n;
    document.querySelectorAll('#pdReviewStars button').forEach(function (btn, i) {
      btn.classList.toggle('on', i < n);
    });
  }

  async function submitReview() {
    if (!selectedProduct || !reviewRating) { toast('Please select a star rating', 'error'); return; }
    // If this page has the silent-refresh helper (portal.html) and the
    // stored token has expired, refresh it first instead of letting the
    // submit fail with "Unauthorized — valid Google token required" after
    // the person has already typed out their review.
    if (typeof window.ensureFreshGoogleToken === 'function') {
      try { await window.ensureFreshGoogleToken(); } catch (e) { /* fall through */ }
    }
    var token = localStorage.getItem('ax_google_token');
    if (!token) { toast('Sign in to submit a review', 'warning'); return; }
    var comment = (document.getElementById('pdReviewComment')?.value || '').trim();
    try {
      var res = await fetch(apiUrl('/review/submit'), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + token },
        body: JSON.stringify({
          product_id: selectedProduct.product_id,
          category_id: selectedProduct.category_id,
          rating: reviewRating,
          comment: comment
        })
      });
      var data = await res.json();
      if (res.ok && data.success) {
        toast('Review submitted — thank you!', 'success');
        loadReviews(selectedProduct);
        if (typeof global.loadCatalogue === 'function') global.loadCatalogue();
      } else toast(data.error || 'Review could not be submitted', 'error');
    } catch (e) { toast('Network error', 'error'); }
  }

  function renderActions(product) {
    var wrap = document.getElementById('pdModalActions');
    if (!wrap) return;
    var mode = document.body.getAttribute('data-site-mode') || 'index';
    if (mode === 'portal') {
      // "Negotiate price" opens an RFQ thread with the seller — the real B2B
      // path for bulk buyers, instead of only the fixed-price Buy Now.
      var pid = esc(product.product_id || '').replace(/'/g, "\\'");
      var cid = esc(product.category_id || '').replace(/'/g, "\\'");
      wrap.innerHTML =
        '<div class="pd-btn-row">' +
          '<button type="button" class="pd-btn-buy" onclick="ProductModal.buy()"><i class="fa-solid fa-bag-shopping"></i> Buy Now</button>' +
          (typeof window.axCartAdd === 'function'
            ? '<button type="button" class="pd-btn-cart" onclick="ProductModal.addToCart(this)" aria-label="Add to cart"><i class="fa-solid fa-cart-plus"></i></button>'
            : '') +
        '</div>' +
        (typeof window.axOpenRfqComposer === 'function'
          ? '<button type="button" class="pd-btn-negotiate" onclick="axOpenRfqComposer(\'' + pid + '\',\'' + cid + '\',\'' + esc(product.product_name || '').replace(/'/g, "\\'") + '\',' + (product.price_per_kg || 0) + ')"><i class="fa-solid fa-handshake"></i> Negotiate Price</button>'
          : '');
    } else {
      wrap.innerHTML =
        '<button type="button" class="pd-btn-buy" onclick="ProductModal.orderViaPortal()" style="background:linear-gradient(135deg,#4EA86A,#2E6B41)">' +
          '<i class="fa-solid fa-cart-shopping"></i> Order This Product' +
        '</button>' +
        '<p class="pd-action-note" style="margin-top:10px">' +
          '<i class="fa-solid fa-lock"></i> Sign in on the portal, then complete the order form for this product.' +
        '</p>';
    }
  }

  /* Count a product view once per product per session (Phase 2 analytics).
     Uses the product's own pk so the backend increment is O(1). Best-effort. */
  var _viewedPks = {};
  function trackProductView(product) {
    var pk = product && product.pk;
    if (!pk || _viewedPks[pk]) return;
    _viewedPks[pk] = true;
    try {
      fetch(apiUrl('/product/view'), {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ pk: pk }), keepalive: true,
      }).catch(function () {});
    } catch (e) { /* ignore */ }
  }

  function openModal(product) {
    selectedProduct = product;
    var modal = document.getElementById('productDetailModal');
    if (!modal) return;
    _lastFocusedEl = document.activeElement;
    document.getElementById('pdModalTitle').textContent = product.product_name || 'Product Details';
    document.getElementById('pdModalBody').innerHTML = buildInfoHtml(product);
    renderActions(product);
    modal.classList.add('open');
    _raiseModal(modal); // always sit above a shop profile it was opened from
    var closeBtn = modal.querySelector('.pd-modal-close');
    if (closeBtn) closeBtn.focus();
    trackProductView(product);
    loadReviews(product);
    if (product.shop_id) loadShopReactions(product.shop_id);
    else {
      var react = document.getElementById('pdShopReactions');
      if (react) react.innerHTML = '';
    }
  }

  function orderViaPortal() {
    if (selectedProduct) redirectToPortalOrder(selectedProduct);
  }

  function buy() {
    if (!selectedProduct) return;
    // If this product was opened from a shop profile, run the shop-aware buy so
    // the whole order flow opens cleanly on top (nothing hidden behind the shop
    // modal) and the user is returned to the same shop when they're done.
    var shopModal = document.getElementById('shopProfileModal');
    var fromShop = (shopModal && shopModal.classList.contains('open')) || !!_currentShopId;
    if (fromShop && _currentShopId) { startShopBuy(selectedProduct, _currentShopId); return; }
    portalBuyProduct(selectedProduct);
  }

  /* Buy launched from within a shop context: remember which shop to return to,
     close the modals so the order form isn't hidden behind them, then open the
     order flow. axReturnToShopAfterBuy() re-opens the shop on Back / after the
     order is placed. */
  function startShopBuy(product, shopId) {
    var sid = shopId || _currentShopId || null;
    closeModal();
    closeShop();
    if (typeof global.selectProductForOrder === 'function') {
      global.selectProductForOrder(product);   // clears any old return-intent
      window._axBuyReturnShop = sid;            // set AFTER so it survives
    } else {
      redirectToPortalOrder(product);
    }
  }

  function axReturnToShopAfterBuy() {
    var sid = window._axBuyReturnShop;
    window._axBuyReturnShop = null;
    if (!sid) return false;
    // Leave the order flow's overlay state and hop back to the shop profile.
    document.body.classList.remove('ax-buy-overlay');
    if (typeof global.resetOrder === 'function') { try { global.resetOrder(); } catch (e) {} }
    openShopProfile(sid);
    return true;
  }
  global.axReturnToShopAfterBuy = axReturnToShopAfterBuy;

  async function openShopProfile(shopId) {
    shopId = normalizeShopId(shopId);
    _currentShopId = shopId;
    var modal = document.getElementById('shopProfileModal');
    var body = document.getElementById('shopProfileBody');
    if (!modal || !body) return;
    _lastFocusedEl = document.activeElement;
    body.innerHTML = '<p class="pd-muted">Loading shop profile…</p>';
    modal.classList.add('open');
    _raiseModal(modal); // sit above a product modal it may have been opened from
    var closeBtn = modal.querySelector('.pd-modal-close');
    if (closeBtn) closeBtn.focus();
    try {
      var data = await safeApiJson('/shop/public?shop_id=' + encodeURIComponent(shopId));
      if (!data.shop) {
        body.innerHTML = '<p class="pd-muted">Shop not found.</p>';
        return;
      }
      var shop = data.shop;
      var products = data.products || [];
      var reviews = data.reviews || [];
      _shopProducts = products; // kept for the per-card Buy buttons below
      // Trust badges (Phase 2 graphics) — a KYC shop is Verified; GST + any
      // certifications the seller recorded show as structured badges instead
      // of buried in the description text.
      var trustKeys = ['verified'];
      if (shop.gst_number) trustKeys.push('gst');
      (shop.certifications || []).forEach(function (c) {
        c = String(c).toLowerCase();
        if (/fssai/.test(c)) trustKeys.push('fssai');
        else if (/apeda/.test(c)) trustKeys.push('apeda');
        else if (/organic/.test(c)) trustKeys.push('organic');
      });
      var trustHtml = (typeof axTrustBadges === 'function')
        ? '<div class="ax-trust-badges">' + axTrustBadges(trustKeys) + '</div>' : '';
      var statsHtml =
        '<div class="shop-stats-row">' +
          '<div class="shop-stat"><strong>' + (shop.product_count || shop.products_listed || products.length) + '</strong><span>Products</span></div>' +
          '<div class="shop-stat"><strong>' + (shop.products_sold || shop.orders_completed || 0) + '</strong><span>Sold</span></div>' +
          '<div class="shop-stat"><strong>' + (shop.total_reviews || reviews.length) + '</strong><span>Reviews</span></div>' +
          '<div class="shop-stat"><strong>' + (shop.likes || 0) + '</strong><span>Likes</span></div>' +
        '</div>';
      var reviewsHtml = reviews.length
        ? reviews.map(function (r) {
          return '<div class="pd-review-item"><div class="pd-review-head">' + renderStars(r.rating) +
            ' <strong>' + esc(r.reviewer_name || 'Customer') + '</strong></div>' +
            '<div class="pd-review-body">' + esc(r.comment || '') + '</div></div>';
        }).join('')
        : '<p class="pd-muted">No public reviews yet.</p>';
      // WhatsApp deep-link needs a country-coded digits-only number; assume
      // India (+91) for the bare 10-digit numbers sellers enter.
      var _waDigits = String(shop.contact_number || '').replace(/\D/g, '');
      if (_waDigits.length === 10) _waDigits = '91' + _waDigits;
      body.innerHTML =
        (shop.shop_cover_url
          ? '<div class="shop-profile-cover"><img src="' + esc(shop.shop_cover_url) + '" alt=""></div>'
          : '') +
        '<div class="shop-profile-header">' +
          '<div class="shop-profile-icon">' +
            (shop.shop_logo_url
              ? '<img src="' + esc(shop.shop_logo_url) + '" alt="">'
              : '<i class="fa-solid fa-store"></i>') +
          '</div>' +
          '<div style="flex:1">' +
            '<h3 style="font-family:var(--f-display,var(--font-display,Georgia,serif));font-size:20px">' + esc(shop.shop_name || 'Unnamed Shop') + '</h3>' +
            '<p style="font-size:13px;color:var(--c-text3,var(--text3))">' + esc(shop.shop_category || 'Agricultural Products') + ' · ' + esc(shop.address_city || '') + ', ' + esc(shop.address_state || '') + '</p>' +
            '<div class="pd-modal-rating" style="margin:6px 0">' + renderStars(shop.avg_rating) + '</div>' +
          '</div></div>' +
        trustHtml +
        statsHtml +
        '<div class="shop-about-block"><h4><i class="fa-solid fa-circle-info"></i> About This Shop</h4>' +
          '<p class="shop-profile-desc">' + esc(shop.shop_description || 'Verified seller on the Aarvex Global marketplace.') + '</p></div>' +
        (shop.contact_number || shop.address_line
          ? '<div class="shop-about-block"><h4><i class="fa-solid fa-address-card"></i> Contact</h4>' +
            (shop.contact_number ? '<p class="shop-profile-desc"><i class="fa-solid fa-phone"></i> ' + esc(shop.contact_number) + '</p>' : '') +
            (shop.address_line ? '<p class="shop-profile-desc"><i class="fa-solid fa-location-dot"></i> ' + esc(shop.address_line) + '</p>' : '') +
            (shop.contact_number
              ? '<div class="ax-contact-actions" style="display:flex;gap:10px;margin-top:10px">' +
                  '<a class="sc-btn sc-call" href="tel:' + esc(shop.contact_number) + '" title="Call" aria-label="Call"><i class="fa-solid fa-phone"></i></a>' +
                  '<a class="sc-btn sc-wa" href="https://wa.me/' + _waDigits + '" target="_blank" rel="noopener" title="WhatsApp" aria-label="WhatsApp"><i class="fa-brands fa-whatsapp"></i></a>' +
                  '<a class="sc-btn sc-sms" href="sms:' + esc(shop.contact_number) + '" title="Message" aria-label="Message"><i class="fa-solid fa-comment-dots"></i></a>' +
                '</div>'
              : '') +
          '</div>'
          : '') +
        '<h4 class="shop-products-title">Products (' + products.length + ')</h4>' +
        // Same Trade-tab pattern: category sections + 3-col product cards.
        (function () {
          window._axShopModalProducts = products;
          if (!products.length) return '<p class="pd-muted">No active products listed.</p>';
          if (typeof buildProductCardHtml !== 'function') {
            return '<div class="shop-products-grid">' + products.map(function (p, i) {
              return '<div class="shop-product-mini" onclick="ProductModal.viewShopProduct(' + i + ')">' +
                (p.image_url ? '<img src="' + esc(p.image_url) + '" alt="">' : '<div class="shop-mini-ph"><i class="fa-solid fa-seedling"></i></div>') +
                '<div><strong>' + esc(p.product_name) + '</strong><br><small>₹' + (p.price_per_kg || '—') + '/kg</small></div>' +
                '<button type="button" class="shop-mini-buy-btn" onclick="event.stopPropagation();ProductModal.buyShopProduct(' + i + ')"><i class="fa-solid fa-bolt"></i> Buy</button>' +
              '</div>';
            }).join('') + '</div>';
          }
          // Group by category_name (same visual sections as Trade Hub).
          var groups = {};
          var order = [];
          products.forEach(function (p) {
            var key = (p.category_name || p.category_id || 'Other').trim() || 'Other';
            if (!groups[key]) { groups[key] = []; order.push(key); }
            groups[key].push(p);
          });
          var iconFn = (typeof categoryIconFor === 'function') ? categoryIconFor : function () { return 'fa-leaf'; };
          return order.map(function (cat) {
            var items = groups[cat];
            var icon = 'fa-solid ' + iconFn(cat);
            return '<section class="trade-section shop-cat-section">' +
              '<div class="trade-section-head"><span class="trade-section-title"><i class="' + icon + '"></i> ' + esc(cat) + '</span>' +
              '<small style="margin-left:auto;font-size:11.5px;font-weight:700;color:var(--c-text3)">' + items.length + '</small></div>' +
              '<div class="product-grid trade-sec-grid shop-trade-grid">' +
                items.map(function (p) {
                  var idx = products.indexOf(p);
                  return buildProductCardHtml(p, idx, 'shop');
                }).join('') +
              '</div></section>';
          }).join('');
        })() +
        '<div class="shop-reviews-block"><h4><i class="fa-solid fa-star"></i> Public Reviews</h4>' + reviewsHtml + '</div>' +
        '<div class="shop-feedback-form">' +
          '<h4>Rate This Shop</h4>' +
          '<div class="pd-reaction-bar">' +
            '<button type="button" class="pd-react-btn like" onclick="ProductModal.reactShop(\'' + esc(shopId).replace(/'/g, "\\'") + '\',\'like\')"><i class="fa-solid fa-thumbs-up"></i> <span id="shopLikeCount">' + (shop.reaction_likes != null ? shop.reaction_likes : (shop.likes || 0)) + '</span></button>' +
            '<button type="button" class="pd-react-btn dislike" onclick="ProductModal.reactShop(\'' + esc(shopId).replace(/'/g, "\\'") + '\',\'dislike\')"><i class="fa-solid fa-thumbs-down"></i> <span id="shopDislikeCount">' + (shop.dislikes || 0) + '</span></button>' +
          '</div>' +
          (getUser()
            ? '<h4 style="margin-top:16px">Private Message to Shop Owner</h4>' +
              '<p class="pd-muted">Only the shop owner sees this — not shown publicly.</p>' +
              '<textarea id="shopPrivateFeedback" rows="3" maxlength="400" style="width:100%;padding:10px;border-radius:10px;border:1px solid var(--c-border,#E4DBCA);font-family:inherit;font-size:13px" placeholder="Write your message…"></textarea>' +
              '<button type="button" class="pd-btn-primary" style="margin-top:8px" onclick="ProductModal.sendShopFeedback(\'' + esc(shopId).replace(/'/g, "\\'") + '\')"><i class="fa-solid fa-envelope"></i> Send Message</button>'
            : '<p class="pd-muted" style="margin-top:8px"><a href="portal.html" class="pd-link">Sign in</a> to send a private message.</p>') +
        '</div>';
    } catch (e) {
      console.error('[ShopProfile] load failed:', e);
      var errMsg = esc(String((e && e.message) || e));
      var sidSafe = esc(shopId).replace(/'/g, "\\'");
      body.innerHTML =
        '<p class="pd-muted">Could not load shop profile. Please try again.</p>' +
        '<p class="pd-muted" style="font-size:11px;margin-top:6px">Error: ' + errMsg + '</p>' +
        '<button type="button" class="pd-btn-primary" style="margin-top:14px" onclick="ProductModal.openShopProfile(\'' + sidSafe + '\')">' +
          '<i class="fa-solid fa-rotate-right"></i> Retry</button>';
    }
  }

  async function sendShopFeedback(shopId) {
    var user = getUser();
    var token = localStorage.getItem('ax_google_token');
    var msg = (document.getElementById('shopPrivateFeedback')?.value || '').trim();
    if (!msg) { toast('Please enter your feedback', 'error'); return; }
    if (!user) { toast('Sign in to send feedback', 'warning'); return; }
    try {
      var headers = { 'Content-Type': 'application/json' };
      if (token) headers.Authorization = 'Bearer ' + token;
      var res = await fetch(apiUrl('/shop/feedback'), {
        method: 'POST', headers: headers,
        body: JSON.stringify({ shop_id: shopId, message: msg })
      });
      var data = await res.json();
      if (data.success) {
        toast('Feedback sent to the shop owner', 'success');
        document.getElementById('shopPrivateFeedback').value = '';
      } else toast(data.error || 'Could not send feedback', 'error');
    } catch (e) { toast('Network error', 'error'); }
  }

  function closeShop() {
    document.getElementById('shopProfileModal')?.classList.remove('open');
    if (_lastFocusedEl && typeof _lastFocusedEl.focus === 'function') _lastFocusedEl.focus();
    _lastFocusedEl = null;
  }

  /* Buy button on a shop-profile product card — jumps straight into the
     order form (portal) or the product detail (public site, where the
     order form lives on portal.html). */
  var _shopProducts = [];
  function buyShopProduct(index) {
    var p = _shopProducts[index];
    if (!p) return;
    startShopBuy(p, _currentShopId);
  }

  /* Tap a shop-profile product card → open the full product detail modal
     (expanded view + reviews), same as the Trade tab. Opens the already
     loaded shop product object directly — openById() can't be used here
     because it looks the product up in the Trade tab's global `catalogue`,
     which does not contain shop-profile-fetched products (that was the bug:
     tapping a card silently did nothing). */
  function viewShopProduct(index) {
    var p = _shopProducts[index];
    if (!p) return;
    // Layer the product detail ON TOP of the shop (z-index bumped in openModal)
    // instead of closing the shop — so closing the product returns here.
    openModal(p);
  }

  function listingModifyAllowed(dateStr) {
    if (!dateStr) return false;
    return (Date.now() - new Date(dateStr).getTime()) < LISTING_MODIFY_MS;
  }

  var _lastFocusedEl = null;

  function init() {
    document.getElementById('productDetailModal')?.addEventListener('click', function (e) {
      if (e.target.id === 'productDetailModal') closeModal();
    });
    document.getElementById('shopProfileModal')?.addEventListener('click', function (e) {
      if (e.target.id === 'shopProfileModal') closeShop();
    });
    document.addEventListener('keydown', function (e) {
      if (e.key !== 'Escape') return;
      var pd = document.getElementById('productDetailModal');
      var sp = document.getElementById('shopProfileModal');
      if (sp && sp.classList.contains('open')) closeShop();
      else if (pd && pd.classList.contains('open')) closeModal();
    });
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }

  global.ProductModal = {
    openModal: openModal,
    openById: openById,
    closeModal: closeModal,
    orderViaPortal: orderViaPortal,
    buy: buy,
    current: function () { return selectedProduct; },
    addToCart: function (btn) {
      if (typeof window.axCartAdd === 'function' && selectedProduct) {
        window.axCartAdd(selectedProduct, { type: 'sample', qty: 1 });
        if (btn) { btn.classList.add('ax-cart-bounce'); setTimeout(function () { btn.classList.remove('ax-cart-bounce'); }, 400); }
      }
    },
    toggleDesc: toggleDesc,
    swipeScroll: function (track) {
      if (!track) return;
      // Pick the slide whose left edge is closest to the current scroll offset.
      // (Measuring offsets rather than dividing by width keeps the active dot
      // correct now that there's a gap between slides.)
      var slides = track.children, best = 0, bestDist = Infinity;
      for (var s = 0; s < slides.length; s++) {
        var dist = Math.abs(slides[s].offsetLeft - track.scrollLeft);
        if (dist < bestDist) { bestDist = dist; best = s; }
      }
      var dots = track.parentElement.querySelectorAll('.pd-swipe-dot');
      for (var d = 0; d < dots.length; d++) dots[d].classList.toggle('on', d === best);
    },
    setReviewStar: setReviewStar,
    submitReview: submitReview,
    openShopProfile: openShopProfile,
    closeShop: closeShop,
    buyShopProduct: buyShopProduct,
    startShopBuy: startShopBuy,
    currentShopId: function () { return _currentShopId; },
    viewShopProduct: viewShopProduct,
    reactShop: reactShop,
    sendShopFeedback: sendShopFeedback,
    searchShop: function (q) {
      var raw = (q || '').trim();
      if (/shop[-\s]?ax|^\d{4,5}$/i.test(raw)) {
        openShopProfile(normalizeShopId(raw));
        return true;
      }
      return false;
    },
    normalizeShopId: normalizeShopId,
    listingModifyAllowed: listingModifyAllowed,
    LISTING_MODIFY_MS: LISTING_MODIFY_MS
  };

  global.openProductModalById = openById;
  global.openProductModal = openModal;
  global.closeProductModal = closeModal;
})(typeof window !== 'undefined' ? window : this);
