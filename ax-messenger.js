/* ═══════════════════════════════════════════════════════════════════════
   ax-messenger.js — Aarvex messenger bridge
   The messenger UI lives in messenger-app.html (new Aarvex green theme) and
   runs inside an isolated iframe. This file is the parent-side bridge: it
   opens that iframe as a bottom sheet and proxies requests to the real
   backend via mpApi().

   Public entry points (stable for the rest of the app):
     axOpenMessages()               — nav "Messages" button (toggle)
     axOpenChat(sub, name, photo)   — open straight into one conversation
     axCloseMessages()              — dismiss overlay
     axRefreshChatBadge()           — unread attention on the nav icon
     axAcknowledgeChatAttention()   — clear the attention pulse
   ═══════════════════════════════════════════════════════════════════════ */

var AX_MSG_URL = 'messenger-app.html';
var _axMsgOpen = false;
var _axMsgPending = null; // {sub,name,photo} once iframe is ready
var _axMsgReady = false;
var _axChatLastUnread = 0;
var _axChatAttentionAcknowledged = false;

function _axMsgInjectStyles() {
  if (document.getElementById('axMsgStyles')) return;
  var s = document.createElement('style');
  s.id = 'axMsgStyles';
  s.textContent =
    '.ax-msg-scrim{position:fixed;inset:0;z-index:99989;background:rgba(4,10,7,.62);opacity:0;transition:opacity .3s ease;-webkit-backdrop-filter:blur(6px);backdrop-filter:blur(6px);}' +
    '.ax-msg-scrim.show{opacity:1;}' +
    '.ax-msg-sheet{position:fixed;left:0;right:0;bottom:0;z-index:99990;height:84vh;height:84dvh;max-height:96dvh;' +
      'background:#0D1712;border-radius:24px 24px 0 0;box-shadow:0 -24px 64px -16px rgba(0,0,0,.75);' +
      'border-top:1px solid rgba(62,180,137,.18);' +
      'display:flex;flex-direction:column;overflow:hidden;transform:translateY(100%);' +
      'transition:transform .34s cubic-bezier(.22,1,.36,1);will-change:transform;}' +
    '.ax-msg-sheet.show{transform:translateY(0);}' +
    '@media(min-width:560px){.ax-msg-sheet{left:50%;right:auto;width:min(440px,92vw);transform:translate(-50%,100%);border-radius:24px;height:min(86dvh,820px);bottom:20px;top:auto;margin-top:0;box-shadow:0 28px 64px -16px rgba(0,0,0,.75);}' +
      '.ax-msg-sheet.show{transform:translate(-50%,0);}}' +
    '.ax-msg-handle{height:26px;flex-shrink:0;display:flex;align-items:center;justify-content:center;cursor:grab;touch-action:none;background:transparent;}' +
    '.ax-msg-handle .g{width:36px;height:4px;border-radius:999px;background:rgba(255,255,255,.18);transition:.15s;}' +
    '.ax-msg-handle:active{cursor:grabbing;} .ax-msg-handle:active .g{background:#5E7266;width:54px;}' +
    '.ax-msg-sheet iframe{flex:1;width:100%;border:0;display:block;background:#0D1712;min-height:0;}' +
    /* Parent-level call island — visible even if messenger sheet closed */
    '#axCallIsland{position:fixed;top:calc(10px + env(safe-area-inset-top,0px));left:50%;transform:translateX(-50%);z-index:100050;' +
      'display:none;align-items:center;gap:10px;width:min(420px,calc(100vw - 20px));padding:8px 10px 8px 8px;border-radius:999px;' +
      'background:linear-gradient(90deg,#1f8a5f,#146a49);color:#EAF9F1;border:1px solid rgba(62,180,137,.4);' +
      'box-shadow:0 16px 36px -12px rgba(0,0,0,.65);font-family:Inter,system-ui,sans-serif;}' +
    '#axCallIsland.show{display:flex;animation:axIslandIn .28s cubic-bezier(.22,1,.36,1);}' +
    '#axCallIsland.ringing{background:linear-gradient(90deg,#2a5c43,#1c3f30);}' +
    '@keyframes axIslandIn{from{transform:translate(-50%,-120%);opacity:0}to{transform:translateX(-50%);opacity:1}}' +
    '#axCallIsland .av{width:34px;height:34px;border-radius:50%;background:#0d1712;color:#8fe6c4;display:flex;align-items:center;justify-content:center;font-weight:700;font-size:12px;background-size:cover;background-position:center;flex-shrink:0;}' +
    '#axCallIsland .info{flex:1;min-width:0;} #axCallIsland .nm{font-size:13px;font-weight:600;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;}' +
    '#axCallIsland .sub{font-size:11px;opacity:.92;font-family:IBM Plex Mono,ui-monospace,monospace;margin-top:1px;}' +
    '#axCallIsland .btns{display:flex;gap:6px;flex-shrink:0;}' +
    '#axCallIsland .btn{width:34px;height:34px;border-radius:50%;border:0;display:inline-flex;align-items:center;justify-content:center;cursor:pointer;}' +
    '#axCallIsland .btn.accept{background:#2fbd80;color:#062017;} #axCallIsland .btn.end{background:#D2665A;color:#fff;}' +
    '#axCallIsland .btn.open{background:rgba(255,255,255,.15);color:#EAF9F1;}';
  document.head.appendChild(s);
}

