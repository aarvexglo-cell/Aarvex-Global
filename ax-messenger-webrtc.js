/* Aarvex Messenger — WebRTC voice/video (signaling via /call/* API) */

let _axRtcPc = null;
let _axRtcStream = null;
let _axRtcCallId = '';
let _axRtcPollTimer = null;
let _axRtcSince = 0;
let _axRtcKind = 'voice';
let _axRtcPeerSub = '';
let _axRtcMuted = false;
let _axRtcVideoOff = false;
let _axRtcIncomingTimer = null;
let _axRtcPendingCall = null;

const AX_RTC_STUN = [
  { urls: 'stun:stun.l.google.com:19302' },
  { urls: 'stun:stun1.l.google.com:19302' },
];

/* Reliable calling across strict / mobile NATs needs a TURN server (external,
   usually paid infra — cannot be provided from client code). To enable it,
   set ONE of:
     window.AX_TURN = { urls:'turn:HOST:3478', username:'U', credential:'C' }
     localStorage.setItem('ax_turn', JSON.stringify({ urls, username, credential }))
   (an array of such objects also works). Without it, calls use STUN only and
   may not connect on some networks. */
function axRtcIceServers() {
  const list = AX_RTC_STUN.slice();
  try {
    const t = window.AX_TURN || JSON.parse(localStorage.getItem('ax_turn') || 'null');
    if (t) { Array.isArray(t) ? list.push.apply(list, t) : list.push(t); }
  } catch (e) { /* ignore bad TURN config */ }
  return list;
}

async function axRtcApi(path, opts) {
  return (typeof axMsgApi === 'function') ? axMsgApi(path, opts) : mpApi(path, opts);
}

function axRtcShowUI(title, subtitle) {
  let ov = document.getElementById('axRtcOverlay');
  if (!ov) {
    ov = document.createElement('div');
    ov.id = 'axRtcOverlay';
    ov.className = 'ax-rtc-overlay';
    ov.innerHTML =
      '<div class="ax-rtc-sheet">' +
        '<div class="ax-rtc-videos">' +
          '<video id="axRtcRemote" autoplay playsinline></video>' +
          '<video id="axRtcLocal" autoplay playsinline muted></video>' +
        '</div>' +
        '<div class="ax-rtc-info"><b id="axRtcTitle"></b><span id="axRtcSub"></span></div>' +
        '<div class="ax-rtc-controls">' +
          '<button type="button" id="axRtcMute" onclick="axRtcToggleMute()"><i class="fa-solid fa-microphone"></i></button>' +
          '<button type="button" id="axRtcCam" onclick="axRtcToggleCam()"><i class="fa-solid fa-video"></i></button>' +
          '<button type="button" class="ax-rtc-end" onclick="axRtcEndCall()"><i class="fa-solid fa-phone-slash"></i></button>' +
          '<button type="button" onclick="axRtcToggleSpeaker()"><i class="fa-solid fa-volume-high"></i></button>' +
        '</div></div>';
    document.body.appendChild(ov);
  }
  document.getElementById('axRtcTitle').textContent = title || 'Call';
  document.getElementById('axRtcSub').textContent = subtitle || 'Connecting…';
  ov.style.display = '';
}

function axRtcHideUI() {
  const ov = document.getElementById('axRtcOverlay');
  if (ov) ov.style.display = 'none';
}

async function axRtcGetMedia(video) {
  return navigator.mediaDevices.getUserMedia({
    audio: true,
    video: video ? { facingMode: 'user', width: { ideal: 640 }, height: { ideal: 480 } } : false,
  });
}

