/* Aarvex Portal — Shared helpers + Top Shops Leaderboard
 * Extracted from portal.html's inline <script> (was lines 1382-2900).
 * gv/sv form helpers, toast queue, escapeHtml, and the Top Shops Leaderboard
 * (loadTopShops/navigateToShop/likeShop) called directly from portal.html's
 * INIT block on page load.
 * LOAD THIS FIRST among the new portal-*.js split files — portal-nav.js,
 * portal-catalogue-render.js and portal-order-flow.js all call showToast/gv/sv
 * defined here.
 */

/* ── HELPERS ── */

/* In-app Cashfree checkout (v3 JS SDK, loaded in portal.html <head>).
   Opens the payment modal RIGHT INSIDE the app using a payment_session_id
   from the backend (Cashfree order) — no new tab, no WhatsApp round-trip.
   Used by both the online product-order flow (portal-order-flow.js) and the
   shop-subscription flow (portal-delivery.js).

   The promise only resolves once the buyer finishes or CLOSES the modal, so
   callers can gate "success" on real payment completion. Returns:
     { available:false }                    → SDK/session missing (fall back to link)
     { available:true, paid:true, ... }     → payment completed at the gateway
     { available:true, paid:false, cancelled:true } → buyer closed / payment failed
   NOTE: the authoritative confirmation is still the server-side webhook — this
   result is only used to drive the UI (never to fulfil the order client-side). */
async function axCashfreeCheckout(paymentSessionId, mode) {
  if (!paymentSessionId || typeof Cashfree === 'undefined') return { available: false, paid: false };
  try {
    const cashfree = Cashfree({ mode: mode === 'production' ? 'production' : 'sandbox' });
    // "_modal" keeps the whole flow inside the current page as an overlay.
    const result = await cashfree.checkout({ paymentSessionId: paymentSessionId, redirectTarget: '_modal' });
    if (result && result.error) return { available: true, paid: false, cancelled: true, error: result.error };
    if (result && result.paymentDetails) return { available: true, paid: true, details: result.paymentDetails };
    // Unknown/edge (e.g. redirect flow) — treat as not-yet-confirmed.
    return { available: true, paid: false, cancelled: false };
  } catch (e) {
    return { available: false, paid: false, error: e };
  }
}

function gv(id) { const el = document.getElementById(id); return el ? el.value : ''; }
/* val ?? '' — guards against DOM .value coercing a JS `undefined`/`null`
   profile field (e.g. GST never saved) into the literal string
   "undefined"/"null" showing up in the input. */
function sv(id, val) { const el = document.getElementById(id); if (el) el.value = (val == null ? '' : val); }

/* One-tap copy with visual feedback — used by the order-success Order ID
   row and the copy chips on notifications (ARN / tracking key / OTP).
   Falls back to the execCommand path on non-secure/older contexts. */
function axCopyText(text, btn) {
  text = String(text == null ? '' : text).trim();
  if (!text) return;
  function done() {
    if (btn) {
      const old = btn.innerHTML;
      btn.innerHTML = '<i class="fa-solid fa-check"></i>';
      btn.classList.add('copied');
      setTimeout(function () { btn.innerHTML = old; btn.classList.remove('copied'); }, 1400);
    }
    showToast('Copied: ' + text, 'success');
  }
  function fallback() {
    const ta = document.createElement('textarea');
    ta.value = text;
    ta.style.cssText = 'position:fixed;opacity:0;pointer-events:none';
    document.body.appendChild(ta);
    ta.select();
    try { document.execCommand('copy'); done(); }
    catch (e) { showToast('Could not copy — long-press to copy manually', 'error'); }
    ta.remove();
  }
  if (navigator.clipboard && navigator.clipboard.writeText) {
    navigator.clipboard.writeText(text).then(done).catch(fallback);
  } else {
    fallback();
  }
}

let toastTimer;
let toastQueue = [];
let toastShowing = false;
function showToast(msg, type) {
  toastQueue.push({ msg: msg, type: type || 'info' });
  if (!toastShowing) processToastQueue();
  // A2 · haptic confirmation (Android) — success/error/warning give a short
  // tactile buzz so feedback isn't missed under a finger or in sunlight.
  if (typeof axHaptic === 'function') {
    if (type === 'error') axHaptic('error');
    else if (type === 'success') axHaptic('success');
    else if (type === 'warning') axHaptic('warning');
  }
}
function processToastQueue() {
  if (!toastQueue.length) { toastShowing = false; return; }
  toastShowing = true;
  const next = toastQueue.shift();
  const t = document.getElementById('toast');
  const icons = {success:'<i class="fa-solid fa-circle-check"></i>',error:'<i class="fa-solid fa-circle-xmark"></i>',info:'<i class="fa-solid fa-circle-info"></i>',warning:'<i class="fa-solid fa-triangle-exclamation"></i>'};
  t.innerHTML = (icons[next.type]||icons.info) + ' ' + next.msg;
  t.className = next.type==='success'?'show success':next.type==='error'?'show error':next.type==='warning'?'show warning':'show';
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => {
    t.className = t.className.replace('show','').trim();
    setTimeout(processToastQueue, 220); // small gap before next toast slides in
  }, toastQueue.length ? 2200 : 3800); // shorter dwell if more are waiting
}

