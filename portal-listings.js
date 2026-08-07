/* Portal: mobile sidebar, unified listings, 30-min modify window */
'use strict';

function toggleMobileSidebar(force) {
  var sidebar = document.getElementById('portalSidebar');
  var backdrop = document.getElementById('sidebarBackdrop');
  if (!sidebar) return;
  var open = force !== undefined ? force : !sidebar.classList.contains('open');
  sidebar.classList.toggle('open', open);
  if (backdrop) backdrop.classList.toggle('open', open);
  document.body.classList.toggle('sidebar-open', open);
}

function closeMobileSidebar() {
  toggleMobileSidebar(false);
}

/* Swipe-up-to-close for the top menu drawer (matches the drag-to-close on the
   messages / notifications / cart sheets). */
function axWireSidebarDragClose() {
  var sidebar = document.getElementById('portalSidebar');
  if (!sidebar || sidebar._axDragWired) return;
  sidebar._axDragWired = true;
  var startY = null, atTop = true;
  sidebar.addEventListener('touchstart', function (e) {
    startY = e.touches && e.touches[0] ? e.touches[0].clientY : null;
    atTop = sidebar.scrollTop <= 2;   // only start a close-drag from the top
  }, { passive: true });
  sidebar.addEventListener('touchend', function (e) {
    if (startY == null || !atTop) { startY = null; return; }
    var y = e.changedTouches && e.changedTouches[0] ? e.changedTouches[0].clientY : startY;
    if (startY - y > 60) closeMobileSidebar();   // dragged up > 60px → close
    startY = null;
  });
}
document.addEventListener('DOMContentLoaded', axWireSidebarDragClose);

function sellHistoryKey() {
  return currentUser ? 'ax_sells_list_' + currentUser.sub : null;
}

function getSellHistory() {
  var key = sellHistoryKey();
  if (!key) return [];
  try { return JSON.parse(localStorage.getItem(key) || '[]'); } catch (e) { return []; }
}

function saveSellHistory(listing) {
  var key = sellHistoryKey();
  if (!key) return;
  listing.id = listing.id || 'SL-' + Date.now();
  listing.date = listing.date || new Date().toISOString();
  listing.status = listing.status || 'Submitted';
  var hist = getSellHistory();
  if (window._sellEditIndex != null && window._sellEditIndex >= 0) {
    listing.reference_id = hist[window._sellEditIndex]?.reference_id || listing.reference_id;
    listing.ticket_id = hist[window._sellEditIndex]?.ticket_id || listing.ticket_id;
    hist[window._sellEditIndex] = Object.assign({}, hist[window._sellEditIndex], listing);
    window._sellEditIndex = null;
  } else {
    hist.unshift(listing);
    var cnt = parseInt(localStorage.getItem('ax_sells_' + currentUser.sub) || '0', 10) + 1;
    localStorage.setItem('ax_sells_' + currentUser.sub, String(cnt));
  }
  localStorage.setItem(key, JSON.stringify(hist.slice(0, 50)));
  if (typeof updateStats === 'function') updateStats();
}

function updateOrderHistory(index, patch) {
  var key = orderHistoryKey();
  if (!key) return;
  var hist = getOrderHistory();
  if (index < 0 || index >= hist.length) return;
  hist[index] = Object.assign({}, hist[index], patch);
  localStorage.setItem(key, JSON.stringify(hist));
}

function removeOrderHistory(index) {
  var key = orderHistoryKey();
  if (!key) return;
  var hist = getOrderHistory();
  hist.splice(index, 1);
  localStorage.setItem(key, JSON.stringify(hist));
  if (typeof updateStats === 'function') updateStats();
}

function removeSellHistory(index) {
  var key = sellHistoryKey();
  if (!key) return;
  var hist = getSellHistory();
  hist.splice(index, 1);
  localStorage.setItem(key, JSON.stringify(hist));
  if (typeof updateStats === 'function') updateStats();
}

function listingModifyAllowed(dateStr) {
  if (typeof ProductModal !== 'undefined') return ProductModal.listingModifyAllowed(dateStr);
  if (!dateStr) return false;
  return (Date.now() - new Date(dateStr).getTime()) < (30 * 60 * 1000);
}

function getUnifiedListings(filter) {
  filter = filter || 'all';
  var orders = getOrderHistory().map(function (o, i) {
    return { type: 'order', index: i, id: o.arn || ('ORD-' + i), title: o.product || 'Order', meta: o, date: o.date, status: o.status || 'New' };
  });
  var sells = getSellHistory().map(function (s, i) {
    return { type: 'sell', index: i, id: s.reference_id || s.id || ('SL-' + i), title: s.crop || 'Listing', meta: s, date: s.date, status: s.status || 'Submitted' };
  });
  var all = orders.concat(sells).sort(function (a, b) {
    return new Date(b.date || 0) - new Date(a.date || 0);
  });
  if (filter === 'orders') return all.filter(function (x) { return x.type === 'order'; });
  if (filter === 'sells') return all.filter(function (x) { return x.type === 'sell'; });
  return all;
}

