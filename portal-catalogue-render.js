/* Aarvex Portal — Shop Directory + Catalogue rendering
 * Extracted from portal.html's inline <script> (was lines 1382-2900).
 * Shop directory list/cards, catalogue fetch+render, category quick-grid,
 * favourites grid, product-like toggling, search/filter.
 * Depends on: portal-helpers.js (gv/sv/showToast/escapeHtml) — load AFTER it.
 * NOTE: renderCatalogue() defined here is later overridden by portal-enhancements.js
 * (pre-existing behaviour, unchanged by this split — just flagging it).
 * Distinct from catalogue-ui.js (shared CatalogueUI.* render helpers used across
 * portal.html AND index.html) — this file is portal.html-only page logic that
 * calls into those shared helpers.
 */

/* ── SHOP FAVOURITES (heart on shop cards) ──
   A shop "favourite" is the SAME SHOPLIKE record the shop-profile like writes
   and that powers the Favourites → Shops tab; the heart on a card just toggles
   it via POST /shop/like ({shop_id, liked:true|false}). We cache the user's
   favourited shop-ids so every card renders the right filled/outline heart
   without a per-card backend call. */
let favShopIds = null; // Set of shop_ids, null until first load
function getFavShopIds() { return favShopIds || new Set(); }
async function loadFavShopIds() {
  if (!currentUser || !localStorage.getItem('ax_google_token')) { favShopIds = new Set(); return favShopIds; }
  try {
    const res = await fetch(LAMBDA_URL + '/shop/favourites', { headers: { Authorization: 'Bearer ' + localStorage.getItem('ax_google_token'), Accept: 'application/json' } });
    const data = await res.json();
    favShopIds = new Set((data.shops || []).map(s => s.shop_id));
  } catch (e) { favShopIds = favShopIds || new Set(); }
  return favShopIds;
}
function isShopFav(shopId) { return getFavShopIds().has(shopId); }
function toggleShopFav(ev, shopId, btn) {
  if (ev) ev.stopPropagation();
  if (!currentUser || !localStorage.getItem('ax_google_token')) { showToast('Sign in to save shops', 'warning'); return; }
  const ids = getFavShopIds();
  const nowFav = !ids.has(shopId);
  if (nowFav) ids.add(shopId); else ids.delete(shopId);
  favShopIds = ids;
  const paint = (on) => {
    if (!btn) return;
    btn.classList.toggle('liked', on);
    const icon = btn.querySelector('i');
    if (icon) icon.className = (on ? 'fa-solid' : 'fa-regular') + ' fa-heart';
  };
  paint(nowFav);
  refreshFavouritesGridIfVisible();
  if (typeof axLoadFavShops === 'function' && document.getElementById('panel-favourites')?.classList.contains('active')) axLoadFavShops();
  fetch(LAMBDA_URL + '/shop/like', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + localStorage.getItem('ax_google_token') },
    body: JSON.stringify({ shop_id: shopId, liked: nowFav })
  }).then(res => { if (!res.ok) throw new Error('bad status'); })
    .catch(() => {
      const s = getFavShopIds();
      if (nowFav) s.delete(shopId); else s.add(shopId);
      favShopIds = s;
      paint(!nowFav);
      showToast('Could not update favourite. Please try again.', 'error');
    });
}

/* ── SHOP DIRECTORY ── */
let shopDirectoryList = [];
let shopDirectoryLoaded = false;

