/* Aarvex Portal — Multi-item Cart (Phase 1 #4)
 * A saved shopping list. Because each product is a separate lot order (often
 * from different shops, with their own delivery), "Checkout" feeds the cart
 * items through the EXISTING, tested order flow one at a time — the money /
 * order-creation path is never duplicated or bypassed. State is per-user in
 * localStorage.
 */
'use strict';

function _axCartKey() {
  const sub = (typeof currentUser !== 'undefined' && currentUser && currentUser.sub) ? currentUser.sub : 'guest';
  return 'ax_cart_' + sub;
}
function axCartGet() {
  try { return JSON.parse(localStorage.getItem(_axCartKey()) || '[]'); } catch (e) { return []; }
}
function axCartSet(items) {
  try { localStorage.setItem(_axCartKey(), JSON.stringify(items)); } catch (e) {}
  axCartSyncBadge();
}
function axCartCount() { return axCartGet().reduce((n, it) => n + 1, 0); }

/* Add a product. `type` = 'sample' | 'bulk'; qty in kg (sample) or the bulk
   fraction is chosen at checkout. Merges duplicates (same product + type). */
function axCartAdd(product, opts) {
  opts = opts || {};
  if (!product || !product.product_id) return;
  const items = axCartGet();
  const key = (product.shop_id || '') + '::' + product.product_id + '::' + (opts.type || 'sample');
  const existing = items.find(i => i.key === key);
  if (existing) {
    existing.qty = (existing.qty || 1) + (opts.qty || 1);
  } else {
    items.push({
      key: key,
      product_id: product.product_id,
      category_id: product.category_id || '',
      product_name: product.product_name || '',
      shop_id: product.shop_id || '',
      shop_name: product.shop_name || '',
      price_per_kg: product.price_per_kg || 0,
      image_url: (product.image_urls && product.image_urls[0]) || product.image_url || '',
      type: opts.type || 'sample',
      qty: opts.qty || (opts.type === 'bulk' ? 0 : 1),
    });
  }
  axCartSet(items);
  if (typeof showToast === 'function') showToast('Added to cart', 'success');
}
function axCartRemove(key) { axCartSet(axCartGet().filter(i => i.key !== key)); axCartRender(); }
function axCartUpdateQty(key, delta) {
  const items = axCartGet();
  const it = items.find(i => i.key === key);
  if (it) { it.qty = Math.max(1, (it.qty || 1) + delta); axCartSet(items); axCartRender(); }
}
function axCartClear() { axCartSet([]); axCartRender(); }

/* Floating cart button + badge, kept in sync everywhere. */
function axCartSyncBadge() {
  const n = axCartCount();
  let btn = document.getElementById('axCartFab');
  if (!btn) {
    btn = document.createElement('button');
    btn.id = 'axCartFab';
    btn.type = 'button';
    btn.className = 'ax-cart-fab';
    btn.setAttribute('aria-label', 'Cart');
    btn.innerHTML = '<i class="fa-solid fa-cart-shopping"></i><span class="ax-cart-badge">0</span>';
    btn.onclick = axCartOpen;
    document.body.appendChild(btn);
  }
  const badge = btn.querySelector('.ax-cart-badge');
  if (badge) badge.textContent = n;
  btn.classList.toggle('has-items', n > 0);
}

function axCartMoney(n) { return '₹' + (Number(n) || 0).toLocaleString('en-IN', { maximumFractionDigits: 0 }); }

function axCartOpen() {
  let ov = document.getElementById('axCartSheet');
  if (ov) ov.remove();
  ov = document.createElement('div');
  ov.id = 'axCartSheet';
  ov.className = 'ax-comments-overlay';
  ov.innerHTML = '<div class="ax-cart-box">' +
    '<div class="ax-comments-head"><b><i class="fa-solid fa-cart-shopping"></i> Your Cart</b>' +
      '<button type="button" class="ax-strip-icon-btn ax-sheet-close" onclick="document.getElementById(\'axCartSheet\').remove()" aria-label="Close"><i class="fa-solid fa-chevron-down"></i></button></div>' +
    '<div id="axCartList"></div>' +
    '<div id="axCartFoot"></div>' +
  '</div>';
  ov.addEventListener('click', e => { if (e.target === ov) ov.remove(); });
  document.body.appendChild(ov);
  if (window.axSheetify) window.axSheetify(ov, { onClose: () => ov.remove() });
  axCartRender();
}

