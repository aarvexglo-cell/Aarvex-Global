/* Aarvex Portal — RFQ / Price Negotiation (Phase 1)
 * Buyer opens a negotiation on a product; buyer and seller trade offers in a
 * chat-style thread until one side accepts. Backend:
 *   /rfq/create · /rfq/message · /rfq/list · /rfq/get   (marketplace.py)
 * Depends on mpApi + showToast (portal-marketplace.js). Load after it.
 */
'use strict';

let _axRfqId = null;

function axRfqEsc(s) {
  return String(s == null ? '' : s).replace(/[<>&"]/g, function (c) {
    return { '<': '&lt;', '>': '&gt;', '&': '&amp;', '"': '&quot;' }[c];
  });
}
function axRfqMoney(n) { return '₹' + (Number(n) || 0).toLocaleString('en-IN', { maximumFractionDigits: 2 }); }

/* Step 1 — buyer's opening offer for a product. */
function axOpenRfqComposer(productId, categoryId, productName, listPrice) {
  let ov = document.getElementById('axRfqComposer');
  if (ov) ov.remove();
  ov = document.createElement('div');
  ov.id = 'axRfqComposer';
  ov.className = 'ax-comments-overlay';
  ov.innerHTML = '<div class="ax-rfq-box">' +
    '<div class="ax-comments-head"><b><i class="fa-solid fa-handshake"></i> Negotiate price</b>' +
      '<button type="button" class="ax-strip-icon-btn" onclick="document.getElementById(\'axRfqComposer\').remove()" aria-label="Close"><i class="fa-solid fa-xmark"></i></button></div>' +
    '<p class="ax-rfq-sub">Send your offer to the seller of <b>' + axRfqEsc(productName) + '</b>' +
      (listPrice ? '. Listed at ' + axRfqMoney(listPrice) + '/kg.' : '.') + '</p>' +
    '<div class="ax-rfq-fields">' +
      '<label>Your price (₹/kg)<input type="number" id="axRfqPrice" min="1" placeholder="e.g. ' + (listPrice ? Math.round(listPrice * 0.9) : 100) + '"></label>' +
      '<label>Quantity (kg)<input type="number" id="axRfqQty" min="1" placeholder="e.g. 500"></label>' +
    '</div>' +
    '<textarea id="axRfqText" rows="2" maxlength="300" placeholder="Message to seller (optional)…"></textarea>' +
    '<button type="button" class="btn-primary btn-full" onclick="axRfqSubmitCreate(\'' + axRfqEsc(productId) + '\',\'' + axRfqEsc(categoryId) + '\')"><i class="fa-solid fa-paper-plane"></i> Send offer</button>' +
  '</div>';
  ov.addEventListener('click', function (e) { if (e.target === ov) ov.remove(); });
  document.body.appendChild(ov);
}

async function axRfqSubmitCreate(productId, categoryId) {
  const price = parseFloat(document.getElementById('axRfqPrice')?.value || '0');
  const qty = parseFloat(document.getElementById('axRfqQty')?.value || '0');
  const text = (document.getElementById('axRfqText')?.value || '').trim();
  if (!price || price <= 0) { showToast('Enter your offer price', 'warning'); return; }
  const data = await mpApi('/rfq/create', {
    method: 'POST',
    body: JSON.stringify({ product_id: productId, category_id: categoryId, price: price, quantity_kg: qty, text: text }),
  });
  if (data && data.success && data.rfq) {
    document.getElementById('axRfqComposer')?.remove();
    if (typeof ProductModal !== 'undefined' && ProductModal.closeModal) ProductModal.closeModal();
    axOpenRfqThread(data.rfq);
    showToast('Offer sent — the seller has been notified', 'success');
  } else {
    showToast((data && data.error) || 'Could not send offer', 'error');
  }
}

/* Step 2 — the negotiation thread. `rfq` may be a full object (from create /
   get) or just a header with an rfq_id, in which case we fetch it. */
