/* Aarvex Portal — Address Book (used by the Order form's external
 * "Delivery Location" box). Backed by /address/list, /address/save,
 * /address/delete. Location capture itself is delegated to LocationPicker
 * (Leaflet + Control Geocoder). */
'use strict';

var AX_ADDRESSES = [];
var AX_SELECTED_ADDRESS_ID = null;

function esc_addr(s) {
  if (s == null) return '';
  return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

async function loadAddressBook() {
  const box = document.getElementById('addressBookList');
  if (!box) return;
  box.innerHTML = '<p style="color:var(--c-text3);font-size:13px;padding:8px 0">Loading your saved addresses…</p>';
  // Ensure auth before address APIs — but only when NEITHER the session token
  // nor the Google token is valid (the session token alone is enough; don't pop
  // an interactive Google sign-in every hour).
  if (typeof window.ensureFreshGoogleToken === 'function'
      && typeof axAuthExpired === 'function' && axAuthExpired()) {
    await window.ensureFreshGoogleToken({ interactive: true });
  }
  const data = await mpApi('/address/list');
  if (!data || data.error) {
    AX_ADDRESSES = [];
    var isAuth = data && (data.status === 401 || /unauthorized|google token/i.test(String(data.error || '')));
    box.innerHTML = '<div style="padding:10px;border:1px solid rgba(217,54,68,.3);background:rgba(217,54,68,.06);border-radius:4px;font-size:12.5px;color:var(--c-red,#D93644)">' +
      '<i class="fa-solid fa-triangle-exclamation"></i> Could not load saved addresses' +
      ((data && data.error) ? (': ' + esc_addr(data.error)) : '') +
      (isAuth
        ? '. <a href="javascript:void(0)" onclick="axFixAuthThenAddresses()" style="cursor:pointer;text-decoration:underline;color:inherit;font-weight:700">Sign in again</a>'
        : '. <a onclick="loadAddressBook()" style="cursor:pointer;text-decoration:underline;color:inherit">Retry</a>') +
      '</div>';
    return;
  }
  AX_ADDRESSES = data.addresses || [];
  renderAddressBook();
}

async function axFixAuthThenAddresses() {
  if (typeof window.axInteractiveGoogleReauth === 'function') {
    await window.axInteractiveGoogleReauth();
  }
  await loadAddressBook();
}
window.axFixAuthThenAddresses = axFixAuthThenAddresses;

function renderAddressBook() {
  const box = document.getElementById('addressBookList');
  if (!box) return;
  if (!AX_ADDRESSES.length) {
    box.innerHTML = '<p style="color:var(--c-text3);font-size:13px;padding:8px 0">No saved addresses yet — add one below.</p>';
  } else {
    box.innerHTML = AX_ADDRESSES.map(function (a) {
      const checked = AX_SELECTED_ADDRESS_ID === a.address_id ? 'checked' : '';
      return '<label class="addr-book-item" style="display:flex;gap:10px;align-items:flex-start;padding:10px;border:1px solid var(--c-border,#E4DBCA);border-radius:12px;margin-bottom:8px;cursor:pointer">' +
        '<input type="radio" name="axAddressPick" value="' + esc_addr(a.address_id) + '" ' + checked + ' onchange="selectAddress(\'' + esc_addr(a.address_id) + '\')" style="margin-top:3px">' +
        '<div style="flex:1;min-width:0">' +
          '<strong style="font-size:13px">' + esc_addr(a.label || 'Address') + '</strong><br>' +
          '<span style="font-size:12.5px;color:var(--c-text3)">' + esc_addr(a.address) + ', ' + esc_addr(a.city) + ', ' + esc_addr(a.state) + (a.pincode ? ' - ' + esc_addr(a.pincode) : '') + '</span>' +
        '</div>' +
        '<button type="button" onclick="editAddress(\'' + esc_addr(a.address_id) + '\', event)" title="Edit" style="border:none;background:none;color:var(--c-text3);cursor:pointer;font-size:14px;padding:4px"><i class="fa-solid fa-pen"></i></button>' +
        '<button type="button" onclick="deleteAddress(\'' + esc_addr(a.address_id) + '\', event)" title="Delete" style="border:none;background:none;color:var(--c-red,#D93644);cursor:pointer;font-size:14px;padding:4px"><i class="fa-solid fa-trash"></i></button>' +
      '</label>';
    }).join('');
  }
  // Auto-select the default / first address if nothing picked yet.
  if (!AX_SELECTED_ADDRESS_ID && AX_ADDRESSES.length) {
    const def = AX_ADDRESSES.find(function (a) { return a.is_default; }) || AX_ADDRESSES[0];
    selectAddress(def.address_id); // also refreshes the Delivery Location status card
  } else if (typeof updateOrderSectionStatus === 'function') {
    // Covers the two cases selectAddress() above doesn't: the book is
    // empty (nothing to auto-select — e.g. after deleting the last saved
    // address), or a selection already existed and just needs re-checking.
    updateOrderSectionStatus('delivery');
  }
}

function selectAddress(addressId) {
  AX_SELECTED_ADDRESS_ID = addressId;
  document.querySelectorAll('input[name="axAddressPick"]').forEach(function (r) {
    r.checked = r.value === addressId;
  });
  const err = document.getElementById('addressBookError');
  if (err) err.style.display = 'none';
  if (typeof updateOrderSectionStatus === 'function') updateOrderSectionStatus('delivery');
  // The chosen delivery area drives local ad targeting — refresh the banners so
  // the viewer sees ads for their district (falls back to state/national).
  if (typeof window.axReloadAdsForArea === 'function') { try { window.axReloadAdsForArea(); } catch (e) { /* ignore */ } }
}

function getSelectedAddress() {
  return AX_ADDRESSES.find(function (a) { return a.address_id === AX_SELECTED_ADDRESS_ID; }) || null;
}

function openAddNewAddress() {
  if (typeof LocationPicker === 'undefined') {
    showToast('Location picker failed to load — check your connection', 'error');
    return;
  }
  LocationPicker.open({
    onSave: saveAddressFromPicker,
  });
}

function editAddress(addressId, ev) {
  if (ev) ev.stopPropagation();
  if (typeof LocationPicker === 'undefined') {
    showToast('Location picker failed to load — check your connection', 'error');
    return;
  }
  const a = AX_ADDRESSES.find(function (x) { return x.address_id === addressId; });
  if (!a) return;
  LocationPicker.open({
    address_id: a.address_id,
    label: a.label,
    address: a.address,
    city: a.city,
    state: a.state,
    district: a.district,
    pincode: a.pincode,
    lat: a.lat,
    lng: a.lng,
    onSave: saveAddressFromPicker,
  });
}

async function saveAddressFromPicker(addr) {
  const data = await mpApi('/address/save', { method: 'POST', body: JSON.stringify(addr) });
  if (data && data.success) {
    showToast(addr.address_id ? 'Address updated' : 'Address saved', 'success');
    await loadAddressBook();
    selectAddress(data.address_id);
  } else {
    showToast((data && data.error) || 'Could not save address', 'error');
  }
}

async function deleteAddress(addressId, ev) {
  if (ev) ev.stopPropagation();
  if (!confirm('Delete this saved address?')) return;
  const data = await mpApi('/address/delete', { method: 'POST', body: JSON.stringify({ address_id: addressId }) });
  if (data && data.success) {
    if (AX_SELECTED_ADDRESS_ID === addressId) AX_SELECTED_ADDRESS_ID = null;
    showToast('Address deleted', 'info');
    await loadAddressBook();
  } else {
    showToast((data && data.error) || 'Could not delete address', 'error');
  }
}