function _axMsgSetY(sheet, dy) {
  var wide = window.matchMedia('(min-width:560px)').matches;
  sheet.style.transform = wide ? 'translate(-50%,' + dy + 'px)' : 'translateY(' + dy + 'px)';
}

function _axMsgAppLockOk() {
  var pin = '';
  try { pin = localStorage.getItem('axMsgPin') || ''; } catch (e) {}
  if (!pin) {
    try {
      var p = JSON.parse(localStorage.getItem('ax_msg_prefs') || '{}');
      pin = p.appLock || '';
    } catch (e2) {}
  }
  if (!pin) return true;
  var entered = prompt('Enter messenger PIN');
  if (entered !== pin) {
    if (typeof showToast === 'function') showToast('Wrong PIN', 'error');
    return false;
  }
  return true;
}

function _axMsgOpenOverlay(pending) {
  _axMsgPending = pending || null;
  if (_axMsgOpen) {
    if (_axMsgPending && _axMsgReady) {
      _axMsgPost({ type: 'axmsg:open', sub: _axMsgPending.sub, name: _axMsgPending.name, photo: _axMsgPending.photo });
    }
    return;
  }
  /* Re-show existing overlay kept alive for an active call */
  var existing = document.getElementById('axMsgOverlay');
  if (existing && _axMsgCallActive) {
    _axMsgOpen = true;
    var scrim = document.getElementById('axMsgScrim');
    var sheet = document.getElementById('axMsgSheet');
    if (scrim) scrim.classList.add('show');
    if (sheet) sheet.classList.add('show');
    document.body.style.overflow = 'hidden';
    document.querySelectorAll('.ax-msg-nav-btn').forEach(function (b) { b.classList.add('is-active'); });
    var island = document.getElementById('axCallIsland');
    if (island) { island.className = ''; island.innerHTML = ''; island.style.display = 'none'; }
    _axMsgPost({ type: 'axmsg:call-cmd', cmd: 'open' });
    if (_axMsgPending && _axMsgReady) {
      _axMsgPost({ type: 'axmsg:open', sub: _axMsgPending.sub, name: _axMsgPending.name, photo: _axMsgPending.photo });
      _axMsgPending = null;
    }
    return;
  }
  if (!_axMsgAppLockOk()) return;

  _axMsgOpen = true; _axMsgReady = false;
  _axMsgInjectStyles();
  var ov = document.getElementById('axMsgOverlay');
  if (ov) ov.remove();
  ov = document.createElement('div');
  ov.id = 'axMsgOverlay';
  ov.innerHTML =
    '<div class="ax-msg-scrim" id="axMsgScrim"></div>' +
    '<div class="ax-msg-sheet" id="axMsgSheet">' +
      '<div class="ax-msg-handle" id="axMsgHandle"><span class="g"></span></div>' +
      '<iframe id="axMsgFrame" title="Aarvex Messenger" allow="geolocation; camera; microphone; autoplay"></iframe>' +
    '</div>';
  document.body.appendChild(ov);
  document.body.style.overflow = 'hidden';

  var scrim = document.getElementById('axMsgScrim');
  var sheet = document.getElementById('axMsgSheet');
  var handle = document.getElementById('axMsgHandle');
  scrim.addEventListener('click', _axMsgCloseOverlay);
  _axMsgWireDrag(sheet, handle);

  requestAnimationFrame(function () { scrim.classList.add('show'); sheet.classList.add('show'); });

  window.addEventListener('message', _axMsgOnMessage);
  document.getElementById('axMsgFrame').src = AX_MSG_URL + '?v=4';
}

function _axMsgWireDrag(sheet, handle) {
  var dragging = false, startY = 0, dy = 0;
  handle.addEventListener('pointerdown', function (e) {
    dragging = true; startY = e.clientY; dy = 0;
    sheet.style.transition = 'none';
    try { handle.setPointerCapture(e.pointerId); } catch (_) {}
  });
  handle.addEventListener('pointermove', function (e) {
    if (!dragging) return;
    dy = Math.max(0, e.clientY - startY);
    _axMsgSetY(sheet, dy);
  });
  function end() {
    if (!dragging) return;
    dragging = false;
    sheet.style.transition = '';
    if (dy > 130) { _axMsgCloseOverlay(); }
    else { sheet.style.transform = ''; }
  }
  handle.addEventListener('pointerup', end);
  handle.addEventListener('pointercancel', end);
}