function shopDirectoryCardHtml(shop) {
  const esc = (typeof CatalogueUI !== 'undefined') ? CatalogueUI.esc : (s => String(s == null ? '' : s));
  const rating = parseFloat(shop.avg_rating) || 0;
  const ratingHtml = rating
    ? '<span style="color:#C7993A;font-weight:700"><i class="fa-solid fa-star"></i> ' + rating.toFixed(1) + '</span>'
    : '<span style="color:var(--c-text4);font-weight:700">New</span>';
  const sidEsc = esc(shop.shop_id).replace(/'/g, "\\'");
  const favd = isShopFav(shop.shop_id);
  return '<div class="product-card" style="cursor:pointer" onclick="ProductModal.openShopProfile(\'' + sidEsc + '\')">' +
    '<div class="product-card-media" style="display:flex;align-items:center;justify-content:center;aspect-ratio:4/3;background:var(--color-surface-raised)">' +
      (shop.shop_logo_url ? '<img src="' + esc(shop.shop_logo_url) + '" alt="" style="width:100%;height:100%;object-fit:cover">' : '<i class="fa-solid fa-store" style="font-size:32px;color:var(--c-leaf)"></i>') +
      '<button type="button" class="ax-shop-fav-btn' + (favd ? ' liked' : '') + '" onclick="toggleShopFav(event,\'' + sidEsc + '\',this)" aria-label="Save shop"><i class="' + (favd ? 'fa-solid' : 'fa-regular') + ' fa-heart"></i></button>' +
    '</div>' +
    '<div class="product-card-body">' +
      '<div style="font-size:11px;color:var(--c-text3);font-weight:600;text-transform:uppercase;letter-spacing:.03em;margin-bottom:4px">' + esc(shop.shop_category || 'Shop') + '</div>' +
      '<h4 style="font-family:var(--f-display);font-size:16px;margin-bottom:4px">' + esc(shop.shop_name || shop.shop_id) + '</h4>' +
      '<div style="font-size:12.5px;color:var(--c-text3);margin-bottom:8px"><i class="fa-solid fa-location-dot"></i> ' + esc(shop.address_city || '—') + (shop.address_state ? ', ' + esc(shop.address_state) : '') + '</div>' +
      '<div style="display:flex;align-items:center;justify-content:space-between;gap:8px;font-size:12.5px">' +
        ratingHtml +
        '<span class="ax-shop-prodcount">' + (shop.product_count || 0) + ' product' + ((shop.product_count == 1) ? '' : 's') + '</span>' +
      '</div>' +
    '</div></div>';
}

function shopDirectorySkeletonHtml() {
  return Array(6).fill(0).map(() =>
    '<div class="product-card" style="pointer-events:none">' +
      '<div class="skeleton" style="width:100%;aspect-ratio:4/3;border-radius:0"></div>' +
      '<div class="product-card-body">' +
        '<div class="skeleton" style="height:10px;width:50%;margin-bottom:8px;border-radius:4px"></div>' +
        '<div class="skeleton" style="height:18px;width:80%;margin-bottom:10px;border-radius:6px"></div>' +
        '<div class="skeleton" style="height:10px;width:60%;border-radius:4px"></div>' +
      '</div></div>'
  ).join('');
}

async function loadShopDirectory(forceRefresh) {
  const grid = document.getElementById('shopDirectoryGrid');
  if (!grid) return;
  if (shopDirectoryLoaded && !forceRefresh) { filterShopDirectory(); return; }
  grid.innerHTML = shopDirectorySkeletonHtml();
  try {
    const res = await fetch(LAMBDA_URL + '/shop/list?limit=100', {
      headers: { 'Content-Type': 'application/json', 'Accept': 'application/json', Authorization: 'Bearer ' + (localStorage.getItem('ax_google_token') || '') },
      signal: AbortSignal.timeout(10000),
    });
    const data = await res.json();
    shopDirectoryList = data.shops || [];
    shopDirectoryLoaded = true;
    await loadFavShopIds();
    filterShopDirectory();
  } catch (e) {
    console.error('[ShopDirectory] load failed:', e);
    grid.innerHTML = (typeof CatalogueUI !== 'undefined')
      ? CatalogueUI.emptyStateHtml({ icon: 'fa-triangle-exclamation', message: 'Could not load shops. Please try again.' })
      : '<p style="grid-column:1/-1;text-align:center;color:var(--c-text3)">Could not load shops. Please try again.</p>';
  }
}

function filterShopDirectory() {
  const grid = document.getElementById('shopDirectoryGrid');
  if (!grid) return;
  const q = (document.getElementById('shopDirectorySearch')?.value || '').trim().toLowerCase();
  const filtered = !q ? shopDirectoryList : shopDirectoryList.filter(s =>
    (s.shop_name || '').toLowerCase().includes(q) ||
    (s.shop_category || '').toLowerCase().includes(q) ||
    (s.address_city || '').toLowerCase().includes(q) ||
    (s.address_state || '').toLowerCase().includes(q)
  );
  if (!filtered.length) {
    grid.innerHTML = (typeof CatalogueUI !== 'undefined')
      ? CatalogueUI.emptyStateHtml({ icon: 'fa-shop', message: q ? 'No shops match your search.' : 'No active shops yet.' })
      : '<p style="grid-column:1/-1;text-align:center;color:var(--c-text3)">' + (q ? 'No shops match your search.' : 'No active shops yet.') + '</p>';
    return;
  }
  grid.innerHTML = filtered.map(shopDirectoryCardHtml).join('');
}

/* ── CATALOGUE ── */
let catalogueSource = 'loading'; // 'live' | 'offline'

// No hardcoded fallback — only real products from DynamoDB are shown.
const DEFAULT_PRODUCTS = [];

function showCatalogueSkeletons() {
  const grid = document.getElementById('productGrid');
  if (!grid) return;
  if (typeof axShowLoader === 'function') {
    if (!grid.innerHTML.trim()) {
      grid.innerHTML = '<div style="min-height:200px"></div>';
    }
    axShowLoader(grid, 'Loading catalogue…');
    return;
  }
  if (typeof axLoaderHtml === 'function') {
    grid.innerHTML = axLoaderHtml('Loading catalogue…', 110);
    if (typeof axMountLoaders === 'function') axMountLoaders(grid);
    return;
  }
  grid.innerHTML = Array(6).fill(0).map(() =>
    '<div class="product-card" style="pointer-events:none">' +
      '<div class="skeleton" style="width:100%;aspect-ratio:4/3;border-radius:0"></div>' +
      '<div class="product-card-body">' +
        '<div class="skeleton" style="height:10px;width:60%;margin-bottom:8px;border-radius:4px"></div>' +
        '<div class="skeleton" style="height:18px;width:85%;margin-bottom:10px;border-radius:6px"></div>' +
        '<div class="skeleton" style="height:10px;width:45%;margin-bottom:8px;border-radius:4px"></div>' +
        '<div class="skeleton" style="height:24px;width:55%;margin-bottom:8px;border-radius:4px"></div>' +
        '<div class="skeleton" style="height:34px;width:100%;border-radius:8px"></div>' +
      '</div></div>'
  ).join('');
}

function updateCatalogueSourceBadge() {
  const badge = document.getElementById('catalogueSourceBadge');
  if (!badge) return;
  if (catalogueSource === 'live') {
    badge.innerHTML = '<i class="fa-solid fa-circle" style="font-size:7px;animation:pulse 2s infinite"></i> Live · '+(typeof axCatalogueTotal==='function'?axCatalogueTotal():catalogue.length)+' products available';
    badge.style.background = 'rgba(34,197,94,.1)';
    badge.style.border = '1px solid rgba(34,197,94,.22)';
    badge.style.color = '#16A34A';
  } else if (catalogueSource === 'offline') {
    badge.innerHTML = '<i class="fa-solid fa-wifi-slash"></i> Could not reach server — <a onclick="loadCatalogue()" style="color:inherit;font-weight:700;cursor:pointer;text-decoration:underline">Retry</a>';
    badge.style.background = 'rgba(239,68,68,.08)';
    badge.style.border = '1px solid rgba(239,68,68,.2)';
    badge.style.color = '#DC2626';
  }
}

/* ── Scalable catalogue state (Phase 0) ──────────────────────────────
   The browser no longer pulls the ENTIRE catalogue. The default Trade feed
   comes from /catalogue/sections (bounded ~top-6 per section); search,
   category browsing and "See all" use /catalogue/search (paginated). This
   keeps the app fast whether there are 8 products or 80,000.
     _axSections    : the server-built section payload (default view)
     _axAllCategories: category names for the filter pills / quick-grid
     catalogue      : the pooled products across sections (stable) — used for
                      category names + any legacy per-index lookups
     filteredCatalogue: the CURRENTLY DISPLAYED array cards index into
     _axFlatMode    : true while showing a flat (search / category / see-all)
                      result set instead of the sectioned feed
     _axSearchCtx   : the active flat query + pagination cursor */
let _axSections = null;
let _axAllCategories = [];
let _axFlatMode = false;
let _axSearchCtx = { q: '', category: '', sort: '', label: '', offset: 0, total: 0, nextOffset: null, loading: false };
const AX_PAGE_SIZE = 24;

async function loadCatalogue() {
  showCatalogueSkeletons();
  let data = null;
  for (let attempt = 0; attempt < 2 && !data; attempt++) {
    try {
      const res = await fetch(LAMBDA_URL + '/catalogue/sections', {
        headers: { 'Content-Type': 'application/json', 'Accept': 'application/json', Authorization: 'Bearer ' + (localStorage.getItem('ax_google_token') || '') },
        signal: AbortSignal.timeout(attempt === 0 ? 10000 : 6000),
      });
      if (res.ok) data = typeof safeFetchJson === 'function' ? await safeFetchJson(res) : await res.json();
    } catch (e) {
      console.warn('[Catalogue] sections attempt', attempt + 1, 'failed:', e.message);
    }
  }
  if (!data) {
    catalogueSource = 'offline';
    _axSections = null; catalogue = []; filteredCatalogue = [];
    console.error('[Catalogue] sections load failed, showing empty state');
  } else {
    catalogueSource = 'live';
    _axSections = data;
    _axAllCategories = data.all_categories || [];
    // Pool every product shown across the sections into `catalogue` (stable,
    // deduped) so card indices and category names resolve.
    const pool = [];
    const seen = new Set();
    const add = (arr) => (arr || []).forEach(p => {
      const k = (p.shop_id || '') + '::' + (p.product_id || '');
      if (!seen.has(k)) { seen.add(k); pool.push(p); }
    });
    add(data.best_offers);
    (data.categories || []).forEach(c => add(c.products));
    add(data.top_rated);
    catalogue = pool;
  }
  _axFlatMode = false;
  filteredCatalogue = [...catalogue];
  renderCatalogue();
  buildCatalogueFilters();
  updateCatalogueSourceBadge();
}

/* Total product count for the "Live · N products available" badge — the
   server reports it even though we only ship a bounded page. */
function axCatalogueTotal() { return (_axSections && _axSections.total) || catalogue.length; }

function categoryIconFor(cat) {
  const c = (cat || '').toLowerCase();
  if (c.includes('wheat') || c.includes('grain') || c.includes('rice')) return 'fa-wheat-awn';
  if (c.includes('onion') || c.includes('vegetable') || c.includes('veg')) return 'fa-carrot';
  if (c.includes('chili') || c.includes('chilli') || c.includes('mirch') || c.includes('spice')) return 'fa-pepper-hot';
  if (c.includes('fruit')) return 'fa-apple-whole';
  if (c.includes('pulse') || c.includes('lentil') || c.includes('dal')) return 'fa-seedling';
  return 'fa-leaf';
}
function buildCatalogueFilters() {
  // Category names come from the server's section payload now, not from a
  // fully-loaded client catalogue.
  const cats = (_axAllCategories && _axAllCategories.length)
    ? _axAllCategories.slice().sort()
    : Array.from(new Set(catalogue.map(p => p.category_name || 'Other'))).sort();
  const wrap = document.getElementById('catalogueFilters');
  if (!wrap) return;
  wrap.classList.add('chip-scroll-fade');
  wrap.innerHTML = '<button class="filter-pill active" data-cat="all" type="button"><span class="cat-icon-circle"><i class="fa-solid fa-border-all"></i></span>All</button>';
  cats.forEach(cat => {
    const btn = document.createElement('button');
    btn.className = 'filter-pill';
    btn.type = 'button';
    btn.dataset.cat = cat;
    btn.innerHTML = '<span class="cat-icon-circle"><i class="fa-solid '+categoryIconFor(cat)+'"></i></span>' + cat;
    wrap.appendChild(btn);
  });
  if (typeof initPortalCatalogueFilter === 'function') initPortalCatalogueFilter();
}

/* Category pill / search box now drive a SERVER query (paginated) instead of
   filtering a fully-loaded client catalogue. "All" with no search returns to
   the sectioned feed. */
function filterCat(btn, cat) {
  document.querySelectorAll('#catalogueFilters .filter-pill').forEach(b => b.classList.remove('active'));
  if (btn) btn.classList.add('active');
  const search = gv('catalogueSearchInput').trim();
  if ((!cat || cat === 'all') && !search) { axExitFlat(); return; }
  axCatalogueSearch({
    q: search, category: (cat && cat !== 'all') ? cat : '',
    label: search ? ('Results for “' + search + '”') : (cat || 'All'),
  });
}

function filterSearch(val) {
  const activeCat = document.querySelector('#catalogueFilters .filter-pill.active')?.dataset?.cat || '';
  const cat = activeCat && activeCat !== 'all' ? activeCat : '';
  if (!val && !cat) { axExitFlat(); return; }
  axCatalogueSearch({
    q: val || '', category: cat,
    label: val ? ('Results for “' + val + '”') : (activeCat || 'All'),
  });
}

function getProductIcon(p) {
  const n = (p.product_name||'').toLowerCase();
  const c = (p.category_id||p.category_name||'').toLowerCase();
  if (n.includes('mirch')||n.includes('chilli')||n.includes('pepper')||n.includes('kashmiri')) return 'fa-solid fa-pepper-hot';
  if (n.includes('haldi')||n.includes('turmeric')) return 'fa-solid fa-mortar-pestle';
  if (n.includes('jeera')||n.includes('cumin')||n.includes('coriander')||n.includes('dhania')) return 'fa-solid fa-leaf';
  if (n.includes('rice')||n.includes('basmati')||n.includes('chawal')) return 'fa-solid fa-bowl-rice';
  if (n.includes('wheat')||n.includes('gehun')||n.includes('flour')||n.includes('atta')) return 'fa-solid fa-wheat-awn';
  if (n.includes('soy')||n.includes('chana')||n.includes('dal')||n.includes('pulse')||n.includes('lentil')) return 'fa-solid fa-circle-dot';
  if (n.includes('onion')||n.includes('pyaz')) return 'fa-solid fa-circle';
  if (n.includes('garlic')||n.includes('lahsun')) return 'fa-solid fa-asterisk';
  if (n.includes('sesame')||n.includes('til')) return 'fa-solid fa-seedling';
  if (n.includes('oil')||n.includes('tel')) return 'fa-solid fa-droplet';
  if (n.includes('sugar')||n.includes('jaggery')||n.includes('gur')) return 'fa-solid fa-cubes-stacked';
  if (n.includes('cotton')||n.includes('kapas')) return 'fa-solid fa-cloud';
  if (n.includes('maize')||n.includes('corn')||n.includes('makka')||n.includes('sorghum')||n.includes('jowar')) return 'fa-solid fa-wheat-awn';
  if (c.includes('spice')||c.includes('masala')) return 'fa-solid fa-mortar-pestle';
  if (c.includes('grain')||c.includes('cereal')) return 'fa-solid fa-wheat-awn';
  if (c.includes('veggie')||c.includes('vegetable')) return 'fa-solid fa-carrot';
  if (c.includes('seed')||c.includes('oil')) return 'fa-solid fa-seedling';
  if (c.includes('pulse')||c.includes('dal')) return 'fa-solid fa-circle-dot';
  if (c.includes('fruit')) return 'fa-solid fa-apple-whole';
  return 'fa-solid fa-seedling';
}

function likedProductsKey() {
  return currentUser ? 'ax_liked_products_' + currentUser.sub : 'ax_liked_products_guest';
}
function getLikedProducts() {
  try { return JSON.parse(localStorage.getItem(likedProductsKey()) || '[]'); } catch (e) { return []; }
}
function isProductLiked(key) {
  return getLikedProducts().indexOf(key) !== -1;
}
function toggleProductLike(ev, key, btn) {
  if (ev) ev.stopPropagation(); // don't trigger the card's own onclick (open product)
  let liked = getLikedProducts();
  const i = liked.indexOf(key);
  let nowLiked;
  if (i === -1) { liked.push(key); nowLiked = true; }
  else { liked.splice(i, 1); nowLiked = false; }
  localStorage.setItem(likedProductsKey(), JSON.stringify(liked));
  if (btn) {
    btn.classList.toggle('liked', nowLiked);
    const icon = btn.querySelector('i');
    if (icon) icon.className = (nowLiked ? 'fa-solid' : 'fa-regular') + ' fa-heart';
  }
  refreshFavouritesGridIfVisible();
  if (!currentUser || !localStorage.getItem('ax_google_token')) return;
  fetch(LAMBDA_URL + '/favourites/toggle', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + localStorage.getItem('ax_google_token') },
    body: JSON.stringify({ key: key, liked: nowLiked })
  }).then(function (res) {
    if (res.ok) return;
    var reverted = getLikedProducts();
    var at = reverted.indexOf(key);
    if (nowLiked && at !== -1) reverted.splice(at, 1);
    if (!nowLiked && at === -1) reverted.push(key);
    localStorage.setItem(likedProductsKey(), JSON.stringify(reverted));
    renderCatalogue();
    refreshFavouritesGridIfVisible();
    showToast('Could not save favourite. Please try again.', 'error');
  }).catch(function () {
    var reverted = getLikedProducts();
    var at = reverted.indexOf(key);
    if (nowLiked && at !== -1) reverted.splice(at, 1);
    if (!nowLiked && at === -1) reverted.push(key);
    localStorage.setItem(likedProductsKey(), JSON.stringify(reverted));
    renderCatalogue();
    refreshFavouritesGridIfVisible();
    showToast('Could not save favourite. Please try again.', 'error');
  });
}

