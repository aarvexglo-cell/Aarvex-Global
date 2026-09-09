/* =====================================================================
   Aarvex Nova — demo interactions  ·  REAL DATA (no sample fallback)
   Live catalogue + shops from the same backend as the portal.
   ===================================================================== */
(function () {
  'use strict';

  var LAMBDA = window.LAMBDA_URL || 'https://j1yound90m.execute-api.ap-southeast-1.amazonaws.com';

  /* Feature-tour copy — real portal module descriptions (not data) */
  var FEATS = {
    trade: { badge: 'Trade module', title: 'Live Trade Hub', body: 'Browse live catalogue with stock, lot pricing, shop IDs, ratings, voice search, and favourites — the same grid after login.', bullets: ['Products | Shops mode switch', 'Category chips + live stock', 'Search by product or shop ID'], img: 'https://images.unsplash.com/photo-1597362925123-77861d3fbac7?auto=format&fit=crop&w=1400&q=75' },
    deal: { badge: 'Deals / RFQ', title: 'Negotiate price', body: 'When list price isn’t final, open a deal thread — structured negotiation instead of endless chat screenshots.', bullets: ['RFQ-style deal inbox', 'Buyer ↔ seller negotiation', 'Clear status on each deal'], img: 'https://images.unsplash.com/photo-1556742049-0cfed4f6a45d?auto=format&fit=crop&w=1400&q=75' },
    pay: { badge: 'Payments', title: 'Pay Online + COD', body: 'In-app Cashfree checkout for online orders and shop subscriptions, or Cash on Delivery when the deal needs it.', bullets: ['Cashfree modal checkout', 'COD option on orders', 'GST fields for B2B invoices'], img: 'https://images.unsplash.com/photo-1556742111-a301076d9d18?auto=format&fit=crop&w=1400&q=75' },
    track: { badge: 'Logistics', title: 'Track every consignment', body: 'Follow order status, delivery journey, and OTPs from the Track panel — visibility after the deal closes.', bullets: ['Order timeline', 'Delivery partner flow', 'Saved map addresses'], img: 'https://images.unsplash.com/photo-1586528116311-ad8dd3c8310d?auto=format&fit=crop&w=1400&q=75' },
    msg: { badge: 'Messaging', title: 'In-app messenger', body: 'Chat with shops without leaving Aarvex — alerts, threads, and optional voice/video call signaling.', bullets: ['Chats inside portal', 'Notification center', 'WhatsApp fallback support'], img: 'https://images.unsplash.com/photo-1516321318423-f06f85e504b3?auto=format&fit=crop&w=1400&q=75' },
    sell: { badge: 'Seller stack', title: 'KYC → Shop → Listings', body: 'Sellers complete KYC, subscribe, create a shop, publish products, and manage deals — optional delivery role.', bullets: ['Shop subscription (Cashfree)', 'Product listings & pause', 'Refer & Earn growth loop'], img: 'https://images.unsplash.com/photo-1500382017468-9049fed747ef?auto=format&fit=crop&w=1400&q=75' }
  };

  var MODS = {
    Home: 'Dashboard with banners, people search, order stats, and GST readiness — your command center after login.',
    Trade: 'Live catalogue, Products|Shops, voice search, category grid, and order checkout.',
    Favourites: 'Saved products and followed shops — quick re-order path.',
    Sell: 'List produce intent / seller onboarding entry from the Trade sell mode.',
    Shop: 'Create and manage your agro shop after KYC + subscription.',
    Track: 'Shipment status, journey strip, and delivery OTPs.',
    Deals: 'Negotiation inbox (RFQ) between buyers and sellers.',
    Refer: 'Invite network and earn through the referral program.',
    Messages: 'In-app messenger for shop conversations.',
    Alerts: 'Orders, KYC, reviews, and admin notifications.',
    Profile: 'Personal info, KYC, and address book for faster checkout.',
    Delivery: 'Delivery-partner dashboard for claiming and completing runs.'
  };

  var MOD_ICON = {
    Home: 'fa-house', Trade: 'fa-bag-shopping', Favourites: 'fa-heart', Sell: 'fa-wheat-awn',
    Shop: 'fa-store', Track: 'fa-location-crosshairs', Deals: 'fa-handshake', Refer: 'fa-gift',
    Messages: 'fa-comments', Alerts: 'fa-bell', Profile: 'fa-user', Delivery: 'fa-truck'
  };

  var state = {
    products: [], shops: [], shopMap: {}, cat: 'All', q: '', mode: 'products',
    status: 'loading', shopStatus: 'loading', spot: 0, spotTimer: null, soft: false
  };

  function $(id) { return document.getElementById(id); }
  function esc(s) { return String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/"/g, '&quot;'); }

  /* Product "shop_name" from catalogue is the shop_id (e.g. SHOP-AX-00001).
     Resolve the friendly name from the /shops/top map when available. */
  function shopName(p) {
    if (!p) return 'Verified shop';
    var byId = p.shop_id && state.shopMap[p.shop_id];
    if (byId) return byId;
    var n = p.shop_name || '';
    if (/^SHOP[-_]/i.test(n) || !n) return 'Verified shop';
    return n;
  }
  function activeProducts() { return state.products.filter(function (p) { return !p.is_paused; }); }

  function detectSoft() {
    var reduce = false;
    try { reduce = window.matchMedia('(prefers-reduced-motion: reduce)').matches; } catch (e) { }
    var saveData = false;
    try { saveData = !!(navigator.connection && navigator.connection.saveData); } catch (e) { }
    state.soft = reduce || saveData || window.innerWidth < 700;
    return state.soft;
  }

  function observe() {
    var nodes = document.querySelectorAll('.nx-reveal:not(.in), .nx-reveal-clip:not(.in), .nx-card:not(.in), .nx-shop:not(.in)');
    if (!('IntersectionObserver' in window)) { nodes.forEach(function (n) { n.classList.add('in'); }); return; }
    var io = new IntersectionObserver(function (entries) {
      entries.forEach(function (e) {
        if (!e.isIntersecting) return;
        var el = e.target;
        if (!el._nxStag) {
          el._nxStag = true;
          var p = el.parentElement;
          if (p) {
            var sibs = 0, mine = 0, i, ch = p.children;
            for (i = 0; i < ch.length; i++) {
              var c = ch[i], cl = c.classList;
              if (cl && (cl.contains('nx-reveal') || cl.contains('nx-reveal-clip') || cl.contains('nx-card') || cl.contains('nx-shop'))) {
                if (c === el) mine = sibs;
                sibs++;
              }
            }
            if (sibs > 1 && mine > 0) el.style.setProperty('--reveal-delay', Math.min(mine, 6) * 70 + 'ms');
          }
        }
        el.classList.add('in'); io.unobserve(el);
        /* Clip-reveal children (headings, step/feature photos) report an
           intersectionRatio of 0 while clipped, so they can't be observed
           reliably on their own. Reveal them together with the reliably-tracked
           container they live in. */
        var clipKids = el.querySelectorAll('.nx-reveal-clip:not(.in)');
        for (var q = 0; q < clipKids.length; q++) clipKids[q].classList.add('in');
      });
      /* threshold 0 (not 0.12): clip-reveal elements start with
         clip-path:inset(0 0 100%), which makes their intersectionRatio 0 in
         Chromium — so a 0.12 threshold never fires and the heading/photo stays
         clipped forever. Firing on isIntersecting (ratio 0 is enough) reveals
         them; rootMargin keeps the trigger gentle for the opacity reveals. */
    }, { threshold: 0, rootMargin: '0px 0px -40px 0px' });
    nodes.forEach(function (n) { io.observe(n); });
  }

  function animateCount(el, to) {
    if (!el) return;
    var target = parseInt(to, 10);
    if (isNaN(target)) { el.textContent = String(to); return; }
    if (el.dataset.animated === '1') { el.textContent = String(target); return; }
    el.dataset.animated = '1';
    if (state.soft) { el.textContent = String(target); return; }
    var t0 = null, dur = 1100;
    function frame(ts) {
      if (!t0) t0 = ts;
      var p = Math.min(1, (ts - t0) / dur);
      var eased = 1 - Math.pow(1 - p, 3);
      el.textContent = String(Math.round(target * eased));
      if (p < 1) requestAnimationFrame(frame);
    }
    requestAnimationFrame(frame);
  }
  function runProofCounts() {
    var root = $('nxProof');
    if (!root) return;
    root.querySelectorAll('.nx-proof-num[data-count]').forEach(function (el) {
      var n = el.getAttribute('data-count');
      if (n && n !== '0') animateCount(el, n);
    });
  }

  /* ── Market ── */
  function filtered() {
    var list = activeProducts();
    if (state.cat && state.cat !== 'All') list = list.filter(function (p) { return p.category_name === state.cat; });
    var q = state.q.trim().toLowerCase();
    if (q) list = list.filter(function (p) { return [p.product_name, p.category_name, shopName(p), p.description].join(' ').toLowerCase().indexOf(q) !== -1; });
    return list;
  }
  function renderCats() {
    var cats = ['All'];
    activeProducts().forEach(function (p) { if (p.category_name && cats.indexOf(p.category_name) === -1) cats.push(p.category_name); });
    var el = $('nxCats');
    if (!el) return;
    el.innerHTML = cats.map(function (c) {
      return '<button type="button" class="nx-cat' + (c === state.cat ? ' on' : '') + '" data-cat="' + esc(c) + '">' + esc(c) + '</button>';
    }).join('');
  }
  function priceHTML(p) {
    if (p.price_per_kg == null || p.price_per_kg === '') return '<small>Contact for price</small>';
    var html = '₹' + esc(p.price_per_kg) + '<small>/kg</small>';
    if (p.discount_percent > 0 && p.mrp_price_per_kg) html += ' <s>₹' + esc(p.mrp_price_per_kg) + '</s>';
    return html;
  }
  function fact(label, value, icon) {
    return '<div class="nx-pm-fact"><i class="fa-solid ' + icon + '"></i><div><b>' + esc(value) + '</b><span>' + esc(label) + '</span></div></div>';
  }
  function openProductDetails(product) {
    var dialog = $('nxProductDialog');
    if (!dialog || !product) return;
    var id = encodeURIComponent(product.product_id || '');
    var image = product.image_url && String(product.image_url).length > 10 ? String(product.image_url) : '';

    var media = $('nxProductDialogMedia');
    if (media) {
      media.style.backgroundImage = image ? 'url("' + image.replace(/"/g, '%22') + '")' : '';
      media.classList.toggle('is-empty', !image);
    }
    var off = $('nxProductDialogOff');
    if (off) { var has = product.discount_percent > 0; off.hidden = !has; off.textContent = has ? '-' + product.discount_percent + '%' : ''; }
    var rate = $('nxProductDialogRate');
    if (rate) { var hr = product.total_reviews > 0; rate.hidden = !hr; rate.innerHTML = hr ? '<i class="fa-solid fa-star"></i> ' + esc(product.avg_rating) + ' (' + esc(product.total_reviews) + ')' : ''; }

    var title = $('nxProductDialogTitle'); if (title) title.textContent = product.product_name || 'Product';
    var cat = $('nxProductDialogCat'); if (cat) cat.textContent = product.category_name || 'Produce';
    var shop = $('nxProductDialogShop'); if (shop) shop.innerHTML = '<i class="fa-solid fa-store"></i> ' + esc(shopName(product)) + ' · <span class="nx-pm-verified"><i class="fa-solid fa-circle-check"></i> KYC verified</span>';

    var price = $('nxProductDialogPrice');
    if (price) {
      var main = (product.price_per_kg != null && product.price_per_kg !== '')
        ? '<b>₹' + esc(product.price_per_kg) + '</b><small>/kg</small>' : '<b>Contact</b>';
      var strike = (product.discount_percent > 0 && product.mrp_price_per_kg) ? '<s>₹' + esc(product.mrp_price_per_kg) + '</s>' : '';
      var lot = product.lot_price ? '<span class="nx-pm-lot">Lot: ₹' + esc(product.lot_price) + (product.lot_size_kg ? ' / ' + esc(product.lot_size_kg) + ' kg' : '') + '</span>' : '';
      price.innerHTML = '<div class="nx-pm-price-main">' + main + ' ' + strike + '</div>' + lot;
    }

    var desc = $('nxProductDialogDescription');
    if (desc) desc.textContent = product.description || 'Live listing from the Aarvex certified catalogue — buy, negotiate, pay and track inside the portal.';

    var facts = $('nxProductDialogFacts');
    if (facts) {
      var f = [];
      f.push(fact('Available', product.available_stock || (product.available_stock_kg != null ? product.available_stock_kg + ' kg' : 'In stock'), 'fa-boxes-stacked'));
      if (product.min_order_kg) f.push(fact('Min order', product.min_order_kg + ' kg', 'fa-weight-hanging'));
      if (product.lot_size_kg) f.push(fact('Lot size', product.lot_size_kg + ' kg', 'fa-pallet'));
      f.push(fact('Payment', 'COD + Online', 'fa-credit-card'));
      facts.innerHTML = f.join('');
    }

    var portal = $('nxProductDialogPortal'); if (portal) portal.href = 'portal.html?product=' + id;
    var deal = $('nxProductDialogDeal'); if (deal) deal.href = 'portal.html?product=' + id + '&action=deal';
    var chat = $('nxProductDialogChat'); if (chat) chat.href = 'portal.html?shop=' + encodeURIComponent(product.shop_id || '') + '&action=chat';
    var fav = $('nxProductDialogFav');
    if (fav) {
      fav.classList.remove('on');
      fav.innerHTML = '<i class="fa-regular fa-heart"></i>';
      fav.onclick = function () {
        var on = fav.classList.toggle('on');
        fav.innerHTML = '<i class="fa-' + (on ? 'solid' : 'regular') + ' fa-heart"></i>';
      };
    }

    dialog.hidden = false;
    // retrigger entrance animation
    dialog.classList.remove('is-open'); void dialog.offsetWidth; dialog.classList.add('is-open');
    document.body.classList.add('nx-dialog-open');
    var closeBtn = dialog.querySelector('.nx-product-dialog-close'); if (closeBtn) closeBtn.focus();
  }
  function closeProductDetails() {
    var dialog = $('nxProductDialog');
    if (!dialog || dialog.hidden) return;
    dialog.classList.remove('is-open');
    dialog.hidden = true;
    document.body.classList.remove('nx-dialog-open');
  }
  function renderGrid() {
    var grid = $('nxGrid'), live = $('nxLive'), stat = $('nxStatProducts');
    if (!grid) return;

    if (state.status === 'loading') { skeletons(); if (live) live.innerHTML = '<span class="nx-dot"></span> Loading live catalogue…'; return; }
    if (state.status === 'error') {
      grid.innerHTML = '<div class="nx-empty nx-empty-err"><i class="fa-solid fa-triangle-exclamation"></i>'
        + '<p>Couldn’t reach the live catalogue right now.</p>'
        + '<button type="button" class="nx-btn nx-btn-line" id="nxRetry"><i class="fa-solid fa-rotate"></i> Retry</button></div>';
      if (live) live.innerHTML = '<span class="nx-dot nx-dot-off"></span> Offline · live data unavailable';
      if (stat) stat.textContent = '—';
      var rb = $('nxRetry'); if (rb) rb.addEventListener('click', function () { loadCatalogue(); loadShops(); });
      return;
    }

    var list = filtered();
    var total = activeProducts().length;
    if (stat) { stat.setAttribute('data-count', String(total)); stat.dataset.animated = ''; animateCount(stat, total); }
    if (live) live.innerHTML = '<span class="nx-dot"></span> Live · <b style="color:var(--accent-text)">' + list.length + '</b> of ' + total + ' products';

    if (!list.length) { grid.innerHTML = '<div class="nx-empty">No products match — try another filter or search.</div>'; return; }

    grid.innerHTML = list.map(function (p, i) {
      var img = p.image_url && String(p.image_url).length > 10;
      var off = p.discount_percent > 0 ? '<span class="nx-card-off">-' + esc(p.discount_percent) + '%</span>' : '';
      var rate = p.total_reviews > 0 ? '<span class="nx-card-rate"><i class="fa-solid fa-star"></i> ' + esc(p.avg_rating) + '</span>' : '';
      return '<article class="nx-card" data-id="' + esc(p.product_id || i) + '">' +
        '<div class="nx-card-media">' + off + rate +
        (img ? '<img src="' + esc(p.image_url) + '" alt="' + esc(p.product_name) + '" loading="lazy" onerror="this.style.display=\'none\';this.nextElementSibling.style.display=\'grid\'">' : '') +
        '<div class="nx-card-ph" style="' + (img ? 'display:none' : '') + '"><i class="fa-solid fa-leaf"></i></div>' +
        '</div>' +
        '<div class="nx-card-body">' +
        '<div class="nx-card-cat">' + esc(p.category_name || 'Produce') + '</div>' +
        '<div class="nx-card-name">' + esc(p.product_name) + '</div>' +
        '<div class="nx-card-shop"><i class="fa-solid fa-store"></i> ' + esc(shopName(p)) + '</div>' +
        '<div class="nx-card-row"><div class="nx-card-price">' + priceHTML(p) + '</div>' +
        '<span class="nx-card-stock">' + esc(p.available_stock || 'In Stock') + '</span></div>' +
        '<button class="nx-btn nx-btn-line nx-btn-sm nx-card-detail" type="button">View details</button>' +
        '</div></article>';
    }).join('');
    observe();
    grid.querySelectorAll('.nx-card').forEach(function (card) {
      card.addEventListener('click', function () {
        var product = state.products.find(function (item) { return String(item.product_id) === String(card.getAttribute('data-id')); });
        openProductDetails(product);
      });
    });
    renderSpotlight();
    fillHeroCards();
  }

  document.addEventListener('click', function (event) {
    var close = event.target.closest && event.target.closest('[data-product-close]');
    if (close) closeProductDetails();
  });
  document.addEventListener('keydown', function (event) {
    if (event.key === 'Escape') closeProductDetails();
  });

  function renderShops() {
    var el = $('nxShops');
    if (!el) return;
    if (state.shopStatus === 'loading') { el.innerHTML = Array(3).fill('<div class="nx-skel nx-skel-shop"></div>').join(''); return; }
    if (!state.shops.length) {
      el.innerHTML = '<div class="nx-empty">' + (state.shopStatus === 'error' ? 'Couldn’t load shops right now.' : 'No verified shops listed yet.') + '</div>';
      return;
    }
    el.innerHTML = state.shops.slice(0, 9).map(function (s, i) {
      var name = s.shop_name || s.shop_id || 'Shop';
      var count = (s.product_count != null) ? s.product_count : '—';
      var img = s.shop_logo_url || s.logo_url || '';
      var rating = s.total_reviews > 0 ? (' · ★ ' + s.avg_rating) : (s.like_count ? (' · ♥ ' + s.like_count) : '');
      return '<a class="nx-shop" href="portal.html?shop=' + encodeURIComponent(s.shop_id || '') + '" style="transition-delay:' + (i * 0.04) + 's">' +
        '<div class="nx-shop-av">' + (img ? '<img src="' + esc(img) + '" alt="" onerror="this.remove()">' : esc(String(name).charAt(0).toUpperCase())) + '</div>' +
        '<div><div class="nx-shop-name">' + esc(name) + '</div>' +
        '<div class="nx-shop-meta">' + esc(String(count)) + ' products · Verified' + esc(rating) + '</div></div></a>';
    }).join('');
    observe();
  }

  function skeletons() { var g = $('nxGrid'); if (g) g.innerHTML = Array(8).fill('<div class="nx-skel"></div>').join(''); }

  async function loadCatalogue() {
    state.status = 'loading';
    renderGrid();
    try {
      var res = await fetch(LAMBDA + '/catalogue', { headers: { Accept: 'application/json' }, signal: AbortSignal.timeout ? AbortSignal.timeout(15000) : undefined });
      if (!res.ok) throw new Error('HTTP ' + res.status);
      var data = await res.json();
      state.products = data.products || data.items || [];
      state.status = 'ok';
    } catch (e) {
      state.products = [];
      state.status = 'error';
    }
    renderCats();
    renderGrid();
  }

  async function loadShops() {
    state.shopStatus = 'loading';
    renderShops();
    try {
      var res = await fetch(LAMBDA + '/shops/top', { headers: { Accept: 'application/json' }, signal: AbortSignal.timeout ? AbortSignal.timeout(12000) : undefined });
      if (!res.ok) throw new Error('HTTP ' + res.status);
      var data = await res.json();
      state.shops = data.shops || data.items || data.top_shops || [];
      state.shopMap = {};
      state.shops.forEach(function (s) { if (s.shop_id && s.shop_name) state.shopMap[s.shop_id] = s.shop_name; });
      state.shopStatus = 'ok';
    } catch (e) {
      state.shops = [];
      state.shopStatus = 'error';
    }
    renderShops();
    // refresh friendly shop names now that the map exists
    if (state.status === 'ok') { renderGrid(); }
  }

  function setMode(mode) {
    state.mode = mode;
    document.querySelectorAll('.nx-mode').forEach(function (b) { b.classList.toggle('on', b.getAttribute('data-mode') === mode); });
    var pp = $('nxProductsPane'), sp = $('nxShopsPane');
    if (pp) pp.hidden = mode !== 'products';
    if (sp) sp.hidden = mode !== 'shops';
  }

  /* ── Theater ── */
  var _axActiveFeat = 'trade';
  // Curated translation lookup (demo.th.<key>.<field>) so the theater copy
  // switches with the site language instead of staying English.
  function _txFeat(key, field, en) {
    return (typeof window.t === 'function') ? window.t('demo.th.' + key + '.' + field, en) : en;
  }
  function showFeat(key) {
    _axActiveFeat = key;
    var f = FEATS[key] || FEATS.trade;
    document.querySelectorAll('.nx-ttab').forEach(function (b) { b.classList.toggle('on', b.getAttribute('data-feat') === key); });
    var vis = $('nxTheaterVisual');
    /* Layer the photo over the brand gradient so a slow/failed image keeps a
       branded panel instead of an empty box. */
    if (vis) vis.style.backgroundImage = 'url("' + f.img + '"), var(--grad-media)';
    if ($('nxTheaterBadge')) $('nxTheaterBadge').textContent = _txFeat(key, 'badge', f.badge);
    if ($('nxTheaterTitle')) $('nxTheaterTitle').textContent = _txFeat(key, 'title', f.title);
    if ($('nxTheaterBody')) $('nxTheaterBody').textContent = _txFeat(key, 'body', f.body);
    var ul = $('nxTheaterBullets');
    if (ul) ul.innerHTML = f.bullets.map(function (x, i) { return '<li>' + esc(_txFeat(key, 'b' + i, x)) + '</li>'; }).join('');
  }
  // Re-render the active theater panel when the language changes.
  document.addEventListener('ax:lang-changed', function () { showFeat(_axActiveFeat); });

  /* ── Spotlight (real products with images) ── */
  function spotList() {
    return activeProducts().filter(function (p) { return p.image_url && String(p.image_url).length > 10; }).slice(0, 6);
  }
  function renderSpotlight() {
    var list = spotList();
    var stage = $('spotlight');
    if (!list.length) {
      if ($('nxSpotName')) $('nxSpotName').textContent = state.status === 'error' ? 'Live catalogue unavailable' : 'Loading live products…';
      if ($('nxSpotMeta')) $('nxSpotMeta').textContent = '';
      if ($('nxSpotCat')) $('nxSpotCat').textContent = '';
      if ($('nxSpotPrice')) $('nxSpotPrice').innerHTML = '';
      if ($('nxSpotDots')) $('nxSpotDots').innerHTML = '';
      return;
    }
    if (state.spot >= list.length) state.spot = 0;
    var p = list[state.spot];
    var media = $('nxSpotMedia');
    if (media) {
      media.style.opacity = '0.55';
      setTimeout(function () { media.style.backgroundImage = 'url("' + (p.image_url || '') + '"), var(--grad-media)'; media.style.opacity = '1'; }, 120);
    }
    if ($('nxSpotCat')) $('nxSpotCat').textContent = p.category_name || 'Produce';
    if ($('nxSpotName')) $('nxSpotName').textContent = p.product_name || '';
    if ($('nxSpotMeta')) $('nxSpotMeta').textContent = shopName(p) + ' · ' + (p.available_stock || 'In Stock');
    if ($('nxSpotPrice')) $('nxSpotPrice').innerHTML = priceHTML(p);
    if ($('nxSpotCta')) $('nxSpotCta').href = 'portal.html?product=' + encodeURIComponent(p.product_id || '');
    var dots = $('nxSpotDots');
    if (dots) dots.innerHTML = list.map(function (_, i) { return '<button type="button" class="' + (i === state.spot ? 'on' : '') + '" data-i="' + i + '" aria-label="Slide ' + (i + 1) + '"></button>'; }).join('');
    resetSpotBar();
  }
  function resetSpotBar() {
    var bar = $('nxSpotBar');
    if (!bar) return;
    var i = bar.querySelector('i');
    if (!i) return;
    i.style.transition = 'none'; i.style.width = '0%';
    if (state.soft) return;
    void i.offsetWidth;
    i.style.transition = 'width 5s linear'; i.style.width = '100%';
  }
  function spotNext(dir) { var list = spotList(); var n = list.length || 1; state.spot = (state.spot + (dir || 1) + n) % n; renderSpotlight(); }
  function startSpotAuto() { clearInterval(state.spotTimer); if (state.soft || spotList().length < 2) return; state.spotTimer = setInterval(function () { spotNext(1); }, 5000); }

  /* ── Hero floating cards → real data ── */
  function fillHeroCards() {
    var cards = document.querySelectorAll('.nx-hero-art .nx-orb-card');
    if (!cards.length) return;
    var list = activeProducts();
    var withImg = list.filter(function (p) { return p.image_url; });
    var p0 = withImg[0] || list[0];
    var p1 = withImg[1] || list[1];
    var s0 = state.shops[0];
    if (p0 && cards[0]) {
      cards[0].querySelector('b').textContent = p0.category_name || 'Fresh Produce';
      cards[0].querySelector('span').textContent = p0.available_stock || 'Live stock';
    }
    if (p1 && cards[1]) {
      cards[1].querySelector('b').textContent = p1.product_name;
      cards[1].querySelector('span').innerHTML = (p1.price_per_kg != null ? '₹' + esc(p1.price_per_kg) + ' <small>/kg</small>' : 'Verified shop');
    }
    if (cards[2]) {
      cards[2].querySelector('b').textContent = s0 ? (s0.shop_name || 'Verified shop') : 'KYC verified';
      cards[2].querySelector('span').textContent = s0 && s0.product_count != null ? (s0.product_count + ' products · verified') : 'KYC verified shop';
    }
  }

  /* ── Portal stack ── */
  function showMod(name) {
    document.querySelectorAll('.nx-mod').forEach(function (b) { b.classList.toggle('on', b.getAttribute('data-mod') === name); });
    if ($('nxModTitle')) $('nxModTitle').textContent = name;
    if ($('nxModBody')) $('nxModBody').textContent = MODS[name] || '';
    var core = document.querySelector('.nx-stack-core-ico i');
    if (core) core.className = 'fa-solid ' + (MOD_ICON[name] || 'fa-house');
  }

  /* ── Theme toggle ── */
  function initTheme() {
    var saved = null;
    try { saved = localStorage.getItem('nx-theme'); } catch (e) { }
    if (saved) document.documentElement.setAttribute('data-theme', saved);
    syncThemeIcon();
    var btn = $('nxTheme');
    if (btn) btn.addEventListener('click', function () {
      var cur = document.documentElement.getAttribute('data-theme') === 'dark' ? 'light' : 'dark';
      document.documentElement.setAttribute('data-theme', cur);
      try { localStorage.setItem('nx-theme', cur); } catch (e) { }
      syncThemeIcon();
    });
  }
  function syncThemeIcon() {
    var btn = $('nxTheme');
    if (!btn) return;
    var dark = document.documentElement.getAttribute('data-theme') === 'dark';
    btn.innerHTML = '<i class="fa-solid ' + (dark ? 'fa-moon' : 'fa-sun') + '"></i>';
  }

  /* ── Magnetic buttons ── */
  /* Phase 3: magnetic buttons — the button eases toward the cursor (lerp) and
     snaps back on leave. Applied to tagged magnets + all large CTAs. */
  function initMagnet() {
    if (detectSoft()) return;
    try { if (window.matchMedia('(pointer: coarse)').matches) return; } catch (e) { }
    document.querySelectorAll('.nx-magnet, .nx-btn-lg').forEach(function (el) {
      var cx = 0, cy = 0, tx = 0, ty = 0, raf = null;
      function loop() {
        cx += (tx - cx) * 0.18; cy += (ty - cy) * 0.18;
        if (tx === 0 && ty === 0 && Math.abs(cx) < 0.15 && Math.abs(cy) < 0.15) { el.style.transform = ''; raf = null; return; }
        el.style.transform = 'translate(' + cx.toFixed(2) + 'px,' + cy.toFixed(2) + 'px)';
        raf = requestAnimationFrame(loop);
      }
      function kick() { if (!raf) raf = requestAnimationFrame(loop); }
      el.addEventListener('pointermove', function (e) {
        var r = el.getBoundingClientRect();
        tx = (e.clientX - r.left - r.width / 2) * 0.3;
        ty = (e.clientY - r.top - r.height / 2) * 0.45;
        kick();
      });
      el.addEventListener('pointerleave', function () { tx = 0; ty = 0; kick(); });
    });
  }

  /* ── Card tilt (hero art) ── */
  function initTilt() {
    if (detectSoft()) return;
    document.querySelectorAll('.nx-tilt').forEach(function (el) {
      el.addEventListener('pointermove', function (e) {
        var r = el.getBoundingClientRect();
        var rx = ((e.clientY - r.top) / r.height - 0.5) * -12;
        var ry = ((e.clientX - r.left) / r.width - 0.5) * 12;
        el.style.transform = 'perspective(600px) rotateX(' + rx + 'deg) rotateY(' + ry + 'deg)';
      });
      el.addEventListener('pointerleave', function () { el.style.transform = ''; });
    });
  }

  /* ── Chrome: nav shrink, progress, dots ── */
  function bindChrome() {
    var nav = $('nxNav'), progress = $('nxProgress'), progressI = progress && progress.querySelector('i');
    var ids = ['top', 'how', 'theater', 'spotlight', 'market', 'roles', 'trust'];
    var links = document.querySelectorAll('#nxDots a');
    function onScroll() {
      var y = window.scrollY || 0;
      if (nav) nav.classList.toggle('on', y > 16);
      if (progressI) {
        var max = document.documentElement.scrollHeight - window.innerHeight;
        progressI.style.width = (max > 0 ? (y / max) * 100 : 0) + '%';
      }
      var mid = y + window.innerHeight * 0.35, active = 'top';
      ids.forEach(function (id) {
        var el = id === 'top' ? nav : document.getElementById(id);
        if (el && el.offsetTop <= mid) active = id;
      });
      links.forEach(function (a) { a.classList.toggle('on', a.getAttribute('data-dot') === active); });
    }
    window.addEventListener('scroll', onScroll, { passive: true });
    onScroll();
  }

  function bindDrawer() {
    var menu = $('nxMenu'), drawer = $('nxDrawer');
    if (!menu || !drawer) return;
    menu.addEventListener('click', function () {
      var open = drawer.classList.toggle('open');
      menu.classList.toggle('open', open);
      document.body.style.overflow = open ? 'hidden' : '';
    });
    drawer.querySelectorAll('a').forEach(function (a) {
      a.addEventListener('click', function () { drawer.classList.remove('open'); menu.classList.remove('open'); document.body.style.overflow = ''; });
    });
  }

  /* Smart auth entry — landing page reads the portal's saved session (ax_user)
     and reflects it in the header icon + drawer button. Signed in → avatar (photo
     if set, else initials) that links straight to the portal (which lands the
     user on their account). Signed out → a plain "Login". No two-button pair. */
  function axNovaAuth() {
    var user = null;
    try { user = JSON.parse(localStorage.getItem('ax_user') || 'null'); } catch (e) { user = null; }
    var headBtn = $('nxAuthBtn');
    var drawerBtn = $('nxDrawerAuth');

    function photoFor(u) {
      var p = (u && u.picture) || '';
      if (u && u.sub) {
        try {
          var pr = JSON.parse(localStorage.getItem('ax_profile_' + u.sub) || 'null');
          if (pr && pr.custom_photo) p = pr.custom_photo;
        } catch (e) { /* ignore */ }
      }
      return p;
    }
    function initialsOf(name) {
      if (!name) return 'U';
      var parts = String(name).trim().split(/\s+/).filter(Boolean);
      var a = (parts[0] || '')[0] || '';
      var b = parts.length > 1 ? (parts[parts.length - 1][0] || '') : '';
      return (a + b).toUpperCase() || 'U';
    }
    function esc(s) {
      return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
        return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
      });
    }
    function avatarHTML(u) {
      var photo = photoFor(u);
      return photo
        ? '<img src="' + esc(photo) + '" alt="" class="nx-auth-photo">'
        : '<span class="nx-auth-initials">' + esc(initialsOf(u && u.name)) + '</span>';
    }

    if (user) {
      var av = avatarHTML(user);
      var nm = user.name || 'Your account';
      if (headBtn) {
        headBtn.classList.add('nx-auth-in');
        headBtn.setAttribute('aria-label', 'Open your portal — ' + nm);
        headBtn.setAttribute('title', nm);
        headBtn.innerHTML = av;
      }
      if (drawerBtn) {
        drawerBtn.className = 'nx-drawer-auth';
        drawerBtn.innerHTML =
          '<span class="nx-da-av">' + av + '</span>' +
          '<span class="nx-da-txt"><b>' + esc(nm) + '</b><small>Open your portal</small></span>' +
          '<i class="fa-solid fa-arrow-right nx-da-arrow" aria-hidden="true"></i>';
      }
    } else {
      if (headBtn) {
        headBtn.classList.remove('nx-auth-in');
        headBtn.setAttribute('aria-label', 'Login');
        headBtn.setAttribute('title', 'Login');
        headBtn.innerHTML = '<i class="fa-solid fa-right-to-bracket" aria-hidden="true"></i>';
      }
      if (drawerBtn) {
        drawerBtn.className = 'nx-btn nx-btn-solid nx-drawer-btn';
        drawerBtn.innerHTML = '<i class="fa-solid fa-right-to-bracket"></i> Login';
      }
    }
  }

  function bindTouchCinema() {
    var stage = $('nxCinema');
    if (!stage) return;
    var x0 = 0;
    stage.addEventListener('touchstart', function (e) { x0 = e.changedTouches[0].clientX; }, { passive: true });
    stage.addEventListener('touchend', function (e) {
      var dx = e.changedTouches[0].clientX - x0;
      if (Math.abs(dx) < 40) return;
      spotNext(dx < 0 ? 1 : -1); startSpotAuto();
    }, { passive: true });
  }

  function bindLangDropdown() {
    function closeAll(except) {
      document.querySelectorAll('.ax-lang-dd.open').forEach(function (dd) {
        if (dd === except) return;
        dd.classList.remove('open');
        var b = dd.querySelector('.ax-lang-dd-btn'), m = dd.querySelector('.ax-lang-dd-menu');
        if (b) b.setAttribute('aria-expanded', 'false');
        if (m) m.hidden = true;
      });
    }
    document.querySelectorAll('.ax-lang-dd .ax-lang-dd-btn').forEach(function (btn) {
      btn.addEventListener('click', function (e) {
        e.stopPropagation();
        var dd = btn.closest('.ax-lang-dd'), menu = dd.querySelector('.ax-lang-dd-menu');
        var willOpen = !dd.classList.contains('open');
        closeAll(dd);
        dd.classList.toggle('open', willOpen);
        btn.setAttribute('aria-expanded', willOpen ? 'true' : 'false');
        if (menu) menu.hidden = !willOpen;
      });
    });
    document.addEventListener('click', function () { closeAll(null); });
    document.addEventListener('keydown', function (e) { if (e.key === 'Escape') closeAll(null); });
  }

  function bind() {
    detectSoft();
    initTheme();
    bindDrawer();
    axNovaAuth();
    bindChrome();
    bindTouchCinema();
    bindLangDropdown();
    initMagnet();
    initTilt();

    var t, search = $('nxSearch');
    if (search) search.addEventListener('input', function () { state.q = search.value; clearTimeout(t); t = setTimeout(renderGrid, 200); });

    document.addEventListener('click', function (e) {
      var cat = e.target.closest('.nx-cat');
      if (cat) { state.cat = cat.getAttribute('data-cat') || 'All'; renderCats(); renderGrid(); }
      var mode = e.target.closest('.nx-mode');
      if (mode) setMode(mode.getAttribute('data-mode') || 'products');
      var tab = e.target.closest('.nx-ttab');
      if (tab) showFeat(tab.getAttribute('data-feat') || 'trade');
      var mod = e.target.closest('.nx-mod');
      if (mod) showMod(mod.getAttribute('data-mod') || 'Home');
      var dot = e.target.closest('#nxSpotDots button');
      if (dot) { state.spot = parseInt(dot.getAttribute('data-i'), 10) || 0; renderSpotlight(); startSpotAuto(); }
    });

    var refresh = $('nxRefresh');
    if (refresh) refresh.addEventListener('click', function () { loadCatalogue().then(startSpotAuto); loadShops(); });

    if ($('nxSpotPrev')) $('nxSpotPrev').addEventListener('click', function () { spotNext(-1); startSpotAuto(); });
    if ($('nxSpotNext')) $('nxSpotNext').addEventListener('click', function () { spotNext(1); startSpotAuto(); });

    var cinema = $('nxCinema');
    if (cinema) {
      cinema.addEventListener('mouseenter', function () { clearInterval(state.spotTimer); });
      cinema.addEventListener('mouseleave', startSpotAuto);
    }

    document.querySelectorAll('.nx-mod').forEach(function (b) {
      b.addEventListener('mouseenter', function () { if (!state.soft) showMod(b.getAttribute('data-mod') || 'Home'); });
    });

    if ('IntersectionObserver' in window && $('nxProof')) {
      var pio = new IntersectionObserver(function (entries) {
        entries.forEach(function (en) { if (en.isIntersecting) { runProofCounts(); pio.disconnect(); } });
      }, { threshold: 0.35 });
      pio.observe($('nxProof'));
    }

    window.addEventListener('resize', detectSoft);

    observe();
    showFeat('trade');
    showMod('Home');

    var y = $('nxYear');
    if (y) y.textContent = new Date().getFullYear();
  }

  /* FAQ accordion (new section) — one-open-at-a-time */
  function initFaq() {
    var items = document.querySelectorAll('.nx-faq-item');
    items.forEach(function (it) {
      var q = it.querySelector('.nx-faq-q');
      if (!q) return;
      q.addEventListener('click', function () {
        var isOpen = it.classList.contains('open');
        items.forEach(function (o) { o.classList.remove('open'); var b = o.querySelector('.nx-faq-q'); if (b) b.setAttribute('aria-expanded', 'false'); });
        if (!isOpen) { it.classList.add('open'); q.setAttribute('aria-expanded', 'true'); }
      });
    });
  }

  /* Contact form → opens the user's mail client (no server / no credential capture) */
  function initContact() {
    var form = $('nxContactForm');
    if (!form) return;
    form.addEventListener('submit', function (e) {
      e.preventDefault();
      var name = (($('nxCfName') || {}).value || '').trim();
      var email = (($('nxCfEmail') || {}).value || '').trim();
      var msg = (($('nxCfMsg') || {}).value || '').trim();
      var subject = encodeURIComponent('Aarvex enquiry from ' + (name || 'website'));
      var body = encodeURIComponent(msg + '\n\n— ' + name + (email ? ' (' + email + ')' : ''));
      window.location.href = 'mailto:aarvexglo@gmail.com?subject=' + subject + '&body=' + body;
    });
  }

  /* Hero: live 3D mouse-parallax on the preview panel + counter-parallax chips,
     a glow that drifts with the cursor, and a cycling search line. Gives the
     cover a dynamic, professional feel. Skipped on low-power / reduced-motion. */
  function initHeroParallax() {
    var hero = document.getElementById('hero');
    var panel = document.querySelector('.nx-hero-panel');
    if (!hero || !panel || detectSoft()) return;
    var chip1 = document.querySelector('.nx-hcf-1');
    var chip2 = document.querySelector('.nx-hcf-2');
    var glow = document.querySelector('.nx-hero-glow');
    var tx = 0, ty = 0, cx = 0, cy = 0, raf = null;
    function frame() {
      cx += (tx - cx) * 0.09; cy += (ty - cy) * 0.09;
      var rx = (-cy * 8).toFixed(2), ry = (cx * 10).toFixed(2);
      panel.style.transform = 'rotateX(' + rx + 'deg) rotateY(' + ry + 'deg)';
      if (chip1) chip1.style.transform = 'translate(' + (cx * -22).toFixed(1) + 'px,' + (cy * -16).toFixed(1) + 'px)';
      if (chip2) chip2.style.transform = 'translate(' + (cx * 26).toFixed(1) + 'px,' + (cy * 18).toFixed(1) + 'px)';
      if (glow) glow.style.marginLeft = (cx * 26).toFixed(1) + 'px';
      if (Math.abs(tx - cx) > 0.0004 || Math.abs(ty - cy) > 0.0004) raf = requestAnimationFrame(frame);
      else raf = null;
    }
    function kick() { if (!raf) raf = requestAnimationFrame(frame); }
    hero.addEventListener('pointermove', function (e) {
      var r = hero.getBoundingClientRect();
      tx = (e.clientX - r.left) / r.width - 0.5;
      ty = (e.clientY - r.top) / r.height - 0.5;
      panel.classList.add('is-tilting'); kick();
    });
    hero.addEventListener('pointerleave', function () { tx = 0; ty = 0; panel.classList.remove('is-tilting'); kick(); });

    var search = document.querySelector('.nx-hp-search');
    if (search) {
      search.style.transition = 'opacity .26s ease';
      var queries = ['Search products or shops…', 'Search "Basmati 1121"…', 'Search verified sellers…', 'Search "Turmeric" bulk…', 'Search by shop ID…'];
      var qi = 0;
      setInterval(function () {
        qi = (qi + 1) % queries.length;
        search.style.opacity = '0';
        setTimeout(function () {
          search.innerHTML = '<i class="fa-solid fa-magnifying-glass"></i> ' + queries[qi];
          search.style.opacity = '1';
        }, 260);
      }, 2800);
    }
  }

  /* ── Phase 1: smooth (inertia) scroll — Lenis-style, hand-rolled + guarded.
     Desktop pointer only; touch + reduced-motion keep native scroll. Overlays
     and inputs that scroll internally are left to the browser. Anchor links
     ease to their section. Native scroll (scrollbar / keyboard) stays in sync. */
  function initSmoothScroll() {
    var root = document.documentElement;
    if (detectSoft()) return;
    try {
      if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) return;
      if (window.matchMedia('(pointer: coarse)').matches) return;
    } catch (e) { }
    root.style.scrollBehavior = 'auto';
    var target = window.scrollY, current = window.scrollY, ease = 0.11, running = false, raf = null;
    function maxScroll() { return Math.max(0, root.scrollHeight - window.innerHeight); }
    function clamp(v) { return Math.max(0, Math.min(v, maxScroll())); }
    function loop() {
      current += (target - current) * ease;
      if (Math.abs(target - current) < 0.5) { current = target; running = false; }
      window.scrollTo(0, Math.round(current));
      raf = running ? requestAnimationFrame(loop) : null;
    }
    function start() { if (!running) { running = true; if (!raf) raf = requestAnimationFrame(loop); } }
    function hasScroll(el) {
      while (el && el !== document.body && el.nodeType === 1) {
        if (el.scrollHeight > el.clientHeight + 2) {
          var oy = getComputedStyle(el).overflowY;
          if (oy === 'auto' || oy === 'scroll') return true;
        }
        el = el.parentElement;
      }
      return false;
    }
    window.addEventListener('wheel', function (e) {
      if (e.ctrlKey) return;
      if (hasScroll(e.target)) return;
      e.preventDefault();
      target = clamp(target + e.deltaY);
      start();
    }, { passive: false });
    window.addEventListener('scroll', function () { if (!running) { target = current = window.scrollY; } }, { passive: true });
    window.addEventListener('resize', function () { target = clamp(target); current = clamp(current); });
    document.addEventListener('click', function (e) {
      var a = e.target.closest && e.target.closest('a[href^="#"]');
      if (!a) return;
      var id = a.getAttribute('href');
      if (!id || id.length < 2) return;
      var el = document.querySelector(id);
      if (!el) return;
      e.preventDefault();
      var nav = document.getElementById('nxNav');
      var off = nav ? nav.offsetHeight : 0;
      target = clamp(el.getBoundingClientRect().top + window.scrollY - off + 2);
      start();
    });
  }

  /* ── Phase 2: text system. Hero headline words rise from behind a mask; every
     section heading gets a clip-wipe reveal (works even when i18n swaps text). */
  function initSplitText() {
    var title = document.querySelector('.nx-hero-title');
    if (title && !detectSoft() && !title.classList.contains('split')) {
      title.classList.remove('nx-rise', 'nx-d1');
      var words = title.querySelectorAll('.nx-word');
      for (var i = 0; i < words.length; i++) {
        var w = words[i];
        w.innerHTML = '<span class="nx-word-i">' + w.textContent + '</span>';
        w.firstChild.style.animationDelay = (0.12 + i * 0.06).toFixed(2) + 's';
      }
      // On first visit the loader plays first, then triggers .split (see initLoader);
      // on return visits (loader already hidden) the words rise right away.
      var ldr = document.getElementById('nxLoader');
      if (!ldr || ldr.style.display === 'none') title.classList.add('split');
    }
    var heads = document.querySelectorAll('.nx-h2, .nx-cinema-name');
    for (var j = 0; j < heads.length; j++) {
      if (!heads[j].classList.contains('nx-reveal-clip')) heads[j].classList.add('nx-reveal-clip');
    }
    /* Phase 6/7: images + the dark CTA band wipe in with a clip-reveal. */
    var imgs = document.querySelectorAll('.nx-step-photo, .nx-aud-bg, .nx-feat-bg, .nx-cta-band');
    for (var k = 0; k < imgs.length; k++) {
      if (!imgs[k].classList.contains('nx-reveal-clip')) imgs[k].classList.add('nx-reveal-clip');
    }
    /* The clip-reveal class was just added here, so these nodes weren't part of
       any earlier observe() pass. Observe them now (idempotent — observe() only
       picks up :not(.in) nodes) so headings/photos actually reveal on scroll. */
    observe();
  }

  /* ── Phase 7: intro loader — first visit only. AARVEX wordmark wipes in with
     a progress bar, then the whole overlay curtains up to reveal the page.
     Skippable (any interaction), and skipped instantly on return visits. */
  function initLoader() {
    var loader = document.getElementById('nxLoader');
    function mark() { try { sessionStorage.setItem('nxIntro', '1'); } catch (e) { } }
    if (!loader || loader.style.display === 'none') { mark(); return; }
    var finished = false;
    function finish() {
      if (finished) return; finished = true;
      loader.classList.add('done'); mark();
      var ht = document.querySelector('.nx-hero-title');   // hero headline rises as the curtain lifts
      if (ht && !ht.classList.contains('split')) ht.classList.add('split');
      setTimeout(function () { if (loader.parentNode) loader.parentNode.removeChild(loader); }, 850);
    }
    var reduce = false;
    try { reduce = window.matchMedia('(prefers-reduced-motion: reduce)').matches; } catch (e) { }
    var t = setTimeout(finish, reduce ? 350 : 1550);
    ['wheel', 'keydown', 'touchstart', 'click'].forEach(function (ev) {
      window.addEventListener(ev, function skip() { clearTimeout(t); finish(); }, { once: true, passive: true });
    });
  }

  /* ── Phase 6: scrollytelling — as the Capabilities theater passes through the
     viewport, its tabs auto-advance so the visual changes with scroll. */
  function initTheaterScroll() {
    var sec = document.getElementById('theater');
    if (!sec || detectSoft()) return;
    var tabs = sec.querySelectorAll('.nx-ttab');
    if (!tabs.length) return;
    var feats = [];
    for (var i = 0; i < tabs.length; i++) feats.push(tabs[i].getAttribute('data-feat'));
    var ticking = false, last = -1;
    function update() {
      ticking = false;
      var r = sec.getBoundingClientRect(), vh = window.innerHeight;
      if (r.bottom < 0 || r.top > vh) return;               // section off-screen
      // Progress 0→1 across the section's pinned scroll range (its extra height).
      // With the sticky pin (CSS), this steps the tabs evenly Trade→Sell as you
      // scroll, and the page only moves on once the last tab is reached.
      var total = sec.offsetHeight - vh;
      var p = total > 0 ? Math.min(1, Math.max(0, -r.top / total)) : 0;
      var idx = Math.floor(p * (feats.length - 0.0001));
      idx = Math.max(0, Math.min(feats.length - 1, idx));
      if (idx !== last) { last = idx; if (typeof showFeat === 'function') showFeat(feats[idx]); }
    }
    window.addEventListener('scroll', function () { if (!ticking) { ticking = true; requestAnimationFrame(update); } }, { passive: true });
    update();
  }

  /* ── Phase 4: custom cursor — a white dot (instant) + a ring (eased lag),
     both mix-blend-difference so they read black-on-white and white-on-black
     automatically. Interactive elements grow the ring (+ optional label);
     press shrinks it. Desktop pointer only. */
  function initCursor() {
    if (detectSoft()) return;
    try {
      if (window.matchMedia('(pointer: coarse)').matches) return;
      if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) return;
      if (window.matchMedia('(max-width: 900px)').matches) return;
    } catch (e) { }
    var dot = document.createElement('div'); dot.className = 'nx-cursor-dot';
    var ring = document.createElement('div'); ring.className = 'nx-cursor-ring';
    var label = document.createElement('span'); label.className = 'nx-cursor-label';
    ring.appendChild(label);
    document.body.appendChild(dot); document.body.appendChild(ring);
    document.body.classList.add('nx-cursor-on');
    var mx = window.innerWidth / 2, my = window.innerHeight / 2, rx = mx, ry = my, raf = null, hovering = false;
    function loop() {
      rx += (mx - rx) * 0.2; ry += (my - ry) * 0.2;
      dot.style.transform = 'translate(' + mx + 'px,' + my + 'px) scale(' + (hovering ? 0 : 1) + ')';
      ring.style.transform = 'translate(' + rx + 'px,' + ry + 'px)';
      raf = requestAnimationFrame(loop);
    }
    document.addEventListener('mousemove', function (e) { mx = e.clientX; my = e.clientY; if (!raf) raf = requestAnimationFrame(loop); }, { passive: true });
    document.addEventListener('mousedown', function () { ring.classList.add('is-down'); }, { passive: true });
    document.addEventListener('mouseup', function () { ring.classList.remove('is-down'); }, { passive: true });
    var sel = 'a, button, .nx-btn, [role="button"], .nx-mode, .nx-ttab, .nx-mod, .nx-round, .nx-faq-q, input, textarea, [data-cursor]';
    document.addEventListener('mouseover', function (e) {
      var el = e.target.closest && e.target.closest(sel);
      if (!el) return;
      var lbl = el.getAttribute('data-cursor');
      hovering = true;
      if (lbl) { label.textContent = lbl; ring.classList.add('has-label'); ring.classList.remove('is-hover'); }
      else { ring.classList.add('is-hover'); ring.classList.remove('has-label'); }
    });
    document.addEventListener('mouseout', function (e) {
      var el = e.target.closest && e.target.closest(sel);
      if (!el) return;
      if (e.relatedTarget && el.contains(e.relatedTarget)) return;
      hovering = false;
      ring.classList.remove('is-hover', 'has-label');
    });
  }

  /* ── Phase 5: hero scene — multi-speed scroll parallax. As you scroll, the
     ghosted wordmark + grid drift slowly, the copy rises and fades, and the
     preview panel counter-drifts and fades — a cinematic exit. */
  function initHeroScroll() {
    var hero = document.getElementById('hero');
    if (!hero || detectSoft()) return;
    var copy = hero.querySelector('.nx-hero-copy');
    var art = hero.querySelector('.nx-hero-art');
    var ghost = hero.querySelector('.nx-hero-ghost');
    var mesh = hero.querySelector('.nx-hero-mesh');
    var ticking = false;
    function update() {
      ticking = false;
      var y = window.scrollY;
      var h = hero.offsetHeight || window.innerHeight;
      if (y > h + 120) return;                 // hero fully out — stop working
      var p = Math.min(y / h, 1);
      if (ghost) ghost.style.transform = 'translate3d(-50%,' + (y * 0.28).toFixed(1) + 'px,0)';
      if (mesh) mesh.style.transform = 'translate3d(0,' + (y * 0.45).toFixed(1) + 'px,0)';
      if (copy) { copy.style.transform = 'translate3d(0,' + (y * 0.14).toFixed(1) + 'px,0)'; copy.style.opacity = Math.max(0, 1 - p * 1.15).toFixed(3); }
      if (art) { art.style.transform = 'translate3d(0,' + (y * -0.05).toFixed(1) + 'px,0)'; art.style.opacity = Math.max(0, 1 - p * 0.95).toFixed(3); }
    }
    window.addEventListener('scroll', function () { if (!ticking) { ticking = true; requestAnimationFrame(update); } }, { passive: true });
    window.addEventListener('resize', function () { if (!ticking) { ticking = true; requestAnimationFrame(update); } }, { passive: true });
    update();
  }

  /* Back-to-top: reveal the FAB past ~70% viewport of scroll, ease to the top.
     window.scrollTo drives the page; the smooth-scroll engine re-syncs to it via
     its own scroll listener, so there's no fight between the two. */
  function initTopBtn() {
    var btn = document.getElementById('nxTop');
    if (!btn) return;
    var soft = detectSoft();
    function onScroll() {
      if ((window.scrollY || 0) > window.innerHeight * 0.7) btn.classList.add('show');
      else btn.classList.remove('show');
    }
    window.addEventListener('scroll', onScroll, { passive: true });
    onScroll();
    btn.addEventListener('click', function () {
      try { window.scrollTo({ top: 0, behavior: soft ? 'auto' : 'smooth' }); }
      catch (e) { window.scrollTo(0, 0); }
    });
  }

  document.addEventListener('DOMContentLoaded', function () {
    /* Each init is isolated so one failure never blocks the loader, the live
       data, or the rest of the motion system. */
    function safe(fn) { try { fn(); } catch (e) { } }
    safe(initLoader);
    safe(initSplitText);
    safe(bind);
    safe(function () { setMode('products'); });
    safe(function () { loadCatalogue().then(startSpotAuto); });
    safe(loadShops);
    safe(initFaq);
    safe(initContact);
    safe(initSmoothScroll);
    safe(initHeroParallax);
    safe(initHeroScroll);
    safe(initTheaterScroll);
    safe(initCursor);
    safe(initTopBtn);
  });
})();