function _axMsgFrameWin() {
  var f = document.getElementById('axMsgFrame');
  return f && f.contentWindow;
}
function _axMsgPost(msg) {
  var w = _axMsgFrameWin();
  if (w) w.postMessage(msg, '*');
}

async function _axMsgOnMessage(e) {
  var frame = document.getElementById('axMsgFrame');
  if (!frame || e.source !== frame.contentWindow) return;
  var d = e.data || {};
  if (d.type === 'axmsg:ready') {
    _axMsgReady = true;
    if (_axMsgPending) {
      _axMsgPost({ type: 'axmsg:open', sub: _axMsgPending.sub, name: _axMsgPending.name, photo: _axMsgPending.photo });
      _axMsgPending = null;
    }
    if (_axMsgPendingCall) {
      _axMsgPost({ type: 'axmsg:incoming-call', call: _axMsgPendingCall });
      _axMsgPendingCall = null;
    }
  } else if (d.type === 'axmsg:rpc') {
    var result;
    try {
      if (typeof mpApi !== 'function') result = { error: 'offline' };
      else result = await mpApi(d.path, d.opts || undefined);
    } catch (err) {
      result = { error: (err && err.message) || 'request failed' };
    }
    _axMsgPost({ type: 'axmsg:rpc:res', id: d.id, result: result });
  } else if (d.type === 'axmsg:close') {
    _axMsgCloseOverlay();
  } else if (d.type === 'axmsg:call-state') {
    _axMsgRenderCallIsland(d);
  } else if (d.type === 'axmsg:call-cmd') {
    /* handled inside iframe */
  }
}

function _axMsgRenderCallIsland(d) {
  _axMsgInjectStyles();
  _axMsgCallActive = !!(d && d.active);
  var el = document.getElementById('axCallIsland');
  if (!el) {
    el = document.createElement('div');
    el.id = 'axCallIsland';
    document.body.appendChild(el);
  }
  if (!d || !d.active) {
    el.className = '';
    el.innerHTML = '';
    el.style.display = 'none';
    /* Tear down hidden messenger shell kept alive for the call */
    if (!_axMsgOpen) {
      var ov = document.getElementById('axMsgOverlay');
      if (ov && ov.parentNode) {
        window.removeEventListener('message', _axMsgOnMessage);
        ov.remove();
        _axMsgReady = false;
        _axMsgPending = null;
      }
    }
    return;
  }
  /* When messenger sheet is open, island lives inside iframe — hide parent duplicate unless sheet closed */
  if (_axMsgOpen) {
    el.className = '';
    el.innerHTML = '';
    el.style.display = 'none';
    return;
  }
  var peer = d.peer || {};
  var name = peer.name || 'Call';
  var photo = peer.photo || '';
  var initials = String(name).trim().split(/\s+/).map(function (w) { return w[0] || ''; }).join('').slice(0, 2).toUpperCase() || '?';
  var av = photo
    ? '<div class="av" style="background-image:url(\'' + String(photo).replace(/'/g, '') + '\');color:transparent"></div>'
    : '<div class="av">' + initials + '</div>';
  var connected = d.state === 'connected';
  var incoming = d.state === 'incoming';
  var sub = connected
    ? _axMsgFmtDur(d.dur || 0)
    : (incoming ? ('Incoming ' + (d.kind === 'video' ? 'video' : 'voice') + '…') : (d.state === 'outgoing' ? 'Calling…' : 'Connecting…'));
  var btns = incoming
    ? '<div class="btns"><button type="button" class="btn end" aria-label="Decline" onclick="_axMsgIslandCmd(\'reject\')"><i class="fa-solid fa-phone-slash"></i></button>' +
      '<button type="button" class="btn accept" aria-label="Accept" onclick="_axMsgIslandCmd(\'accept\')"><i class="fa-solid fa-' + (d.kind === 'video' ? 'video' : 'phone') + '"></i></button></div>'
    : '<div class="btns"><button type="button" class="btn open" aria-label="Open call" onclick="_axMsgIslandCmd(\'open\')"><i class="fa-solid fa-up-right-and-down-left-from-center"></i></button>' +
      '<button type="button" class="btn end" aria-label="End" onclick="_axMsgIslandCmd(\'end\')"><i class="fa-solid fa-phone-slash"></i></button></div>';
  el.className = 'show' + (connected ? '' : ' ringing');
  el.style.display = 'flex';
  el.innerHTML = av + '<div class="info"><div class="nm">' + _axMsgEsc(name) + '</div><div class="sub">' + _axMsgEsc(sub) + '</div></div>' + btns;
}
function _axMsgEsc(s) {
  return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
    return ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c];
  });
}
function _axMsgFmtDur(n) {
  n = Math.max(0, parseInt(n || 0, 10));
  var m = Math.floor(n / 60), s = n % 60;
  return m + ':' + String(s).padStart(2, '0');
}
function _axMsgIslandCmd(cmd) {
  if (!_axMsgOpen) _axMsgOpenOverlay(null);
  setTimeout(function () {
    _axMsgPost({ type: 'axmsg:call-cmd', cmd: cmd });
  }, _axMsgReady ? 50 : 600);
}
window._axMsgIslandCmd = _axMsgIslandCmd;