/* Re-renders the standalone Favourites grid only when that panel is the one
   currently on screen — cheap no-op from the Trade tab, but on the
   Favourites page itself this is what makes an unliked card disappear
   immediately instead of waiting for the next panel switch. */
function refreshFavouritesGridIfVisible() {
  const favPanel = document.getElementById('panel-favourites');
  if (favPanel && favPanel.classList.contains('active') && typeof renderFavouritesGrid === 'function') {
    renderFavouritesGrid();
  }
}

async function syncFavourites() {
  if (!currentUser || !localStorage.getItem('ax_google_token')) return;
  try {
    const res = await fetch(LAMBDA_URL + '/favourites', { headers: { Authorization: 'Bearer ' + localStorage.getItem('ax_google_token'), Accept: 'application/json' } });
    const data = await res.json();
    if (res.ok && Array.isArray(data.liked_keys)) {
      localStorage.setItem(likedProductsKey(), JSON.stringify(data.liked_keys));
      if (typeof renderCatalogue === 'function') renderCatalogue();
    }
  } catch (e) { console.warn('[Favourites] sync failed', e); }
}

function renderStarRating(avg) {
  const n = parseFloat(avg) || 0;
  if (!n) {
    // §0-5: zero/no reviews yet — an empty 5-star row reads as "rated zero",
    // which is worse than showing nothing. Show only the New badge, no stars.
    return '<div class="product-card-rating"><span class="rating-count rating-count-new">New</span></div>';
  }
  // Inline-SVG stars instead of ★/☆ text glyphs: stroke-linejoin:round
  // softens every point (no sharp spikes), unfilled stars render as grey
  // outlines and filled ones as solid dark gold — see .ax-star in
  // portal-base.css. Flex row keeps the numeric score vertically centred
  // beside the stars instead of drifting on the text baseline.
  const filled = Math.round(Math.min(5, Math.max(0, n)));
  let stars = '';
  for (let i = 0; i < 5; i++) {
    stars += '<svg class="ax-star' + (i < filled ? ' filled' : '') + '" viewBox="0 0 24 24" aria-hidden="true"><path d="M12 3.8l2.44 4.95 5.46.79-3.95 3.85.93 5.44L12 16.26l-4.88 2.57.93-5.44-3.95-3.85 5.46-.79z"/></svg>';
  }
  return '<div class="product-card-rating"><span class="rating-stars rating-stars-svg">' + stars + '</span><span class="rating-count">' + n.toFixed(1) + '</span></div>';
}

/* Which array a card index refers to — 'catalogue' cards are indexed into
   filteredCatalogue (Trade tab), 'favourites' cards are indexed into
   favouritesCatalogue (standalone Favourites page). Keeping this as a small
   lookup (rather than window[name]) because these are `let`-scoped globals,
   not `var`, so they never attach to window. */
function productListBySource(source) {
  if (source === 'favourites') return favouritesCatalogue;
  if (source === 'shop') return window._axShopModalProducts || [];
  return filteredCatalogue;
}

/* Shared product-card markup used by both renderCatalogue() (Trade tab)
   and renderFavouritesGrid() (My Favourites page) — avoids maintaining two
   copies of the same card HTML. `source` tags the card's click handlers so
   they look the product back up in the right array. */
/* ── Product card media ───────────────────────────────────────────────
   One image  → plain <img> (unchanged).
   Several    → a swipeable carousel: auto-advances while on screen, and
                supports manual left/right swipe + tappable dots. Products
                upload up to 3 images (image_urls), which previously only
                ever showed the first one. */
function productCardMediaHtml(p, iconClass, hasImg, imgSrc) {
  const urls = (Array.isArray(p.image_urls) && p.image_urls.length
    ? p.image_urls
    : (hasImg ? [imgSrc] : [])
  ).filter(u => u && String(u).trim().length > 10);
  const placeholder = '<div class="product-card-placeholder"><i class="' + iconClass + '"></i></div>';
  if (!urls.length) return placeholder;
  if (urls.length === 1) {
    return '<img class="product-card-thumb" src="' + urls[0] + '" alt="' + p.product_name + '" loading="lazy" decoding="async" onerror="this.onerror=null;this.style.display=\'none\';this.nextElementSibling.style.display=\'flex\'">' +
      '<div class="product-card-placeholder" style="display:none"><i class="' + iconClass + '"></i></div>';
  }
  return '<div class="pc-carousel" data-idx="0" data-count="' + urls.length + '">' +
      '<div class="pc-carousel-track">' +
        urls.map(u => '<img class="product-card-thumb" src="' + u + '" alt="" loading="lazy" decoding="async">').join('') +
      '</div>' +
      '<div class="pc-carousel-dots">' +
        urls.map((_, i) => '<span class="pc-dot' + (i === 0 ? ' on' : '') + '"></span>').join('') +
      '</div>' +
    '</div>';
}

