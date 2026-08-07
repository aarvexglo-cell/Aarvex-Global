/* Aarvex Portal — Order / Sell / Track / History flows
 * Extracted from portal.html's inline <script> (was lines 1382-2900).
 * Order placement (submitOrder), sell listing (submitSell), order tracking
 * (trackOrder), and local order-history rendering.
 * Depends on: portal-helpers.js (gv/sv/showToast) — load AFTER it.
 */

/* ── ORDER FLOW ── */
function selectProductForOrder(productJson) {
  // Gate (Batch 5): an importer must have Personal Information saved before
  // they can buy — otherwise the order has no name/phone/address to ship to.
  if (typeof axRequireProfileComplete === 'function' && !axRequireProfileComplete('place an order')) return;
  // Any fresh buy clears a stale "return to shop" intent; startShopBuy() re-sets
  // it immediately after this call so the shop-shopping loop still works.
  window._axBuyReturnShop = null;
  let product;
  try { product = typeof productJson === 'string' ? JSON.parse(productJson.replace(/&quot;/g,'"').replace(/&#39;/g,"'")) : productJson; }
  catch(e) { showToast('Error selecting product', 'error'); return; }
  selectedProduct = product;
  const iconClass = getProductIcon(product);
  const priceTag = product.price_per_kg ? '₹'+product.price_per_kg+'/kg' : 'Price on request';
  // Show the real product photo (Batch 1) — fall back to the category icon.
  const pImg = product.image_url || product.image || product.photo_url || product.product_image || (product.images && product.images[0]) || '';
  const pMedia = pImg
    ? '<div class="selected-product-emoji"><img src="'+pImg+'" alt="" style="width:100%;height:100%;object-fit:cover;border-radius:inherit"></div>'
    : '<div class="selected-product-emoji"><i class="'+iconClass+'"></i></div>';
  document.getElementById('selectedProductCard').innerHTML =
    pMedia +
    '<div style="flex:1;min-width:0">' +
      '<div class="selected-product-name">'+product.product_name+'</div>' +
      '<div class="selected-product-meta">'+(product.category_name||'')+' · Min '+(product.min_order_kg||1)+' kg · '+priceTag+'</div>' +
    '</div>' +
    '<button class="change-product-btn" onclick="backToCatalogue()"><i class="fa-solid fa-rotate"></i> Change</button>';
  // The whole order flow (orderStep1/2/3) lives inside #panel-trade →
  // Order mode. Buying from anywhere else (Favourites grid, a shop
  // profile modal, etc.) used to just toggle step2 visible INSIDE a
  // display:none panel — the click appeared to do nothing. Bring the
  // Trade panel + Order mode forward first; selectedProduct is already
  // set above, so switchTradeMode('order') won't reset us back to step 1.
  const tradePanelEl = document.getElementById('panel-trade');
  if (tradePanelEl && !tradePanelEl.classList.contains('active')) switchPanel('trade');
  const activeModeTab = document.querySelector('.trade-mode-tab.active');
  if (!activeModeTab || activeModeTab.dataset.mode !== 'order') switchTradeMode('order');
  document.getElementById('orderStep1').style.display = 'none';
  document.getElementById('orderStep2').style.display = '';
  document.getElementById('orderStep3').style.display = 'none';
  setOrderProgressStep(2);
  prefillForms();
  updateOrderSectionStatus('yourDetails');
  updateOrderSectionStatus('delivery');
  setOrderType('sample');
  refreshStockFractions();
  loadAddressBook();
  const editing = window._orderEditIndex != null;
  document.getElementById('orderUpdateBtn').style.display = editing ? '' : 'none';
  document.getElementById('orderExternalSection').style.display = editing ? 'none' : '';
  window.scrollTo({top:0,behavior:'smooth'});
}

function setOrderProgressStep(step) {
  const s1 = document.getElementById('orderProgressStep1');
  const s2 = document.getElementById('orderProgressStep2');
  if (s1) s1.classList.toggle('active', step === 1);
  if (s2) s2.classList.toggle('active', step === 2);
  if (s1) s1.classList.toggle('done', step === 2);
}
function backToCatalogue() {
  // Buy that was launched from a shop profile: the Back arrow returns the user
  // to that exact shop instead of dumping them on the catalogue.
  if (window._axBuyReturnShop && typeof window.axReturnToShopAfterBuy === 'function') {
    document.getElementById('orderStep2').style.display = 'none';
    if (window.axReturnToShopAfterBuy()) { selectedProduct = null; return; }
  }
  document.getElementById('orderStep1').style.display = '';
  document.getElementById('orderStep2').style.display = 'none';
  setOrderProgressStep(1);
  selectedProduct = null;
}

let orderPurchaseFraction = null; // 'quarter' | 'half' | 'full' — bulk orders only

function refreshStockFractions() {
  if (!selectedProduct) return;
  const stock = parseFloat(selectedProduct.free_stock_kg != null ? selectedProduct.free_stock_kg : selectedProduct.available_stock_kg) || 0;
  const q = (stock * 0.25), h = (stock * 0.5), f = stock;
  document.getElementById('fracQuarterKg').textContent = q ? Math.round(q) + ' kg' : '—';
  document.getElementById('fracHalfKg').textContent = h ? Math.round(h) + ' kg' : '—';
  document.getElementById('fracFullKg').textContent = f ? Math.round(f) + ' kg (all remaining)' : '—';
  const note = document.getElementById('stockRemainingNote');
  if (note) {
    note.style.display = '';
    note.innerHTML = '<i class="fa-solid fa-boxes-stacked"></i> ' + (stock ? Math.round(stock) + ' kg available for new orders' : 'Out of stock');
  }
  orderPurchaseFraction = null;
  ['Quarter','Half','Full'].forEach(function (n) {
    document.getElementById('fracCard'+n).classList.remove('active');
  });
}

function setPurchaseFraction(frac) {
  orderPurchaseFraction = frac;
  ['quarter','half','full'].forEach(function (f) {
    const id = 'fracCard' + f.charAt(0).toUpperCase() + f.slice(1);
    document.getElementById(id).classList.toggle('active', f === frac);
  });
}

function setOrderType(type) {
  orderType = type;
  document.getElementById('typeCardSample').classList.toggle('active', type === 'sample');
  document.getElementById('typeCardBulk').classList.toggle('active', type === 'bulk');
  document.getElementById('typeCardSample').setAttribute('aria-selected', type === 'sample');
  document.getElementById('typeCardBulk').setAttribute('aria-selected', type === 'bulk');
  // Re-tint the whole form: green for Sample, orange for Bulk (--order-accent).
  const step = document.getElementById('orderStep2');
  if (step) {
    step.classList.toggle('order-theme-sample', type === 'sample');
    step.classList.toggle('order-theme-bulk', type === 'bulk');
  }
  document.getElementById('qtySampleBox').style.display = type === 'sample' ? '' : 'none';
  document.getElementById('qtyBulkBox').style.display   = type === 'bulk'   ? '' : 'none';
  if (type === 'bulk') refreshStockFractions();
}
let orderPaymentMethod = 'online';
function setPaymentMethod(method) {
  orderPaymentMethod = method;
  document.getElementById('payCardOnline').classList.toggle('active', method === 'online');
  document.getElementById('payCardCod').classList.toggle('active', method === 'cod');
  document.getElementById('payCardOnline').setAttribute('aria-selected', method === 'online');
  document.getElementById('payCardCod').setAttribute('aria-selected', method === 'cod');
}

/* ── Your Details / Delivery Location collapse cards ──────────────────
   Both start collapsed regardless of state; the header just turns green
   ("already have this") or red ("still needed") based on whether the
   required fields / a picked address are present. Re-run on every input
   change so the header updates live while a red card is open and being
   filled in. */
function orderSectionEls(section) {
  const id = section === 'yourDetails' ? 'yourDetailsCard' : 'deliveryCard';
  return {
    card: document.getElementById(id),
    summary: document.getElementById(section === 'yourDetails' ? 'yourDetailsSummary' : 'deliverySummary'),
  };
}
function updateOrderSectionStatus(section) {
  const { card, summary } = orderSectionEls(section);
  if (!card) return false;
  let complete, text;
  if (section === 'yourDetails') {
    const name = gv('o_name').trim(), mobile = gv('o_mobile').trim(), email = gv('o_email').trim();
    complete = !!(name && mobile && email);
    text = complete ? (name + ' · ' + mobile) : 'Please fill your details';
  } else {
    const addr = typeof getSelectedAddress === 'function' ? getSelectedAddress() : null;
    complete = !!addr;
    text = complete ? ((addr.label || 'Address') + ' · ' + (addr.city || '')) : 'Please select or add an address';
  }
  card.classList.toggle('is-complete', complete);
  card.classList.toggle('is-incomplete', !complete);
  if (summary) summary.textContent = text;
  return complete;
}
function toggleOrderSection(section) {
  const { card } = orderSectionEls(section);
  if (card) card.classList.toggle('is-open');
}
/* Used by submitOrder() to draw attention to whichever card is still
   incomplete instead of only showing the generic error banner. */
function expandOrderSection(section) {
  const { card } = orderSectionEls(section);
  if (!card) return;
  card.classList.add('is-open');
  card.scrollIntoView({ behavior: 'smooth', block: 'center' });
}

async function submitOrder() {
  const errBox = document.getElementById('orderError');
  errBox.classList.remove('show');
  if (!selectedProduct) { showToast('Please select a product first', 'error'); backToCatalogue(); return; }

  // Pay Online / order APIs need a valid Google ID token.
  if (typeof isGoogleTokenExpired === 'function' && isGoogleTokenExpired()) {
    if (typeof window.ensureFreshGoogleToken === 'function') {
      await window.ensureFreshGoogleToken({ interactive: true });
    }
    if (typeof isGoogleTokenExpired === 'function' && isGoogleTokenExpired()) {
      showToast('Google sign-in required before placing order / payment', 'error');
      return;
    }
  }

  let qty = 0;
  if (orderType === 'bulk') {
    if (!orderPurchaseFraction) {
      document.getElementById('orderErrorMsg').textContent = 'Please choose Quarter, Half or Full quantity.';
      errBox.classList.add('show'); return;
    }
    const stock = parseFloat(selectedProduct.free_stock_kg != null ? selectedProduct.free_stock_kg : selectedProduct.available_stock_kg) || 0;
    qty = orderPurchaseFraction === 'quarter' ? stock * 0.25 : orderPurchaseFraction === 'half' ? stock * 0.5 : stock;
  } else {
    qty = parseFloat(gv('o_qty')) || 0;
    if (qty > 5) {
      document.getElementById('orderErrorMsg').textContent = 'Sample orders are max 5 kg. Switch to Bulk for more.';
      errBox.classList.add('show'); return;
    }
  }
  const name    = gv('o_name').trim();
  const mobile  = gv('o_mobile').trim();
  const email   = gv('o_email').trim();
  const selectedAddr = typeof getSelectedAddress === 'function' ? getSelectedAddress() : null;
  const missing = [];
  if (!qty)     missing.push('Quantity');
  if (!name)    missing.push('Full Name');
  if (!mobile)  missing.push('Mobile');
  if (!email)   missing.push('Email');
  // company_name required by backend — auto-fill with name if blank
  const company = gv('o_company').trim() || (name + ' (Individual)');
  if (missing.length) {
    updateOrderSectionStatus('yourDetails');
    expandOrderSection('yourDetails');
    document.getElementById('orderErrorMsg').textContent = 'Please fill: ' + missing.join(', ');
    errBox.classList.add('show'); return;
  }
  if (!selectedAddr) {
    document.getElementById('addressBookError').style.display = '';
    updateOrderSectionStatus('delivery');
    expandOrderSection('delivery');
    document.getElementById('orderErrorMsg').textContent = 'Please select or add a delivery address.';
    errBox.classList.add('show'); return;
  }
  const recaptchaToken = getRecaptchaToken('orderRecaptcha');
  if (!recaptchaToken) {
    showToast('Please complete the captcha verification', 'error');
    return;
  }
  const payload = {
    product_id: selectedProduct.product_id || '',
    category_id: selectedProduct.category_id || '',
    product_name: selectedProduct.product_name || '',
    order_type: orderType, quantity_kg: qty,
    purchase_option: orderType === 'bulk' ? orderPurchaseFraction : '',
    payment_method: orderPaymentMethod,
    customer_name: name, company_name: company,
    mobile, email, gst_number: gv('o_gst').trim(),
    address_id: selectedAddr.address_id,
    country: gv('o_country').trim() || 'India',
    amount_inr: orderType === 'sample' ? 500 : (selectedProduct.price_per_kg ? Math.round(qty * parseFloat(selectedProduct.price_per_kg)) : 0),
    price_per_kg: selectedProduct.price_per_kg || 0,
    recaptcha_token: recaptchaToken,
  };
  if (window._orderEditIndex != null) {
    const existing = getOrderHistory()[window._orderEditIndex];
    if (existing && existing.arn) payload.existing_arn = existing.arn;
  }
  const btn = document.getElementById('orderSubmitBtn');
  btn.disabled = true; btn.innerHTML = '<div class="spinner"></div> Submitting…';
  try {
    const _authToken = localStorage.getItem('ax_google_token');
    const _headers = {'Content-Type':'application/json'};
    if (_authToken) _headers['Authorization'] = 'Bearer ' + _authToken;
    const res = await fetch(LAMBDA_URL + '/web/order', {
      method:'POST', headers: _headers, body: JSON.stringify(payload),
      signal: AbortSignal.timeout(15000),
    });
    const data = typeof safeFetchJson === 'function' ? await safeFetchJson(res) : await res.json();
    if (res.ok && data.success) {
      const payUrl = data.payment_link || data.payment_link_url || '';
      const paySession = data.payment_session_id || '';
      const payMode = data.payment_mode || '';
      const isOnline = orderPaymentMethod === 'online';
      const arn = data.arn || (window._orderEditIndex != null ? getOrderHistory()[window._orderEditIndex]?.arn : '');

      // ── ONLINE payment MUST complete before we show success or advance ──
      // The backend has the order in an awaiting-payment state; nothing
      // progresses (no delivery record, no invoice) until the Cashfree webhook
      // confirms payment. So if the buyer cancels/closes the modal, we keep
      // them on the review step and show NO success — they can retry.
      if (isOnline && (paySession || payUrl)) {
        const pay = await axCashfreeCheckout(paySession, payMode);
        if (!pay.paid) {
          if (pay.available === false && payUrl) {
            // SDK/session unavailable → hosted page in a new tab as fallback.
            window.open(payUrl, '_blank');
            showToast('Payment page opened in a new tab. Complete payment to confirm your order.', 'info');
          } else {
            showToast('Payment not completed — your order is not confirmed. Aap dobara "Submit" karke pay kar sakte hain.', 'error');
          }
          resetRecaptchaWidget('orderRecaptcha');
          btn.disabled = false; btn.innerHTML = '<i class="fa-solid fa-paper-plane"></i> Submit Order Request';
          return;
        }
      }

      // ── Payment done (or COD) → NOW show success, save, and advance ──
      // Multi-item cart: if a cart checkout is in progress, advance the queue.
      if (typeof axCartOrderPlaced === 'function') axCartOrderPlaced();
      document.getElementById('orderStep2').style.display = 'none';
      document.getElementById('orderStep3').style.display = '';
      // Ordered from a shop profile → offer a one-tap return to that shop on the
      // success screen (added once, keeps the shop-shopping loop intact).
      if (window._axBuyReturnShop) {
        const actions = document.querySelector('#orderStep3 .success-actions');
        if (actions && !document.getElementById('orderBackToShopBtn')) {
          const sid = window._axBuyReturnShop;
          const b = document.createElement('button');
          b.type = 'button';
          b.id = 'orderBackToShopBtn';
          b.className = 'btn-sm-outline';
          b.innerHTML = '<i class="fa-solid fa-store"></i> Back to shop';
          b.onclick = function () { window._axBuyReturnShop = sid; if (typeof window.axReturnToShopAfterBuy === 'function') window.axReturnToShopAfterBuy(); };
          actions.insertBefore(b, actions.firstChild);
        }
      }
      const arnEl = document.getElementById('orderARN');
      const arnRow = document.getElementById('orderARNRow');
      if (arn && arnEl) { arnEl.textContent = arn; if (arnRow) arnRow.style.display = ''; }
      // Compact what-you-ordered recap under the Order ID.
      const sumEl = document.getElementById('orderSuccessSummary');
      if (sumEl && selectedProduct) {
        sumEl.innerHTML =
          '<div class="ss-cell"><span>Product</span><b>' + (selectedProduct.product_name || '—') + '</b></div>' +
          '<div class="ss-cell"><span>Quantity</span><b>' + (Math.round(qty * 100) / 100) + ' kg · ' + (orderType === 'bulk' ? 'Bulk' : 'Sample') + '</b></div>' +
          '<div class="ss-cell"><span>Payment</span><b>' + (isOnline ? 'Paid Online' : 'Cash on Delivery') + '</b></div>';
        sumEl.style.display = '';
      }
      if (window._orderEditIndex != null && data.updated) {
        updateOrderHistory(window._orderEditIndex, { product: selectedProduct.product_name, type: orderType, qty, status: 'Updated', date: getOrderHistory()[window._orderEditIndex]?.date || new Date().toISOString() });
        window._orderEditIndex = null;
        showToast('Order updated successfully', 'success');
      } else if (!data.updated) {
        saveOrderHistory({arn: data.arn, product: selectedProduct.product_name, type: orderType, qty, status: isOnline ? 'Paid' : 'New', date: new Date().toISOString()});
        showToast(isOnline ? 'Payment received! Your order is confirmed.' : 'Order placed! Check WhatsApp for confirmation.', 'success');
      }
    } else {
      document.getElementById('orderErrorMsg').textContent = data.error || 'Something went wrong. Please try again.';
      errBox.classList.add('show');
      resetRecaptchaWidget('orderRecaptcha');
    }
  } catch(e) {
    document.getElementById('orderErrorMsg').textContent = 'Network error. Check your connection and try again.';
    errBox.classList.add('show');
    resetRecaptchaWidget('orderRecaptcha');
  }
  btn.disabled = false; btn.innerHTML = '<i class="fa-solid fa-paper-plane"></i> Submit Order Request';
}

function resetOrder() {
  window._axBuyReturnShop = null; // fresh order — drop any return-to-shop intent
  selectedProduct = null; orderType = 'sample'; orderPurchaseFraction = null;
  document.getElementById('orderStep1').style.display = '';
  document.getElementById('orderStep2').style.display = 'none';
  document.getElementById('orderStep3').style.display = 'none';
  setOrderProgressStep(1);
  sv('o_qty', ''); setOrderType('sample');
}


/* ── SELL FLOW ── */
async function submitSell() {
  const errBox = document.getElementById('sellError');
  errBox.classList.remove('show');
  const name   = gv('s_name').trim();
  const mobile = gv('s_mobile').trim();
  const crop   = gv('s_crop').trim();
  const qty    = parseFloat(gv('s_qty')) || 0;
  const city   = gv('s_city').trim();
  const state  = gv('s_state').trim();
  const pincode = gv('s_pincode').trim();
  const missing = [];
  if (!name)   missing.push('Name');
  if (!mobile) missing.push('Mobile');
  if (!crop)   missing.push('Crop');
  if (!qty)    missing.push('Quantity');
  if (!city)   missing.push('City');
  if (!state)  missing.push('State');
  // Pincode required so the produce pickup point can be geo-located for the
  // delivery-triangle (otherwise a claimed order shows "incomplete location").
  if (!pincode) missing.push('Pincode');
  if (missing.length) {
    document.getElementById('sellErrorMsg').textContent = 'Please fill: ' + missing.join(', ');
    errBox.classList.add('show'); return;
  }
  const recaptchaToken = getRecaptchaToken('sellRecaptcha');
  if (!recaptchaToken) {
    showToast('Please complete the captcha verification', 'error');
    return;
  }
  const payload = {
    contact_name: name, mobile,
    email: gv('s_email').trim() || undefined,
    crop, quantity_available_kg: qty,
    expected_price: gv('s_price').trim() || undefined,
    location_city: city, location_state: state,
    pincode: pincode,
    recaptcha_token: recaptchaToken,
  };
  const btn = document.getElementById('sellSubmitBtn');
  btn.disabled = true; btn.innerHTML = '<div class="spinner" style="border-color:rgba(0,0,0,.2);border-top-color:var(--c-earth)"></div> Submitting…';
  try {
    const res = await fetch(LAMBDA_URL + '/web/sell', {
      method:'POST', headers:{'Content-Type':'application/json'}, body: JSON.stringify(payload),
      signal: AbortSignal.timeout(15000),
    });
    const data = typeof safeFetchJson === 'function' ? await safeFetchJson(res) : await res.json();
    if (res.ok && data.success) {
      document.getElementById('sellFormWrapper').style.display = 'none';
      document.getElementById('sellSuccess').style.display = '';
      const refEl = document.getElementById('sellRefId');
      if (data.reference_id) { refEl.textContent = 'Reference ID: '+data.reference_id; refEl.style.display = ''; }
      saveSellHistory({
        crop, quantity_available_kg: qty, expected_price: gv('s_price').trim(),
        location_city: city, location_state: state,
        contact_name: name, mobile, reference_id: data.reference_id,
        status: 'Submitted'
      });
      updateStats();
      showToast('Listing submitted! Team will call within 24 hrs.', 'success');
    } else {
      document.getElementById('sellErrorMsg').textContent = data.error || 'Something went wrong. Please try again.';
      errBox.classList.add('show');
      resetRecaptchaWidget('sellRecaptcha');
    }
  } catch(e) {
    document.getElementById('sellErrorMsg').textContent = 'Network error. Check your connection.';
    errBox.classList.add('show');
    resetRecaptchaWidget('sellRecaptcha');
  }
  btn.disabled = false; btn.innerHTML = '<i class="fa-solid fa-paper-plane"></i> Submit Listing';
}

function resetSell() {
  document.getElementById('sellFormWrapper').style.display = '';
  document.getElementById('sellSuccess').style.display = 'none';
  sv('s_crop',''); sv('s_qty',''); sv('s_price','');
}

/* ── TRACK ORDER ── */
async function trackOrder() {
  const arn = gv('trackARN').trim();
  if (!arn) { showToast('Please enter an Order ID', 'error'); return; }
  const btn = document.getElementById('trackBtn');
  if (btn) { btn.disabled = true; btn.innerHTML = '<span class="spinner dark"></span> Tracking…'; }
  const resultBox = document.getElementById('trackResult');
  const content = document.getElementById('trackResultContent');
  const mapWrap = document.getElementById('trackMapWrap');
  const timeline = document.getElementById('trackTimeline');
  const otpBanner = document.getElementById('trackOtpBanner');
  const otpVal = document.getElementById('trackOtpValue');
  try {
    const res = await fetch(LAMBDA_URL + '/track?arn=' + encodeURIComponent(arn), {
      headers: { Authorization: 'Bearer ' + (localStorage.getItem('ax_google_token') || ''), Accept: 'application/json' },
    });
    const data = typeof safeFetchJson === 'function' ? await safeFetchJson(res) : await res.json();
    if (data.error && res.status >= 400) throw new Error(data.error);
    // Product / ARN / status now live in the track strip (axRenderTrackStrip)
    // above the map — no duplicate card here. This slot instead shows the ONE
    // thing that was missing: the amount + whether it's paid or COD-due.
    if (data.payment && typeof axTrackAmountCard === 'function') {
      content.style.display = '';
      content.innerHTML = axTrackAmountCard(data.payment);
    } else {
      content.style.display = 'none';
      content.innerHTML = '';
    }
    if (timeline && data.timeline) {
      mapWrap.style.display = '';
      timeline.innerHTML = (typeof axRenderTrackTimeline === 'function')
        ? axRenderTrackTimeline(data.timeline)
        : data.timeline.map(function(s) {
            return '<div style="display:flex;align-items:center;gap:10px;padding:6px 0;font-size:13px;color:'+(s.done?'var(--c-leaf2)':'var(--c-text3)')+'">' +
              '<i class="fa-solid fa-'+(s.done?'circle-check':'circle')+'"></i> '+s.step+'</div>';
          }).join('');
    }
    if (data.your_otp && otpBanner && otpVal) {
      otpBanner.style.display = '';
      otpVal.textContent = data.your_otp;
    } else if (otpBanner) otpBanner.style.display = 'none';
    if (typeof PortalEnhancements !== 'undefined' && PortalEnhancements.renderTrackMap) {
      PortalEnhancements.renderTrackMap(data);
    }
    if (data.driver_location && data.driver_location.lat) {
      timeline.innerHTML += '<p style="font-size:12px;color:var(--c-text3);margin-top:8px"><i class="fa-solid fa-location-dot"></i> Driver location updated '+((data.driver_location.updated_at||'').slice(0,16).replace('T',' '))+'</p>';
    }
    // Proof-of-delivery photo (if the partner captured one at hand-over).
    if (data.pod_photo_url && timeline) {
      timeline.innerHTML += '<div class="ax-pod-proof"><small><i class="fa-solid fa-camera"></i> Proof of delivery</small>' +
        '<a href="'+data.pod_photo_url+'" target="_blank" rel="noopener"><img src="'+data.pod_photo_url+'" alt="Proof of delivery photo" loading="lazy"></a></div>';
    }
    resultBox.style.display = '';
  } catch (e) {
    const local = getOrderHistory().find(o => o.arn && o.arn.toLowerCase() === arn.toLowerCase());
    if (local) {
      const statusClass = {'new':'status-new','processing':'status-processing','shipped':'status-shipped','delivered':'status-delivered'}[(local.status||'new').toLowerCase()] || 'status-new';
      content.innerHTML = '<div class="status-pill '+statusClass+'">'+(local.status||'New')+'</div><p style="margin-top:8px">'+ (local.product||'') +'</p>';
      resultBox.style.display = '';
    } else {
      content.innerHTML = '<p style="color:var(--c-text3);text-align:center;padding:var(--s3)">'+(e.message||'Order not found')+'</p>';
      resultBox.style.display = '';
    }
  }
  if (btn) { btn.disabled = false; btn.innerHTML = '<i class="fa-solid fa-magnifying-glass"></i> Track Order'; }
}

/* ── ORDER HISTORY ── */
function orderHistoryKey() { return currentUser ? 'ax_orders_' + currentUser.sub : null; }
function getOrderHistory() {
  const key = orderHistoryKey(); if (!key) return [];
  try { return JSON.parse(localStorage.getItem(key) || '[]'); } catch(e) { return []; }
}
function saveOrderHistory(order) {
  const key = orderHistoryKey(); if (!key) return;
  const hist = getOrderHistory(); hist.unshift(order);
  localStorage.setItem(key, JSON.stringify(hist.slice(0,50)));
  renderDashRecent(); updateStats();
}

function loadMyOrders() {
  if (typeof getUnifiedListings === 'function') { loadMyListings(); return; }
  const orders = getOrderHistory();
  const wrap = document.getElementById('myOrdersList');
  if (wrap) {
    wrap.innerHTML = orders.length
      ? orders.slice(0,30).map((o,i) => orderCardHtml(o,i)).join('')
      : '<div class="orders-empty"><div class="orders-empty-icon"><i class="fa-solid fa-box-open"></i></div><h4>No orders yet</h4><p>Your placed orders will appear here.<br><a onclick="switchPanel(\'order\')" style="color:var(--c-leaf2);font-weight:700;cursor:pointer">Place your first order →</a></p></div>';
  }
  renderDashRecent();
}

function renderDashRecent() {
  const orders = getOrderHistory().slice(0,3);
  const dash = document.getElementById('dashRecentOrders');
  if (!dash) return;
  dash.innerHTML = orders.length
    ? orders.map((o,i) => orderCardHtml(o,i)).join('')
    : '<div style="text-align:center;padding:var(--s5);color:var(--c-text3);font-size:13px"><div class="empty-icon-wrap" style="margin-bottom:var(--s2)"><i class="fa-solid fa-box-open"></i></div>No orders yet — <a onclick="switchPanel(\'order\')" style="color:var(--c-leaf2);font-weight:700;cursor:pointer">place your first order</a></div>';
}

function orderCardHtml(o, index) {
  index = index !== undefined ? index : 0;
  const statusKey = (o.status||'new').toLowerCase().replace(/\s/g,'_');
  const statusClass = {'new':'status-new','processing':'status-processing','shipped':'status-shipped','delivered':'status-delivered','payment_confirmed':'status-processing','pending':'status-pending','cancelled':'status-pending'}[statusKey] || 'status-new';
  const date = o.date ? new Date(o.date).toLocaleDateString('en-IN',{day:'numeric',month:'short',year:'numeric'}) : '';
  const click = typeof openListingDetail === 'function' ? ' onclick="openListingDetail(\'order\','+index+')"' : '';
  return '<div class="order-card listing-card"'+click+' role="button" tabindex="0">' +
    '<div class="order-card-icon"><i class="fa-solid fa-box"></i></div>' +
    '<div style="flex:1;min-width:0">' +
      '<div class="order-card-name">'+(o.product||'—')+'</div>' +
      '<div class="order-card-meta">'+(o.type?o.type.charAt(0).toUpperCase()+o.type.slice(1):'')+' · '+(o.qty||'')+' kg · '+date+'</div>' +
      (o.arn?'<div class="order-card-arn">ARN: '+o.arn+'<button class="arn-copy-btn" onclick="event.stopPropagation();copyARN(\''+o.arn+'\')" title="Copy ARN"><i class="fa-regular fa-copy"></i></button></div>':'') +
    '</div>' +
    '<div class="order-card-side">' +
      '<div class="status-pill '+statusClass+'">'+(o.status||'New')+'</div>' +
      (o.arn && statusKey !== 'cancelled' && statusKey !== 'delivered'
        ? '<button type="button" class="ax-order-track-btn" onclick="event.stopPropagation();axBuyerTrack(\''+o.arn+'\')"><i class="fa-solid fa-location-crosshairs"></i> Track</button>'
        : '') +
      // GST invoice + delivery rating both unlock once the order is delivered.
      (o.arn && statusKey === 'delivered'
        ? '<button type="button" class="ax-order-invoice-btn" onclick="event.stopPropagation();axDownloadInvoice(\''+o.arn+'\')"><i class="fa-solid fa-file-invoice"></i> Invoice</button>' +
          '<button type="button" class="ax-order-rate-btn" onclick="event.stopPropagation();axRateDelivery(\''+o.arn+'\')"><i class="fa-regular fa-star"></i> Rate delivery</button>' +
          '<button type="button" class="ax-order-dispute-btn" onclick="event.stopPropagation();axOpenDispute(\''+o.arn+'\')"><i class="fa-solid fa-triangle-exclamation"></i> Report a problem</button>'
        : '') +
    '</div>' +
    '</div>';
}

/* Buyer-side tracking (Batch F): opens the Track panel pre-filled with the
   order's ARN and runs the track lookup, giving the buyer the SAME live
   view delivery/importer get — status strip, distance/ETA, contacts, and the
   distance-triangle button (axShowTriangle) that shows how far the delivery
   boy, shop and importer are from each other. */
function axBuyerTrack(arn) {
  if (typeof switchPanel === 'function') switchPanel('track');
  const input = document.getElementById('trackARN');
  if (input) input.value = arn;
  if (typeof trackOrder === 'function') setTimeout(trackOrder, 80);
}

/* ── Dispute / Refund / Return (Phase 1) ──────────────────────────────
   A COD marketplace needs a formal complaint path or buyers never trust it.
   Opens a form; the dispute lands in the admin queue for resolution. */
const AX_DISPUTE_REASONS = [
  { key: 'not_delivered', label: 'Not delivered' },
  { key: 'damaged', label: 'Arrived damaged' },
  { key: 'wrong_item', label: 'Wrong item' },
  { key: 'quality', label: 'Quality issue' },
  { key: 'quantity_short', label: 'Quantity short' },
  { key: 'other', label: 'Other' },
];
let _axDisputePhotos = [];
function axOpenDispute(arn) {
  _axDisputePhotos = [];
  let ov = document.getElementById('axDisputeSheet');
  if (ov) ov.remove();
  ov = document.createElement('div');
  ov.id = 'axDisputeSheet';
  ov.className = 'ax-comments-overlay';
  ov.innerHTML = '<div class="ax-dispute-box">' +
    '<div class="ax-comments-head"><b><i class="fa-solid fa-triangle-exclamation"></i> Report a problem</b>' +
      '<button type="button" class="ax-strip-icon-btn" onclick="document.getElementById(\'axDisputeSheet\').remove()" aria-label="Close"><i class="fa-solid fa-xmark"></i></button></div>' +
    '<p class="ax-rate-sub">Order <b>' + arn + '</b>. Our team reviews every report.</p>' +
    '<label class="ax-dispute-label">What went wrong?</label>' +
    '<select id="axDisputeReason" class="ax-dispute-select">' +
      AX_DISPUTE_REASONS.map(function (r) { return '<option value="' + r.key + '">' + r.label + '</option>'; }).join('') +
    '</select>' +
    '<label class="ax-dispute-label">What would you like?</label>' +
    '<div class="ax-dispute-res" id="axDisputeRes">' +
      ['refund', 'replacement', 'return'].map(function (r, i) {
        return '<button type="button" class="ax-dispute-res-btn' + (i === 0 ? ' active' : '') + '" data-res="' + r + '" onclick="axSetDisputeRes(this)">' + r.charAt(0).toUpperCase() + r.slice(1) + '</button>';
      }).join('') +
    '</div>' +
    '<textarea id="axDisputeDetail" rows="3" maxlength="1000" placeholder="Describe the problem…"></textarea>' +
    '<label class="ax-dispute-photobtn"><i class="fa-solid fa-camera"></i> Add photos (up to 3)' +
      '<input type="file" accept="image/*" multiple style="display:none" onchange="axDisputePickPhotos(this)"></label>' +
    '<div id="axDisputePreview" class="ax-dispute-preview"></div>' +
    '<button type="button" class="btn-primary btn-full" onclick="axSubmitDispute(\'' + arn + '\')"><i class="fa-solid fa-paper-plane"></i> Submit report</button>' +
  '</div>';
  ov.addEventListener('click', function (e) { if (e.target === ov) ov.remove(); });
  document.body.appendChild(ov);
}
function axSetDisputeRes(btn) {
  document.querySelectorAll('#axDisputeRes .ax-dispute-res-btn').forEach(function (b) { b.classList.toggle('active', b === btn); });
}
function axDisputePickPhotos(input) {
  const files = [...(input.files || [])].slice(0, 3);
  _axDisputePhotos = [];
  const prev = document.getElementById('axDisputePreview');
  if (prev) prev.innerHTML = '';
  files.forEach(function (f) {
    if (f.size > 5 * 1024 * 1024) { showToast('Each photo must be under 5MB', 'warning'); return; }
    const fr = new FileReader();
    fr.onload = function () {
      _axDisputePhotos.push(fr.result);
      if (prev) prev.insertAdjacentHTML('beforeend', '<img src="' + fr.result + '" alt="">');
    };
    fr.readAsDataURL(f);
  });
}
async function axSubmitDispute(arn) {
  const reason = document.getElementById('axDisputeReason')?.value || '';
  const detail = (document.getElementById('axDisputeDetail')?.value || '').trim();
  const res = document.querySelector('#axDisputeRes .ax-dispute-res-btn.active')?.dataset.res || 'refund';
  if (!detail) { showToast('Please describe the problem', 'warning'); return; }
  const data = await mpApi('/dispute/create', {
    method: 'POST',
    body: JSON.stringify({ arn: arn, reason: reason, detail: detail, resolution_wanted: res, photos_b64: _axDisputePhotos }),
  });
  if (data && data.success) {
    document.getElementById('axDisputeSheet')?.remove();
    showToast('Report submitted — we’ll get back to you', 'success');
  } else {
    showToast((data && data.error) || 'Could not submit report', 'error');
  }
}

/* ── Rate the delivery partner (Phase 1) ──────────────────────────────
   Shops and products were rateable; the person who actually delivered was
   not. Opens a small star picker; one rating per order, re-rating replaces. */
let _axRateArn = null;
let _axRateValue = 0;
function axRateDelivery(arn) {
  _axRateArn = arn;
  _axRateValue = 0;
  let ov = document.getElementById('axRateSheet');
  if (ov) ov.remove();
  ov = document.createElement('div');
  ov.id = 'axRateSheet';
  ov.className = 'ax-comments-overlay';
  ov.innerHTML = '<div class="ax-rate-box">' +
    '<div class="ax-comments-head"><b>Rate your delivery</b>' +
      '<button type="button" class="ax-strip-icon-btn" onclick="document.getElementById(\'axRateSheet\').remove()" aria-label="Close"><i class="fa-solid fa-xmark"></i></button></div>' +
    '<p class="ax-rate-sub">How was the delivery for <b>' + arn + '</b>?</p>' +
    '<div class="ax-rate-stars" id="axRateStars">' +
      [1, 2, 3, 4, 5].map(function (n) {
        return '<button type="button" class="ax-rate-star" data-val="' + n + '" onclick="axSetRating(' + n + ')" aria-label="' + n + ' star"><i class="fa-regular fa-star"></i></button>';
      }).join('') +
    '</div>' +
    '<textarea id="axRateComment" rows="3" maxlength="300" placeholder="Anything you\'d like to add? (optional)"></textarea>' +
    '<button type="button" class="btn-primary btn-full" onclick="axSubmitDeliveryRating()"><i class="fa-solid fa-paper-plane"></i> Submit rating</button>' +
  '</div>';
  ov.addEventListener('click', function (e) { if (e.target === ov) ov.remove(); });
  document.body.appendChild(ov);
}
function axSetRating(n) {
  _axRateValue = n;
  document.querySelectorAll('#axRateStars .ax-rate-star').forEach(function (b) {
    const on = parseInt(b.dataset.val, 10) <= n;
    b.classList.toggle('on', on);
    b.innerHTML = '<i class="fa-' + (on ? 'solid' : 'regular') + ' fa-star"></i>';
  });
}
async function axSubmitDeliveryRating() {
  if (!_axRateValue) { showToast('Pick a star rating first', 'warning'); return; }
  const comment = (document.getElementById('axRateComment')?.value || '').trim();
  const data = await mpApi('/delivery/rate', {
    method: 'POST',
    body: JSON.stringify({ arn: _axRateArn, rating: _axRateValue, comment: comment }),
  });
  if (data && data.success) {
    document.getElementById('axRateSheet')?.remove();
    showToast('Thanks — your rating helps other buyers', 'success');
  } else {
    showToast((data && data.error) || 'Could not submit rating', 'error');
  }
}

/* Download the GST invoice for a delivered order (Phase 1). The backend
   returns an empty url until the delivery is actually completed. */
async function axDownloadInvoice(arn) {
  if (!arn) return;
  showToast('Fetching invoice…', 'info');
  const data = await mpApi('/order/invoice?arn=' + encodeURIComponent(arn));
  if (data && data.invoice_url) {
    window.open(data.invoice_url, '_blank', 'noopener');
    return;
  }
  showToast((data && (data.message || data.error)) || 'Invoice not available yet', 'warning');
}

/* ── Account & History panel (Batch G) ──────────────────────────────
   One panel serving all three roles: seller + delivery-partner earnings
   come from the backend payout ledger (/account/summary), buyer orders
   from the local order history. Each role card shows total / paid /
   pending and a COD-vs-online split; below them a full transactions
   ledger. GST + platform fee are company-retained, noted at the bottom. */
async function axLoadAccount() {
  const el = document.getElementById('accountContent');
  if (!el) return;
  el.innerHTML = '<div class="ax-account-loading"><i class="fa-solid fa-spinner fa-spin"></i> Loading your account…</div>';
  let data = {};
  try { data = (typeof mpApi === 'function') ? await mpApi('/account/summary') : {}; } catch (e) { data = {}; }
  const roles = (data && data.roles) || {};
  const txns = (data && data.transactions) || [];
  const inr = n => '₹' + (Number(n) || 0).toLocaleString('en-IN', { maximumFractionDigits: 2 });
  const esc = s => String(s == null ? '' : s).replace(/[<>&]/g, c => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;' }[c]));
  const roleCard = (key, title, icon) => {
    const r = roles[key];
    if (!r) return '';
    return '<div class="ax-acct-card">' +
      '<div class="ax-acct-card-head"><i class="' + icon + '"></i> ' + title + '</div>' +
      '<div class="ax-acct-stat-row">' +
        '<div class="ax-acct-stat"><span>Total</span><b>' + inr(r.total) + '</b></div>' +
        '<div class="ax-acct-stat"><span>Paid</span><b class="pos">' + inr(r.paid) + '</b></div>' +
        '<div class="ax-acct-stat"><span>Pending</span><b class="warn">' + inr(r.pending) + '</b></div>' +
      '</div>' +
      '<div class="ax-acct-split"><span><i class="fa-solid fa-hand-holding-dollar"></i> COD ' + inr(r.cod) + '</span>' +
        '<span><i class="fa-solid fa-credit-card"></i> Online ' + inr(r.online) + '</span>' +
        '<span>' + (r.count || 0) + ' orders</span></div>' +
    '</div>';
  };
  let html = '';
  html += roleCard('seller', 'Seller Earnings', 'fa-solid fa-store');
  html += roleCard('delivery_partner', 'Delivery Earnings', 'fa-solid fa-truck-fast');
  // COD vs Online donut across all of the user's earnings (Phase 2 graphics).
  const totCod = Object.values(roles).reduce((a, r) => a + (r.cod || 0), 0);
  const totOnline = Object.values(roles).reduce((a, r) => a + (r.online || 0), 0);
  if ((totCod || totOnline) && typeof axDonut === 'function') {
    html += '<div class="ax-acct-card"><div class="ax-acct-card-head"><i class="fa-solid fa-chart-pie"></i> Payment mix</div>' +
      axDonut([{ label: 'COD', value: totCod, color: '#C7993A' }, { label: 'Online', value: totOnline, color: '#2E6B41' }],
        { center: inr(totCod + totOnline), centerSub: 'Total', fmt: inr }) + '</div>';
  }
  const orders = (typeof getOrderHistory === 'function') ? getOrderHistory() : [];
  if (orders.length) {
    html += '<div class="ax-acct-card"><div class="ax-acct-card-head"><i class="fa-solid fa-bag-shopping"></i> Your Orders (' + orders.length + ')</div>' +
      orders.slice(0, 20).map(o => {
        const delivered = String(o.status || '').toLowerCase().indexOf('deliver') !== -1;
        const arn = esc(o.arn || '');
        // Whole row taps through to the full order-detail sheet (History
        // transparency) when we know the ARN.
        const clickable = o.arn ? ' ax-acct-txn-tap" onclick="if(typeof axOpenOrderDetail===\'function\')axOpenOrderDetail(\'' + arn + '\')"' : '"';
        return '<div class="ax-acct-txn' + clickable + '><div><b>' + esc(o.product || '—') + '</b>' +
          '<small>' + esc(o.type || '') + ' · ' + esc(o.qty || '') + ' kg · ' + arn + '</small></div>' +
          '<span class="ax-acct-txn-right">' +
            '<span class="ax-acct-txn-status">' + esc(o.status || 'New') + '</span>' +
            (o.arn ? '<i class="fa-solid fa-chevron-right ax-acct-chev"></i>' : '') +
          '</span></div>';
      }).join('') +
    '</div>';
  }
  if (txns.length) {
    html += '<div class="ax-acct-card"><div class="ax-acct-card-head"><i class="fa-solid fa-receipt"></i> Transactions</div>' +
      txns.map(t => {
        const arn = esc(t.arn || '');
        const tap = t.arn ? ' ax-acct-txn-tap" onclick="if(typeof axOpenOrderDetail===\'function\')axOpenOrderDetail(\'' + arn + '\')"' : '"';
        return '<div class="ax-acct-txn' + tap + '><div><b>' + inr(t.amount) + ' <small class="ax-acct-role">' +
          (t.payee_type === 'delivery_partner' ? 'delivery' : 'seller') + '</small></b>' +
          '<small>' + arn + ' · ' + esc((t.payment_method || '').toUpperCase()) + ' · ' + esc((t.created_at || '').slice(0, 10)) + '</small></div>' +
          '<span class="ax-acct-txn-status ' + (t.status === 'paid' ? 'pos' : 'warn') + '">' + esc(t.status || '') + '</span></div>';
      }).join('') +
    '</div>';
  }
  if (!html) {
    html = (typeof axEmptyState === 'function')
      ? axEmptyState('box', 'No account activity yet', 'Your earnings, payouts and orders will appear here once you buy, sell, or deliver.')
      : '<div class="ax-account-empty"><i class="fa-solid fa-wallet"></i><p>No account activity yet.</p></div>';
  } else {
    html += '<p class="ax-acct-note"><i class="fa-solid fa-circle-info"></i> GST &amp; platform fee are retained by Aarvex Global on each order — amounts shown are your net payout.</p>';
  }
  el.innerHTML = html;
}