function listingCardHtml(item) {
  var date = item.date ? new Date(item.date).toLocaleDateString('en-IN', { day: 'numeric', month: 'short', year: 'numeric' }) : '';
  var icon = item.type === 'order' ? 'fa-box' : 'fa-wheat-awn';
  var typeLabel = item.type === 'order' ? 'Order' : 'Sell Listing';
  var meta = item.meta || {};
  var sub = item.type === 'order'
    ? ((meta.type || '') + ' · ' + (meta.qty || '') + ' kg · ' + date)
    : ((meta.quantity_available_kg || meta.qty || '') + ' kg · ' + (meta.location_city || '') + ' · ' + date);
  var statusKey = (item.status || 'new').toLowerCase().replace(/\s/g, '_');
  var statusClass = { new: 'status-new', submitted: 'status-new', processing: 'status-processing', cancelled: 'status-pending' }[statusKey] || 'status-new';
  return '<div class="order-card listing-card" onclick="openListingDetail(\'' + item.type + '\',' + item.index + ')" role="button" tabindex="0">' +
    '<div class="order-card-icon"><i class="fa-solid ' + icon + '"></i></div>' +
    '<div style="flex:1;min-width:0">' +
    '<div class="listing-type-tag">' + typeLabel + '</div>' +
    '<div class="order-card-name">' + (item.title || '—') + '</div>' +
    '<div class="order-card-meta">' + sub + '</div>' +
    (item.id ? '<div class="order-card-arn">ID: ' + item.id + '</div>' : '') +
    '</div>' +
    '<div class="status-pill ' + statusClass + '">' + (item.status || 'New') + '</div>' +
    '</div>';
}

function loadMyListings() {
  var wrap = document.getElementById('myOrdersList');
  if (!wrap) return;
  var tab = document.querySelector('.listings-tab.active');
  var filter = tab ? tab.getAttribute('data-filter') : 'all';
  var items = getUnifiedListings(filter);
  wrap.innerHTML = items.length
    ? items.map(listingCardHtml).join('')
    : '<div class="orders-empty"><div class="orders-empty-icon"><i class="fa-solid fa-box-open"></i></div><h4>Nothing here yet</h4><p>Your orders and sell listings will appear here.<br><a onclick="switchPanel(\'trade\');switchTradeMode(\'order\')" style="color:var(--c-leaf2);font-weight:700;cursor:pointer">Browse products →</a></p></div>';
  var badge = document.getElementById('ordersCountBadge');
  if (badge) {
    var n = getOrderHistory().length;
    badge.textContent = n;
    badge.style.display = n > 0 ? '' : 'none';
  }
  if (typeof renderDashRecent === 'function') renderDashRecent();
}

function setListingsTab(btn, filter) {
  document.querySelectorAll('.listings-tab').forEach(function (b) { b.classList.remove('active'); });
  if (btn) btn.classList.add('active');
  loadMyListings();
}

function updateListingActionButtons(type, item) {
  var actions = document.getElementById('listingDetailActions');
  if (!actions) return;
  var canModify = listingModifyAllowed(item.date);
  var modifyBtn = canModify
    ? '<button type="button" class="btn-primary" style="flex:1" onclick="modifyListing()"><i class="fa-solid fa-pen"></i> Modify</button>'
    : '';
  var modifyNote = canModify
    ? '<p style="font-size:11px;color:var(--c-text3);width:100%;margin:0 0 8px"><i class="fa-solid fa-clock"></i> Modifications available for 30 minutes after submission.</p>'
    : '<p style="font-size:11px;color:var(--c-text3);width:100%;margin:0 0 8px"><i class="fa-solid fa-lock"></i> Modification window closed. You may cancel this listing only.</p>';
  actions.innerHTML = modifyNote + '<div style="display:flex;gap:10px;flex-wrap:wrap;width:100%">' + modifyBtn +
    '<button type="button" class="btn-sm-outline" style="flex:1;color:var(--c-red);border-color:rgba(217,54,68,.3)" onclick="cancelListing()"><i class="fa-solid fa-ban"></i> Cancel</button></div>';
}