/* Move a carousel to a slide (wraps around). */
function axCarouselGo(el, idx) {
  const count = parseInt(el.dataset.count, 10) || 1;
  idx = ((idx % count) + count) % count;
  el.dataset.idx = idx;
  const track = el.querySelector('.pc-carousel-track');
  if (track) track.style.transform = 'translateX(-' + (idx * 100) + '%)';
  el.querySelectorAll('.pc-carousel-dots .pc-dot').forEach((d, i) => d.classList.toggle('on', i === idx));
}

/* Auto-advance — one shared timer for the whole page, and only for carousels
   currently on screen, so off-screen cards cost nothing. */
setInterval(function () {
  document.querySelectorAll('.pc-carousel').forEach(function (el) {
    if (el._paused) return;
    const r = el.getBoundingClientRect();
    if (r.bottom < 0 || r.top > (window.innerHeight || 0)) return;
    axCarouselGo(el, (parseInt(el.dataset.idx, 10) || 0) + 1);
  });
}, 3200);

/* Manual swipe. Auto-advance pauses briefly after a manual swipe, and the
   swipe must not also open the product modal — hence the click guard. */
document.addEventListener('touchstart', function (e) {
  const c = e.target.closest && e.target.closest('.pc-carousel');
  if (!c) return;
  c._x = e.touches[0].clientX;
  c._paused = true;
}, { passive: true });
document.addEventListener('touchend', function (e) {
  const c = e.target.closest && e.target.closest('.pc-carousel');
  if (!c || c._x == null) return;
  const dx = e.changedTouches[0].clientX - c._x;
  if (Math.abs(dx) > 35) {
    axCarouselGo(c, (parseInt(c.dataset.idx, 10) || 0) + (dx < 0 ? 1 : -1));
    c._swipedAt = Date.now();
  }
  c._x = null;
  clearTimeout(c._resume);
  c._resume = setTimeout(function () { c._paused = false; }, 4000);
}, { passive: true });
document.addEventListener('click', function (e) {
  const c = e.target.closest && e.target.closest('.pc-carousel');
  if (c && c._swipedAt && Date.now() - c._swipedAt < 400) {
    e.stopPropagation();
    e.preventDefault();
  }
}, true);

function buildProductCardHtml(p, idx, source) {
  source = source || 'catalogue';
  const iconClass = getProductIcon(p);
  const hasImg = p.image_url && p.image_url.trim().length > 10;
  const disc = typeof CatalogueUI !== 'undefined' ? CatalogueUI.priceDiscountInfo(p) : { show: false, pct: 0, mrpHtml: '', badgeHtml: '' };
  const usingLot = !!(p.lot_size_kg && p.lot_price);
  const priceNow = usingLot ? p.lot_price : p.price_per_kg;
  const priceHtml = priceNow
    ? '<div class="product-card-price-row"><span class="product-card-price-now">₹' + priceNow + '</span>' + disc.mrpHtml + '</div>' +
      (disc.show ? '<div class="product-card-discount-note">' + disc.pct + '% OFF on MRP</div>' : '')
    : '<div class="product-card-price-row"><span class="product-card-price-now product-card-price-unset">Contact for price</span></div>';
  const avail = parseFloat(p.available_stock_kg);
  const init = parseFloat(p.initial_stock_kg) || parseFloat(p.lot_size_kg) || 0;
  let stockLabel = p.available_stock || 'In Stock';
  if (!isNaN(avail) && avail >= 0) {
    stockLabel = init > 0 && avail < init
      ? (Math.round(avail) + ' kg left')
      : (Math.round(avail) + ' kg available');
    if (avail <= 0) stockLabel = 'Out of stock';
  }
  const stockTextLc = stockLabel.toLowerCase();
  const isOut = stockTextLc.includes('out') || avail === 0;
  const isLow = !isOut && init > 0 && avail / init <= 0.2;
  const stockColor = isOut ? '#EF4444' : (isLow ? '#EF4444' : '#22C55E');
  const stockUrgentStyle = isLow ? ' style="background:rgba(239,68,68,.08);border-radius:999px;padding:2px 9px;font-weight:800"' : '';
  const qtyLabel = (!isNaN(avail) && avail > 0)
    ? (Math.round(avail) + ' kg')
    : (usingLot ? ('1 lot (' + p.lot_size_kg + ' kg)') : (p.price_per_kg ? 'per kg' : ''));
  const imgSrc = hasImg ? p.image_url.trim() : '';
  const likeKey = (p.shop_id||'')+'::'+(p.product_id||idx);
  const isLiked = isProductLiked(likeKey);
  const ratingNum = parseFloat(p.avg_rating) || 0;
  const ratedBadge = ratingNum >= 4.5 ? '<span class="product-card-badge-rated">Top Rated</span>' : '';
  return '<div class="product-card product-card-reveal" style="animation-delay:'+Math.min(idx*35,350)+'ms" onclick="selectProductByIndex('+idx+',\''+source+'\')">' +
    '<div class="product-card-media">' +
      productCardMediaHtml(p, iconClass, hasImg, imgSrc) +
      ratedBadge +
      '<button type="button" class="product-card-like-btn'+(isLiked?' liked':'')+'" onclick="toggleProductLike(event,\''+likeKey+'\',this)"><i class="'+(isLiked?'fa-solid':'fa-regular')+' fa-heart"></i></button>' +
      (typeof axCartAdd === 'function' ? '<button type="button" class="product-card-plus-btn" onclick="axCartAddByIndex('+idx+',event,\''+source+'\',this)" aria-label="Add to cart"><i class="fa-solid fa-plus"></i></button>' : '') +
      '<div class="product-card-media-footer">' +
        (qtyLabel ? '<span class="product-card-qty-chip">'+qtyLabel+'</span>' : '<span></span>') +
        '<div class="product-card-btns">' +
          '<button type="button" class="product-card-add-btn" onclick="directBuyByIndex('+idx+',event,\''+source+'\')" aria-label="Buy now"><i class="fa-solid fa-bolt"></i></button>' +
        '</div>' +
      '</div>' +
    '</div>' +
    '<div class="product-card-body">' +
      priceHtml +
      '<div class="product-card-name">'+p.product_name+'</div>' +
      renderStarRating(p.avg_rating) +
      '<div class="product-card-stock"'+stockUrgentStyle+'><i class="fa-solid fa-circle" style="color:'+stockColor+'"></i> '+stockLabel+'</div>' +
    '</div></div>';
}

/* ══════════════════════════════════════════════════════════════
   TRADE TAB SECTIONED LAYOUT (Batch B3–B6)
   Default (no search, category = All) view is a rich, sectioned feed:
     Best Offers → Category 1 → Top-6 Shops → Category 2 → Category 3
     → Promotional Ad → remaining categories → Top Rated.
   As soon as a search term is typed OR a specific category pill is
   picked, we fall back to the original flat filtered grid so those
   flows are untouched. Cards index into filteredCatalogue (same object
   refs as `catalogue` in the default view) so click/buy handlers resolve
   correctly regardless of section grouping.
   ══════════════════════════════════════════════════════════════ */
const TRADE_PER_CATEGORY = 6;

function tradeSectionGridHtml(items) {
  return '<div class="product-grid trade-sec-grid">' +
    items.map(p => buildProductCardHtml(p, filteredCatalogue.indexOf(p), 'catalogue')).join('') +
  '</div>';
}
function tradeSectionHtml(title, iconClass, items, opts) {
  opts = opts || {};
  if (!items || !items.length) return '';
  const esc = (typeof escapeHtml === 'function') ? escapeHtml : (s => s);
  // "See all" appears only when the section is actually truncated.
  const more = (opts.total || items.length) > items.length;
  // Attribute-safe value: a single-quoted JS-string arg inside the double-quoted
  // onclick. JSON.stringify emitted double quotes that closed the attribute
  // early (e.g. category "Spices & Masale"), so See-all silently did nothing.
  const seeAllVal = String(opts.seeAllValue || '')
    .replace(/\\/g, '\\\\').replace(/'/g, "\\'").replace(/"/g, '&quot;');
  const seeAll = (more && opts.seeAllKind)
    ? '<button type="button" class="trade-seeall-btn" onclick="axTradeSeeAll(\'' + opts.seeAllKind + '\', \'' + seeAllVal + '\')">See all ' + (opts.total || '') + ' <i class="fa-solid fa-chevron-right"></i></button>'
    : '';
  return '<section class="trade-section' + (opts.cls ? ' ' + opts.cls : '') + '">' +
    '<div class="trade-section-head">' +
      '<span class="trade-section-title">' + (iconClass ? '<i class="' + iconClass + '"></i> ' : '') + esc(title) + '</span>' +
      (opts.badge ? '<span class="trade-section-badge">' + esc(opts.badge) + '</span>' : '') +
      seeAll +
    '</div>' +
    tradeSectionGridHtml(items) +
  '</section>';
}

/* ── Flat (search / category / see-all) view via /catalogue/search ────
   Everything that used to filter the whole in-browser catalogue now runs a
   PAGINATED server query, so results are complete (not just what page 1
   happened to load) and the payload stays small. `label` drives the header
   shown above the grid; empty label = a plain search with no header. */