async function axOpenRfqThread(rfq) {
  if (typeof rfq === 'string') rfq = { rfq_id: rfq };
  _axRfqId = rfq.rfq_id;
  if (!rfq.messages) {
    const data = await mpApi('/rfq/get?rfq_id=' + encodeURIComponent(rfq.rfq_id));
    if (!data || !data.rfq) { showToast('Could not open negotiation', 'error'); return; }
    rfq = data.rfq;
  }
  let ov = document.getElementById('axRfqThread');
  if (ov) ov.remove();
  ov = document.createElement('div');
  ov.id = 'axRfqThread';
  ov.className = 'ax-comments-overlay';
  ov.innerHTML = '<div class="ax-rfq-thread-box">' +
    '<div class="ax-comments-head"><div class="ax-rfq-thread-title"><b>' + axRfqEsc(rfq.product_name || 'Negotiation') + '</b>' +
      '<small>' + (rfq.i_am_seller ? 'Buyer: ' + axRfqEsc(rfq.buyer_name || '—') : 'with the seller') + '</small></div>' +
      '<button type="button" class="ax-strip-icon-btn" onclick="axCloseRfqThread()" aria-label="Close"><i class="fa-solid fa-xmark"></i></button></div>' +
    '<div class="ax-rfq-msgs" id="axRfqMsgs"></div>' +
    '<div class="ax-rfq-foot" id="axRfqFoot"></div>' +
  '</div>';
  ov.addEventListener('click', function (e) { if (e.target === ov) axCloseRfqThread(); });
  document.body.appendChild(ov);
  document.body.style.overflow = 'hidden';
  axRfqRender(rfq);
}
function axCloseRfqThread() {
  document.getElementById('axRfqThread')?.remove();
  document.body.style.overflow = '';
}

function axRfqRender(rfq) {
  const box = document.getElementById('axRfqMsgs');
  const foot = document.getElementById('axRfqFoot');
  if (!box || !foot) return;
  box.innerHTML = (rfq.messages || []).map(function (m) {
    const side = m.mine ? 'mine' : 'theirs';
    let body;
    if (m.kind === 'offer') {
      body = '<div class="ax-rfq-offer"><span class="ax-rfq-price">' + axRfqMoney(m.price) + '/kg</span>' +
        (m.quantity_kg ? '<span class="ax-rfq-qty">× ' + m.quantity_kg + ' kg</span>' : '') + '</div>' +
        (m.text ? '<div class="ax-rfq-note">' + axRfqEsc(m.text) + '</div>' : '');
    } else if (m.kind === 'accept') {
      body = '<div class="ax-rfq-accepted"><i class="fa-solid fa-circle-check"></i> Accepted at ' + axRfqMoney(m.price) + '/kg</div>';
    } else {
      body = '<div class="ax-rfq-note">' + axRfqEsc(m.text) + '</div>';
    }
    return '<div class="ax-rfq-msg ' + side + '"><div class="ax-rfq-bubble">' +
      '<div class="ax-rfq-from">' + axRfqEsc(m.from_name) + '</div>' + body + '</div></div>';
  }).join('') || '<p class="ax-feed-loading">No messages yet.</p>';
  box.scrollTop = box.scrollHeight;

  if (rfq.status === 'accepted') {
    foot.innerHTML = '<div class="ax-rfq-deal"><i class="fa-solid fa-circle-check"></i> Price agreed at <b>' + axRfqMoney(rfq.agreed_price) + '/kg</b>' +
      (rfq.i_am_buyer ? ' <button type="button" class="btn-primary btn-sm" onclick="axRfqBuyAtAgreed()">Place order</button>' : '') + '</div>';
    return;
  }
  if (rfq.status !== 'open') {
    foot.innerHTML = '<div class="ax-rfq-closed">This negotiation is closed.</div>';
    return;
  }
  const lastOffer = [...(rfq.messages || [])].reverse().find(function (m) { return m.kind === 'offer'; });
  const canAccept = lastOffer && !lastOffer.mine;
  foot.innerHTML =
    '<div class="ax-rfq-reply">' +
      '<input type="number" id="axRfqReplyPrice" min="1" placeholder="Counter ₹/kg">' +
      '<button type="button" class="btn-secondary btn-sm" onclick="axRfqSend(\'offer\')">Counter</button>' +
    '</div>' +
    (canAccept ? '<button type="button" class="btn-primary btn-full ax-rfq-accept" onclick="axRfqAccept(' + (lastOffer.price || 0) + ',' + (lastOffer.quantity_kg || 0) + ')"><i class="fa-solid fa-check"></i> Accept ' + axRfqMoney(lastOffer.price) + '/kg</button>' : '') +
    '<textarea id="axRfqReplyText" rows="1" maxlength="300" placeholder="Message…" class="ax-rfq-reply-text"></textarea>' +
    '<button type="button" class="ax-rfq-send-text" onclick="axRfqSend(\'text\')"><i class="fa-solid fa-paper-plane"></i></button>';
}

