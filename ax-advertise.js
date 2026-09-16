/* ============================================================================
   ax-advertise.js — Self-serve ad booking (Phase 3)
   ----------------------------------------------------------------------------
   A logged-in advertiser books a district / state / national ad, pays via the
   in-app Cashfree modal, and lands as a pending-review campaign an admin
   approves. Reuses mpApi (auth), axCashfreeCheckout (portal-helpers) and the
   Cashfree SDK already loaded by portal.html.

   - Theme-aware: reads the portal's light/dark theme and paints the modal to
     match (the old modal relied on tokens that don't exist, so it broke in dark).
   - State → District dropdowns (ax-india-districts.js) stop typos that would
     silently target the wrong / no area; an "Other…" option keeps coverage open.
   - Slot availability: the quote reports whether the slot is free for the dates;
     a full slot disables Pay so we never take money for a slot we can't give.

   Entry point: window.axOpenAdBooking()
   ============================================================================ */
(function () {
  'use strict';

  var PLACEMENTS = [
    ['dashboard', 'Home — top banner'],
    ['trade', 'Trade — top banner'],
    ['trade_mid', 'Trade — swipe slide 1'],
    ['trade_mid2', 'Trade — swipe slide 2'],
    ['trade_mid3', 'Trade — swipe slide 3'],
    ['trade_bottom', 'Trade — below products'],
  ];
  var DAY_OPTIONS = [7, 15, 30, 60, 90];

  var THEME = {
    light: { overlay: 'rgba(10,15,25,.5)', surface: '#ffffff', surface2: '#f4f6fb', text: '#141a2e', text3: '#5a6480', border: '#d9dfec', accent: '#2f4fc8', accentInk: '#ffffff', good: '#1f9d55', goodBg: '#e6f4ec', warn: '#b06d0c', warnBg: '#f8efd9', bad: '#c0392b', badBg: '#f8e5e2' },
    dark: { overlay: 'rgba(0,0,0,.62)', surface: '#161d2e', surface2: '#1e2740', text: '#e9ecf8', text3: '#98a2c2', border: '#2c3652', accent: '#7d95f2', accentInk: '#0b1020', good: '#46cb88', goodBg: '#152a20', warn: '#e0a54b', warnBg: '#2c2314', bad: '#ec8177', badBg: '#2e1a18' },
  };

  function esc(s) { return String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/"/g, '&quot;'); }
  function el(id) { return document.getElementById(id); }
  function toast(m, t) { if (typeof showToast === 'function') showToast(m, t || 'info'); }

  function isDark() {
    var t = document.documentElement.getAttribute('data-theme');
    if (t === 'dark') return true;
    if (t === 'light') return false;
    return !!(window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)').matches);
  }

  function axOpenAdBooking() {
    if (el('axAdBookModal')) return;
    if (typeof mpApi !== 'function') { toast('Please open this from inside the app', 'error'); return; }
    var c = isDark() ? THEME.dark : THEME.light;
    var hasData = (typeof axIndiaStates === 'function');

    var wrap = document.createElement('div');
    wrap.id = 'axAdBookModal';
    wrap.setAttribute('role', 'dialog');
    wrap.setAttribute('aria-modal', 'true');
    wrap.style.cssText = 'position:fixed;inset:0;z-index:100000;background:' + c.overlay +
      ';display:flex;align-items:flex-start;justify-content:center;overflow:auto;padding:18px;font-family:inherit';

    var stateOpts = hasData
      ? '<option value="">— Select state —</option>' + axIndiaStates().map(function (s) { return '<option value="' + esc(s) + '">' + esc(s) + '</option>'; }).join('')
      : '';

    wrap.innerHTML =
      '<div class="axad-card">' +
      '<div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:4px">' +
      '<h3 style="margin:0;font-size:20px;color:var(--ax-text)">📣 Advertise on Aarvex</h3>' +
      '<button id="axAdClose" type="button" aria-label="Close" style="border:0;background:none;font-size:24px;line-height:1;cursor:pointer;color:var(--ax-text3)">&times;</button></div>' +
      '<p style="margin:0 0 14px;font-size:13px;color:var(--ax-text3)">अपने ज़िले के ग्राहकों तक पहुँचें। Book करें, pay करें — review के बाद live।</p>' +

      _field('Where', '<select id="axAdPlacement" class="axad-in">' + PLACEMENTS.map(function (p) { return '<option value="' + p[0] + '">' + esc(p[1]) + '</option>'; }).join('') + '</select>') +
      '<div style="display:flex;gap:10px">' +
        '<div style="flex:1">' + _field('Reach', '<select id="axAdScope" class="axad-in"><option value="district">District (one district)</option><option value="state">State (whole state)</option><option value="national">National (all India)</option></select>') + '</div>' +
        '<div style="flex:1">' + _field('Duration', '<select id="axAdDays" class="axad-in">' + DAY_OPTIONS.map(function (d) { return '<option value="' + d + '"' + (d === 7 ? ' selected' : '') + '>' + d + ' days</option>'; }).join('') + '</select>') + '</div>' +
      '</div>' +
      '<div id="axAdStateWrap" style="display:none">' + _field('State', hasData
        ? '<select id="axAdState" class="axad-in">' + stateOpts + '</select>'
        : '<input id="axAdState" type="text" placeholder="Maharashtra" class="axad-in">') + '</div>' +
      '<div id="axAdDistrictWrap" style="display:none">' + _field('District', hasData
        ? '<select id="axAdDistrict" class="axad-in" disabled><option value="">— Select state first —</option></select>'
        : '<input id="axAdDistrict" type="text" placeholder="Nagpur" class="axad-in">') + '</div>' +
      '<div id="axAdDistrictOtherWrap" style="display:none">' + _field('District name', '<input id="axAdDistrictOther" type="text" placeholder="Type your district" class="axad-in">') + '</div>' +

      _field('Ad image / video (≤10MB)', '<input id="axAdFile" type="file" accept="image/jpeg,image/png,image/gif,video/mp4,video/webm" class="axad-in">') +
      _field('Link (optional)', '<input id="axAdLink" type="url" placeholder="https://…" class="axad-in">') +
      '<div style="display:flex;gap:10px">' +
        '<div style="flex:1">' + _field('Title (optional)', '<input id="axAdTitle" type="text" maxlength="80" class="axad-in">') + '</div>' +
        '<div style="flex:1">' + _field('Start (optional)', '<input id="axAdStart" type="datetime-local" class="axad-in">') + '</div>' +
      '</div>' +

      '<div id="axAdQuote" class="axad-quote">Price: <b>—</b></div>' +
      '<div id="axAdAvail" style="display:none;margin:-6px 0 12px;padding:9px 12px;border-radius:9px;font-size:13px"></div>' +
      '<button id="axAdPay" type="button" class="axad-pay">Pay &amp; Submit</button>' +
      '<div id="axAdMine" style="margin-top:16px"></div>' +

      '<style>' +
      '#axAdBookModal{' +
        '--ax-surface:' + c.surface + ';--ax-surface2:' + c.surface2 + ';--ax-text:' + c.text + ';--ax-text3:' + c.text3 +
        ';--ax-border:' + c.border + ';--ax-accent:' + c.accent + ';--ax-accent-ink:' + c.accentInk + ';--ax-good:' + c.good +
        ';--ax-good-bg:' + c.goodBg + ';--ax-bad:' + c.bad + ';--ax-bad-bg:' + c.badBg + ';--ax-warn:' + c.warn + ';--ax-warn-bg:' + c.warnBg + '}' +
      '.axad-card{background:var(--ax-surface);color:var(--ax-text);max-width:460px;width:100%;border-radius:16px;padding:22px;margin:auto;box-shadow:0 24px 70px rgba(0,0,0,.45);border:1px solid var(--ax-border)}' +
      '.axad-in{width:100%;padding:10px 11px;border:1px solid var(--ax-border);border-radius:9px;font-size:14px;font-family:inherit;background:var(--ax-surface2);color:var(--ax-text);box-sizing:border-box}' +
      '.axad-in:focus{outline:2px solid var(--ax-accent);outline-offset:0;border-color:var(--ax-accent)}' +
      '.axad-in:disabled{opacity:.6}' +
      'select.axad-in{appearance:auto}' +
      '.axad-lbl{font-size:11.5px;text-transform:uppercase;letter-spacing:.04em;color:var(--ax-text3);margin:10px 0 4px;display:block;font-weight:600}' +
      '.axad-quote{margin:8px 0 12px;padding:12px 14px;border-radius:10px;background:var(--ax-surface2);font-size:14px;color:var(--ax-text)}' +
      '.axad-quote b{color:var(--ax-text)}' +
      '.axad-pay{width:100%;padding:13px;border:0;border-radius:10px;background:var(--ax-accent);color:var(--ax-accent-ink);font-size:16px;font-weight:700;cursor:pointer}' +
      '.axad-pay:disabled{opacity:.5;cursor:not-allowed}' +
      '</style>' +
      '</div>';
    document.body.appendChild(wrap);

    function close() { var m = el('axAdBookModal'); if (m) m.remove(); }
    wrap.addEventListener('click', function (e) { if (e.target === wrap) close(); });
    el('axAdClose').onclick = close;
    el('axAdScope').onchange = function () { onScope(); refreshQuote(); };
    el('axAdPlacement').addEventListener('change', refreshQuote);
    el('axAdDays').addEventListener('change', refreshQuote);
    el('axAdStart').addEventListener('change', refreshQuote);
    if (hasData) {
      el('axAdState').addEventListener('change', function () { fillDistricts(); refreshQuote(); });
      el('axAdDistrict').addEventListener('change', function () { onDistrictPick(); refreshQuote(); });
      el('axAdDistrictOther').addEventListener('input', refreshQuote);
    } else {
      el('axAdState').addEventListener('input', refreshQuote);
      el('axAdDistrict').addEventListener('input', refreshQuote);
    }
    el('axAdPay').onclick = submit;
    onScope();
    refreshQuote();
    loadMine();

    function onScope() {
      var s = el('axAdScope').value;
      el('axAdStateWrap').style.display = (s === 'state' || s === 'district') ? '' : 'none';
      el('axAdDistrictWrap').style.display = (s === 'district') ? '' : 'none';
      if (s !== 'district') el('axAdDistrictOtherWrap').style.display = 'none';
    }

    function fillDistricts() {
      if (!hasData) return;
      var sel = el('axAdDistrict');
      var st = el('axAdState').value;
      var list = st ? axDistrictsOf(st) : [];
      sel.innerHTML = (st ? '<option value="">— Select district —</option>' : '<option value="">— Select state first —</option>')
        + list.map(function (d) { return '<option value="' + esc(d) + '">' + esc(d) + '</option>'; }).join('')
        + (st ? '<option value="__other__">Other… (type it)</option>' : '');
      sel.disabled = !st;
      el('axAdDistrictOtherWrap').style.display = 'none';
      el('axAdDistrictOther').value = '';
    }

    function onDistrictPick() {
      var other = el('axAdDistrict').value === '__other__';
      el('axAdDistrictOtherWrap').style.display = other ? '' : 'none';
    }

    function currentDistrict() {
      if (!hasData) return el('axAdDistrict').value.trim();
      if (el('axAdDistrict').value === '__other__') return el('axAdDistrictOther').value.trim();
      return el('axAdDistrict').value.trim();
    }
    function currentState() { return el('axAdState').value.trim(); }

    var _quoteAmt = 0, _available = true;
    async function refreshQuote() {
      var p = el('axAdPlacement').value, s = el('axAdScope').value, d = el('axAdDays').value || 7;
      var st = currentState(), di = currentDistrict();
      var startVal = el('axAdStart').value;
      var startIso = startVal ? new Date(startVal).toISOString() : '';
      // Need the target before availability is meaningful.
      var haveTarget = (s === 'national') || (s === 'state' && st) || (s === 'district' && di);
      try {
        var qs = '/ad/booking/quote?placement=' + encodeURIComponent(p) + '&scope=' + encodeURIComponent(s) +
          '&days=' + encodeURIComponent(d) + '&state=' + encodeURIComponent(st) + '&district=' + encodeURIComponent(di) +
          '&start=' + encodeURIComponent(startIso);
        var q = await mpApi(qs);
        if (q && q.success) {
          _quoteAmt = q.amount;
          el('axAdQuote').innerHTML = 'Price: <b>₹' + q.amount + '</b> <span style="color:var(--ax-text3)">(₹' + q.per_day + '/day × ' + q.days + ' days)</span>';
          updateAvail(haveTarget, q);
        }
      } catch (e) { /* ignore */ }
    }

    function updateAvail(haveTarget, q) {
      var box = el('axAdAvail'), btn = el('axAdPay');
      if (!haveTarget) { box.style.display = 'none'; _available = true; btn.disabled = false; return; }
      box.style.display = '';
      _available = !!q.available;
      if (q.available) {
        var left = q.slots_left, cap = q.capacity;
        box.style.background = 'var(--ax-good-bg)'; box.style.color = 'var(--ax-good)';
        box.innerHTML = '✅ Slot available' + (cap > 1 ? ' — ' + left + ' of ' + cap + ' left for these dates' : ' for these dates');
        btn.disabled = false;
      } else {
        box.style.background = 'var(--ax-bad-bg)'; box.style.color = 'var(--ax-bad)';
        box.innerHTML = '⛔ यह slot इन तारीख़ों के लिए full है। दूसरी dates, दूसरा placement, या wider reach चुनें।';
        btn.disabled = true;
      }
    }

    async function submit() {
      var f = el('axAdFile').files[0];
      if (!f) { toast('Please choose an image or video', 'error'); return; }
      if (f.size > 10 * 1024 * 1024) { toast('Max 10MB', 'error'); return; }
      var scope = el('axAdScope').value;
      var st = currentState(), di = currentDistrict();
      if (scope === 'district' && !di) { toast('Please select your district', 'error'); return; }
      if (scope === 'state' && !st) { toast('Please select the state', 'error'); return; }
      if (!_available) { toast('That slot is full for these dates', 'error'); return; }
      var btn = el('axAdPay'); btn.disabled = true; btn.textContent = 'Preparing…';
      try {
        var b64 = await new Promise(function (r) { var fr = new FileReader(); fr.onload = function () { r(fr.result); }; fr.readAsDataURL(f); });
        var mediaType = f.type.indexOf('video/') === 0 ? 'video' : (f.type === 'image/gif' ? 'gif' : 'image');
        var startVal = el('axAdStart').value;
        var payload = {
          placement: el('axAdPlacement').value,
          scope: scope,
          state: st,
          district: di,
          days: parseInt(el('axAdDays').value || '7', 10),
          image_b64: b64,
          media_type: mediaType,
          link_url: el('axAdLink').value.trim(),
          title: el('axAdTitle').value.trim(),
          start_at: startVal ? new Date(startVal).toISOString() : '',
        };
        var res = await mpApi('/ad/booking/create', { method: 'POST', body: JSON.stringify(payload) });
        if (res && res.error === 'slot_full') { toast(res.message || 'That slot is full for these dates', 'error'); refreshQuote(); btn.disabled = false; btn.textContent = 'Pay & Submit'; return; }
        if (!res || !res.success) { toast((res && res.error) || 'Could not create booking', 'error'); btn.disabled = false; btn.textContent = 'Pay & Submit'; return; }
        if (!res.payment_session_id) { toast('Payment could not start — try again later', 'error'); btn.disabled = false; btn.textContent = 'Pay & Submit'; return; }
        btn.textContent = 'Opening payment…';
        if (typeof axCashfreeCheckout !== 'function') { toast('Payment unavailable here', 'error'); btn.disabled = false; btn.textContent = 'Pay & Submit'; return; }
        var pay = await axCashfreeCheckout(res.payment_session_id, res.payment_mode);
        if (pay && pay.paid) {
          el('axAdPay').outerHTML = '<div style="padding:14px;border-radius:10px;background:var(--ax-good-bg);color:var(--ax-good);font-size:14px;text-align:center">✅ Payment received! Your ad is <b>under review</b> and will go live once approved.</div>';
          loadMine();
        } else {
          toast(pay && pay.cancelled ? 'Payment cancelled' : 'Payment not completed', 'warning');
          btn.disabled = false; btn.textContent = 'Pay & Submit';
        }
      } catch (e) {
        toast('Something went wrong: ' + (e.message || e), 'error');
        btn.disabled = false; btn.textContent = 'Pay & Submit';
      }
    }

    async function loadMine() {
      try {
        var data = await mpApi('/ad/booking/mine');
        var rows = (data && data.bookings) || [];
        if (!rows.length) { el('axAdMine').innerHTML = ''; return; }
        el('axAdMine').innerHTML =
          '<div class="axad-lbl">Your ads</div>' +
          rows.slice(0, 8).map(function (b) {
            var target = b.scope === 'district' ? (b.target_district || 'District') : (b.scope === 'state' ? (b.target_state || 'State') : 'National');
            var label = b.status, color = 'var(--ax-text3)';
            if (b.status === 'pending_payment') { label = 'awaiting payment'; color = 'var(--ax-warn)'; }
            else if (b.campaign_status === 'pending_review') { label = 'under review'; color = 'var(--ax-text3)'; }
            else if (b.campaign_status === 'active') { label = 'live'; color = 'var(--ax-good)'; }
            else if (b.campaign_status === 'paused') { label = 'paused'; color = 'var(--ax-warn)'; }
            else if (b.status === 'paid') { label = 'paid'; color = 'var(--ax-good)'; }
            var stats = (b.impressions || b.clicks)
              ? '<div style="font-size:11px;color:var(--ax-text3)">' + b.impressions + ' views · ' + b.clicks + ' clicks · ' + b.ctr + '% CTR</div>'
              : '';
            return '<div style="display:flex;gap:10px;align-items:center;padding:8px 0;border-top:1px solid var(--ax-border);font-size:13px">' +
              (b.image_url ? '<img src="' + esc(b.image_url) + '" style="width:40px;height:28px;object-fit:cover;border-radius:5px">' : '') +
              '<div style="flex:1;min-width:0"><b>' + esc(b.placement) + '</b> · ' + esc(target) + '<div style="font-size:11.5px;color:var(--ax-text3)">₹' + b.amount + ' · ' + b.days + ' days</div>' + stats + '</div>' +
              '<span style="color:' + color + ';font-weight:600;font-size:12px">' + esc(label) + '</span></div>';
          }).join('');
      } catch (e) { /* ignore */ }
    }
  }

  function _field(label, inner) {
    return '<label class="axad-lbl">' + esc(label) + '</label>' + inner;
  }

  window.axOpenAdBooking = axOpenAdBooking;
})();