/* ── STAR PERFORMER SHOPS — 3×3 grid of the 9 best-rated shops.
   Each cell: circular shop photo (logo if the API ever supplies one,
   otherwise initials on a brand-green disc), name, rating and likes.
   Tapping a cell opens the SAME shop profile the catalogue's shop-ID
   chip opens (ProductModal.openShopProfile). ── */
async function loadTopShops() {
  const loading = document.getElementById('topShopsLoading');
  const empty = document.getElementById('topShopsEmpty');
  const list = document.getElementById('topShopsList');

  try {
    const res = await fetch(LAMBDA_URL + '/shops/top', {
      headers: { Accept: 'application/json', Authorization: 'Bearer ' + (localStorage.getItem('ax_google_token') || '') }
    });
    const data = typeof safeFetchJson === 'function' ? await safeFetchJson(res) : await res.json();

    loading.style.display = 'none';

    if (!data.shops || data.shops.length === 0) {
      empty.style.display = 'block';
      return;
    }

    const shops = data.shops.slice(0, 9);
    window._axTopShops = shops; // reused by the feed's interleaved shop strips
    list.style.display = '';
    list.innerHTML = shops.map(shop => {
      const name = shop.shop_name || 'Unnamed Shop';
      const initials = name.trim().split(/\s+/).map(w => w[0]).join('').slice(0, 2).toUpperCase();
      const photo = shop.shop_logo_url
        ? `<img class="ax-star-shop-photo" src="${escapeHtml(shop.shop_logo_url)}" alt="" loading="lazy">`
        : `<div class="ax-star-shop-photo ax-star-shop-initials">${escapeHtml(initials || 'S')}</div>`;
      return `
        <button type="button" class="ax-star-shop-cell" onclick="navigateToShop('${escapeHtml(shop.shop_id)}')">
          ${photo}
          <div class="ax-star-shop-name">${escapeHtml(name)}</div>
          <div class="ax-star-shop-meta">
            <span class="ax-star-shop-rating"><i class="fa-solid fa-star"></i> ${shop.avg_rating || 0}</span>
            <span class="ax-star-shop-likes"><i class="fa-solid fa-heart"></i> ${shop.like_count || 0}</span>
          </div>
        </button>
      `;
    }).join('');

  } catch (e) {
    console.error('Failed to load top shops:', e);
    loading.style.display = 'none';
    empty.style.display = 'block';
  }
}

function navigateToShop(shopId) {
  // Open the shop's full profile directly — the same view the shop-ID
  // chip on a product opens (products, reviews, rating, buy from there).
  if (window.ProductModal && typeof ProductModal.openShopProfile === 'function') {
    ProductModal.openShopProfile(shopId);
    return;
  }
  // Fallback: filter the Trade catalogue by shop ID.
  switchPanel('trade');
  switchTradeMode('order');
  setTimeout(() => {
    const searchInput = document.getElementById('catalogueSearchInput');
    if (searchInput) {
      searchInput.value = shopId;
      searchInput.dispatchEvent(new Event('input'));
    }
  }, 100);
}

async function likeShop(shopId, btn) {
  if (!currentUser) {
    showToast('Please login to like shops', 'warning');
    return;
  }
  
  try {
    const res = await fetch(LAMBDA_URL + '/shop/like', {
      method: 'POST',
      headers: { 
        'Content-Type': 'application/json',
        'Authorization': 'Bearer ' + (localStorage.getItem('ax_google_token') || '')
      },
      body: JSON.stringify({ shop_id: shopId })
    });
    const data = typeof safeFetchJson === 'function' ? await safeFetchJson(res) : await res.json();
    
    if (data.success) {
      btn.classList.add('liked');
      const icon = btn.querySelector('i');
      if (icon) icon.classList.add('fa-solid');
      icon.classList.remove('fa-regular');
      
      // Update like count display
      const likesDisplay = btn.parentElement.querySelector('.top-shop-likes, .top-shop-card-meta span:last-child');
      if (likesDisplay) {
        likesDisplay.innerHTML = `<i class="fa-solid fa-heart" style="color:#E1435A"></i> ${data.like_count}`;
      }
      
      if (!data.already_liked) {
        showToast('Shop liked!', 'success');
      }
    } else {
      showToast(data.error || 'Failed to like shop', 'error');
    }
  } catch (e) {
    console.error('Failed to like shop:', e);
    showToast('Failed to like shop. Please try again.', 'error');
  }
}

function escapeHtml(text) {
  const div = document.createElement('div');
  div.textContent = text;
  return div.innerHTML;
}
