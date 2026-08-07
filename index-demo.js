/* Aarvex Index Demo — dynamic catalogue + shops */
(function () {
  'use strict';

  var LAMBDA_URL = 'https://j1yound90m.execute-api.ap-southeast-1.amazonaws.com';

  var FALLBACK = [
    { product_id: 'teja', product_name: 'Teja Lal Mirch', category_name: 'Spices', price_per_kg: '420', available_stock: '46 kg left', image_url: '', shop_name: 'Aarvex Spices' },
    { product_id: 'tomato', product_name: 'Tomato', category_name: 'Fresh Produce', price_per_kg: '750', available_stock: '46 kg left', image_url: 'https://images.unsplash.com/photo-1546470427-e2707481ec07?auto=format&fit=crop&w=600&q=70', shop_name: 'Fresh Valley' },
    { product_id: 'capsicum', product_name: 'Shimla Mirch', category_name: 'Fresh Produce', price_per_kg: '600', available_stock: '9 kg left', image_url: 'https://images.unsplash.com/photo-1563565375-f3fdfdbefa83?auto=format&fit=crop&w=600&q=70', shop_name: 'Green Basket' },
    { product_id: 'basmati', product_name: 'Basmati 1121', category_name: 'Grains', price_per_kg: '110', available_stock: 'In Stock', image_url: '', shop_name: 'Grain Hub' },
    { product_id: 'haldi', product_name: 'Haldi', category_name: 'Spices', price_per_kg: '180', available_stock: 'In Stock', image_url: '', shop_name: 'Aarvex Spices' },
    { product_id: 'onion', product_name: 'Onion', category_name: 'Fresh Produce', price_per_kg: '35', available_stock: 'Seasonal', image_url: 'https://images.unsplash.com/photo-1518977956812-cd3d41ea4d16?auto=format&fit=crop&w=600&q=70', shop_name: 'Farm Direct' }
  ];

  var state = {
    products: [],
    shops: [],
    category: 'All',
    mode: 'products',
    query: '',
    source: 'loading'
  };

  function $(id) { return document.getElementById(id); }
  function esc(s) {
    return String(s == null ? '' : s)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  }

  function priceHtml(p) {
    if (p.lot_price && p.lot_size_kg) {
      return '₹' + esc(p.lot_price) + '<small> / lot</small>';
    }
    if (p.price_per_kg) return '₹' + esc(p.price_per_kg) + '<small>/kg</small>';
    return '<small>Contact</small>';
  }

  function filtered() {
    var list = state.products.slice();
    if (state.category && state.category !== 'All') {
      list = list.filter(function (p) { return p.category_name === state.category; });
    }
    var q = state.query.trim().toLowerCase();
    if (q) {
      list = list.filter(function (p) {
        return [p.product_name, p.category_name, p.shop_name, p.description]
          .join(' ').toLowerCase().indexOf(q) !== -1;
      });
    }
    return list;
  }

  function observeIn(root) {
    var nodes = (root || document).querySelectorAll('.dx-card:not(.is-in), .dx-shop:not(.is-in), .dx-reveal:not(.is-in)');
    if (!('IntersectionObserver' in window)) {
      nodes.forEach(function (n) { n.classList.add('is-in'); });
      return;
    }
    var io = new IntersectionObserver(function (entries) {
      entries.forEach(function (e) {
        if (e.isIntersecting) {
          e.target.classList.add('is-in');
          io.unobserve(e.target);
        }
      });
    }, { threshold: 0.12, rootMargin: '0px 0px -24px 0px' });
    nodes.forEach(function (n, i) {
      n.style.transitionDelay = Math.min(i * 0.05, 0.35) + 's';
      io.observe(n);
    });
  }

  function renderCats() {
    var cats = ['All'];
    state.products.forEach(function (p) {
      if (p.category_name && cats.indexOf(p.category_name) === -1) cats.push(p.category_name);
    });
    var el = $('dxCats');
    if (!el) return;
    el.innerHTML = cats.map(function (c) {
      return '<button type="button" class="dx-cat' + (c === state.category ? ' active' : '') + '" data-cat="' + esc(c) + '">' + esc(c) + '</button>';
    }).join('');
  }

  function renderGrid() {
    var grid = $('dxGrid');
    var live = $('dxLive');
    if (!grid) return;
    var list = filtered();
    if (live) {
      live.innerHTML = '<span class="dx-live-dot"></span> Live · <b style="color:var(--demo-lime)">' + list.length + '</b> products' +
        (state.source !== 'live' ? ' · <span style="opacity:.8">' + esc(state.source) + '</span>' : '');
    }
    if (!list.length) {
      grid.innerHTML = '<div class="dx-empty"><i class="fa-solid fa-seedling" style="font-size:28px;margin-bottom:10px;display:block;color:var(--demo-lime)"></i>No matches — try another category or search.</div>';
      return;
    }
    grid.innerHTML = list.map(function (p, idx) {
      var hasImg = p.image_url && String(p.image_url).length > 10;
      return (
        '<article class="dx-card" data-id="' + esc(p.product_id || idx) + '" style="transition-delay:' + Math.min(idx * 0.04, 0.3) + 's">' +
          '<div class="dx-card-media">' +
            (hasImg
              ? '<img src="' + esc(p.image_url) + '" alt="' + esc(p.product_name) + '" loading="lazy" onerror="this.style.display=\'none\';this.nextElementSibling.style.display=\'grid\'">'
              : '') +
            '<div class="dx-card-fallback" style="' + (hasImg ? 'display:none' : '') + '"><i class="fa-solid fa-leaf"></i></div>' +
            '<button type="button" class="dx-card-like" aria-label="Save"><i class="fa-regular fa-heart"></i></button>' +
          '</div>' +
          '<div class="dx-card-body">' +
            '<div class="dx-card-cat">' + esc(p.category_name || 'Produce') + '</div>' +
            '<div class="dx-card-name">' + esc(p.product_name) + '</div>' +
            (p.shop_name ? '<div style="font-size:12px;color:var(--demo-muted)"><i class="fa-solid fa-store" style="margin-right:4px;opacity:.7"></i>' + esc(p.shop_name) + '</div>' : '') +
            '<div class="dx-card-meta">' +
              '<div class="dx-card-price">' + priceHtml(p) + '</div>' +
              '<div class="dx-card-stock"><i class="fa-solid fa-circle"></i>' + esc(p.available_stock || 'In Stock') + '</div>' +
            '</div>' +
          '</div>' +
        '</article>'
      );
    }).join('');
    observeIn(grid);
    grid.querySelectorAll('.dx-card').forEach(function (card) {
      card.addEventListener('click', function (e) {
        if (e.target.closest('.dx-card-like')) return;
        var id = card.getAttribute('data-id');
        window.location.href = 'portal.html?product=' + encodeURIComponent(id || '');
      });
    });
  }

  function renderShops() {
    var el = $('dxShops');
    if (!el) return;
    var shops = state.shops;
    if (!shops.length) {
      el.innerHTML = '<div class="dx-empty">Top shops will appear when sellers publish listings.</div>';
      return;
    }
    el.innerHTML = shops.slice(0, 8).map(function (s, i) {
      var name = s.shop_name || s.name || 'Shop';
      var init = name.charAt(0).toUpperCase();
      var count = s.product_count || s.listings || s.live_products || '—';
      var img = s.logo_url || s.shop_logo || '';
      return (
        '<a class="dx-shop" href="portal.html" style="transition-delay:' + (i * 0.05) + 's">' +
          '<div class="dx-shop-av">' + (img ? '<img src="' + esc(img) + '" alt="">' : init) + '</div>' +
          '<div>' +
            '<div class="dx-shop-name">' + esc(name) + '</div>' +
            '<div class="dx-shop-meta">' + esc(String(count)) + ' products · Verified seller</div>' +
          '</div>' +
        '</a>'
      );
    }).join('');
    observeIn(el);
  }

  function showSkeletons() {
    var grid = $('dxGrid');
    if (!grid) return;
    grid.innerHTML = Array(8).fill('<div class="dx-skel"></div>').join('');
  }

  async function loadCatalogue() {
    showSkeletons();
    state.source = 'loading';
    try {
      var res = await fetch(LAMBDA_URL + '/catalogue', {
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
          updateTicker(products);
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
    updateTicker(state.products);
  }

  async function loadShops() {
    try {
      var res = await fetch(LAMBDA_URL + '/shops/top', {
        headers: { Accept: 'application/json' },
        signal: AbortSignal.timeout ? AbortSignal.timeout(10000) : undefined
      });
      if (res.ok) {
        var data = await res.json();
        state.shops = data.shops || data.items || data.top_shops || [];
      }
    } catch (e) { /* ignore */ }
    if (!state.shops.length) {
      state.shops = [
        { shop_name: 'Fresh Valley', product_count: 13 },
        { shop_name: 'Aarvex Spices', product_count: 8 },
        { shop_name: 'Grain Hub', product_count: 5 },
        { shop_name: 'Farm Direct', product_count: 11 }
      ];
    }
    renderShops();
    var inline = document.getElementById('dxShopsInline');
    var src = document.getElementById('dxShops');
    if (inline && src) inline.innerHTML = src.innerHTML;
  }

  function updateTicker(products) {
    var track = $('dxTickerTrack');
    if (!track || !products.length) return;
    var bits = products.slice(0, 12).map(function (p) {
      return '<span><b>' + esc(p.product_name) + '</b> · ' + esc(p.category_name || 'Produce') +
        (p.price_per_kg ? ' · ₹' + esc(p.price_per_kg) + '/kg' : '') + '</span>';
    });
    var html = bits.join('') + bits.join('');
    track.innerHTML = html;
  }

  function setMode(mode) {
    state.mode = mode;
    document.querySelectorAll('.dx-mode').forEach(function (b) {
      b.classList.toggle('active', b.getAttribute('data-mode') === mode);
    });
    var productsBlock = $('dxProductsBlock');
    var shopsBlock = $('dxShopsBlock');
    if (productsBlock) productsBlock.hidden = mode !== 'products';
    if (shopsBlock) shopsBlock.hidden = mode !== 'shops';
  }

  function bind() {
    var nav = $('dxNav');
    window.addEventListener('scroll', function () {
      if (nav) nav.classList.toggle('is-scrolled', window.scrollY > 24);
    }, { passive: true });

    var toggle = $('dxNavToggle');
    var mobile = $('dxMobile');
    if (toggle && mobile) {
      toggle.addEventListener('click', function () {
        mobile.classList.toggle('open');
        toggle.innerHTML = mobile.classList.contains('open')
          ? '<i class="fa-solid fa-xmark"></i>'
          : '<i class="fa-solid fa-bars"></i>';
      });
      mobile.querySelectorAll('a').forEach(function (a) {
        a.addEventListener('click', function () {
          mobile.classList.remove('open');
          toggle.innerHTML = '<i class="fa-solid fa-bars"></i>';
        });
      });
    }

    var input = $('dxSearch');
    var clear = $('dxSearchClear');
    var t;
    if (input) {
      input.addEventListener('input', function () {
        state.query = input.value;
        if (clear) clear.classList.toggle('show', !!state.query);
        clearTimeout(t);
        t = setTimeout(renderGrid, 220);
      });
    }
    if (clear) {
      clear.addEventListener('click', function () {
        if (input) input.value = '';
        state.query = '';
        clear.classList.remove('show');
        renderGrid();
      });
    }

    document.addEventListener('click', function (e) {
      var cat = e.target.closest('.dx-cat');
      if (cat) {
        state.category = cat.getAttribute('data-cat') || 'All';
        renderCats();
        renderGrid();
      }
      var mode = e.target.closest('.dx-mode');
      if (mode) setMode(mode.getAttribute('data-mode') || 'products');
    });

    var refresh = $('dxRefresh');
    if (refresh) refresh.addEventListener('click', function () {
      loadCatalogue();
      loadShops();
    });

    observeIn(document);
  }

  document.addEventListener('DOMContentLoaded', function () {
    bind();
    setMode('products');
    loadCatalogue();
    loadShops();
  });
})();