async function axCatalogueSearch(opts, append) {
  opts = opts || {};
  _axFlatMode = true;
  const grid = document.getElementById('productGrid');
  if (!append && grid) showCatalogueSkeletons();
  const offset = append ? _axSearchCtx.offset : 0;
  const params = new URLSearchParams();
  if (opts.q) params.set('q', opts.q);
  if (opts.category && opts.category !== 'all') params.set('category', opts.category);
  if (opts.sort) params.set('sort', opts.sort);
  if (opts.shop_id) params.set('shop_id', opts.shop_id);
  params.set('limit', AX_PAGE_SIZE);
  params.set('offset', offset);
  _axSearchCtx.loading = true;
  let data = { products: [], total: 0, next_offset: null };
  try {
    const res = await fetch(LAMBDA_URL + '/catalogue/search?' + params.toString(), { headers: { Accept: 'application/json', Authorization: 'Bearer ' + (localStorage.getItem('ax_google_token') || '') } });
    if (res.ok) data = typeof safeFetchJson === 'function' ? await safeFetchJson(res) : await res.json();
  } catch (e) { console.warn('[Catalogue] search failed', e); }
  _axSearchCtx = {
    q: opts.q || '', category: opts.category || '', sort: opts.sort || '', shop_id: opts.shop_id || '',
    label: opts.label || '', total: data.total || 0, offset: offset + AX_PAGE_SIZE,
    nextOffset: data.next_offset, loading: false,
  };
  filteredCatalogue = append ? filteredCatalogue.concat(data.products || []) : (data.products || []);
  renderCatalogue();
  if (!append) document.getElementById('productGrid')?.scrollIntoView({ behavior: 'smooth', block: 'start' });
}
function axCatalogueLoadMore() {
  if (_axSearchCtx.nextOffset == null || _axSearchCtx.loading) return;
  return axCatalogueSearch({
    q: _axSearchCtx.q, category: _axSearchCtx.category, sort: _axSearchCtx.sort,
    shop_id: _axSearchCtx.shop_id, label: _axSearchCtx.label,
  }, true);
}
/* Leave flat mode → back to the sectioned feed. */
function axExitFlat() {
  _axFlatMode = false;
  filteredCatalogue = [...catalogue];
  const input = document.getElementById('catalogueSearchInput');
  if (input) input.value = '';
  document.querySelectorAll('#catalogueFilters .filter-pill').forEach(b => b.classList.toggle('active', b.dataset.cat === 'all'));
  renderCatalogue();
}

/* ── "See all" from a section → a flat, paginated category/offers/rated view. */
let _axTradeSeeAll = null; // kept for compatibility with older callers
function axTradeSeeAll(kind, value) {
  if (kind === 'category') axCatalogueSearch({ category: value, label: value });
  else if (kind === 'offers') axCatalogueSearch({ sort: 'offers', label: 'Best Offers' });
  else if (kind === 'rated') axCatalogueSearch({ sort: 'rated', label: 'Top Rated' });
}
function axTradeSeeAllClear() { axExitFlat(); }

/* Top-6 shops strip inside the Trade feed — reuses the same .ax-star-shop-cell
   card the home tab used (that home section is now hidden — moved here per
   request) and the /shops/top endpoint (cached in window._axTopShops). Each
   cell carries a favourite heart too. */
async function renderTradeTopShops() {
  const list = document.getElementById('tradeTopShopsList');
  if (!list) return;
  const esc = (typeof escapeHtml === 'function') ? escapeHtml : (s => s);
  const hideSection = () => { const sec = list.closest('.trade-topshops'); if (sec) sec.style.display = 'none'; };
  try {
    let shops = window._axTopShops;
    if (!shops) {
      const res = await fetch(LAMBDA_URL + '/shops/top', { headers: { Accept: 'application/json', Authorization: 'Bearer ' + (localStorage.getItem('ax_google_token') || '') } });
      const data = await res.json();
      shops = data.shops || [];
      window._axTopShops = shops;
    }
    await loadFavShopIds();
    shops = shops.slice(0, 6);
    if (!shops.length) { hideSection(); return; }
    list.innerHTML = shops.map(shop => {
      const name = shop.shop_name || 'Unnamed Shop';
      const initials = name.trim().split(/\s+/).map(w => w[0]).join('').slice(0, 2).toUpperCase();
      const photo = shop.shop_logo_url
        ? '<img class="ax-star-shop-photo" src="' + esc(shop.shop_logo_url) + '" alt="" loading="lazy">'
        : '<div class="ax-star-shop-photo ax-star-shop-initials">' + esc(initials || 'S') + '</div>';
      const favd = isShopFav(shop.shop_id);
      const sid = esc(shop.shop_id);
      return '<button type="button" class="ax-star-shop-cell" onclick="navigateToShop(\'' + sid + '\')">' +
        photo +
        '<div class="ax-star-shop-name">' + esc(name) + '</div>' +
        '<div class="ax-star-shop-meta">' +
          '<span class="ax-star-shop-rating"><i class="fa-solid fa-star"></i> ' + (shop.avg_rating || 0) + '</span>' +
          '<span class="ax-star-shop-likes"><i class="fa-solid fa-heart"></i> ' + (shop.like_count || 0) + '</span>' +
        '</div>' +
        '<span class="ax-star-shop-fav ax-shop-row-fav' + (favd ? ' liked' : '') + '" onclick="event.stopPropagation();toggleShopFav(event,\'' + sid + '\',this)"><i class="' + (favd ? 'fa-solid' : 'fa-regular') + ' fa-heart"></i></span>' +
      '</button>';
    }).join('');
  } catch (e) { console.warn('[TradeTopShops] failed', e); hideSection(); }
}

function renderCatalogue() {
  const grid = document.getElementById('productGrid');
  if (!grid) return;
  if (typeof axHideLoader === 'function') axHideLoader(grid);
  if (_axFlatMode) { renderCatalogueFlat(grid); return; }
  renderCatalogueSections(grid);
}

/* Flat, paginated result set (search / category / see-all). */
function renderCatalogueFlat(grid) {
  const esc = (typeof escapeHtml === 'function') ? escapeHtml : (s => s);
  grid.classList.add('trade-sectioned');
  if (!filteredCatalogue.length && !_axSearchCtx.loading) {
    grid.innerHTML =
      '<div class="trade-seeall-head">' +
        '<button type="button" class="trade-seeall-back" onclick="axExitFlat()" aria-label="Back"><i class="fa-solid fa-arrow-left"></i></button>' +
        '<span class="trade-seeall-title">' + esc(_axSearchCtx.label || 'Search') + '</span></div>' +
      '<div style="text-align:center;padding:var(--s7);color:var(--c-text3)"><div class="empty-icon-wrap"><i class="fa-solid fa-magnifying-glass"></i></div>' +
        '<div style="font-size:16px;font-weight:600;">No products found</div>' +
        '<div style="font-size:13px;margin-top:8px">Try a different search or category</div></div>';
    return;
  }
  const header =
    '<div class="trade-seeall-head">' +
      '<button type="button" class="trade-seeall-back" onclick="axExitFlat()" aria-label="Back"><i class="fa-solid fa-arrow-left"></i></button>' +
      '<span class="trade-seeall-title">' + esc(_axSearchCtx.label || 'Results') + '</span>' +
      '<small>' + (_axSearchCtx.total || filteredCatalogue.length) + ' products</small>' +
    '</div>';
  const more = _axSearchCtx.nextOffset != null
    ? '<div class="trade-loadmore"><button type="button" class="btn-sm-outline" onclick="axCatalogueLoadMore()"><i class="fa-solid fa-angles-down"></i> Load more</button></div>'
    : '';
  grid.innerHTML = header +
    '<div class="product-grid trade-sec-grid">' +
      filteredCatalogue.map((p, idx) => buildProductCardHtml(p, idx, 'catalogue')).join('') +
    '</div>' + more;
}

/* Default sectioned feed, built from the server's bounded /catalogue/sections
   payload (_axSections) — no full catalogue in the browser. */