function openListingDetail(type, index) {
  var item = type === 'order' ? getOrderHistory()[index] : getSellHistory()[index];
  if (!item) return;
  window._listingEdit = { type: type, index: index };
  var modal = document.getElementById('listingDetailModal');
  var body = document.getElementById('listingDetailBody');
  if (!modal || !body) return;
  var title = type === 'order' ? (item.product || 'Order') : (item.crop || 'Sell Listing');
  document.getElementById('listingDetailTitle').textContent = title;
  var rows = type === 'order'
    ? [
      ['Product', item.product], ['Type', item.type], ['Quantity', (item.qty || '') + ' kg'],
      ['Order ID', item.arn], ['Status', item.status], ['Date', item.date ? new Date(item.date).toLocaleString('en-IN') : '']
    ]
    : [
      ['Crop', item.crop], ['Quantity', (item.quantity_available_kg || item.qty || '') + ' kg'],
      ['Expected Price', item.expected_price || '—'], ['City', item.location_city], ['State', item.location_state],
      ['Reference', item.reference_id || item.id], ['Status', item.status]
    ];
  body.innerHTML = rows.filter(function (r) { return r[1]; }).map(function (r) {
    return '<div class="listing-detail-row"><span>' + r[0] + '</span><strong>' + r[1] + '</strong></div>';
  }).join('');
  updateListingActionButtons(type, item);
  modal.classList.add('open');
}

function closeListingDetail() {
  document.getElementById('listingDetailModal')?.classList.remove('open');
  window._listingEdit = null;
}

function modifyListing() {
  var ed = window._listingEdit;
  if (!ed) return;
  var item = ed.type === 'order' ? getOrderHistory()[ed.index] : getSellHistory()[ed.index];
  if (!item || !listingModifyAllowed(item.date)) {
    showToast('Modification window has expired (30 minutes)', 'warning');
    updateListingActionButtons(ed.type, item || {});
    return;
  }
  closeListingDetail();
  if (ed.type === 'order') {
    window._orderEditIndex = ed.index;
    var o = item;
    switchPanel('trade');
    switchTradeMode('order');
    setTimeout(function () {
      var p = catalogue.find(function (x) { return x.product_name === o.product; });
      if (p && typeof ProductModal !== 'undefined') ProductModal.openModal(p);
      else if (p) selectProductForOrder(p);
      if (o.qty) sv('o_qty', o.qty);
      if (o.type) setOrderType(o.type);
      showToast('Update your details and submit to save changes', 'info');
    }, 400);
  } else {
    window._sellEditIndex = ed.index;
    var s = item;
    switchPanel('trade');
    switchTradeMode('sell');
    sv('s_crop', s.crop || '');
    sv('s_qty', s.quantity_available_kg || s.qty || '');
    sv('s_price', s.expected_price || '');
    sv('s_city', s.location_city || '');
    sv('s_state', s.location_state || '');
    showToast('Update listing and submit to save changes', 'info');
  }
}

async function cancelListing() {
  var ed = window._listingEdit;
  if (!ed) return;
  if (!confirm('Cancel this ' + (ed.type === 'order' ? 'order' : 'listing') + '?')) return;

  if (ed.type === 'order') {
    // Real order cancellation now goes through the backend (claim-time
    // stock reservation phase) — it decides whether any reserved stock
    // needs reversing and whether the order is still cancellable at all
    // (e.g. rejects once the delivery journey has already started).
    // The local history entry is only removed once the backend confirms.
    var order = getOrderHistory()[ed.index];
    var arn = order && order.arn;
    if (!arn) {
      showToast('Could not find this order\'s ID — try refreshing the page', 'error');
      return;
    }
    var data = await mpApi('/order/cancel', { method: 'POST', body: JSON.stringify({ arn: arn }) });
    if (!data || !data.success) {
      showToast((data && data.error) || 'Could not cancel this order', 'error');
      return;
    }
    updateOrderHistory(ed.index, { status: 'Cancelled' });
    removeOrderHistory(ed.index);
    showToast(data.stock_restored ? 'Order cancelled — booking released' : 'Order cancelled', 'success');
    if (typeof axInvalidateCatalogue === 'function') axInvalidateCatalogue();
  } else {
    // Sell-listing cancellation is unrelated to the stock/order workflow —
    // stays local-only, exactly as before.
    removeSellHistory(ed.index);
    showToast('Cancelled successfully', 'success');
  }

  closeListingDetail();
  loadMyListings();
  if (typeof renderDashRecent === 'function') renderDashRecent();
}

