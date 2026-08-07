/* Aarvex — Location Picker (Leaflet + own Nominatim-based typeahead search)
 * Free/open-source replacement for the old Google/Mappls address text-fields.
 *
 * NOTE: an earlier version depended on the "leaflet-control-geocoder" plugin
 * for the search box — that plugin isn't reliably available on cdnjs, so the
 * search box silently never appeared. This version only depends on plain
 * Leaflet (confirmed working) and talks to OpenStreetMap's free Nominatim
 * API directly for a Google-style live-suggestion dropdown, so there's
 * nothing extra that can fail to load.
 *
 * Usage:
 *   LocationPicker.open({
 *     lat: 20.5937, lng: 78.9629,          // optional starting point
 *     onSave: function (addr) { ... }       // addr = {address, city, state, pincode, lat, lng}
 *   });
 */
(function (global) {
  'use strict';

  var DEFAULT_CENTER = [20.5937, 78.9629]; // India centroid
  var _map = null, _marker = null, _onSave = null, _modalEl = null;
  var _searchDebounce = null, _searchSeq = 0;

  function esc(s) {
    if (s == null) return '';
    return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  }

  function ensureLeafletLoaded(cb) {
    if (global.L) { cb(); return; }
    var css = document.createElement('link');
    css.rel = 'stylesheet';
    css.href = 'https://cdnjs.cloudflare.com/ajax/libs/leaflet/1.9.4/leaflet.min.css';
    document.head.appendChild(css);
    var js = document.createElement('script');
    js.src = 'https://cdnjs.cloudflare.com/ajax/libs/leaflet/1.9.4/leaflet.min.js';
    js.onload = cb;
    js.onerror = function () {
      alert('Could not load the map library. Please check your internet connection and try again.');
    };
    document.head.appendChild(js);
  }

  function buildModal() {
    var el = document.createElement('div');
    el.id = 'locationPickerModal';
    el.style.cssText = 'position:fixed;inset:0;background:rgba(14,30,22,.6);z-index:10000;display:flex;align-items:center;justify-content:center;padding:14px';
    el.innerHTML =
      '<div style="background:#fff;border-radius:16px;max-width:520px;width:100%;max-height:92vh;display:flex;flex-direction:column;overflow:hidden">' +
        '<div style="padding:16px 18px;border-bottom:1px solid #eee;display:flex;justify-content:space-between;align-items:center">' +
          '<strong style="font-size:16px">Pick delivery location</strong>' +
          '<button type="button" id="lpCloseBtn" style="border:none;background:none;font-size:20px;cursor:pointer;color:#888">&times;</button>' +
        '</div>' +
        '<div style="padding:12px 18px 0">' +
          '<div style="display:flex;gap:8px;margin-bottom:2px;position:relative">' +
            '<div style="flex:1;position:relative">' +
              '<i class="fa-solid fa-magnifying-glass" style="position:absolute;left:11px;top:50%;transform:translateY(-50%);color:#999;font-size:13px;pointer-events:none"></i>' +
              '<input id="lpSearchInput" placeholder="Search area, street, landmark…" autocomplete="off" ' +
                'style="width:100%;box-sizing:border-box;padding:10px 10px 10px 32px;border-radius:10px;border:1px solid #ddd;font-family:inherit;font-size:13.5px">' +
            '</div>' +
            '<button type="button" id="lpUseMyLocation" style="white-space:nowrap;padding:0 12px;border-radius:10px;border:1px solid #ddd;background:#f6f6f6;cursor:pointer;font-size:13px"><i class="fa-solid fa-location-crosshairs"></i> My location</button>' +
          '</div>' +
          '<p id="lpSearchStatus" style="font-size:11.5px;color:#999;margin:5px 2px 8px"></p>' +
        '</div>' +
        '<div id="lpMapHost" style="height:260px;width:100%"></div>' +
        '<div style="padding:10px 18px;font-size:12px;color:#888">Drag the pin, tap the map, or search above to set the exact spot.</div>' +
        '<div style="padding:0 18px 16px;display:grid;grid-template-columns:1fr 1fr;gap:8px">' +
          '<input id="lpLabel" placeholder="Label (e.g. Home, Warehouse)" style="grid-column:1/-1;padding:9px 10px;border-radius:9px;border:1px solid #ddd;font-family:inherit;font-size:13px">' +
          '<textarea id="lpAddress" placeholder="Full address" rows="2" style="grid-column:1/-1;padding:9px 10px;border-radius:9px;border:1px solid #ddd;font-family:inherit;font-size:13px"></textarea>' +
          '<input id="lpCity" placeholder="City" style="padding:9px 10px;border-radius:9px;border:1px solid #ddd;font-family:inherit;font-size:13px">' +
          '<input id="lpState" placeholder="State" style="padding:9px 10px;border-radius:9px;border:1px solid #ddd;font-family:inherit;font-size:13px">' +
          '<input id="lpPincode" placeholder="Pincode" style="padding:9px 10px;border-radius:9px;border:1px solid #ddd;font-family:inherit;font-size:13px">' +
        '</div>' +
        '<div style="padding:0 18px 18px;display:flex;gap:10px">' +
          '<button type="button" id="lpCancelBtn" style="flex:1;padding:11px;border-radius:10px;border:1px solid #ddd;background:#fff;cursor:pointer">Cancel</button>' +
          '<button type="button" id="lpSaveBtn" style="flex:1;padding:11px;border-radius:10px;border:none;background:var(--c-leaf,#2E6B41);color:#fff;font-weight:700;cursor:pointer">Save address</button>' +
        '</div>' +
      '</div>';
    document.body.appendChild(el);
    return el;
  }

  function fillFieldsFromAddress(a, displayName) {
    document.getElementById('lpAddress').value = displayName || '';
    document.getElementById('lpCity').value = a.city || a.town || a.village || a.county || a.suburb || '';
    document.getElementById('lpState').value = a.state || '';
    document.getElementById('lpPincode').value = a.postcode || '';
  }

  function reverseGeocode(lat, lng) {
    fetch('https://nominatim.openstreetmap.org/reverse?lat=' + lat + '&lon=' + lng + '&format=json&addressdetails=1')
      .then(function (r) { return r.json(); })
      .then(function (data) {
        fillFieldsFromAddress(data.address || {}, data.display_name);
      })
      .catch(function () { /* best-effort only — user can type manually */ });
  }

  function placeMarker(lat, lng, doReverseGeocode) {
    if (_marker) { _marker.setLatLng([lat, lng]); }
    else {
      _marker = global.L.marker([lat, lng], { draggable: true }).addTo(_map);
      _marker.on('dragend', function () {
        var pos = _marker.getLatLng();
        reverseGeocode(pos.lat, pos.lng);
      });
    }
    _map.setView([lat, lng], 16);
    if (doReverseGeocode) reverseGeocode(lat, lng);
  }

  function getOrCreateDropdownEl() {
    var dd = document.getElementById('lpSearchDropdown');
    if (dd) return dd;
    dd = document.createElement('div');
    dd.id = 'lpSearchDropdown';
    dd.style.cssText = 'display:none;position:fixed;background:#fff;border:1px solid #ddd;border-radius:10px;max-height:220px;overflow-y:auto;z-index:2147483647;box-shadow:0 8px 24px rgba(0,0,0,.18)';
    // Appended directly to <body> — a sibling of the whole modal — so no
    // ancestor's overflow/stacking-context quirks (or Leaflet's internal
    // pane z-indexes) can ever paint it underneath the map again.
    document.body.appendChild(dd);
    return dd;
  }

  function positionDropdown() {
    var dd = document.getElementById('lpSearchDropdown');
    var input = document.getElementById('lpSearchInput');
    if (!dd || !input) return;
    var r = input.getBoundingClientRect();
    dd.style.left = r.left + 'px';
    dd.style.top = (r.bottom + 4) + 'px';
    dd.style.width = r.width + 'px';
  }

  function hideDropdown() {
    var dd = document.getElementById('lpSearchDropdown');
    if (dd) { dd.style.display = 'none'; dd.innerHTML = ''; }
  }

  function renderDropdown(results) {
    var dd = getOrCreateDropdownEl();
    positionDropdown();
    if (!results.length) {
      dd.innerHTML = '<div style="padding:10px 12px;font-size:13px;color:#999">No matches — try a different search or tap the map directly.</div>';
      dd.style.display = '';
      return;
    }
    dd.innerHTML = results.map(function (r, i) {
      return '<div class="lp-suggestion" data-i="' + i + '" style="padding:10px 12px;font-size:13px;cursor:pointer;border-bottom:1px solid #f2f2f2"><i class="fa-solid fa-location-dot" style="color:#999;margin-right:6px"></i>' + esc(r.display_name) + '</div>';
    }).join('');
    dd.style.display = '';
    Array.prototype.forEach.call(dd.querySelectorAll('.lp-suggestion'), function (row) {
      row.addEventListener('mousedown', function (e) {
        // mousedown (not click) so it fires before the input's blur hides the dropdown
        e.preventDefault();
        var r = results[parseInt(row.getAttribute('data-i'), 10)];
        placeMarker(parseFloat(r.lat), parseFloat(r.lon), false);
        fillFieldsFromAddress(r.address || {}, r.display_name);
        document.getElementById('lpSearchInput').value = r.display_name;
        hideDropdown();
      });
      row.addEventListener('mouseenter', function () { row.style.background = '#f7f7f7'; });
      row.addEventListener('mouseleave', function () { row.style.background = '#fff'; });
    });
  }

  function runSearch(query) {
    var mySeq = ++_searchSeq;
    var status = document.getElementById('lpSearchStatus');
    if (status) status.textContent = 'Searching…';
    fetch('https://nominatim.openstreetmap.org/search?q=' + encodeURIComponent(query) +
      '&format=json&addressdetails=1&limit=6&countrycodes=in')
      .then(function (r) { return r.json(); })
      .then(function (results) {
        if (mySeq !== _searchSeq) return; // a newer keystroke already superseded this request
        if (status) status.textContent = '';
        renderDropdown(results || []);
      })
      .catch(function () {
        if (mySeq !== _searchSeq) return;
        if (status) status.textContent = 'Search failed — check your connection.';
      });
  }

  function bindSearchInput() {
    var input = document.getElementById('lpSearchInput');
    input.addEventListener('input', function () {
      var q = input.value.trim();
      clearTimeout(_searchDebounce);
      if (q.length < 3) { hideDropdown(); return; }
      _searchDebounce = setTimeout(function () { runSearch(q); }, 400);
    });
    input.addEventListener('blur', function () {
      // small delay so a suggestion's mousedown handler still fires first
      setTimeout(hideDropdown, 150);
    });
    input.addEventListener('focus', function () {
      if (input.value.trim().length >= 3) {
        var dd = document.getElementById('lpSearchDropdown');
        if (dd && dd.innerHTML) { positionDropdown(); dd.style.display = ''; }
      }
    });
    window.addEventListener('resize', positionDropdown);
    window.addEventListener('scroll', positionDropdown, true);
  }

  function initMapUi(startLat, startLng) {
    _map = global.L.map('lpMapHost').setView([startLat, startLng], startLat === DEFAULT_CENTER[0] ? 5 : 16);
    global.L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
      maxZoom: 19,
      attribution: '&copy; OpenStreetMap contributors',
    }).addTo(_map);

    _map.on('click', function (e) {
      placeMarker(e.latlng.lat, e.latlng.lng, true);
    });

    if (startLat !== DEFAULT_CENTER[0] || startLng !== DEFAULT_CENTER[1]) {
      placeMarker(startLat, startLng, false);
    }

    bindSearchInput();

    document.getElementById('lpUseMyLocation').onclick = function () {
      if (!navigator.geolocation) { alert('GPS not supported on this device'); return; }
      var btn = document.getElementById('lpUseMyLocation');
      var original = btn.innerHTML;
      btn.innerHTML = '<i class="fa-solid fa-spinner fa-spin"></i> Locating…';
      navigator.geolocation.getCurrentPosition(function (pos) {
        btn.innerHTML = original;
        placeMarker(pos.coords.latitude, pos.coords.longitude, true);
      }, function () {
        btn.innerHTML = original;
        alert('Could not fetch your live location. Please search or tap the map instead.');
      }, { enableHighAccuracy: true, timeout: 10000 });
    };
  }

  function close() {
    if (_modalEl) { _modalEl.remove(); _modalEl = null; }
    var dd = document.getElementById('lpSearchDropdown');
    if (dd) dd.remove();
    window.removeEventListener('resize', positionDropdown);
    window.removeEventListener('scroll', positionDropdown, true);
    _map = null; _marker = null; _onSave = null;
    clearTimeout(_searchDebounce);
  }

  function open(opts) {
    opts = opts || {};
    _onSave = typeof opts.onSave === 'function' ? opts.onSave : function () {};
    ensureLeafletLoaded(function () {
      _modalEl = buildModal();
      if (opts.address_id) {
        var titleEl = _modalEl.querySelector('strong');
        if (titleEl) titleEl.textContent = 'Edit address';
      }
      document.getElementById('lpCloseBtn').onclick = close;
      document.getElementById('lpCancelBtn').onclick = close;
      // Prefill (edit-existing-address mode)
      if (opts.label) document.getElementById('lpLabel').value = opts.label;
      if (opts.address) document.getElementById('lpAddress').value = opts.address;
      if (opts.city) document.getElementById('lpCity').value = opts.city;
      if (opts.state) document.getElementById('lpState').value = opts.state;
      if (opts.pincode) document.getElementById('lpPincode').value = opts.pincode;
      if (opts.address_id) _modalEl.dataset.editingId = opts.address_id;
      document.getElementById('lpSaveBtn').onclick = function () {
        var address = document.getElementById('lpAddress').value.trim();
        var city = document.getElementById('lpCity').value.trim();
        var state = document.getElementById('lpState').value.trim();
        if (!address || !city || !state || !_marker) {
          alert('Please pick a location (search above, tap the map, or use My Location) and confirm address, city & state.');
          return;
        }
        var pos = _marker.getLatLng();
        var addr = {
          label: document.getElementById('lpLabel').value.trim() || 'Address',
          address: address,
          city: city,
          state: state,
          pincode: document.getElementById('lpPincode').value.trim(),
          lat: pos.lat,
          lng: pos.lng,
        };
        if (opts.address_id) addr.address_id = opts.address_id;
        var cb = _onSave; // capture before close() clears _onSave
        close();
        cb(addr);
      };
      var startLat = opts.lat || DEFAULT_CENTER[0];
      var startLng = opts.lng || DEFAULT_CENTER[1];
      // Map needs to exist in the DOM before Leaflet initializes it.
      setTimeout(function () { initMapUi(startLat, startLng); }, 30);
    });
  }

  global.LocationPicker = { open: open, close: close, ensureLeaflet: ensureLeafletLoaded };
})(typeof window !== 'undefined' ? window : this);
