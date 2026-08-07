/* Aarvex Portal — Address Book
   ------------------------------------------------------------------------
   Replaces the old plain-text "Delivery Address" fields with a saved
   address book + a free/open-source location picker built on:
     - Leaflet (map rendering)
     - OpenStreetMap Nominatim (search + reverse geocoding — this is the
       same free geocoding service the "Leaflet Control Geocoder" plugin
       uses under the hood; we talk to it directly so the search box and
       result list can match the site's own design instead of the
       plugin's default control widget).

   IMPORTANT — nothing about the order/sell submission flow changes:
   this module only *fills* the existing hidden inputs
   (o_address / o_city / o_state / o_pincode / o_address_lat / o_address_lng)
   that submitOrder() already reads via gv(). Whoever calls the picker
   just gets those fields populated from a saved address instead of
   typing them by hand every time.

   Data is stored per-user in localStorage under `ax_addrbook_<sub>` as
   a small array of { id, label, address, city, state, pincode, lat, lng }.
   ------------------------------------------------------------------------ */
'use strict';

(function (global) {
  var NOMINATIM_SEARCH = 'https://nominatim.openstreetmap.org/search';
  var NOMINATIM_REVERSE = 'https://nominatim.openstreetmap.org/reverse';
  var DEFAULT_CENTER = [20.5937, 78.9629]; // India
  var DEFAULT_ZOOM = 5;

  var pickerMap = null;
  var pickerMarker = null;
  var activePrefix = null; // 'o' for order, could extend to 's' etc.
  var editingId = null;    // set when editing an existing saved address
  var searchDebounce = null;
  var lastPickedLatLng = null;

  function esc(s) {
    if (s == null) return '';
    return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  }

  function sv(id, val) { var el = document.getElementById(id); if (el) el.value = val; }
  function gv(id) { var el = document.getElementById(id); return el ? el.value : ''; }

  function toast(msg, type) {
    if (typeof global.showToast === 'function') global.showToast(msg, type || 'info');
  }

  function userSub() {
    try {
      if (global.currentUser && global.currentUser.sub) return global.currentUser.sub;
      var u = JSON.parse(localStorage.getItem('ax_user') || 'null');
      return u ? u.sub : null;
    } catch (e) { return null; }
  }

  function storeKey() {
    var sub = userSub();
    return sub ? 'ax_addrbook_' + sub : null;
  }

  function getAddresses() {
    var key = storeKey();
    if (!key) return [];
    try { return JSON.parse(localStorage.getItem(key) || '[]'); } catch (e) { return []; }
  }

  function saveAddresses(list) {
    var key = storeKey();
    if (!key) return;
    localStorage.setItem(key, JSON.stringify(list));
  }

  function selectedIdKey(prefix) { return '_addrSelected_' + prefix; }

  /* ── Seed one address automatically from the saved profile the first
     time the address book is empty, so people aren't staring at a blank
     list on their very first order. Safe to call repeatedly — it only
     ever seeds once. ── */
  function ensureSeedFromProfile(prefix, profile) {
    if (!profile || !profile.address || !profile.city || !profile.state) return;
    var list = getAddresses();
    if (list.length) return;
    var addr = {
      id: 'addr_' + Date.now(),
      label: 'My Address',
      address: profile.address,
      city: profile.city,
      state: profile.state,
      pincode: profile.pincode || '',
      lat: profile.address_lat || '',
      lng: profile.address_lng || ''
    };
    list.push(addr);
    saveAddresses(list);
    renderList(prefix);
    selectAddress(prefix, addr.id);
  }

  function addressCardHtml(addr, prefix, isSelected) {
    var line2 = [addr.city, addr.state, addr.pincode].filter(Boolean).join(', ');
    return (
      '<div class="addr-card' + (isSelected ? ' selected' : '') + '" role="button" tabindex="0" ' +
        'onclick="AddressBook.selectAddress(\'' + prefix + '\',\'' + addr.id + '\')">' +
        '<div class="addr-card-radio"><i class="fa-solid ' + (isSelected ? 'fa-circle-check' : 'fa-circle') + '"></i></div>' +
        '<div class="addr-card-body">' +
          '<div class="addr-card-label"><i class="fa-solid fa-location-dot"></i> ' + esc(addr.label || 'Address') + '</div>' +
          '<div class="addr-card-line">' + esc(addr.address) + '</div>' +
          '<div class="addr-card-line addr-card-sub">' + esc(line2) + '</div>' +
        '</div>' +
        '<button type="button" class="addr-card-del" title="Delete address" ' +
          'onclick="event.stopPropagation();AddressBook.deleteAddress(\'' + prefix + '\',\'' + addr.id + '\')">' +
          '<i class="fa-solid fa-trash"></i></button>' +
      '</div>'
    );
  }

  function renderList(prefix) {
    var wrap = document.getElementById('addrBookList_' + prefix);
    if (!wrap) return;
    var list = getAddresses();
    var selectedId = global[selectedIdKey(prefix)] || (list[0] && list[0].id) || null;
    wrap.innerHTML =
      (list.length
        ? list.map(function (a) { return addressCardHtml(a, prefix, a.id === selectedId); }).join('')
        : '<p class="addr-empty-hint"><i class="fa-solid fa-map-location-dot"></i> No saved address yet — add one below.</p>') +
      '<button type="button" class="addr-add-btn" onclick="AddressBook.openPicker(\'' + prefix + '\')">' +
        '<i class="fa-solid fa-plus"></i> Add New Address</button>';
    // Make sure the hidden fields reflect the selected/default address.
    if (selectedId) selectAddress(prefix, selectedId, /*silent*/ true);
  }

  function selectAddress(prefix, id, silent) {
    var list = getAddresses();
    var addr = list.find(function (a) { return a.id === id; });
    if (!addr) return;
    global[selectedIdKey(prefix)] = id;
    sv(prefix + '_address', addr.address || '');
    sv(prefix + '_city', addr.city || '');
    sv(prefix + '_state', addr.state || '');
    sv(prefix + '_pincode', addr.pincode || '');
    sv(prefix + '_address_lat', addr.lat || '');
    sv(prefix + '_address_lng', addr.lng || '');
    if (!silent) renderList(prefix);
  }

  function deleteAddress(prefix, id) {
    if (!confirm('Delete this saved address?')) return;
    var list = getAddresses().filter(function (a) { return a.id !== id; });
    saveAddresses(list);
    if (global[selectedIdKey(prefix)] === id) global[selectedIdKey(prefix)] = null;
    renderList(prefix);
    toast('Address removed', 'success');
  }

  /* ── Leaflet loader (unpkg CDN, same free stack used elsewhere in the
     portal for live-tracking maps) ── */
  function ensureLeaflet(cb) {
    if (global.L) { cb(); return; }
    if (!document.getElementById('leafletCss')) {
      var lcss = document.createElement('link');
      lcss.id = 'leafletCss';
      lcss.rel = 'stylesheet';
      lcss.href = 'https://unpkg.com/leaflet@1.9.4/dist/leaflet.css';
      document.head.appendChild(lcss);
    }
    if (document.getElementById('leafletJs')) {
      var t = setInterval(function () { if (global.L) { clearInterval(t); cb(); } }, 100);
      return;
    }
    var js = document.createElement('script');
    js.id = 'leafletJs';
    js.src = 'https://unpkg.com/leaflet@1.9.4/dist/leaflet.js';
    js.onload = cb;
    document.head.appendChild(js);
  }

  function openPicker(prefix) {
    activePrefix = prefix;
    editingId = null;
    lastPickedLatLng = null;
    var modal = document.getElementById('addressPickerModal');
    if (!modal) return;
    sv('addrPickerLabel', '');
    sv('addrPickerAddress', '');
    sv('addrPickerCity', '');
    sv('addrPickerState', '');
    sv('addrPickerPincode', '');
    sv('addrPickerSearch', '');
    var sugg = document.getElementById('addrPickerSuggestions');
    if (sugg) { sugg.innerHTML = ''; sugg.style.display = 'none'; }
    modal.classList.add('open');
    ensureLeaflet(function () {
      setTimeout(initPickerMap, 30); // let the modal box get its final layout size first
    });
  }

  function closePicker() {
    var modal = document.getElementById('addressPickerModal');
    if (modal) modal.classList.remove('open');
  }

  function initPickerMap() {
    var el = document.getElementById('addrPickerMap');
    if (!el || !global.L) return;
    if (!pickerMap) {
      pickerMap = global.L.map(el).setView(DEFAULT_CENTER, DEFAULT_ZOOM);
      global.L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
        maxZoom: 19,
        attribution: '&copy; OpenStreetMap contributors'
      }).addTo(pickerMap);
      pickerMap.on('click', function (e) {
        placeMarker(e.latlng.lat, e.latlng.lng);
        reverseGeocode(e.latlng.lat, e.latlng.lng);
      });
    } else {
      pickerMap.invalidateSize();
    }
  }

  function placeMarker(lat, lng) {
    lastPickedLatLng = { lat: lat, lng: lng };
    if (!pickerMarker) {
      pickerMarker = global.L.marker([lat, lng], { draggable: true }).addTo(pickerMap);
      pickerMarker.on('dragend', function () {
        var pos = pickerMarker.getLatLng();
        lastPickedLatLng = { lat: pos.lat, lng: pos.lng };
        reverseGeocode(pos.lat, pos.lng);
      });
    } else {
      pickerMarker.setLatLng([lat, lng]);
    }
    pickerMap.setView([lat, lng], Math.max(pickerMap.getZoom(), 15));
  }

  function fillFieldsFromNominatim(addr, displayName, lat, lng) {
    addr = addr || {};
    sv('addrPickerAddress', displayName || '');
    sv('addrPickerCity', addr.city || addr.town || addr.village || addr.suburb || addr.county || '');
    sv('addrPickerState', addr.state || '');
    sv('addrPickerPincode', addr.postcode || '');
    if (lat != null) global.document.getElementById('addrPickerMap').dataset.lat = lat;
    if (lng != null) global.document.getElementById('addrPickerMap').dataset.lng = lng;
  }

  function reverseGeocode(lat, lng) {
    var url = NOMINATIM_REVERSE + '?format=json&addressdetails=1&lat=' + encodeURIComponent(lat) + '&lon=' + encodeURIComponent(lng);
    fetch(url, { headers: { Accept: 'application/json' } })
      .then(function (r) { return r.json(); })
      .then(function (data) {
        fillFieldsFromNominatim(data.address, data.display_name, lat, lng);
      })
      .catch(function () { /* geocoding is best-effort; manual fields still editable */ });
  }

  function useMyLocation() {
    if (!navigator.geolocation) { toast('GPS not supported on this device', 'warning'); return; }
    toast('Fetching your current location…', 'info');
    navigator.geolocation.getCurrentPosition(function (pos) {
      var lat = pos.coords.latitude, lng = pos.coords.longitude;
      ensureLeaflet(function () {
        setTimeout(function () {
          initPickerMap();
          placeMarker(lat, lng);
          reverseGeocode(lat, lng);
        }, 30);
      });
    }, function () {
      toast('Could not get your location — please allow location access, or search/tap the map instead.', 'warning');
    }, { enableHighAccuracy: true, timeout: 10000 });
  }

  function renderSuggestions(results) {
    var box = document.getElementById('addrPickerSuggestions');
    if (!box) return;
    if (!results.length) { box.innerHTML = ''; box.style.display = 'none'; return; }
    box.innerHTML = results.map(function (r, i) {
      return '<div class="addr-suggest-item" data-i="' + i + '"><i class="fa-solid fa-location-dot"></i> ' + esc(r.display_name) + '</div>';
    }).join('');
    box.style.display = '';
    box.querySelectorAll('.addr-suggest-item').forEach(function (item) {
      item.addEventListener('mousedown', function (e) {
        e.preventDefault();
        var r = results[parseInt(item.getAttribute('data-i'), 10)];
        if (!r) return;
        var lat = parseFloat(r.lat), lng = parseFloat(r.lon);
        ensureLeaflet(function () {
          setTimeout(function () {
            initPickerMap();
            placeMarker(lat, lng);
            fillFieldsFromNominatim(r.address, r.display_name, lat, lng);
          }, 30);
        });
        box.style.display = 'none';
      });
    });
  }

  function searchAddress(query) {
    query = (query || '').trim();
    if (query.length < 3) { renderSuggestions([]); return; }
    var url = NOMINATIM_SEARCH + '?format=json&addressdetails=1&limit=6&countrycodes=in&q=' + encodeURIComponent(query);
    fetch(url, { headers: { Accept: 'application/json' } })
      .then(function (r) { return r.json(); })
      .then(function (data) { renderSuggestions(data || []); })
      .catch(function () { renderSuggestions([]); });
  }

  function onSearchInput(val) {
    clearTimeout(searchDebounce);
    searchDebounce = setTimeout(function () { searchAddress(val); }, 450);
  }

  function savePickedAddress() {
    var address = gv('addrPickerAddress').trim();
    var city = gv('addrPickerCity').trim();
    var state = gv('addrPickerState').trim();
    var pincode = gv('addrPickerPincode').trim();
    var label = gv('addrPickerLabel').trim();
    if (!address || !city || !state) {
      toast('Please search or tap the map to pick an address (Address, City, State are required)', 'error');
      return;
    }
    var mapEl = document.getElementById('addrPickerMap');
    var lat = (lastPickedLatLng && lastPickedLatLng.lat) || mapEl.dataset.lat || '';
    var lng = (lastPickedLatLng && lastPickedLatLng.lng) || mapEl.dataset.lng || '';
    var list = getAddresses();
    var addr = {
      id: 'addr_' + Date.now(),
      label: label || ('Address ' + (list.length + 1)),
      address: address, city: city, state: state, pincode: pincode,
      lat: lat, lng: lng
    };
    list.unshift(addr);
    saveAddresses(list);
    renderList(activePrefix);
    selectAddress(activePrefix, addr.id);
    closePicker();
    toast('Address saved', 'success');
  }

  global.AddressBook = {
    renderList: renderList,
    selectAddress: selectAddress,
    deleteAddress: deleteAddress,
    openPicker: openPicker,
    closePicker: closePicker,
    useMyLocation: useMyLocation,
    savePickedAddress: savePickedAddress,
    onSearchInput: onSearchInput,
    ensureSeedFromProfile: ensureSeedFromProfile,
    getAddresses: getAddresses
  };
})(typeof window !== 'undefined' ? window : this);
