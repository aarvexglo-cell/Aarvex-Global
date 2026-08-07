/* Aarvex Index Demo V2 ADVANCED — market + theater + spotlight + motion */
(function () {
  'use strict';

  var LAMBDA = 'https://j1yound90m.execute-api.ap-southeast-1.amazonaws.com';
  var FALLBACK = [
    { product_id: 't1', product_name: 'Tomato', category_name: 'Fresh Produce', price_per_kg: '750', available_stock: '46 kg', image_url: 'https://images.unsplash.com/photo-1546470427-e2707481ec07?auto=format&fit=crop&w=900&q=70', shop_name: 'Fresh Valley' },
    { product_id: 't2', product_name: 'Shimla Mirch', category_name: 'Fresh Produce', price_per_kg: '600', available_stock: '9 kg', image_url: 'https://images.unsplash.com/photo-1563565375-f3fdfdbefa83?auto=format&fit=crop&w=900&q=70', shop_name: 'Green Basket' },
    { product_id: 't3', product_name: 'Teja Mirch', category_name: 'Spices', price_per_kg: '420', available_stock: 'In Stock', image_url: 'https://images.unsplash.com/photo-1583119022894-919a68a3d0e3?auto=format&fit=crop&w=900&q=70', shop_name: 'Aarvex Spices' },
    { product_id: 't4', product_name: 'Basmati 1121', category_name: 'Grains', price_per_kg: '110', available_stock: 'In Stock', image_url: 'https://images.unsplash.com/photo-1586201375761-83865001e31c?auto=format&fit=crop&w=900&q=70', shop_name: 'Grain Hub' },
    { product_id: 't5', product_name: 'Haldi', category_name: 'Spices', price_per_kg: '180', available_stock: 'In Stock', image_url: 'https://images.unsplash.com/photo-1615485500704-a1ea186ef86d?auto=format&fit=crop&w=900&q=70', shop_name: 'Aarvex Spices' },
    { product_id: 't6', product_name: 'Onion', category_name: 'Fresh Produce', price_per_kg: '35', available_stock: 'Seasonal', image_url: 'https://images.unsplash.com/photo-1518977956812-cd3d41ea4d16?auto=format&fit=crop&w=900&q=70', shop_name: 'Farm Direct' },
    { product_id: 't7', product_name: 'Jeera', category_name: 'Spices', price_per_kg: '320', available_stock: 'In Stock', image_url: 'https://images.unsplash.com/photo-1596040033229-a9821ebd058d?auto=format&fit=crop&w=900&q=70', shop_name: 'Spice Route' },
    { product_id: 't8', product_name: 'Garlic', category_name: 'Fresh Produce', price_per_kg: '140', available_stock: '22 kg', image_url: 'https://images.unsplash.com/photo-1508747703725-719777637510?auto=format&fit=crop&w=900&q=70', shop_name: 'Farm Direct' }
  ];

  var FEATS = {
    trade: {
      badge: 'Trade module',
      title: 'Live Trade Hub',
      body: 'Browse live catalogue with stock, lot pricing, shop IDs, ratings, voice search, and favourites — the same grid after login.',
      bullets: ['Products | Shops mode switch', 'Category chips + live stock', 'Search by product or shop ID'],
      img: 'https://images.unsplash.com/photo-1597362925123-77861d3fbac7?auto=format&fit=crop&w=1400&q=75'
    },
    deal: {
      badge: 'Deals / RFQ',
      title: 'Negotiate price',
      body: 'When list price isn’t final, open a deal thread — structured negotiation instead of endless chat screenshots.',
      bullets: ['RFQ-style deal inbox', 'Buyer ↔ seller negotiation', 'Clear status on each deal'],
      img: 'https://images.unsplash.com/photo-1556742049-0cfed4f6a45d?auto=format&fit=crop&w=1400&q=75'
    },
    pay: {
      badge: 'Payments',
      title: 'Pay Online + COD',
      body: 'In-app Cashfree checkout for online orders and shop subscriptions, or Cash on Delivery when the deal needs it.',
      bullets: ['Cashfree modal checkout', 'COD option on orders', 'GST fields for B2B invoices'],
      img: 'https://images.unsplash.com/photo-1556742111-a301076d9d18?auto=format&fit=crop&w=1400&q=75'
    },
    track: {
      badge: 'Logistics',
      title: 'Track every consignment',
      body: 'Follow order status, delivery journey, and OTPs from the Track panel — visibility after the deal closes.',
      bullets: ['Order timeline', 'Delivery partner flow', 'Saved map addresses'],
      img: 'https://images.unsplash.com/photo-1586528116311-ad8dd3c8310d?auto=format&fit=crop&w=1400&q=75'
    },
    msg: {
      badge: 'Messaging',
      title: 'In-app messenger',
      body: 'Chat with shops without leaving Aarvex — alerts, threads, and optional voice/video call signaling.',
      bullets: ['Chats inside portal', 'Notification center', 'WhatsApp fallback support'],
      img: 'https://images.unsplash.com/photo-1516321318423-f06f85e504b3?auto=format&fit=crop&w=1400&q=75'
    },
    sell: {
      badge: 'Seller stack',
      title: 'KYC → Shop → Listings',
      body: 'Sellers complete KYC, subscribe, create a shop, publish products, and manage deals — optional delivery role.',
      bullets: ['Shop subscription (Cashfree)', 'Product listings & pause', 'Refer & Earn growth loop'],
      img: 'https://images.unsplash.com/photo-1500382017468-9049fed747ef?auto=format&fit=crop&w=1400&q=75'
    }
  };

  var MODS = {
    Home: 'Dashboard with banners, people search, order stats, and GST readiness — your command center.',
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

  var state = { products: [], shops: [], cat: 'All', q: '', mode: 'products', source: 'loading', spot: 0, spotTimer: null };

  function $(id) { return document.getElementById(id); }
  function esc(s) {
    return String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/"/g, '&quot;');
  }

  function observe() {
    var nodes = document.querySelectorAll('.v2-reveal:not(.in), .v2-card:not(.in), .v2-shop:not(.in)');
    if (!('IntersectionObserver' in window)) {
      nodes.forEach(function (n) { n.classList.add('in'); });
      return;
    }
    var io = new IntersectionObserver(function (entries) {
      entries.forEach(function (e) {
        if (e.isIntersecting) { e.target.classList.add('in'); io.unobserve(e.target); }
      });
    }, { threshold: 0.12, rootMargin: '0px 0px -20px 0px' });
    nodes.forEach(function (n, i) {
      n.style.transitionDelay = Math.min(i * 0.04, 0.28) + 's';
      io.observe(n);
    });
  }

  function animateCount(el, to) {
    if (!el || el.dataset.animated === '1') return;
    var target = parseInt(to, 10);
    if (!target && target !== 0) return;
    el.dataset.animated = '1';
    var start = 0, t0 = null, dur = 900;
    function frame(ts) {
      if (!t0) t0 = ts;
      var p = Math.min(1, (ts - t0) / dur);
      var eased = 1 - Math.pow(1 - p, 3);
      el.textContent = String(Math.round(start + (target - start) * eased));
      if (p < 1) requestAnimationFrame(frame);
    }
    requestAnimationFrame(frame);
  }

  function runProofCounts() {
    var root = $('v2Proof');
    if (!root) return;
    var nums = root.querySelectorAll('.v2-proof-num[data-count]');
    nums.forEach(function (el) {
      var n = el.getAttribute('data-count');
      if (n && n !== '0') animateCount(el, n);
    });
  }

  function filtered() {
    var list = state.products.slice();
    if (state.cat && state.cat !== 'All') {
      list = list.filter(function (p) { return p.category_name === state.cat; });
    }
    var q = state.q.trim().toLowerCase();
    if (q) {
      list = list.filter(function (p) {
        return [p.product_name, p.category_name, p.shop_name, p.description].join(' ').toLowerCase().indexOf(q) !== -1;
      });
    }
    return list;
  }

  function renderCats() {
    var cats = ['All'];
    state.products.forEach(function (p) {
      if (p.category_name && cats.indexOf(p.category_name) === -1) cats.push(p.category_name);
    });
    var el = $('v2Cats');
    if (!el) return;
    el.innerHTML = cats.map(function (c) {
      return '<button type="button" class="v2-cat' + (c === state.cat ? ' on' : '') + '" data-cat="' + esc(c) + '">' + esc(c) + '</button>';
    }).join('');
  }

  function renderGrid() {
    var grid = $('v2Grid');
    var live = $('v2Live');
    var stat = $('v2StatProducts');
    if (!grid) return;
    var list = filtered();
    if (stat) {
      stat.setAttribute('data-count', String(state.products.length || list.length || 0));
      stat.dataset.animated = '';
      animateCount(stat, state.products.length || list.length || 0);
    }
    if (live) {
      live.innerHTML = '<span class="v2-dot"></span> Live · <b style="color:var(--lime)">' + list.length + '</b> showing' +
        (state.source !== 'live' ? ' · ' + esc(state.source) : '');
    }
    if (!list.length) {
      grid.innerHTML = '<div class="v2-empty">No matches — try another filter.</div>';
      return;
    }
    grid.innerHTML = list.map(function (p, i) {
      var img = p.image_url && String(p.image_url).length > 10;
      var price = p.lot_price
        ? ('₹' + esc(p.lot_price) + '<small> / lot</small>')
        : (p.price_per_kg ? ('₹' + esc(p.price_per_kg) + '<small>/kg</small>') : '<small>Contact</small>');
      return (
        '<article class="v2-card" data-id="' + esc(p.product_id || i) + '">' +
          '<div class="v2-card-media">' +
            (img ? '<img src="' + esc(p.image_url) + '" alt="' + esc(p.product_name) + '" loading="lazy" onerror="this.style.display=\'none\';this.nextElementSibling.style.display=\'grid\'">' : '') +
            '<div class="v2-card-ph" style="' + (img ? 'display:none' : '') + '"><i class="fa-solid fa-leaf"></i></div>' +
          '</div>' +
          '<div class="v2-card-body">' +
            '<div class="v2-card-cat">' + esc(p.category_name || 'Produce') + '</div>' +
            '<div class="v2-card-name">' + esc(p.product_name) + '</div>' +
            '<div class="v2-card-row"><div class="v2-card-price">' + price + '</div>' +
            '<span style="font-size:11px;color:var(--mute)">' + esc(p.available_stock || 'In Stock') + '</span></div>' +
          '</div></article>'
      );
    }).join('');
    observe();
    grid.querySelectorAll('.v2-card').forEach(function (card) {
      card.addEventListener('click', function () {
        window.location.href = 'portal.html?product=' + encodeURIComponent(card.getAttribute('data-id') || '');
      });
    });
    renderSpotlight();
  }

  function renderShops() {
    var el = $('v2Shops');
    if (!el) return;
    var shops = state.shops.length ? state.shops : [
      { shop_name: 'Fresh Valley', product_count: 13 },
      { shop_name: 'Aarvex Spices', product_count: 8 },
      { shop_name: 'Grain Hub', product_count: 5 },
      { shop_name: 'Farm Direct', product_count: 11 }
    ];
    el.innerHTML = shops.slice(0, 9).map(function (s, i) {
      var name = s.shop_name || s.name || 'Shop';
      var count = s.product_count || s.listings || '—';
      var img = s.logo_url || s.shop_logo || '';
      return (
        '<a class="v2-shop" href="portal.html" style="transition-delay:' + (i * 0.04) + 's">' +
          '<div class="v2-shop-av">' + (img ? '<img src="' + esc(img) + '" alt="">' : esc(name.charAt(0).toUpperCase())) + '</div>' +
          '<div><div class="v2-shop-name">' + esc(name) + '</div>' +
          '<div class="v2-shop-meta">' + esc(String(count)) + ' products · Verified</div></div></a>'
      );
    }).join('');
    observe();
  }

  function skeletons() {
    var g = $('v2Grid');
    if (g) g.innerHTML = Array(8).fill('<div class="v2-skel"></div>').join('');
  }

  async function loadCatalogue() {
    skeletons();
    state.source = 'loading';
    try {
      var res = await fetch(LAMBDA + '/catalogue', {
        headers: { Accept: 'application/json' },
        signal: AbortSignal.timeout ? AbortSignal.timeout(12000) : undefined
      });
      if (res.ok) {
        var data = await res.json();
        var products = data.products || data.items || [];
        if (products.length) {
          state.products = products;
          state.source = 'live';
          renderCats();
          renderGrid();
          return;
        }
      }
      state.products = FALLBACK;
      state.source = 'sample';
    } catch (e) {
      state.products = FALLBACK;
      state.source = 'offline preview';
    }
    renderCats();
    renderGrid();
  }

  async function loadShops() {
    try {
      var res = await fetch(LAMBDA + '/shops/top', {
        headers: { Accept: 'application/json' },
        signal: AbortSignal.timeout ? AbortSignal.timeout(10000) : undefined
      });
      if (res.ok) {
        var data = await res.json();
        state.shops = data.shops || data.items || data.top_shops || [];
      }
    } catch (e) { /* ignore */ }
    renderShops();
  }

  function setMode(mode) {
    state.mode = mode;
    document.querySelectorAll('.v2-mode').forEach(function (b) {
      b.classList.toggle('on', b.getAttribute('data-mode') === mode);
    });
    var pp = $('v2ProductsPane');
    var sp = $('v2ShopsPane');
    if (pp) pp.hidden = mode !== 'products';
    if (sp) sp.hidden = mode !== 'shops';
  }

  /* ── Theater ── */
  function showFeat(key) {
    var f = FEATS[key] || FEATS.trade;
    document.querySelectorAll('.v2-ttab').forEach(function (b) {
      b.classList.toggle('on', b.getAttribute('data-feat') === key);
    });
    var vis = $('v2TheaterVisual');
    if (vis) vis.style.backgroundImage = 'url("' + f.img + '")';
    if ($('v2TheaterBadge')) $('v2TheaterBadge').textContent = f.badge;
    if ($('v2TheaterTitle')) $('v2TheaterTitle').textContent = f.title;
    if ($('v2TheaterBody')) $('v2TheaterBody').textContent = f.body;
    var ul = $('v2TheaterBullets');
    if (ul) ul.innerHTML = f.bullets.map(function (x) { return '<li>' + esc(x) + '</li>'; }).join('');
  }

  /* ── Spotlight ── */
  function spotList() {
    return (state.products.length ? state.products : FALLBACK).filter(function (p) {
      return p.image_url && String(p.image_url).length > 10;
    }).slice(0, 6);
  }

  function renderSpotlight() {
    var list = spotList();
    if (!list.length) list = FALLBACK.slice(0, 4);
    if (state.spot >= list.length) state.spot = 0;
    var p = list[state.spot];
    var media = $('v2SpotMedia');
    if (media) media.style.backgroundImage = 'url("' + (p.image_url || '') + '")';
    if ($('v2SpotCat')) $('v2SpotCat').textContent = p.category_name || 'Produce';
    if ($('v2SpotName')) $('v2SpotName').textContent = p.product_name || '';
    if ($('v2SpotMeta')) $('v2SpotMeta').textContent = (p.shop_name || 'Verified shop') + ' · ' + (p.available_stock || 'In Stock');
    if ($('v2SpotPrice')) {
      $('v2SpotPrice').innerHTML = p.price_per_kg
        ? ('₹' + esc(p.price_per_kg) + '<small>/kg</small>')
        : '<small>Contact for price</small>';
    }
    if ($('v2SpotCta')) $('v2SpotCta').href = 'portal.html?product=' + encodeURIComponent(p.product_id || '');
    var dots = $('v2SpotDots');
    if (dots) {
      dots.innerHTML = list.map(function (_, i) {
        return '<button type="button" class="' + (i === state.spot ? 'on' : '') + '" data-i="' + i + '" aria-label="Slide ' + (i + 1) + '"></button>';
      }).join('');
    }
  }

  function spotNext(dir) {
    var list = spotList();
    var n = list.length || 1;
    state.spot = (state.spot + (dir || 1) + n) % n;
    renderSpotlight();
  }

  function startSpotAuto() {
    clearInterval(state.spotTimer);
    state.spotTimer = setInterval(function () { spotNext(1); }, 4500);
  }

  /* ── Module stack ── */
  function showMod(name) {
    document.querySelectorAll('.v2-mod').forEach(function (b) {
      b.classList.toggle('on', b.getAttribute('data-mod') === name);
    });
    if ($('v2ModTitle')) $('v2ModTitle').textContent = name;
    if ($('v2ModBody')) $('v2ModBody').textContent = MODS[name] || '';
  }

  /* ── Ambient + dots ── */
  function bindAmbient() {
    var amb = $('v2Ambient');
    if (!amb) return;
    var reduce = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    if (reduce) return;
    window.addEventListener('pointermove', function (e) {
      amb.style.setProperty('--ax', (e.clientX / window.innerWidth * 100) + '%');
      amb.style.setProperty('--ay', (e.clientY / window.innerHeight * 100) + '%');
    }, { passive: true });
  }

  function bindDots() {
    var ids = ['top', 'how', 'theater', 'market', 'roles', 'trust'];
    var links = document.querySelectorAll('#v2Dots a');
    if (!links.length) return;
    function sync() {
      var mid = window.scrollY + window.innerHeight * 0.35;
      var active = 'top';
      ids.forEach(function (id) {
        var el = document.getElementById(id === 'top' ? 'v2Nav' : id) || document.getElementById(id);
        if (el && el.offsetTop <= mid) active = id;
      });
      links.forEach(function (a) {
        a.classList.toggle('on', a.getAttribute('data-dot') === active);
      });
    }
    window.addEventListener('scroll', sync, { passive: true });
    sync();
  }

  function bind() {
    var nav = $('v2Nav');
    window.addEventListener('scroll', function () {
      if (nav) nav.classList.toggle('on', window.scrollY > 20);
    }, { passive: true });

    var menu = $('v2Menu');
    var drawer = $('v2Drawer');
    if (menu && drawer) {
      menu.addEventListener('click', function () {
        drawer.classList.toggle('open');
        menu.innerHTML = drawer.classList.contains('open')
          ? '<i class="fa-solid fa-xmark"></i>' : '<i class="fa-solid fa-bars"></i>';
      });
      drawer.querySelectorAll('a').forEach(function (a) {
        a.addEventListener('click', function () {
          drawer.classList.remove('open');
          menu.innerHTML = '<i class="fa-solid fa-bars"></i>';
        });
      });
    }

    var t;
    var search = $('v2Search');
    if (search) {
      search.addEventListener('input', function () {
        state.q = search.value;
        clearTimeout(t);
        t = setTimeout(renderGrid, 200);
      });
    }

    document.addEventListener('click', function (e) {
      var cat = e.target.closest('.v2-cat');
      if (cat) {
        state.cat = cat.getAttribute('data-cat') || 'All';
        renderCats();
        renderGrid();
      }
      var mode = e.target.closest('.v2-mode');
      if (mode) setMode(mode.getAttribute('data-mode') || 'products');
      var tab = e.target.closest('.v2-ttab');
      if (tab) showFeat(tab.getAttribute('data-feat') || 'trade');
      var mod = e.target.closest('.v2-mod');
      if (mod) showMod(mod.getAttribute('data-mod') || 'Home');
      var dot = e.target.closest('#v2SpotDots button');
      if (dot) {
        state.spot = parseInt(dot.getAttribute('data-i'), 10) || 0;
        renderSpotlight();
        startSpotAuto();
      }
    });

    var refresh = $('v2Refresh');
    if (refresh) refresh.addEventListener('click', function () {
      loadCatalogue();
      loadShops();
    });

    if ($('v2SpotPrev')) $('v2SpotPrev').addEventListener('click', function () { spotNext(-1); startSpotAuto(); });
    if ($('v2SpotNext')) $('v2SpotNext').addEventListener('click', function () { spotNext(1); startSpotAuto(); });

    // Proof counters when visible
    if ('IntersectionObserver' in window && $('v2Proof')) {
      var pio = new IntersectionObserver(function (entries) {
        entries.forEach(function (en) {
          if (en.isIntersecting) { runProofCounts(); pio.disconnect(); }
        });
      }, { threshold: 0.4 });
      pio.observe($('v2Proof'));
    }

    bindAmbient();
    bindDots();
    observe();
    showFeat('trade');
    showMod('Home');
  }

  document.addEventListener('DOMContentLoaded', function () {
    bind();
    setMode('products');
    loadCatalogue().then(function () { startSpotAuto(); });
    loadShops();
  });
})();