function axRtcCreatePc() {
  if (_axRtcPc) return _axRtcPc;
  _axRtcPc = new RTCPeerConnection({ iceServers: axRtcIceServers() });
  _axRtcPc.ontrack = function (ev) {
    const v = document.getElementById('axRtcRemote');
    if (v && ev.streams[0]) v.srcObject = ev.streams[0];
  };
  _axRtcPc.onicecandidate = function (ev) {
    if (ev.candidate && _axRtcCallId) {
      axRtcApi('/call/signal', {
        method: 'POST',
        body: JSON.stringify({ call_id: _axRtcCallId, kind: 'ice', payload: ev.candidate.toJSON() }),
      });
    }
  };
  _axRtcPc.onconnectionstatechange = function () {
    if (_axRtcPc && (_axRtcPc.connectionState === 'failed' || _axRtcPc.connectionState === 'disconnected')) {
      showToast('Connection lost', 'error');
      axRtcEndCall();
    }
    if (_axRtcPc && _axRtcPc.connectionState === 'connected') {
      const sub = document.getElementById('axRtcSub');
      if (sub) sub.textContent = 'Connected';
    }
  };
  return _axRtcPc;
}

async function axRtcStartCall(kind, peerSub, peerName) {
  if (!navigator.mediaDevices) {
    showToast('Calls not supported on this browser', 'error');
    return;
  }
  _axRtcKind = kind || 'voice';
  _axRtcPeerSub = peerSub;
  axRtcShowUI(peerName || 'Call', 'Calling…');
  try {
    _axRtcStream = await axRtcGetMedia(_axRtcKind === 'video');
    const lv = document.getElementById('axRtcLocal');
    if (lv) lv.srcObject = _axRtcStream;
    const data = await axRtcApi('/call/start', {
      method: 'POST',
      body: JSON.stringify({ to_sub: peerSub, kind: _axRtcKind }),
    });
    if (!data || !data.call_id) {
      showToast((data && data.error) || 'Could not start call', 'error');
      axRtcEndCall();
      return;
    }
    _axRtcCallId = data.call_id;
    _axRtcSince = 0;
    const pc = axRtcCreatePc();
    _axRtcStream.getTracks().forEach(function (t) { pc.addTrack(t, _axRtcStream); });
    const offer = await pc.createOffer();
    await pc.setLocalDescription(offer);
    await axRtcApi('/call/signal', {
      method: 'POST',
      body: JSON.stringify({ call_id: _axRtcCallId, kind: 'offer', payload: offer }),
    });
    axRtcPollSignals();
    if (typeof axMsgPushCall === 'function') {
      axMsgPushCall({ type: _axRtcKind, sub: peerSub, name: peerName, ts: Date.now(), dir: 'out' });
    }
  } catch (e) {
    showToast('Microphone/camera permission required', 'error');
    axRtcEndCall();
  }
}

async function axRtcAcceptCall(call) {
  _axRtcCallId = call.call_id;
  _axRtcKind = call.kind || 'voice';
  _axRtcPeerSub = call.caller_sub;
  _axRtcSince = 0;
  axRtcShowUI(call.caller_name || 'Call', 'Connecting…');
  try {
    _axRtcStream = await axRtcGetMedia(_axRtcKind === 'video');
    const lv = document.getElementById('axRtcLocal');
    if (lv) lv.srcObject = _axRtcStream;
    const pc = axRtcCreatePc();
    _axRtcStream.getTracks().forEach(function (t) { pc.addTrack(t, _axRtcStream); });
    axRtcPollSignals();
    if (typeof axMsgPushCall === 'function') {
      axMsgPushCall({ type: _axRtcKind, sub: call.caller_sub, name: call.caller_name, ts: Date.now(), dir: 'in' });
    }
  } catch (e) {
    showToast('Could not accept call', 'error');
    axRtcEndCall();
  }
}

function axRtcPollSignals() {
  if (_axRtcPollTimer) clearInterval(_axRtcPollTimer);
  _axRtcPollTimer = setInterval(axRtcFetchSignals, 1200);
  axRtcFetchSignals();
}