function openProductReviewModal(idx) {
  var p = filteredCatalogue[idx];
  if (!p) return;
  if (typeof ProductModal !== 'undefined') {
    ProductModal.openModal(p);
    return;
  }
  window._reviewProduct = p;
  var modal = document.getElementById('productReviewModal');
  if (!modal) return;
  document.getElementById('reviewProductName').textContent = p.product_name;
  document.getElementById('reviewCommentInput').value = '';
  mpReviewRating = 0;
  document.querySelectorAll('#reviewStarPicker button').forEach(function (b, i) {
    b.classList.toggle('on', false);
    b.onclick = function () {
      mpReviewRating = i + 1;
      document.querySelectorAll('#reviewStarPicker button').forEach(function (x, j) { x.classList.toggle('on', j < mpReviewRating); });
    };
  });
  modal.classList.add('open');
}

function closeProductReviewModal() {
  document.getElementById('productReviewModal')?.classList.remove('open');
}

async function submitPortalReview() {
  var p = window._reviewProduct;
  if (!p || !mpReviewRating) { showToast('Select a star rating', 'error'); return; }
  if (typeof window.ensureFreshGoogleToken === 'function') {
    try { await window.ensureFreshGoogleToken(); } catch (e) { /* fall through */ }
  }
  var token = localStorage.getItem('ax_google_token');
  if (!token) { showToast('Sign in with Google to review', 'warning'); return; }
  var comment = (document.getElementById('reviewCommentInput')?.value || '').trim();
  try {
    var res = await fetch(LAMBDA_URL + '/review/submit', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + token },
      body: JSON.stringify({ product_id: p.product_id, category_id: p.category_id, rating: mpReviewRating, comment: comment })
    });
    var data = await res.json();
    if (res.ok && data.success) {
      showToast('Review submitted!', 'success');
      closeProductReviewModal();
    } else showToast(data.error || 'Review failed', 'error');
  } catch (e) { showToast('Network error', 'error'); }
}

function continueOrderFromCard(idx, ev) {
  if (ev) ev.stopPropagation();
  var p = filteredCatalogue[idx];
  if (!p) return;
  if (typeof ProductModal !== 'undefined') ProductModal.openModal(p);
  else selectProductForOrder(p);
}

function initPortalCatalogueFilter() {
  if (typeof CatalogueUI === 'undefined') return;
  CatalogueUI.initFilterDropdown({
    toggleId: 'portalFilterToggleBtn',
    menuId: 'portalFilterDropdown',
    searchId: 'catalogueSearchInput',
    clearId: 'portalSearchClearBtn',
    badgeId: 'portalFilterActiveBadge',
    onFilter: applyPortalCatalogueFilters,
    onSearch: function () { applyPortalCatalogueFilters(); }
  });
  var inp = document.getElementById('catalogueSearchInput');
  if (inp) {
    // Debounced — applyPortalCatalogueFilters() rebuilds the whole product
    // grid, so running it on EVERY keystroke made typing visibly laggy.
    var _catFilterTimer = null;
    inp.addEventListener('input', function () {
      clearTimeout(_catFilterTimer);
      _catFilterTimer = setTimeout(applyPortalCatalogueFilters, 180);
    });
    inp.addEventListener('focus', function () { document.getElementById('portalFilterDropdown')?.classList.add('is-open'); });
  }
  document.addEventListener('click', function (event) {
    var dropdown = document.getElementById('portalFilterDropdown');
    var search = document.querySelector('.catalogue-search-unified');
    if (dropdown && search && !search.contains(event.target)) dropdown.classList.remove('is-open');
  });
  document.addEventListener('keydown', function (event) {
    if (event.key === 'Escape') document.getElementById('portalFilterDropdown')?.classList.remove('is-open');
  });
}

function applyPortalCatalogueFilters() {
  var q = (document.getElementById('catalogueSearchInput')?.value || '').trim();
  if (q && typeof ProductModal !== 'undefined' && ProductModal.searchShop(q)) return;
  q = q.toLowerCase();
  var st = typeof CatalogueUI !== 'undefined' ? CatalogueUI.getFilterState('portalFilterDropdown') : { category: 'all', rating: 'all' };
  var cat = st.category;
  filteredCatalogue = catalogue.filter(function (p) {
    var cn = p.category_name || '';
    var matchCat = !cat || cat === 'all' || cn === cat;
    var matchQ = !q || [p.product_name, cn, p.description, p.shop_name, p.shop_id].join(' ').toLowerCase().indexOf(q) >= 0;
    return matchCat && matchQ;
  });
  renderCatalogue();
}

document.addEventListener('click', function (e) {
  if (e.target.id === 'sidebarBackdrop') closeMobileSidebar();
});

document.addEventListener('keydown', function (e) {
  if (e.key === 'Escape') {
    closeMobileSidebar();
    closeListingDetail();
    closeProductReviewModal();
    if (typeof ProductModal !== 'undefined') ProductModal.closeModal();
  }
});