function axCartRender() {
  const list = document.getElementById('axCartList');
  const foot = document.getElementById('axCartFoot');
  if (!list) return;
  const items = axCartGet();
  if (!items.length) {
    list.innerHTML = (typeof axEmptyState === 'function')
      ? axEmptyState('basket', 'Your cart is empty', 'Add products from the Trade tab, then check them out together.')
      : '<p class="ax-cart-empty">Your cart is empty.</p>';
    if (foot) foot.innerHTML = '';
    return;
  }
  const esc = s => String(s == null ? '' : s).replace(/[<>&]/g, c => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;' }[c]));
  list.innerHTML = items.map(it => {
    const media = it.image_url
      ? '<img src="' + esc(it.image_url) + '" alt="">'
      : '<div class="ax-cart-ph"><i class="fa-solid fa-seedling"></i></div>';
    const est = it.type === 'sample'
      ? '<span class="ax-cart-est">' + (it.qty || 1) + ' kg · sample</span>'
      : '<span class="ax-cart-est">bulk lot</span>';
    const qtyCtrl = it.type === 'sample'
      ? '<div class="ax-cart-qty"><button type="button" onclick="axCartUpdateQty(\'' + it.key + '\',-1)">−</button><b>' + (it.qty || 1) + '</b><button type="button" onclick="axCartUpdateQty(\'' + it.key + '\',1)">+</button></div>'
      : '';
    return '<div class="ax-cart-row"><div class="ax-cart-media">' + media + '</div>' +
      '<div class="ax-cart-info"><b>' + esc(it.product_name) + '</b>' +
        '<small>' + esc(it.shop_name || 'Shop') + ' · ' + axCartMoney(it.price_per_kg) + '/kg</small>' + est + '</div>' +
      '<div class="ax-cart-actions">' + qtyCtrl +
        '<button type="button" class="ax-cart-del" onclick="axCartRemove(\'' + it.key + '\')" aria-label="Remove"><i class="fa-solid fa-trash-can"></i></button>' +
      '</div></div>';
  }).join('');
  // Estimated total (sample items priced at ₹500 flat like the order form).
  const total = items.reduce((sum, it) => sum + (it.type === 'sample' ? 500 : (it.price_per_kg ? Math.round((it.qty || 0) * it.price_per_kg) : 0)), 0);
  if (foot) {
    foot.innerHTML =
      '<div class="ax-cart-total"><span>' + items.length + ' item' + (items.length > 1 ? 's' : '') + ' · est.</span><b>' + axCartMoney(total) + '</b></div>' +
      '<button type="button" class="btn-primary btn-full" onclick="axCartCheckout()"><i class="fa-solid fa-bag-shopping"></i> Checkout (' + items.length + ')</button>' +
      '<button type="button" class="ax-cart-clear" onclick="axCartClear()">Clear cart</button>' +
      '<p class="ax-cart-note">Each item is confirmed in its own order form (separate delivery per lot).</p>';
  }
}

/* Checkout queue — processes items one at a time through the existing,
   tested order flow. selectProductForOrder() opens the order form; after each
   successful order the queue advances (see the hook in submitOrder). */
let _axCartQueue = [];
function axCartCheckout() {
  const items = axCartGet();
  if (!items.length) return;
  if (typeof currentUser === 'undefined' || !currentUser) { showToast('Sign in to check out', 'warning'); return; }
  _axCartQueue = items.slice();
  document.getElementById('axCartSheet')?.remove();
  window._axCartCheckoutActive = true;
  axCartProcessNext();
}
function axCartProcessNext() {
  if (!_axCartQueue.length) {
    window._axCartCheckoutActive = false;
    if (typeof showToast === 'function') showToast('All cart orders placed 🎉', 'success');
    axCartClear();
    return;
  }
  const it = _axCartQueue[0];
  const remaining = _axCartQueue.length;
  if (typeof showToast === 'function') showToast('Order ' + it.product_name + ' (' + remaining + ' left)', 'info');
  if (typeof switchPanel === 'function') { switchPanel('trade'); if (typeof switchTradeMode === 'function') switchTradeMode('order'); }
  // Reconstruct a product object the order form understands.
  const product = {
    product_id: it.product_id, category_id: it.category_id, product_name: it.product_name,
    shop_id: it.shop_id, shop_name: it.shop_name, price_per_kg: it.price_per_kg,
    image_url: it.image_url, available_stock_kg: it.available_stock_kg || 0,
  };
  if (typeof selectProductForOrder === 'function') {
    selectProductForOrder(product);
    // Pre-select the item's order type + sample quantity.
    setTimeout(function () {
      if (typeof setOrderType === 'function') setOrderType(it.type || 'sample');
      if (it.type === 'sample') { const q = document.getElementById('o_qty'); if (q) q.value = it.qty || 1; }
    }, 250);
  }
}
/* Called by submitOrder() on success — advance the checkout queue. */
function axCartOrderPlaced() {
  if (!window._axCartCheckoutActive) return;
  _axCartQueue.shift();
  // Remove the just-ordered item from the persisted cart too.
  setTimeout(axCartProcessNext, 1500);
}

document.addEventListener('DOMContentLoaded', function () {
  setTimeout(axCartSyncBadge, 500);
});
window.axCartAdd = axCartAdd;
window.axCartOpen = axCartOpen;
window.axCartOrderPlaced = axCartOrderPlaced;