async function axRtcFetchSignals() {
  if (!_axRtcCallId) return;
  const data = await axRtcApi('/call/signals?call_id=' + encodeURIComponent(_axRtcCallId) + '&since=' + _axRtcSince);
  if (!data || !data.signals) return;
  const pc = _axRtcPc;
  if (!pc) return;
  for (let i = 0; i < data.signals.length; i++) {
    const s = data.signals[i];
    _axRtcSince = Math.max(_axRtcSince, s.ts || 0);
    try {
      if (s.kind === 'offer') {
        await pc.setRemoteDescription(s.payload);
        const ans = await pc.createAnswer();
        await pc.setLocalDescription(ans);
        await axRtcApi('/call/signal', {
          method: 'POST',
          body: JSON.stringify({ call_id: _axRtcCallId, kind: 'answer', payload: ans }),
        });
      } else if (s.kind === 'answer') {
        await pc.setRemoteDescription(s.payload);
      } else if (s.kind === 'ice' && s.payload) {
        await pc.addIceCandidate(s.payload);
      } else if (s.kind === 'end') {
        axRtcEndCall();
        return;
      }
    } catch (e) { /* ignore bad signal */ }
  }
  if (data.status === 'ended') axRtcEndCall();
}

async function axRtcEndCall() {
  if (_axRtcCallId) {
    await axRtcApi('/call/signal', {
      method: 'POST',
      body: JSON.stringify({ call_id: _axRtcCallId, kind: 'end', payload: {} }),
    });
    await axRtcApi('/call/end', { method: 'POST', body: JSON.stringify({ call_id: _axRtcCallId }) });
  }
  if (_axRtcPollTimer) { clearInterval(_axRtcPollTimer); _axRtcPollTimer = null; }
  if (_axRtcStream) {
    _axRtcStream.getTracks().forEach(function (t) { t.stop(); });
    _axRtcStream = null;
  }
  if (_axRtcPc) { _axRtcPc.close(); _axRtcPc = null; }
  _axRtcCallId = '';
  _axRtcSince = 0;
  axRtcHideUI();
}

function axRtcToggleMute() {
  _axRtcMuted = !_axRtcMuted;
  if (_axRtcStream) {
    _axRtcStream.getAudioTracks().forEach(function (t) { t.enabled = !_axRtcMuted; });
  }
  const b = document.getElementById('axRtcMute');
  if (b) b.classList.toggle('off', _axRtcMuted);
}

function axRtcToggleCam() {
  _axRtcVideoOff = !_axRtcVideoOff;
  if (_axRtcStream) {
    _axRtcStream.getVideoTracks().forEach(function (t) { t.enabled = !_axRtcVideoOff; });
  }
  const b = document.getElementById('axRtcCam');
  if (b) b.classList.toggle('off', _axRtcVideoOff);
}

function axRtcToggleSpeaker() {
  const v = document.getElementById('axRtcRemote');
  if (v) v.muted = !v.muted;
}

/* ── Ringtone (offline, no asset needed): a repeating two-tone beep via
   WebAudio + phone vibration. Some mobile browsers gate audio on a prior user
   gesture, so this is best-effort; vibration usually still fires. ── */
let _axRtcRing = null;
function axRtcStartRing() {
  axRtcStopRing();
  try {
    const Ctx = window.AudioContext || window.webkitAudioContext;
    if (Ctx) {
      const ctx = new Ctx();
      const beep = function () {
        try {
          const o = ctx.createOscillator(); const g = ctx.createGain();
          o.type = 'sine'; o.frequency.value = 480;
          g.gain.setValueAtTime(0.0001, ctx.currentTime);
          g.gain.exponentialRampToValueAtTime(0.22, ctx.currentTime + 0.05);
          g.gain.exponentialRampToValueAtTime(0.0001, ctx.currentTime + 0.85);
          o.connect(g); g.connect(ctx.destination);
          o.start(); o.stop(ctx.currentTime + 0.9);
        } catch (e) {}
      };
      beep();
      _axRtcRing = { ctx: ctx, t: setInterval(beep, 2000), vib: null };
    } else {
      _axRtcRing = { ctx: null, t: null, vib: null };
    }
  } catch (e) { _axRtcRing = { ctx: null, t: null, vib: null }; }
  if (navigator.vibrate) {
    navigator.vibrate([500, 250, 500]);
    if (_axRtcRing) _axRtcRing.vib = setInterval(function () { navigator.vibrate([500, 250, 500]); }, 2000);
  }
}
function axRtcStopRing() {
  if (_axRtcRing) {
    try { clearInterval(_axRtcRing.t); } catch (e) {}
    try { clearInterval(_axRtcRing.vib); } catch (e) {}
    try { if (_axRtcRing.ctx) _axRtcRing.ctx.close(); } catch (e) {}
    _axRtcRing = null;
  }
  try { if (navigator.vibrate) navigator.vibrate(0); } catch (e) {}
}