var _axMsgPendingCall = null;
var _axMsgCallActive = false;
/** Parent webrtc forwards an incoming call into the messenger iframe. */
function axMsgDeliverIncomingCall(call) {
  if (!call) return;
  if (_axMsgOpen && _axMsgReady) {
    _axMsgPost({ type: 'axmsg:incoming-call', call: call });
    return;
  }
  _axMsgPendingCall = call;
  _axMsgOpenOverlay(null);
}
window.axMsgDeliverIncomingCall = axMsgDeliverIncomingCall;
window.axMsgIsOpen = function () { return !!_axMsgOpen; };

function _axMsgCloseOverlay() {
  /* Keep WebRTC alive — hide sheet but retain iframe while a call is active */
  if (_axMsgCallActive) {
    var sheet = document.getElementById('axMsgSheet');
    var scrim = document.getElementById('axMsgScrim');
    if (sheet) sheet.classList.remove('show');
    if (scrim) scrim.classList.remove('show');
    document.body.style.overflow = '';
    _axMsgOpen = false;
    document.querySelectorAll('.ax-msg-nav-btn').forEach(function (b) { b.classList.remove('is-active'); });
    /* Re-render parent island now that sheet is "closed" */
    _axMsgPost({ type: 'axmsg:call-cmd', cmd: 'broadcast' });
    return;
  }
  window.removeEventListener('message', _axMsgOnMessage);
  var sheet = document.getElementById('axMsgSheet');
  var scrim = document.getElementById('axMsgScrim');
  if (sheet) { sheet.style.transition = ''; sheet.style.transform = ''; sheet.classList.remove('show'); }
  if (scrim) scrim.classList.remove('show');
  var ov = document.getElementById('axMsgOverlay');
  setTimeout(function () { if (ov && ov.parentNode) ov.remove(); }, 360);
  document.body.style.overflow = '';
  _axMsgOpen = false; _axMsgReady = false; _axMsgPending = null;
  document.querySelectorAll('.ax-msg-nav-btn').forEach(function (b) { b.classList.remove('is-active'); });
  axRefreshChatBadge();
}

/* ── Public entry points ────────────────────────────────────────────── */
function axOpenMessages() {
  if (_axMsgOpen) { _axMsgCloseOverlay(); return; }
  document.querySelectorAll('.ax-msg-nav-btn').forEach(function (b) { b.classList.add('is-active'); });
  _axMsgOpenOverlay(null);
}
function axOpenChat(sub, name, photo) {
  if (!sub) { _axMsgOpenOverlay(null); return; }
  _axMsgOpenOverlay({ sub: sub, name: name || 'Chat', photo: photo || '' });
}
function axCloseMessages() { _axMsgCloseOverlay(); }

function axAcknowledgeChatAttention() {
  _axChatAttentionAcknowledged = true;
  document.querySelectorAll('.ax-msg-nav-btn, .ax-banner-msg-btn').forEach(function (btn) {
    btn.classList.remove('has-unread-attention');
  });
}

async function axRefreshChatBadge() {
  try {
    if (typeof mpApi !== 'function') return;
    var data = await mpApi('/chat/list');
    var n = (data && data.total_unread) || 0;
    var badge = document.getElementById('axChatNavBadge');
    if (badge) { badge.textContent = ''; badge.style.display = 'none'; }
    if (n > _axChatLastUnread) _axChatAttentionAcknowledged = false;
    document.querySelectorAll('.ax-msg-nav-btn, .ax-banner-msg-btn').forEach(function (btn) {
      btn.classList.toggle('has-unread', n > 0);
      btn.classList.toggle('has-unread-attention', n > 0 && !_axChatAttentionAcknowledged);
    });
    ['axMsgNavCount', 'axBannerMsgCount'].forEach(function (id) {
      var pill = document.getElementById(id);
      if (pill) {
        pill.textContent = n > 99 ? '99+' : String(n);
        pill.style.display = n > 0 ? '' : 'none';
      }
    });
    _axChatLastUnread = n;
  } catch (e) { /* ignore */ }
}

document.addEventListener('DOMContentLoaded', function () {
  setTimeout(axRefreshChatBadge, 3000);
  setInterval(function () {
    if (document.body.classList.contains('is-signed-in')) axRefreshChatBadge();
  }, 45000);
});
