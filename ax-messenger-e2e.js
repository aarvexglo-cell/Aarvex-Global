/* Aarvex Messenger — E2E encryption (ECDH P-256 + AES-GCM, Web Crypto API)
   Server stores ciphertext only; keys never leave the client except public JWK. */

const _axE2eKeyCache = {};

async function axE2eApi(path, opts) {
  return (typeof axMsgApi === 'function') ? axMsgApi(path, opts) : mpApi(path, opts);
}

function axE2eEnabled() {
  try {
    const p = JSON.parse(localStorage.getItem('ax_msg_prefs') || '{}');
    return p.e2eEnabled !== false;
  } catch (e) { return true; }
}

async function axE2eImportPrivateJwk(jwk) {
  return crypto.subtle.importKey('jwk', jwk, { name: 'ECDH', namedCurve: 'P-256' }, true, ['deriveBits']);
}

async function axE2eImportPublicJwk(jwk) {
  return crypto.subtle.importKey('jwk', jwk, { name: 'ECDH', namedCurve: 'P-256' }, true, []);
}

async function axE2eGetPrivateKey() {
  const raw = localStorage.getItem('ax_e2e_private');
  if (!raw) return null;
  try {
    return axE2eImportPrivateJwk(JSON.parse(raw));
  } catch (e) { return null; }
}

async function axE2eEnsureKeys() {
  if (!window.crypto || !crypto.subtle) return false;
  let privJwk = localStorage.getItem('ax_e2e_private');
  if (!privJwk) {
    const kp = await crypto.subtle.generateKey(
      { name: 'ECDH', namedCurve: 'P-256' }, true, ['deriveKey', 'deriveBits']
    );
    const pubJwk = await crypto.subtle.exportKey('jwk', kp.publicKey);
    privJwk = JSON.stringify(await crypto.subtle.exportKey('jwk', kp.privateKey));
    localStorage.setItem('ax_e2e_private', privJwk);
    await axE2eApi('/chat/e2e/register', { method: 'POST', body: JSON.stringify({ public_key: pubJwk }) });
  }
  return true;
}

async function axE2eAesKeyForPeer(peerSub) {
  if (_axE2eKeyCache[peerSub]) return _axE2eKeyCache[peerSub];
  const priv = await axE2eGetPrivateKey();
  if (!priv) await axE2eEnsureKeys();
  const priv2 = await axE2eGetPrivateKey();
  if (!priv2) throw new Error('E2E keys unavailable');
  const data = await axE2eApi('/chat/e2e/key?user_sub=' + encodeURIComponent(peerSub));
  if (!data || !data.public_key) throw new Error(data.error || 'Peer E2E key missing');
  const pub = await axE2eImportPublicJwk(data.public_key);
  const bits = await crypto.subtle.deriveBits({ name: 'ECDH', public: pub }, priv2, 256);
  const aesKey = await crypto.subtle.importKey('raw', bits, { name: 'AES-GCM' }, false, ['encrypt', 'decrypt']);
  _axE2eKeyCache[peerSub] = aesKey;
  return aesKey;
}

async function axE2eEncrypt(peerSub, plaintext) {
  const key = await axE2eAesKeyForPeer(peerSub);
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const enc = await crypto.subtle.encrypt(
    { name: 'AES-GCM', iv: iv },
    key,
    new TextEncoder().encode(plaintext)
  );
  const pack = {
    v: 1,
    iv: Array.from(iv),
    ct: Array.from(new Uint8Array(enc)),
  };
  return 'e2e:' + btoa(JSON.stringify(pack));
}

async function axE2eDecrypt(peerSub, packed) {
  if (!packed || String(packed).indexOf('e2e:') !== 0) return packed;
  try {
    const key = await axE2eAesKeyForPeer(peerSub);
    const obj = JSON.parse(atob(String(packed).slice(4)));
    const iv = new Uint8Array(obj.iv);
    const ct = new Uint8Array(obj.ct);
    const dec = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: iv }, key, ct);
    return new TextDecoder().decode(dec);
  } catch (e) {
    return '🔒 Could not decrypt';
  }
}

async function axE2eInit() {
  if (!axE2eEnabled()) return;
  try {
    await axE2eEnsureKeys();
  } catch (e) { /* optional */ }
}

function axE2eToggleSetting() {
  const p = JSON.parse(localStorage.getItem('ax_msg_prefs') || '{}');
  p.e2eEnabled = p.e2eEnabled === false;
  localStorage.setItem('ax_msg_prefs', JSON.stringify(p));
  if (p.e2eEnabled) axE2eEnsureKeys().then(function () {
    showToast('End-to-end encryption enabled', 'success');
  });
  else showToast('E2E off — messages use TLS only', 'info');
  if (typeof axMsgRenderHub === 'function') axMsgRenderHub();
}

async function axE2ePrepareSend(peerSub, text) {
  if (!text || !axE2eEnabled() || String(peerSub).indexOf('g:') === 0) {
    return { text: text, e2e: false };
  }
  try {
    await axE2eEnsureKeys();
    const cipher = await axE2eEncrypt(peerSub, text);
    return { text: cipher, e2e: true };
  } catch (e) {
    showToast('E2E encrypt failed — sent unencrypted', 'error');
    return { text: text, e2e: false };
  }
}

async function axE2eDecryptMessage(m, peerSub) {
  if (!m.e2e && String(m.text || '').indexOf('e2e:') !== 0) return m.text;
  const plain = await axE2eDecrypt(peerSub, m.text);
  return plain;
}