function renderCatalogueSections(grid) {
  const s = _axSections;
  if (!s || !((s.best_offers && s.best_offers.length) || (s.categories && s.categories.length) || (s.top_rated && s.top_rated.length))) {
    grid.classList.remove('trade-sectioned');
    grid.innerHTML = '<div style="grid-column:1/-1;text-align:center;padding:var(--s7);color:var(--c-text3)">' +
      '<div class="empty-icon-wrap"><i class="fa-solid fa-store"></i></div>' +
      '<div style="font-size:17px;font-weight:700;color:var(--c-text2);margin-bottom:8px">Products coming soon</div>' +
      '<div style="font-size:13px;line-height:1.6">Sellers are onboarding right now.<br>Check back shortly or <a onclick="switchPanel(\'sell\')" style="color:var(--c-leaf2);font-weight:700;cursor:pointer">list your own produce →</a></div>' +
      '</div>';
    return;
  }
  grid.classList.add('trade-sectioned');
  const cats = s.categories || [];
  // Cards resolve by their index in filteredCatalogue. best_offers / category
  // / top_rated are SEPARATE object instances (even for the same product)
  // after JSON parse, so every rendered instance must be pooled here — before
  // any tradeSectionHtml() call runs its indexOf().
  filteredCatalogue = [];
  (s.best_offers || []).forEach(p => filteredCatalogue.push(p));
  cats.forEach(c => (c.products || []).forEach(p => filteredCatalogue.push(p)));
  (s.top_rated || []).forEach(p => filteredCatalogue.push(p));
  const catSec = (c) => tradeSectionHtml(c.name, 'fa-solid ' + categoryIconFor(c.name), c.products || [],
    { total: c.total || (c.products || []).length, seeAllKind: 'category', seeAllValue: c.name });
  let html = '';
  html += tradeSectionHtml('Best Offers', 'fa-solid fa-bolt', s.best_offers || [],
    { cls: 'trade-offers', badge: 'Limited time', total: s.best_offers_total || (s.best_offers || []).length, seeAllKind: 'offers' });
  if (cats[0]) html += catSec(cats[0]);
  html += '<section class="trade-section trade-topshops">' +
    '<div class="trade-section-head"><span class="trade-section-title"><i class="fa-solid fa-trophy"></i> Top Shops</span></div>' +
    '<div class="ax-star-shops-grid trade-topshops-grid" id="tradeTopShopsList"></div></section>';
  if (cats[1]) html += catSec(cats[1]);
  if (cats[2]) html += catSec(cats[2]);
  html += '<div id="tradeMidAdSlot" class="trade-mid-ad"></div>';
  for (let i = 3; i < cats.length; i++) html += catSec(cats[i]);
  html += tradeSectionHtml('Top Rated', 'fa-solid fa-star', s.top_rated || [],
    { cls: 'trade-highrated', total: s.top_rated_total || (s.top_rated || []).length, seeAllKind: 'rated' });
  grid.innerHTML = html;
  renderTradeTopShops();
  if (typeof mpLoadTradeMidCarousel === 'function') {
    mpLoadTradeMidCarousel('tradeMidAdSlot');
  } else if (typeof mpLoadBanner === 'function') {
    mpLoadBanner('trade_mid', 'tradeMidAdSlot');
  }
  if (typeof mpLoadBanner === 'function') {
    mpLoadBanner('trade_bottom', 'tradeBottomAdSlot');
  }
}

/* Standalone "My Favourites" page (see panel-favourites) — filters the
   full catalogue down to whatever the user has liked, using the same
   likeKey convention as renderCatalogue(). This is deliberately separate
   from the Trade tab's own catalogue, which always shows everything
   (see applyPortalCatalogueFilters — no favourites filtering there). */
async function renderFavouritesGrid() {
  const searchInput = document.getElementById('favSearchInput');
  if (searchInput) searchInput.value = '';
  document.getElementById('favSearchClearBtn')?.classList.remove('show');
  // Liked products come from the server now (the full catalogue is no longer
  // in the browser, so we can't filter it locally). Falls back to the
  // localStorage like-keys against whatever pooled catalogue we do have if the
  // signed-in fetch isn't available.
  let liked = null;
  if (currentUser && localStorage.getItem('ax_google_token')) {
    try {
      const res = await fetch(LAMBDA_URL + '/favourites/products', {
        headers: { Authorization: 'Bearer ' + localStorage.getItem('ax_google_token'), Accept: 'application/json' },
      });
      if (res.ok) { const data = await res.json(); liked = data.products || []; }
    } catch (e) { console.warn('[Favourites] products fetch failed', e); }
  }
  if (liked === null) {
    liked = catalogue.filter((p, idx) => isProductLiked((p.shop_id || '') + '::' + (p.product_id || idx)));
  }
  favouritesCatalogue = liked;
  favouritesCatalogueAll = favouritesCatalogue.slice();
  renderFavouritesGridCards();
}

/* Renders whatever is currently in `favouritesCatalogue` (the full liked
   list, or a text/category-filtered subset of it — see filterFavouritesGrid
   / filterFavouritesGridByCategory below). Kept separate from
   renderFavouritesGrid() so filtering never re-fetches the like-state from
   `catalogue`, it just re-slices the already-known liked list. */
function renderFavouritesGridCards() {
  const grid = document.getElementById('favouritesGrid');
  if (!grid) return;
  if (!favouritesCatalogue.length) {
    const noneAtAll = !favouritesCatalogueAll.length;
    grid.innerHTML = '<div class="ax-fav-empty" style="grid-column:1/-1">' +
      (typeof CatalogueUI !== 'undefined'
        ? CatalogueUI.emptyStateHtml({
            icon: noneAtAll ? 'fa-heart' : 'fa-magnifying-glass',
            title: noneAtAll ? 'No favourites yet' : 'No matches',
            message: noneAtAll
              ? "Go to Trade and tap the heart icon on a product to save it here."
              : "No favourites match your search."
          })
        : '<div class="empty-icon-wrap"><i class="fa-solid fa-heart"></i></div><div style="font-size:16px;font-weight:600;">' + (noneAtAll ? 'No favourites yet' : 'No matches') + '</div><div style="font-size:13px;margin-top:8px">' + (noneAtAll ? 'Go to Trade and tap the heart icon on a product to save it here.' : 'No favourites match your search.') + '</div>') +
      '</div>';
    return;
  }
  grid.innerHTML = favouritesCatalogue.map((p, idx) => buildProductCardHtml(p, idx, 'favourites')).join('');
}

/* ══════════════════════════════════════════════════════════════
   AX SEARCH BAR + CATEGORY QUICK-GRID (Prompt 4.txt Tasks B/D/E)
   Shared full-screen category grid opened by tapping the leading icon
   on the Home, Trade or Favourites search bars. Home has no catalogue
   grid of its own so it redirects into Trade; Favourites filters its
   own already-loaded liked list in place; Trade reuses the existing
   #catalogueFilters pills so filtering logic is never duplicated.
   ══════════════════════════════════════════════════════════════ */
let axCategoryGridSource = 'trade';
function axSourceInputId() {
  return axCategoryGridSource === 'favourites' ? 'favSearchInput' : 'catalogueSearchInput';
}

/* Admin-uploaded category photos (see admin_dashboard.html "Category
   Images" card) — fetched once and cached; falls back to the generic
   categoryIconFor() icon for any category that has no photo configured.
   Keys are lowercased so admin-entered casing never has to exactly match
   the catalogue's category_name. */