async function axRtcPollIncoming() {
  if (!document.body.classList.contains('is-signed-in')) return;
  if (window._axAuthPollPaused) return;
  // Messenger iframe owns the call UI when it is open — avoid double ring sheets.
  if (typeof axMsgIsOpen === 'function' && axMsgIsOpen()) return;
  try {
    const data = await axRtcApi('/call/incoming');
    if (data && (data.status === 401 || /unauthorized|google token/i.test(String(data.error || '')))) {
      window._axAuthPollPaused = true;
      return;
    }
    const calls = (data && data.calls) || [];
    if (!calls.length || _axRtcCallId) {
      if (!calls.length) {
        axRtcStopRing();
        const s = document.getElementById('axRtcIncomingSheet'); if (s) s.remove();
        _axRtcPendingCall = null;
      }
      return;
    }
    const c = calls[0];
    // Prefer delivering into the themed messenger (opens it if needed).
    if (typeof axMsgDeliverIncomingCall === 'function') {
      axMsgDeliverIncomingCall(c);
      return;
    }
    if (document.getElementById('axRtcIncomingSheet')) return;
    const sheet = document.createElement('div');
    sheet.id = 'axRtcIncomingSheet';
    sheet.className = 'ax-actionsheet';
    _axRtcPendingCall = c;
    sheet.innerHTML =
      '<div class="ax-actionsheet-card ax-rtc-incoming">' +
        '<p><b>' + (c.caller_name || 'Someone') + '</b> — incoming ' + (c.kind || 'voice') + ' call</p>' +
        '<button type="button" class="ax-msg-chip active" onclick="axRtcIncomingAccept()">Accept</button>' +
        '<button type="button" class="ax-msg-chip" onclick="axRtcIncomingDecline()">Decline</button>' +
      '</div>';
    document.body.appendChild(sheet);
    axRtcStartRing();
  } catch (e) { /* ignore */ }
}

function axRtcIncomingAccept() {
  axRtcStopRing();
  const sheet = document.getElementById('axRtcIncomingSheet');
  if (sheet) sheet.remove();
  if (_axRtcPendingCall) axRtcAcceptCall(_axRtcPendingCall);
  _axRtcPendingCall = null;
}

async function axRtcIncomingDecline() {
  axRtcStopRing();
  const sheet = document.getElementById('axRtcIncomingSheet');
  if (sheet) sheet.remove();
  if (_axRtcPendingCall) {
    await axRtcApi('/call/end', { method: 'POST', body: JSON.stringify({ call_id: _axRtcPendingCall.call_id }) });
  }
  _axRtcPendingCall = null;
}

function axRtcStartIncomingPoll() {
  if (_axRtcIncomingTimer) clearInterval(_axRtcIncomingTimer);
  _axRtcIncomingTimer = setInterval(axRtcPollIncoming, 5000);
  setTimeout(axRtcPollIncoming, 2000);
}

/* Outbound calls now live in messenger-app.html (real /call/* WebRTC).
   Keep this export so any leftover onclick still opens messenger + chat. */
function axMsgStartCall(kind) {
  if (typeof axOpenMessages === 'function') axOpenMessages();
  if (typeof showToast === 'function') {
    showToast('Open a chat, then tap the call button', 'info');
  }
}
window.axMsgStartCall = axMsgStartCall;

/* Auto-start incoming-call polling as soon as this module loads. The poll
   (axRtcPollIncoming) self-guards on the `is-signed-in` body class, so it is a
   no-op until the user is authenticated — this just makes sure a signed-in user
   actually RINGS on an incoming call (previously nothing ever started the poll,
   so calls could be placed but never received). */
if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', axRtcStartIncomingPoll);
} else {
  axRtcStartIncomingPoll();
}
