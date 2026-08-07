/* Aarvex Portal — Refer & Earn (Phase 2 · growth)
 * Each user has a referral code; when someone they referred places their first
 * order, both sides earn credit. Backend: /referral/code|apply|list.
 * A ?ref=CODE in the URL auto-fills the "apply" field for new users.
 */
'use strict';

function axRefEsc(s) { return String(s == null ? '' : s).replace(/[<>&]/g, c => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;' }[c])); }

async function axLoadReferral() {
  const el = document.getElementById('referralContent');
  if (!el) return;
  el.innerHTML = '<div class="ax-ref-loading"><i class="fa-solid fa-spinner fa-spin"></i> Loading…</div>';
  const [code, list] = await Promise.all([
    mpApi('/referral/code').catch(() => null),
    mpApi('/referral/list').catch(() => null),
  ]);
  if (!code || code.error) {
    el.innerHTML = '<p class="ax-ref-loading">Sign in to get your referral code.</p>';
    return;
  }
  const reward = code.reward_inr || 100;
  const shareText = 'Join me on Aarvex Global — buy & sell agri produce directly. Use my code ' + code.code + ' and we both earn ₹' + reward + '! ' + (code.share_url || '');
  const alreadyReferred = !!code.referred_by;
  const refUrl = code.share_url || '';

  let html =
    '<div class="ax-ref-hero">' +
      '<div class="ax-ref-hero-icon"><i class="fa-solid fa-gift"></i></div>' +
      '<div class="ax-ref-reward">Earn ₹' + reward + ' each</div>' +
      '<p>Share your code. When a friend places their first order, you both get ₹' + reward + ' in credit.</p>' +
      '<div class="ax-ref-code" onclick="axRefCopy(\'' + axRefEsc(code.code) + '\', this)">' +
        '<span>' + axRefEsc(code.code) + '</span><i class="fa-regular fa-copy"></i></div>' +
      '<div class="ax-ref-share">' +
        '<a class="ax-ref-wa" href="https://wa.me/?text=' + encodeURIComponent(shareText) + '" target="_blank" rel="noopener"><i class="fa-brands fa-whatsapp"></i> Share on WhatsApp</a>' +
        '<button type="button" class="ax-ref-copylink" onclick="axRefCopy(\'' + axRefEsc(refUrl) + '\', this, true)"><i class="fa-solid fa-link"></i> Copy link</button>' +
      '</div>' +
    '</div>' +
    '<div class="ax-ref-stats">' +
      '<div class="ax-ref-stat"><b>' + (code.referral_count || 0) + '</b><span>Friends joined</span></div>' +
      '<div class="ax-ref-stat"><b>₹' + (code.referral_credits || 0) + '</b><span>Credit earned</span></div>' +
    '</div>';

  // Apply-a-code (only if the user hasn't used one yet).
  if (!alreadyReferred) {
    const prefill = axRefUrlCode();
    html += '<div class="ax-ref-apply-card">' +
      '<div class="ax-ref-apply-title">Have a referral code?</div>' +
      '<div class="ax-ref-apply-row">' +
        '<input type="text" id="axRefApplyInput" maxlength="12" placeholder="Enter code" value="' + axRefEsc(prefill || '') + '" style="text-transform:uppercase">' +
        '<button type="button" class="btn-primary btn-sm" onclick="axRefApply()">Apply</button>' +
      '</div></div>';
  } else {
    html += '<div class="ax-ref-applied"><i class="fa-solid fa-circle-check"></i> You joined with code <b>' + axRefEsc(code.referred_by) + '</b></div>';
  }

  // Referral list
  const refs = (list && list.referrals) || [];
  if (refs.length) {
    html += '<div class="ax-ref-list-card"><div class="ax-ref-list-title">Your referrals</div>' +
      refs.map(function (r) {
        const rewarded = r.status === 'rewarded';
        return '<div class="ax-ref-list-row"><span>' + axRefEsc(r.referee_name || 'Friend') + '</span>' +
          '<span class="ax-ref-list-status ' + (rewarded ? 'pos' : 'warn') + '">' +
          (rewarded ? '₹' + r.reward_inr + ' earned' : 'Pending first order') + '</span></div>';
      }).join('') + '</div>';
  }
  el.innerHTML = html;
}

function axRefUrlCode() {
  try {
    const m = location.search.match(/[?&]ref=([A-Za-z0-9]+)/);
    return m ? m[1].toUpperCase() : (localStorage.getItem('ax_pending_ref') || '');
  } catch (e) { return ''; }
}

async function axRefApply() {
  const code = (document.getElementById('axRefApplyInput')?.value || '').trim().toUpperCase();
  if (!code) { showToast('Enter a referral code', 'warning'); return; }
  const data = await mpApi('/referral/apply', { method: 'POST', body: JSON.stringify({ code: code }) });
  if (data && data.success) {
    try { localStorage.removeItem('ax_pending_ref'); } catch (e) {}
    showToast('Code applied — you’ll both earn on your first order', 'success');
    axLoadReferral();
  } else {
    showToast((data && data.error) || 'Could not apply code', 'error');
  }
}

function axRefCopy(text, el, isLink) {
  if (!text) return;
  const done = function () {
    if (el) { const orig = el.innerHTML; el.classList.add('copied'); showToast(isLink ? 'Link copied' : 'Code copied', 'success'); setTimeout(function () { el.classList.remove('copied'); }, 1200); }
  };
  if (navigator.clipboard && navigator.clipboard.writeText) navigator.clipboard.writeText(text).then(done).catch(done);
  else { try { const t = document.createElement('textarea'); t.value = text; document.body.appendChild(t); t.select(); document.execCommand('copy'); t.remove(); done(); } catch (e) {} }
}

/* Capture ?ref=CODE on first load so it survives the sign-in redirect. */
document.addEventListener('DOMContentLoaded', function () {
  const c = axRefUrlCode();
  if (c) { try { localStorage.setItem('ax_pending_ref', c); } catch (e) {} }
});
window.axLoadReferral = axLoadReferral;
window.axRefApply = axRefApply;
window.axRefCopy = axRefCopy;