let axCategoryImages = null;
let axCategoryImagesPromise = null;
let axCategoryImageNames = []; // original-casing names from the admin config
function fetchCategoryImages(force) {
  // `force` re-fetches so categories the admin just added show up on the
  // next grid open without a full page reload (the old always-cached
  // version is why "maine do category add kiye lekin purani hi dikh rahi
  // hai" happened).
  if (axCategoryImagesPromise && !force) return axCategoryImagesPromise;
  axCategoryImagesPromise = fetch(LAMBDA_URL + '/category/images?t=' + Date.now(), { headers: { Accept: 'application/json' }, cache: 'no-store' })
    .then(res => res.json())
    .then(data => {
      const raw = (data && data.images) || {};
      axCategoryImages = {};
      axCategoryImageNames = Object.keys(raw);
      Object.keys(raw).forEach(k => { axCategoryImages[k.toLowerCase()] = raw[k]; });
      return axCategoryImages;
    })
    .catch(() => { axCategoryImages = axCategoryImages || {}; return axCategoryImages; });
  return axCategoryImagesPromise;
}
function categoryImageFor(cat) {
  return axCategoryImages ? axCategoryImages[(cat || '').toLowerCase()] : null;
}
function renderCategoryGridItems(cats) {
  const grid = document.getElementById('axCategoryGrid');
  if (!grid) return;
  // "All" always leads; every real category follows; "Other" always closes
  // the list (fallback bucket for products whose category was deleted).
  const allTile = '<button type="button" class="ax-category-grid-item" onclick="selectQuickCategory(\'__ALL__\')">' +
    '<span class="cat-icon-circle cat-icon-all"><i class="fa-solid fa-border-all"></i></span><span class="label">All</span></button>';
  grid.innerHTML = allTile + (cats.length
    ? cats.map(cat => {
        const img = categoryImageFor(cat);
        const tile = img
          ? '<span class="cat-icon-circle cat-icon-photo" style="background-image:url(&quot;' + img.replace(/"/g, '%22') + '&quot;)"></span>'
          : '<span class="cat-icon-circle"><i class="fa-solid ' + categoryIconFor(cat) + '"></i></span>';
        return '<button type="button" class="ax-category-grid-item" onclick=\'selectQuickCategory(' + JSON.stringify(cat) + ')\'>' + tile + '<span class="label">' + cat.replace(/</g, '&lt;') + '</span></button>';
      }).join('')
    : '');
}

/* Merged category list: product categories (live catalogue) + every
   category the admin configured an image for — so a brand-new category
   with no products yet still appears — with "Other" pinned last. */
function axAllCategoryNames() {
  const seen = {};
  const out = [];
  const add = (name) => {
    const key = (name || '').trim().toLowerCase();
    if (!key || key === 'other' || seen[key]) return;
    seen[key] = true;
    out.push(name.trim());
  };
  catalogue.forEach(p => add(p.category_name || 'Other'));
  axCategoryImageNames.forEach(add);
  out.sort((a, b) => a.toLowerCase().localeCompare(b.toLowerCase()));
  out.push('Other');
  return out;
}

/* ── ONE canonical category list everywhere ──────────────────────────
   Every category <select> in the app (Add Product, Create Shop, Edit Shop)
   used to be hardcoded to the same 5 options, so categories the admin added
   in the dashboard never showed up there — only in the search quick-grid.
   These now all render from axAllCategoryNames(): live catalogue categories
   MERGED with every category configured in the admin dashboard. */
const AX_CATEGORY_SELECT_IDS = ['prodCategory', 'shopCategory', 'editShopCategory'];
function axPopulateCategorySelects() {
  const names = axAllCategoryNames();
  if (!names.length) return;
  AX_CATEGORY_SELECT_IDS.forEach(id => {
    const sel = document.getElementById(id);
    if (!sel) return;
    const prev = sel.value;
    sel.innerHTML = names.map(n => '<option>' + String(n).replace(/</g, '&lt;') + '</option>').join('');
    if (prev && names.indexOf(prev) !== -1) sel.value = prev;
  });
}
/* Re-fetch the admin category config, then refresh the selects — call this
   right before showing any form that contains one. */
function axRefreshCategorySelects() {
  return fetchCategoryImages(true).then(axPopulateCategorySelects).catch(() => {});
}
document.addEventListener('DOMContentLoaded', function () {
  setTimeout(axRefreshCategorySelects, 1200);
});

/* Add Product modal opener — refreshes the category list first so a category
   the admin just added is immediately selectable. */
function mpOpenAddProduct() {
  axRefreshCategorySelects();
  document.getElementById('addProductModal')?.classList.add('open');
}

/* ── Price alerts (Phase 1) ──────────────────────────────────────────
   "Notify me when <product/category> drops to ₹X/kg." Repeat buyers return
   for exactly this. Backend fires the alert when a matching product is listed
   or re-priced lower. */
async function axOpenPriceAlerts(prefillTerm) {
  let ov = document.getElementById('axPriceAlertSheet');
  if (ov) ov.remove();
  ov = document.createElement('div');
  ov.id = 'axPriceAlertSheet';
  ov.className = 'ax-comments-overlay';
  ov.innerHTML = '<div class="ax-alert-box">' +
    '<div class="ax-comments-head"><b><i class="fa-solid fa-bell"></i> Price alerts</b>' +
      '<button type="button" class="ax-strip-icon-btn" onclick="document.getElementById(\'axPriceAlertSheet\').remove()" aria-label="Close"><i class="fa-solid fa-xmark"></i></button></div>' +
    '<div class="ax-alert-create">' +
      '<input type="text" id="axAlertTerm" maxlength="60" placeholder="Product or category (e.g. Onion)" value="' + (prefillTerm ? String(prefillTerm).replace(/"/g, '&quot;') : '') + '">' +
      '<input type="number" id="axAlertPrice" min="1" placeholder="₹/kg">' +
      '<button type="button" class="btn-primary btn-sm" onclick="axCreatePriceAlert()"><i class="fa-solid fa-plus"></i></button>' +
    '</div>' +
    '<div id="axAlertList" class="ax-alert-list"><p class="ax-feed-loading"><i class="fa-solid fa-spinner fa-spin"></i> Loading…</p></div>' +
  '</div>';
  ov.addEventListener('click', function (e) { if (e.target === ov) ov.remove(); });
  document.body.appendChild(ov);
  axRenderPriceAlerts();
}
async function axRenderPriceAlerts() {
  const list = document.getElementById('axAlertList');
  if (!list) return;
  const data = (typeof mpApi === 'function') ? await mpApi('/alert/list') : {};
  const alerts = (data && data.alerts) || [];
  if (!alerts.length) { list.innerHTML = '<p class="ax-alert-empty">No alerts yet. Add one above.</p>'; return; }
  list.innerHTML = alerts.map(function (a) {
    return '<div class="ax-alert-row"><span><b>' + String(a.term).replace(/</g, '&lt;') + '</b> at or below ₹' + a.target_price + '/kg</span>' +
      '<button type="button" class="ax-alert-del" onclick="axDeletePriceAlert(\'' + a.alert_id + '\')" aria-label="Remove"><i class="fa-solid fa-trash-can"></i></button></div>';
  }).join('');
}
async function axCreatePriceAlert() {
  const term = (document.getElementById('axAlertTerm')?.value || '').trim();
  const price = parseFloat(document.getElementById('axAlertPrice')?.value || '0');
  if (!term || !price) { showToast('Enter a product and target price', 'warning'); return; }
  const data = await mpApi('/alert/create', { method: 'POST', body: JSON.stringify({ term: term, target_price: price }) });
  if (data && data.success) {
    document.getElementById('axAlertPrice').value = '';
    showToast('Alert set — we’ll notify you', 'success');
    axRenderPriceAlerts();
  } else showToast((data && data.error) || 'Could not set alert', 'error');
}
async function axDeletePriceAlert(id) {
  const data = await mpApi('/alert/delete', { method: 'POST', body: JSON.stringify({ alert_id: id }) });
  if (data && data.success) axRenderPriceAlerts();
}

function openCategoryQuickGrid(source) {
  axCategoryGridSource = source || 'trade';
  axSetQuickGridMode('categories');
  renderCategoryGridItems(axAllCategoryNames());
  // Always re-fetch the admin category config in the background so newly
  // added categories/images appear without a page reload.
  fetchCategoryImages(true).then(() => renderCategoryGridItems(axAllCategoryNames()));
  const sourceInput = document.getElementById(axSourceInputId());
  const overlayInput = document.getElementById('axCategoryGridSearchInput');
  if (overlayInput) {
    overlayInput.value = sourceInput ? sourceInput.value : '';
    if (sourceInput) overlayInput.placeholder = sourceInput.placeholder;
  }
  document.getElementById('axCategoryGridOverlay')?.classList.add('open');
  document.body.style.overflow = 'hidden';
  axSyncQuickGridActionBtn();
  setTimeout(() => overlayInput && overlayInput.focus(), 50);
}

/* ── Categories | Shops toggle inside the quick grid ── */
let axQuickGridMode = 'categories';
let axShopsCache = null;
function axSetQuickGridMode(mode) {
  axQuickGridMode = mode;
  const catGrid = document.getElementById('axCategoryGrid');
  const shopList = document.getElementById('axShopsGridList');
  const label = document.getElementById('axCategoryGridLabel');
  document.querySelectorAll('.ax-grid-mode-btn').forEach(b => b.classList.toggle('active', b.dataset.mode === mode));
  if (catGrid) catGrid.style.display = mode === 'categories' ? '' : 'none';
  if (shopList) shopList.style.display = mode === 'shops' ? '' : 'none';
  if (label) label.textContent = mode === 'shops' ? 'Browse shops' : 'Browse by category';
  if (mode === 'shops') axRenderShopsGrid();
}
async function axRenderShopsGrid() {
  const list = document.getElementById('axShopsGridList');
  if (!list) return;
  if (!axShopsCache) {
    list.innerHTML = '<p class="ax-category-grid-empty"><i class="fa-solid fa-spinner fa-spin"></i> Loading shops…</p>';
    try {
      const res = await fetch(LAMBDA_URL + '/shop/list?limit=100', { headers: { Accept: 'application/json', Authorization: 'Bearer ' + (localStorage.getItem('ax_google_token') || '') } });
      const data = await res.json();
      axShopsCache = data.shops || [];
    } catch (e) {
      list.innerHTML = '<p class="ax-category-grid-empty">Could not load shops — try again.</p>';
      return;
    }
  }
  if (!axShopsCache.length) {
    list.innerHTML = '<p class="ax-category-grid-empty">No shops yet.</p>';
    return;
  }
  await loadFavShopIds();
  list.innerHTML = axShopsCache.map(s => {
    const initials = (s.shop_name || 'S').trim().split(/\s+/).map(w => w[0]).join('').slice(0, 2).toUpperCase();
    const meta = [s.shop_category, [s.address_city, s.address_state].filter(Boolean).join(', ')].filter(Boolean).join(' · ');
    const sidJson = JSON.stringify(s.shop_id);
    const favd = isShopFav(s.shop_id);
    return '<div class="ax-shop-row" onclick=\'axOpenShopFromGrid(' + sidJson + ')\'>' +
      '<span class="ax-shop-row-avatar">' + (s.shop_logo_url ? '<img src="' + s.shop_logo_url.replace(/"/g, '%22') + '" alt="">' : initials) + '</span>' +
      '<span class="ax-shop-row-info"><b>' + String(s.shop_name || s.shop_id).replace(/</g, '&lt;') + '</b>' +
        '<small>' + String(meta || 'Verified seller').replace(/</g, '&lt;') + '</small></span>' +
      '<span class="ax-shop-row-meta"><span><i class="fa-solid fa-star"></i> ' + (s.avg_rating || 0) + '</span>' +
        '<span>' + (s.product_count || 0) + ' products</span></span>' +
      '<button type="button" class="ax-shop-row-fav' + (favd ? ' liked' : '') + '" onclick=\'event.stopPropagation();toggleShopFav(event,' + sidJson + ',this)\' aria-label="Save shop"><i class="' + (favd ? 'fa-solid' : 'fa-regular') + ' fa-heart"></i></button>' +
    '</div>';
  }).join('');
}
function axOpenShopFromGrid(shopId) {
  closeCategoryQuickGrid();
  if (window.ProductModal && typeof ProductModal.openShopProfile === 'function') {
    ProductModal.openShopProfile(shopId);
  }
}
function closeCategoryQuickGrid() {
  document.getElementById('axCategoryGridOverlay')?.classList.remove('open');
  document.body.style.overflow = '';
}
/* Typing inside the full-screen grid's own search field mirrors straight
   back to whichever page-level bar opened it, reusing THAT bar's existing
   filter pipeline (Trade's applyPortalCatalogueFilters via a real 'input'
   event, Favourites' filterFavouritesGrid directly) instead of building a
   second, parallel filtering implementation here. */
let axGridTypeTimer = null;

/* The trailing button in the quick-grid search row doubles as Close (empty
   field) and Submit (something typed) — see the markup in portal.html. */
function axSyncQuickGridActionBtn() {
  const btn = document.getElementById('axQuickGridActionBtn');
  const val = (document.getElementById('axCategoryGridSearchInput')?.value || '').trim();
  if (!btn) return;
  const submitMode = val.length > 0;
  btn.classList.toggle('is-submit', submitMode);
  btn.setAttribute('aria-label', submitMode ? 'Search' : 'Close');
  btn.innerHTML = submitMode
    ? '<i class="fa-solid fa-magnifying-glass"></i>'
    : '<i class="fa-solid fa-xmark"></i>';
}
function axQuickGridAction() {
  const val = (document.getElementById('axCategoryGridSearchInput')?.value || '').trim();
  if (val) axQuickGridSubmit();
  else closeCategoryQuickGrid();
}
/* Enter / submit: close the overlay and show the matching products in the
   Trade tab (previously the overlay just stayed open and nothing "happened"). */
function axQuickGridSubmit() {
  const val = (document.getElementById('axCategoryGridSearchInput')?.value || '').trim();
  clearTimeout(axGridTypeTimer);
  const sourceInput = document.getElementById(axSourceInputId());
  if (sourceInput) sourceInput.value = val;
  closeCategoryQuickGrid();
  if (axCategoryGridSource === 'favourites') {
    filterFavouritesGrid(val);
    return;
  }
  // Trade: a shop-ID style query opens that shop directly, otherwise run the
  // server search (paginated).
  if (val && typeof ProductModal !== 'undefined' && ProductModal.searchShop && ProductModal.searchShop(val)) return;
  filterSearch(val);
}

function axCategoryGridSearchChanged(val) {
  const sourceInput = document.getElementById(axSourceInputId());
  if (sourceInput) sourceInput.value = val;
  axSyncQuickGridActionBtn();
  // Debounced: the downstream filters rebuild whole product grids, which
  // made typing in this overlay stutter on mobile.
  clearTimeout(axGridTypeTimer);
  axGridTypeTimer = setTimeout(() => {
    if (axCategoryGridSource === 'favourites') {
      filterFavouritesGrid(val);
    } else if (sourceInput) {
      sourceInput.dispatchEvent(new Event('input'));
    }
  }, 180);
}
function selectQuickCategory(cat) {
  closeCategoryQuickGrid();
  if (cat === '__ALL__') {
    // "All" tile: clear every filter and show the full list again.
    if (axCategoryGridSource === 'favourites') renderFavouritesGrid();
    else filterCatalogueByCategoryName('all');
    return;
  }
  if (axCategoryGridSource === 'favourites') {
    filterFavouritesGridByCategory(cat);
  } else {
    filterCatalogueByCategoryName(cat);
  }
}
/* Drives the category filter through the SAME #catalogueFilters pills +
   applyPortalCatalogueFilters() pipeline the Trade tab already uses, by
   simulating a click on the matching pill — avoids a second, parallel
   filtering implementation that could drift out of sync with the first. */
function filterCatalogueByCategoryName(cat) {
  const input = document.getElementById('catalogueSearchInput');
  if (input) input.value = '';
  // Reflect the active pill, then run the server category query.
  document.querySelectorAll('#catalogueFilters .filter-pill').forEach(b => b.classList.toggle('active', b.dataset.cat === cat));
  if (!cat || cat === 'all') { axExitFlat(); return; }
  axCatalogueSearch({ category: cat, label: cat });
}

/* Favourites: filters the already-loaded liked-products list in place —
   no navigation, no backend call needed. */
function filterFavouritesGrid(query) {
  const q = (query || '').trim().toLowerCase();
  document.getElementById('favSearchClearBtn')?.classList.toggle('show', !!q);
  favouritesCatalogue = !q ? favouritesCatalogueAll.slice() : favouritesCatalogueAll.filter(p =>
    [p.product_name, p.category_name, p.shop_id, p.shop_name].join(' ').toLowerCase().includes(q)
  );
  renderFavouritesGridCards();
}
function filterFavouritesGridByCategory(cat) {
  const searchInput = document.getElementById('favSearchInput');
  if (searchInput) searchInput.value = '';
  document.getElementById('favSearchClearBtn')?.classList.remove('show');
  favouritesCatalogue = favouritesCatalogueAll.filter(p => (p.category_name || 'Other') === cat);
  renderFavouritesGridCards();
}

/* Clear-button show/hide sync for the Home + Favourites search bars —
   lightweight standalone version of the sync CatalogueUI.initFilterDropdown()
   already does for Trade's #catalogueSearchInput, since those two bars have
   no filter-dropdown menu (they open the full-screen category grid instead,
   see openCategoryQuickGrid above) and so can't reuse that function (it
   requires a menu element to be found before wiring anything). */
function wireSimpleSearchClear(inputId, clearId, onInput) {
  const input = document.getElementById(inputId);
  const clearBtn = document.getElementById(clearId);
  if (!input || !clearBtn) return;
  function sync() { clearBtn.classList.toggle('show', !!input.value.trim()); }
  // Debounce the grid-rebuilding filter callback (typing lag fix) — the
  // clear-button sync itself stays instant, it's just a class toggle.
  let filterTimer = null;
  input.addEventListener('input', () => {
    sync();
    if (typeof onInput !== 'function') return;
    clearTimeout(filterTimer);
    filterTimer = setTimeout(() => onInput(input.value), 180);
  });
  clearBtn.addEventListener('click', () => { clearTimeout(filterTimer); input.value = ''; sync(); if (typeof onInput === 'function') onInput(''); input.focus(); });
  sync();
}
document.addEventListener('DOMContentLoaded', function () {
  wireSimpleSearchClear('favSearchInput', 'favSearchClearBtn', filterFavouritesGrid);
});

function selectProductByIndex(idx, source) {
  const p = productListBySource(source)[idx];
  if (!p) return;
  if (typeof ProductModal !== 'undefined') ProductModal.openModal(p);
  else selectProductForOrder(p);
}

/* "Direct Buy" button on the catalogue card — skips the product detail
   modal and jumps straight into the order flow for that product. */
function directBuyByIndex(idx, ev, source) {
  if (ev) { ev.stopPropagation(); ev.preventDefault(); }
  const p = productListBySource(source)[idx];
  if (!p) return;
  // From a shop-profile card: run the shop-aware buy so the order flow opens
  // on top and returns to the shop afterwards (not hidden behind the modal).
  if (source === 'shop' && typeof ProductModal !== 'undefined' && ProductModal.startShopBuy) {
    ProductModal.startShopBuy(p, ProductModal.currentShopId && ProductModal.currentShopId());
    return;
  }
  selectProductForOrder(p);
}

/* Add-to-cart from a product card (Phase 1 cart) — doesn't open the card. */
function axCartAddByIndex(idx, ev, source, btn) {
  if (ev) { ev.stopPropagation(); ev.preventDefault(); }
  const p = productListBySource(source)[idx];
  if (!p || typeof axCartAdd !== 'function') return;
  axCartAdd(p, { type: 'sample', qty: 1 });
  if (btn) { btn.classList.add('ax-cart-bounce'); setTimeout(function () { btn.classList.remove('ax-cart-bounce'); }, 400); }
}