async function axRfqSend(kind) {
  const body = { rfq_id: _axRfqId, kind: kind };
  if (kind === 'offer') {
    const price = parseFloat(document.getElementById('axRfqReplyPrice')?.value || '0');
    if (!price) { showToast('Enter a counter price', 'warning'); return; }
    body.price = price;
  } else {
    const text = (document.getElementById('axRfqReplyText')?.value || '').trim();
    if (!text) return;
    body.text = text;
  }
  const data = await mpApi('/rfq/message', { method: 'POST', body: JSON.stringify(body) });
  if (data && data.rfq) axRfqRender(data.rfq);
  else showToast((data && data.error) || 'Could not send', 'error');
}
async function axRfqAccept(price, qty) {
  if (!confirm('Accept this price of ₹' + price + '/kg?')) return;
  const data = await mpApi('/rfq/message', {
    method: 'POST',
    body: JSON.stringify({ rfq_id: _axRfqId, kind: 'accept', price: price, quantity_kg: qty }),
  });
  if (data && data.rfq) { axRfqRender(data.rfq); showToast('Price accepted', 'success'); }
  else showToast((data && data.error) || 'Could not accept', 'error');
}
/* After a deal, jump the buyer into the normal order form pre-primed. */
function axRfqBuyAtAgreed() {
  showToast('Opening order form at the agreed price…', 'info');
  axCloseRfqThread();
  // The order form already lets the buyer confirm quantity + address; the
  // agreed price is carried as a note. (Full auto-fill wiring is a later step.)
  if (typeof switchPanel === 'function') { switchPanel('trade'); if (typeof switchTradeMode === 'function') switchTradeMode('order'); }
}

/* Inbox — all my negotiations (buyer + seller side). */
async function axLoadRfqInbox() {
  const el = document.getElementById('rfqInboxList');
  if (!el) return;
  el.innerHTML = '<p class="ax-feed-loading"><i class="fa-solid fa-spinner fa-spin"></i> Loading…</p>';
  const data = await mpApi('/rfq/list');
  const rfqs = (data && data.rfqs) || [];
  if (!rfqs.length) {
    el.innerHTML = (typeof axEmptyState === 'function')
      ? axEmptyState('box', 'No negotiations yet', 'Open any product and tap “Negotiate Price” to start bargaining with the seller.')
      : '<div class="ax-account-empty"><i class="fa-solid fa-handshake"></i><p>No price negotiations yet.</p></div>';
    return;
  }
  el.innerHTML = rfqs.map(function (r) {
    const statusCls = r.status === 'accepted' ? 'pos' : (r.status === 'open' ? 'warn' : '');
    return '<button type="button" class="ax-rfq-inbox-row" onclick="axOpenRfqThread(\'' + axRfqEsc(r.rfq_id) + '\')">' +
      '<div><b>' + axRfqEsc(r.product_name || 'Product') + '</b>' +
        '<small>' + (r.i_am_seller ? 'Buyer: ' + axRfqEsc(r.buyer_name || '—') : 'You are buying') +
        (r.agreed_price ? ' · agreed ' + axRfqMoney(r.agreed_price) + '/kg' : '') + '</small></div>' +
      '<span class="ax-rfq-inbox-status ' + statusCls + '">' + axRfqEsc(r.status) + '</span></button>';
  }).join('');
}
