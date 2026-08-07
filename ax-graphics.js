/* Aarvex Portal — Graphics layer (Phase 2 · visual polish)
 * Zoomable image lightbox, inline SVG charts, warm empty-state illustrations,
 * trust badges and micro-interactions. Pure frontend, no dependencies.
 */
'use strict';

function axGfxEsc(s) { return String(s == null ? '' : s).replace(/[<>&"]/g, c => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', '"': '&quot;' }[c])); }

/* ══════════════════ ZOOMABLE LIGHTBOX ══════════════════
   Agri buyers judge quality from the photo, so let them zoom. Supports a
   gallery (swipe between a product's images), wheel/double-tap/pinch zoom and
   drag-to-pan while zoomed. */
let _axLb = { urls: [], i: 0, scale: 1, x: 0, y: 0, sx: 0, sy: 0, dragging: false, pinchDist: 0 };
function axLightbox(urls, start) {
  _axLb.urls = Array.isArray(urls) ? urls.filter(Boolean) : [urls].filter(Boolean);
  if (!_axLb.urls.length) return;
  _axLb.i = Math.max(0, Math.min(start || 0, _axLb.urls.length - 1));
  let ov = document.getElementById('axLightbox');
  if (ov) ov.remove();
  ov = document.createElement('div');
  ov.id = 'axLightbox';
  ov.className = 'ax-lightbox';
  ov.innerHTML =
    '<button type="button" class="ax-lb-close" aria-label="Close"><i class="fa-solid fa-xmark"></i></button>' +
    (_axLb.urls.length > 1 ? '<button type="button" class="ax-lb-nav ax-lb-prev" aria-label="Previous"><i class="fa-solid fa-chevron-left"></i></button>' +
      '<button type="button" class="ax-lb-nav ax-lb-next" aria-label="Next"><i class="fa-solid fa-chevron-right"></i></button>' : '') +
    '<div class="ax-lb-stage"><img class="ax-lb-img" alt=""></div>' +
    '<div class="ax-lb-hint"><i class="fa-solid fa-magnifying-glass-plus"></i> Double-tap or scroll to zoom</div>' +
    (_axLb.urls.length > 1 ? '<div class="ax-lb-dots">' + _axLb.urls.map((_, i) => '<span class="ax-lb-dot"></span>').join('') + '</div>' : '');
  document.body.appendChild(ov);
  document.body.style.overflow = 'hidden';
  axLbShow();

  const img = ov.querySelector('.ax-lb-img');
  ov.querySelector('.ax-lb-close').onclick = axLbClose;
  ov.addEventListener('click', e => { if (e.target === ov || e.target.classList.contains('ax-lb-stage')) axLbClose(); });
  const prev = ov.querySelector('.ax-lb-prev'); if (prev) prev.onclick = e => { e.stopPropagation(); axLbGo(-1); };
  const next = ov.querySelector('.ax-lb-next'); if (next) next.onclick = e => { e.stopPropagation(); axLbGo(1); };

  // Wheel zoom (desktop)
  img.addEventListener('wheel', e => { e.preventDefault(); axLbZoom(_axLb.scale * (e.deltaY < 0 ? 1.15 : 0.87)); }, { passive: false });
  // Double-tap/click zoom
  let lastTap = 0;
  img.addEventListener('click', e => {
    e.stopPropagation();
    const now = Date.now();
    if (now - lastTap < 300) { axLbZoom(_axLb.scale > 1 ? 1 : 2.5); }
    lastTap = now;
  });
  // Drag to pan when zoomed (pointer)
  img.addEventListener('pointerdown', e => { if (_axLb.scale <= 1) return; _axLb.dragging = true; _axLb.sx = e.clientX - _axLb.x; _axLb.sy = e.clientY - _axLb.y; img.setPointerCapture(e.pointerId); });
  img.addEventListener('pointermove', e => { if (!_axLb.dragging) return; _axLb.x = e.clientX - _axLb.sx; _axLb.y = e.clientY - _axLb.sy; axLbApply(); });
  img.addEventListener('pointerup', () => { _axLb.dragging = false; });
  // Touch swipe between images (when not zoomed) + pinch zoom
  let tsx = 0;
  img.addEventListener('touchstart', e => {
    if (e.touches.length === 2) _axLb.pinchDist = Math.hypot(e.touches[0].clientX - e.touches[1].clientX, e.touches[0].clientY - e.touches[1].clientY);
    else tsx = e.touches[0].clientX;
  }, { passive: true });
  img.addEventListener('touchmove', e => {
    if (e.touches.length === 2 && _axLb.pinchDist) {
      const d = Math.hypot(e.touches[0].clientX - e.touches[1].clientX, e.touches[0].clientY - e.touches[1].clientY);
      axLbZoom(_axLb.scale * (d / _axLb.pinchDist)); _axLb.pinchDist = d;
    }
  }, { passive: true });
  img.addEventListener('touchend', e => {
    if (_axLb.scale <= 1 && tsx) {
      const dx = (e.changedTouches[0].clientX - tsx);
      if (Math.abs(dx) > 50) axLbGo(dx < 0 ? 1 : -1);
    }
    _axLb.pinchDist = 0;
  }, { passive: true });
  document.addEventListener('keydown', axLbKey);
}
function axLbKey(e) {
  if (!document.getElementById('axLightbox')) return;
  if (e.key === 'Escape') axLbClose();
  else if (e.key === 'ArrowRight') axLbGo(1);
  else if (e.key === 'ArrowLeft') axLbGo(-1);
}
function axLbShow() {
  const img = document.querySelector('#axLightbox .ax-lb-img');
  if (!img) return;
  _axLb.scale = 1; _axLb.x = 0; _axLb.y = 0;
  img.src = _axLb.urls[_axLb.i];
  axLbApply();
  document.querySelectorAll('#axLightbox .ax-lb-dot').forEach((d, i) => d.classList.toggle('on', i === _axLb.i));
}
function axLbGo(dir) { _axLb.i = (_axLb.i + dir + _axLb.urls.length) % _axLb.urls.length; axLbShow(); }
function axLbZoom(s) { _axLb.scale = Math.max(1, Math.min(s, 5)); if (_axLb.scale === 1) { _axLb.x = 0; _axLb.y = 0; } axLbApply(); }
function axLbApply() {
  const img = document.querySelector('#axLightbox .ax-lb-img');
  if (img) { img.style.transform = 'translate(' + _axLb.x + 'px,' + _axLb.y + 'px) scale(' + _axLb.scale + ')'; img.style.cursor = _axLb.scale > 1 ? 'grab' : 'zoom-in'; }
}
function axLbClose() { document.getElementById('axLightbox')?.remove(); document.body.style.overflow = ''; document.removeEventListener('keydown', axLbKey); }

/* ══════════════════ INLINE SVG CHARTS ══════════════════ */
/* Lighten a hex colour toward white by `amt` (0..1) — used for the subtle
   top-left highlight on each donut arc. */
function axGfxLighten(hex, amt) {
  try {
    hex = String(hex).replace('#', '');
    if (hex.length === 3) hex = hex.split('').map(function (ch) { return ch + ch; }).join('');
    let r = parseInt(hex.slice(0, 2), 16), g = parseInt(hex.slice(2, 4), 16), b = parseInt(hex.slice(4, 6), 16);
    r = Math.round(r + (255 - r) * amt); g = Math.round(g + (255 - g) * amt); b = Math.round(b + (255 - b) * amt);
    return 'rgb(' + r + ',' + g + ',' + b + ')';
  } catch (e) { return hex; }
}
function axDonut(segments, opts) {
  // segments: [{label, value, color}]
  opts = opts || {};
  segments = (segments || []).filter(Boolean);
  const total = segments.reduce((a, s) => a + (s.value || 0), 0) || 1;
  const nonZero = segments.filter(s => (s.value || 0) > 0).length;
  const R = 54, C = 2 * Math.PI * R, W = 15;
  const gap = nonZero > 1 ? 0.022 * C : 0; // small breathing space between arcs
  const uid = 'axd' + Math.random().toString(36).slice(2, 7);
  // Per-segment gradient (highlight → base) for depth instead of a flat fill.
  const defs = segments.map((s, i) =>
    '<linearGradient id="' + uid + i + '" x1="0" y1="0" x2="1" y2="1">' +
      '<stop offset="0" stop-color="' + axGfxLighten(s.color, 0.22) + '"/>' +
      '<stop offset="1" stop-color="' + s.color + '"/></linearGradient>'
  ).join('');
  let off = 0;
  const rings = segments.map((s, i) => {
    const frac = (s.value || 0) / total;
    if (frac <= 0) return '';
    const len = Math.max(frac * C - gap, 1.5);
    const seg = '<circle cx="70" cy="70" r="' + R + '" fill="none" stroke="url(#' + uid + i + ')" stroke-width="' + W + '" ' +
      'stroke-dasharray="' + len + ' ' + (C - len) + '" stroke-dashoffset="' + (-off * C) + '" transform="rotate(-90 70 70)" stroke-linecap="round"/>';
    off += frac;
    return seg;
  }).join('');
  const legend = segments.map(s => '<div class="ax-chart-leg"><span style="background:' + s.color + '"></span>' + axGfxEsc(s.label) + ' <b>' + (opts.fmt ? opts.fmt(s.value) : s.value) + '</b></div>').join('');
  return '<div class="ax-chart-donut"><svg viewBox="0 0 140 140" width="140" height="140">' +
    '<defs>' + defs +
      '<filter id="' + uid + 's" x="-30%" y="-30%" width="160%" height="160%"><feDropShadow dx="0" dy="2" stdDeviation="3" flood-color="rgba(20,45,30,.30)"/></filter>' +
    '</defs>' +
    '<circle cx="70" cy="70" r="' + R + '" fill="none" stroke="var(--c-mist,#EDF2EC)" stroke-width="' + W + '"/>' +
    '<g filter="url(#' + uid + 's)">' + rings + '</g>' +
    (opts.center ? '<text x="70" y="67" text-anchor="middle" class="ax-donut-c1">' + axGfxEsc(opts.center) + '</text>' + (opts.centerSub ? '<text x="70" y="85" text-anchor="middle" class="ax-donut-c2">' + axGfxEsc(opts.centerSub) + '</text>' : '') : '') +
    '</svg><div class="ax-chart-legend">' + legend + '</div></div>';
}
function axSparkline(values, opts) {
  opts = opts || {};
  values = (values || []).map(Number);
  if (values.length < 2) return '';
  const w = 240, h = 60, max = Math.max.apply(null, values), min = Math.min.apply(null, values);
  const span = (max - min) || 1;
  const pts = values.map((v, i) => (i / (values.length - 1) * w).toFixed(1) + ',' + (h - ((v - min) / span) * (h - 8) - 4).toFixed(1));
  const line = pts.join(' ');
  const area = 'M0,' + h + ' L' + pts.map(p => p.replace(',', ' ')).join(' L') + ' L' + w + ',' + h + ' Z';
  return '<svg class="ax-spark" viewBox="0 0 ' + w + ' ' + h + '" preserveAspectRatio="none">' +
    '<path d="' + area + '" fill="' + (opts.fill || 'rgba(46,107,65,.12)') + '"/>' +
    '<polyline points="' + line + '" fill="none" stroke="' + (opts.stroke || '#2E6B41') + '" stroke-width="2.5" stroke-linejoin="round" stroke-linecap="round"/>' +
    '</svg>';
}

/* ══════════════════ EMPTY-STATE ILLUSTRATIONS ══════════════════
   Warm, on-brand line illustrations instead of a flat grey icon. */
const AX_ILLUS = {
  basket: '<svg viewBox="0 0 120 120" class="ax-illus"><circle cx="60" cy="60" r="54" fill="var(--il-bg)"/><path d="M32 54h56l-6 34a6 6 0 0 1-6 5H44a6 6 0 0 1-6-5z" fill="none" stroke="var(--il-line)" stroke-width="3"/><path d="M44 54l8-18M76 54l-8-18" stroke="var(--il-line)" stroke-width="3" fill="none" stroke-linecap="round"/><circle cx="50" cy="70" r="3" fill="var(--il-accent)"/><circle cx="62" cy="74" r="3" fill="var(--il-accent)"/><circle cx="72" cy="68" r="3" fill="var(--il-accent)"/></svg>',
  field: '<svg viewBox="0 0 120 120" class="ax-illus"><circle cx="60" cy="60" r="54" fill="var(--il-bg)"/><path d="M30 80c10-6 20-6 30 0s20 6 30 0" stroke="var(--il-line)" stroke-width="3" fill="none" stroke-linecap="round"/><path d="M48 78V52M60 80V46M72 78V54" stroke="var(--il-line)" stroke-width="3" stroke-linecap="round"/><path d="M48 52c-6-2-8-8-6-12 5 1 8 6 6 12zM60 46c-6-2-8-9-5-14 6 1 9 8 5 14zM72 54c6-2 8-8 6-12-5 1-8 6-6 12z" fill="var(--il-accent)"/></svg>',
  box: '<svg viewBox="0 0 120 120" class="ax-illus"><circle cx="60" cy="60" r="54" fill="var(--il-bg)"/><path d="M40 52l20-10 20 10v22l-20 10-20-10z" fill="none" stroke="var(--il-line)" stroke-width="3" stroke-linejoin="round"/><path d="M40 52l20 10 20-10M60 62v24" stroke="var(--il-line)" stroke-width="3" fill="none"/><circle cx="60" cy="42" r="3" fill="var(--il-accent)"/></svg>',
  heart: '<svg viewBox="0 0 120 120" class="ax-illus"><circle cx="60" cy="60" r="54" fill="var(--il-bg)"/><path d="M60 82C40 68 34 58 34 50a12 12 0 0 1 26-6 12 12 0 0 1 26 6c0 8-6 18-26 32z" fill="none" stroke="var(--il-line)" stroke-width="3" stroke-linejoin="round"/></svg>',
  search: '<svg viewBox="0 0 120 120" class="ax-illus"><circle cx="60" cy="60" r="54" fill="var(--il-bg)"/><circle cx="54" cy="54" r="16" fill="none" stroke="var(--il-line)" stroke-width="3"/><path d="M66 66l14 14" stroke="var(--il-line)" stroke-width="3" stroke-linecap="round"/><circle cx="54" cy="54" r="6" fill="var(--il-accent)"/></svg>',
  bell: '<svg viewBox="0 0 120 120" class="ax-illus"><circle cx="60" cy="60" r="54" fill="var(--il-bg)"/><path d="M46 74V58a14 14 0 0 1 28 0v16l4 6H42z" fill="none" stroke="var(--il-line)" stroke-width="3" stroke-linejoin="round"/><path d="M55 84a5 5 0 0 0 10 0" stroke="var(--il-line)" stroke-width="3" fill="none" stroke-linecap="round"/><circle cx="60" cy="42" r="3" fill="var(--il-accent)"/></svg>',
};
function axEmptyState(type, title, sub, actionHtml) {
  return '<div class="ax-empty">' + (AX_ILLUS[type] || AX_ILLUS.box) +
    '<div class="ax-empty-title">' + axGfxEsc(title || '') + '</div>' +
    (sub ? '<div class="ax-empty-sub">' + axGfxEsc(sub) + '</div>' : '') +
    (actionHtml || '') + '</div>';
}

/* ══════════════════ TRUST BADGES ══════════════════ */
const AX_TRUST = {
  fssai: { icon: 'fa-certificate', label: 'FSSAI', color: '#2E6B41' },
  apeda: { icon: 'fa-globe', label: 'APEDA', color: '#2A7F7E' },
  organic: { icon: 'fa-leaf', label: 'Organic', color: '#3E9159' },
  gst: { icon: 'fa-file-invoice', label: 'GST', color: '#C7993A' },
  verified: { icon: 'fa-circle-check', label: 'Verified', color: '#2E6B41' },
};
function axTrustBadges(keys) {
  return (keys || []).map(k => {
    const b = AX_TRUST[k]; if (!b) return '';
    return '<span class="ax-trust-badge" style="--tb:' + b.color + '"><i class="fa-solid ' + b.icon + '"></i> ' + b.label + '</span>';
  }).join('');
}

/* ══════════════════ MICRO-INTERACTIONS ══════════════════ */
/* Heart/like burst — call with the button element that was tapped. */
function axBurst(el, emoji) {
  if (!el) return;
  const rect = el.getBoundingClientRect();
  const burst = document.createElement('div');
  burst.className = 'ax-burst';
  burst.style.left = (rect.left + rect.width / 2) + 'px';
  burst.style.top = (rect.top + rect.height / 2) + 'px';
  burst.textContent = emoji || '❤️';
  document.body.appendChild(burst);
  setTimeout(() => burst.remove(), 700);
}

window.axLightbox = axLightbox;
window.axDonut = axDonut;
window.axSparkline = axSparkline;
window.axEmptyState = axEmptyState;
window.axTrustBadges = axTrustBadges;
window.axBurst = axBurst;
