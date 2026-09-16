/* Aarvex Portal — Community Feed + profile cover + favourites shops tab +
 * notifications tabs + settings toggles.
 * Load AFTER portal-marketplace.js (wraps mpLoadNotifications/switchPanel)
 * and after ax-delivery-ux.js (shares small helpers).
 */
'use strict';

/* ── tiny helpers ── */
function axEsc(s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}
function axTimeAgo(iso) {
  if (!iso) return '';
  const d = new Date(/(?:Z|[+-]\d{2}:?\d{2})$/.test(iso) ? iso : iso + 'Z');
  if (isNaN(d.getTime())) return '';
  const s = Math.max(1, Math.floor((Date.now() - d.getTime()) / 1000));
  if (s < 60) return 'just now';
  if (s < 3600) return Math.floor(s / 60) + 'm ago';
  if (s < 86400) return Math.floor(s / 3600) + 'h ago';
  if (s < 604800) return Math.floor(s / 86400) + 'd ago';
  return d.toLocaleDateString('en-IN', { day: 'numeric', month: 'short' });
}
function axCount(n) {
  n = +n || 0;
  if (n >= 1000000) return (n / 1000000).toFixed(1) + 'M';
  if (n >= 1000) return (n / 1000).toFixed(1) + 'k';
  return String(n);
}
function axAvatarHtml(name, photo, cls) {
  const initial = axEsc((name || 'A').trim().charAt(0).toUpperCase());
  return photo
    ? '<img class="' + cls + '" src="' + axEsc(photo) + '" alt="" loading="lazy" onerror="this.replaceWith(Object.assign(document.createElement(\'span\'),{className:this.className+\' ax-avatar-initial\',textContent:\'' + initial + '\'}))">'
    : '<span class="' + cls + ' ax-avatar-initial">' + initial + '</span>';
}

/* ══════════════════ FEED ══════════════════ */
let _axFeedPosts = [];
let _axFeedNextOffset = null;
let _axFeedLoading = false;
let _axViewedIds = {};      // ids already counted this session
let _axViewQueue = [];
let _axViewTimer = null;
let _axFeedObserver = null;

async function axLoadFeed(reset) {
  const list = document.getElementById('axFeedList');
  if (!list || _axFeedLoading) return;
  _axFeedLoading = true;
  const isReset = reset !== false;
  if (isReset) {
    _axFeedPosts = []; _axFeedNextOffset = null;
    // First paint: per-post neon skeleton cards (no single whole-feed loader) so
    // posts stream in one-by-one as their media loads.
    list.innerHTML = axFeedSkeletonHtml(1); // single skeleton card — no second one below
    document.body.classList.add('ax-feed-skel'); // hide floating overlays while loading
  }
  axUpdateFeedSentinel();
  try {
    const url = '/feed?limit=10' + (_axFeedNextOffset ? '&offset=' + _axFeedNextOffset : '');
    const data = await mpApi(url);
    const fresh = (data && data.posts) || [];
    const startIndex = _axFeedPosts.length;
    _axFeedPosts = _axFeedNextOffset ? _axFeedPosts.concat(fresh) : fresh;
    _axFeedNextOffset = data ? data.next_offset : null;
    if (isReset) axRenderFeed();
    else axAppendFeed(fresh, startIndex);
  } catch (e) {
    if (!_axFeedPosts.length) list.innerHTML = '<div class="ax-feed-loading">Could not load the feed — pull to refresh.</div>';
  }
  document.body.classList.remove('ax-feed-skel'); // skeleton replaced → restore overlays
  _axFeedLoading = false;
  axInitFeedInfiniteScroll();
  axUpdateFeedSentinel();
}

/* Skeleton placeholder cards — a neon-green ring inside a post-sized media box —
   shown while the first batch loads, keeping the per-post loading aesthetic. */
function axFeedSkeletonHtml(n) {
  const card =
    '<div class="ax-post-card ax-fsk-card" aria-hidden="true">' +
      '<div class="ax-fsk-head">' +
        '<span class="ax-fsk ax-fsk-av"></span>' +
        '<span class="ax-fsk-hlines">' +
          '<span class="ax-fsk ax-fsk-line" style="width:42%"></span>' +
          '<span class="ax-fsk ax-fsk-line ax-fsk-sm" style="width:26%"></span>' +
        '</span>' +
      '</div>' +
      '<div class="ax-fsk-body">' +
        '<span class="ax-fsk ax-fsk-line" style="width:92%"></span>' +
        '<span class="ax-fsk ax-fsk-line" style="width:70%"></span>' +
      '</div>' +
      '<span class="ax-fsk ax-fsk-media"></span>' +
      '<div class="ax-fsk-acts">' +
        '<span class="ax-fsk ax-fsk-pill"></span>' +
        '<span class="ax-fsk ax-fsk-pill"></span>' +
        '<span class="ax-fsk ax-fsk-pill"></span>' +
      '</div>' +
    '</div>';
  let h = '';
  for (let i = 0; i < (n || 2); i++) h += card;
  return h;
}

/* Append ONLY the newly-fetched posts (infinite scroll) — no full re-render, so
   scroll position and already-loaded media are preserved. */
function axAppendFeed(newPosts, startIndex) {
  const list = document.getElementById('axFeedList');
  if (!list || !newPosts || !newPosts.length) return;
  const mySub = (typeof currentUser !== 'undefined' && currentUser) ? currentUser.sub : '';
  let html = '';
  newPosts.forEach(function (p, j) {
    const i = startIndex + j;                 // global index → keeps the every-2nd-post strip correct
    html += axPostCardHtml(p, mySub);
    if ((i + 1) % 2 === 0) html += axFeedShopsStripHtml(((i + 1) / 2) - 1);
  });
  const tpl = document.createElement('template');
  tpl.innerHTML = html;
  list.appendChild(tpl.content);
  axObserveViews();                            // re-observe new cards for view counting (idempotent)
  requestAnimationFrame(function () { axSyncPostClamps(list); });
}

/* Auto-load the next page when the sentinel nears the viewport (infinite scroll).
   Observer attached once; the manual "Load more" button stays as a fallback. */
let _axFeedScrollObs = null;
function axInitFeedInfiniteScroll() {
  if (_axFeedScrollObs || !('IntersectionObserver' in window)) return;
  const sentinel = document.getElementById('axFeedMore');
  if (!sentinel) return;
  _axFeedScrollObs = new IntersectionObserver(function (entries) {
    if (entries[0].isIntersecting && _axFeedNextOffset != null && !_axFeedLoading) axLoadFeed(false);
  }, { rootMargin: '600px 0px' });
  _axFeedScrollObs.observe(sentinel);
}

/* The sentinel doubles as the "loading more" spinner + end-of-feed marker. */
function axUpdateFeedSentinel() {
  const more = document.getElementById('axFeedMore');
  if (!more) return;
  const hasMore = _axFeedNextOffset != null;
  // No load-more skeleton at all — it kept collapsing, so it's removed. Just show
  // the "Load more posts" button when there are more posts and we're not loading;
  // otherwise the sentinel is hidden. (Infinite scroll still calls axLoadFeed.)
  const showBtn = hasMore && !_axFeedLoading;
  more.style.display = showBtn ? '' : 'none';
  more.innerHTML = showBtn
    ? '<button type="button" class="btn-sm-outline" onclick="axLoadFeed(false)"><i class="fa-solid fa-angles-down"></i> Load more posts</button>'
    : '';
}

function axRenderFeed() {
  const list = document.getElementById('axFeedList');
  const more = document.getElementById('axFeedMore');
  if (!list) return;
  if (typeof axHideLoader === 'function') axHideLoader(list);
  if (!_axFeedPosts.length) {
    list.innerHTML =
      '<div class="ax-feed-empty">' +
        '<i class="fa-regular fa-images"></i>' +
        '<b>No posts yet</b>' +
        '<p>Be the first — share a photo or video of your produce, shop or delivery!</p>' +
        '<button type="button" class="btn-primary btn-sm" onclick="axOpenComposer()"><i class="fa-solid fa-plus"></i> Create the first post</button>' +
      '</div>';
    if (more) more.style.display = 'none';
    return;
  }
  const mySub = (typeof currentUser !== 'undefined' && currentUser) ? currentUser.sub : '';
  let html = '';
  _axFeedPosts.forEach(function (p, i) {
    html += axPostCardHtml(p, mySub);
    // Star Performer strip after every 2nd post.
    if ((i + 1) % 2 === 0) html += axFeedShopsStripHtml(((i + 1) / 2) - 1);
  });
  list.innerHTML = html;
  axUpdateFeedSentinel();
  // Standalone Star Performer band stays hidden on Home — the Top Shops strip
  // was moved into the Trade tab's sectioned feed (Batch B5). It's kept in the
  // DOM only so loadTopShops() can still populate window._axTopShops for the
  // in-feed shop strips, so never un-hide it here.
  const standalone = document.getElementById('topShopsSection');
  if (standalone) standalone.style.display = 'none';
  axObserveViews();
  // Show "… more" only on captions that actually overflow the 2-line clamp.
  requestAnimationFrame(function () { axSyncPostClamps(list); });
}

/* Post media (Batch 7): product-promo grid, single media, or a swipeable
   multi-photo carousel (up to 3) with auto + manual navigation. */
function axPostMediaHtml(p) {
  if (p.post_type === 'product_promo' && p.promo_products && p.promo_products.length) {
    return '<div class="ax-promo-grid">' + p.promo_products.map(function (pr) {
      const img = pr.image_url || pr.image || pr.photo_url || '';
      const price = (pr.price != null ? pr.price : (pr.price_per_kg != null ? pr.price_per_kg : (pr.lot_price != null ? pr.lot_price : '')));
      return '<div class="ax-promo-cell">' +
        (img ? '<img src="' + axEsc(img) + '" alt="" loading="lazy">' : '<div class="ax-promo-noimg"><i class="fa-solid fa-seedling"></i></div>') +
        '<div class="ax-promo-info"><b>' + axEsc(pr.product_name || pr.name || 'Product') + '</b>' +
        (price !== '' ? '<span>₹' + axEsc(String(price)) + (pr.unit_label ? '/' + axEsc(pr.unit_label) : '') + '</span>' : '') + '</div>' +
        '<button type="button" class="ax-promo-buy" onclick="axPromoBuy(\'' + axEsc(pr.product_id) + '\')"><i class="fa-solid fa-bag-shopping"></i> Buy</button>' +
        '</div>';
    }).join('') + '</div>';
  }
  const urls = (p.media_urls && p.media_urls.length) ? p.media_urls : (p.media_url ? [p.media_url] : []);
  const types = (p.media_types && p.media_types.length) ? p.media_types : (p.media_type ? [p.media_type] : []);
  if (!urls.length) return '';
  if (urls.length === 1) {
    return '<div class="ax-post-media-wrap ax-media-loading">' +
      '<span class="ax-post-skel"><span class="ax-neon-ring ax-post-neon"></span></span>' + (types[0] === 'video'
      ? '<video class="ax-post-media" src="' + axEsc(urls[0]) + '#t=0.1" controls playsinline preload="metadata" onloadedmetadata="axFitPostMedia(this);axMediaLoaded(this)" onloadeddata="axMediaLoaded(this)" onerror="axMediaError(this)"></video>'
      : '<img class="ax-post-media" src="' + axEsc(urls[0]) + '" alt="" loading="lazy" onload="axFitPostMedia(this);axMediaLoaded(this)" onerror="axMediaError(this)" onclick="axOpenPost(\'' + axEsc(p.post_id) + '\')">') + '</div>';
  }
  const arr = '[' + urls.map(function (x) { return "'" + axEsc(x) + "'"; }).join(',') + ']';
  const slides = urls.map(function (u, i) {
    return '<div class="ax-carousel-slide">' + (types[i] === 'video'
      ? '<video class="ax-post-media" src="' + axEsc(u) + '" controls playsinline preload="metadata" onloadedmetadata="axMediaLoaded(this)"></video>'
      : '<img class="ax-post-media" src="' + axEsc(u) + '" alt="" loading="lazy" onload="axMediaLoaded(this)" onerror="axMediaError(this)" onclick="axLightbox(' + arr + ',' + i + ')">') + '</div>';
  }).join('');
  const dots = urls.map(function (u, i) { return '<span class="ax-carousel-dot' + (i === 0 ? ' active' : '') + '"></span>'; }).join('');
  return '<div class="ax-post-media-wrap ax-carousel ax-media-loading" data-idx="0" data-count="' + urls.length + '">' +
    '<span class="ax-post-skel"><span class="ax-neon-ring ax-post-neon"></span></span>' +
    '<div class="ax-carousel-track">' + slides + '</div>' +
    '<button type="button" class="ax-carousel-nav prev" onclick="axCarouselMove(this,-1)" aria-label="Previous"><i class="fa-solid fa-chevron-left"></i></button>' +
    '<button type="button" class="ax-carousel-nav next" onclick="axCarouselMove(this,1)" aria-label="Next"><i class="fa-solid fa-chevron-right"></i></button>' +
    '<div class="ax-carousel-dots">' + dots + '</div>' +
    '<span class="ax-carousel-count">1/' + urls.length + '</span>' +
    '</div>';
}
/* Size a carousel wrap to its CURRENT slide's image height, so full (uncropped)
   images of any ratio show without empty space; it animates on swipe. */
function axCarouselFitHeight(car) {
  if (!car || !car.classList || !car.classList.contains('ax-carousel')) return;
  const idx = parseInt(car.dataset.idx || '0', 10);
  const slide = car.querySelectorAll('.ax-carousel-slide')[idx];
  const media = slide && slide.querySelector('.ax-post-media');
  if (!media) return;
  const h = media.getBoundingClientRect().height;
  if (h > 0) car.style.height = Math.round(h) + 'px';
}
window.axCarouselFitHeight = axCarouselFitHeight;

/* A post's media finished loading → drop the neon skeleton and fade the media in. */
function axMediaLoaded(el) {
  const wrap = el && el.closest ? el.closest('.ax-post-media-wrap') : null;
  if (wrap) {
    wrap.classList.remove('ax-media-loading');
    if (wrap.classList.contains('ax-carousel')) axCarouselFitHeight(wrap);
  }
}
/* Broken media → drop the skeleton and show a graceful fallback (no spinner stuck). */
function axMediaError(el) {
  const wrap = el && el.closest ? el.closest('.ax-post-media-wrap') : null;
  if (wrap) { wrap.classList.remove('ax-media-loading'); wrap.classList.add('ax-media-error'); }
  if (el) el.style.display = 'none';
}
window.axMediaLoaded = axMediaLoaded;
window.axMediaError = axMediaError;

function axCarouselGo(car, idx) {
  const count = parseInt(car.dataset.count || '1', 10);
  idx = ((idx % count) + count) % count;
  car.dataset.idx = idx;
  const track = car.querySelector('.ax-carousel-track');
  if (track) track.style.transform = 'translateX(-' + (idx * 100) + '%)';
  car.querySelectorAll('.ax-carousel-dot').forEach(function (d, i) { d.classList.toggle('active', i === idx); });
  const cnt = car.querySelector('.ax-carousel-count');
  if (cnt) cnt.textContent = (idx + 1) + '/' + count;
  axCarouselFitHeight(car); // resize the frame to the new slide (no crop, no gap)
}
function axCarouselMove(btn, dir) {
  const car = btn.closest('.ax-carousel');
  if (!car) return;
  car.dataset.pausedUntil = Date.now() + 12000; // pause auto after manual nav
  axCarouselGo(car, parseInt(car.dataset.idx || '0', 10) + dir);
}
/* Auto-advance carousels that are in view, unless recently interacted with. */
setInterval(function () {
  document.querySelectorAll('.ax-carousel').forEach(function (car) {
    if (Date.now() < parseInt(car.dataset.pausedUntil || '0', 10)) return;
    const r = car.getBoundingClientRect();
    if (r.top < window.innerHeight * 0.85 && r.bottom > window.innerHeight * 0.15) {
      axCarouselGo(car, parseInt(car.dataset.idx || '0', 10) + 1);
    }
  });
}, 4500);
/* Re-fit carousel heights when the viewport changes (rotate / resize). */
var _axCarResizeT;
window.addEventListener('resize', function () {
  clearTimeout(_axCarResizeT);
  _axCarResizeT = setTimeout(function () {
    document.querySelectorAll('.ax-carousel').forEach(axCarouselFitHeight);
  }, 150);
});
/* Manual swipe (touch drag) for feed carousels — complements the prev/next
   arrows and the auto-advance. Attached once and delegated on document so it
   also covers carousels appended later by infinite scroll. A horizontal drag
   past the threshold advances/rewinds one slide; vertical drags are ignored
   so the page still scrolls normally. */
(function axInitCarouselSwipe() {
  let sx = 0, sy = 0, active = null, dragging = false;
  document.addEventListener('touchstart', function (e) {
    const car = e.target.closest && e.target.closest('.ax-carousel');
    if (!car || !e.touches || !e.touches.length) return;
    active = car; dragging = false;
    sx = e.touches[0].clientX; sy = e.touches[0].clientY;
  }, { passive: true });
  document.addEventListener('touchmove', function (e) {
    if (!active || !e.touches || !e.touches.length) return;
    const dx = e.touches[0].clientX - sx;
    const dy = e.touches[0].clientY - sy;
    if (!dragging && Math.abs(dx) > 8 && Math.abs(dx) > Math.abs(dy)) dragging = true;
  }, { passive: true });
  document.addEventListener('touchend', function (e) {
    if (!active) return;
    const t = (e.changedTouches && e.changedTouches[0]) || null;
    if (t) {
      const dx = t.clientX - sx, dy = t.clientY - sy;
      if (dragging && Math.abs(dx) > 45 && Math.abs(dx) > Math.abs(dy)) {
        active.dataset.pausedUntil = Date.now() + 12000; // pause auto after manual nav
        axCarouselGo(active, parseInt(active.dataset.idx || '0', 10) + (dx < 0 ? 1 : -1));
      }
    }
    active = null; dragging = false;
  }, { passive: true });
})();

/* Buy a product straight from a promo post's grid. */
function axPromoBuy(productId) {
  if (!productId) return;
  if (window.ProductModal && typeof ProductModal.openById === 'function') { ProductModal.openById(productId); return; }
  if (typeof openById === 'function') { openById(productId); return; }
  if (typeof switchPanel === 'function') { switchPanel('trade'); showToast('Find this product in Trade', 'info'); }
}

function axPostCardHtml(p, mySub) {
  const own = p.user_sub === mySub;
  // Media sits in a ratio-capped frame (Instagram pattern): nothing taller
  // than 3:4 and nothing wider than 1.91:1 — axFitPostMedia() clamps the
  // real ratio into that range on load, cover-cropping the overflow.
  const media = axPostMediaHtml(p);
  const pid = axEsc(p.post_id);
  const proBadge = p.author_shop_id
    ? '<button type="button" class="ax-post-pro" onclick="ProductModal.openShopProfile(\'' + axEsc(p.author_shop_id) + '\')" title="Verified seller — view shop"><i class="fa-solid fa-circle-check"></i> Pro</button>'
    : '';
  return '<article class="ax-post-card" data-post-id="' + pid + '">' +
    '<header class="ax-post-head">' +
      '<span class="ax-post-author-tap" style="cursor:pointer" onclick="axOpenProfile(\'' + axEsc(p.user_sub) + '\')">' + axAvatarHtml(p.user_name, p.user_photo, 'ax-post-avatar') + '</span>' +
      '<div class="ax-post-head-text">' +
        '<b><span class="ax-post-author-tap" style="cursor:pointer" onclick="axOpenProfile(\'' + axEsc(p.user_sub) + '\')">' + axEsc(p.user_name) + '</span>' + proBadge + '</b>' +
        '<small>' + axTimeAgo(p.created_at) + '</small>' +
      '</div>' +
      (!own && p.user_sub
        ? '<button type="button" class="ax-follow-btn' + (p.followed_by_me ? ' following' : '') + '" onclick="axToggleFollow(\'' + axEsc(p.user_sub) + '\', this)">' +
          (p.followed_by_me ? '<i class="fa-solid fa-check"></i> Following' : '<i class="fa-solid fa-plus"></i> Follow') + '</button>'
        : '') +
      (own
        ? '<button type="button" class="ax-post-menu-btn" onclick="axPostMenu(\'' + pid + '\')" aria-label="Post options"><i class="fa-solid fa-ellipsis"></i></button>'
        : '') +
    '</header>' +
    (p.music
      ? '<div class="ax-post-music-strip"><button type="button" class="ax-post-music-chip" onclick="axFeedToggleMusic(this,\'' + axEsc(p.music) + '\')" title="Play ' + axEsc(p.music) + '"><i class="fa-solid fa-music"></i> <span>' + axEsc(p.music) + '</span></button></div>'
      : '') +
    (p.visibility === 'followers'
      ? '<div class="ax-post-privacy"><i class="fa-solid fa-user-group"></i> Followers only</div>'
      : '') +
    media +
    '<div class="ax-post-actions">' +
      '<button type="button" class="ax-post-act ax-react-btn' + (p.my_reaction ? ' reacted reaction-' + p.my_reaction : '') + '" onclick="axReactPicker(\'' + pid + '\', this)" aria-label="React">' +
        axReactionFace(p.my_reaction) +
        ' <span class="ax-react-count" onclick="event.stopPropagation();axShowLikers(\'' + pid + '\')">' + axCount(p.like_count) + '</span></button>' +
      '<button type="button" class="ax-post-act" onclick="axOpenComments(\'' + pid + '\')">' +
        '<svg class="ax-ico" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M21 11.5c0 4.4-4 8-9 8-1.3 0-2.5-.2-3.6-.7L3 20l1.3-4.3C3.5 14.4 3 13 3 11.5c0-4.4 4-8 9-8s9 3.6 9 8Z"/></svg> <span>' + axCount(p.comment_count) + '</span></button>' +
      '<button type="button" class="ax-post-act" onclick="axSharePost(\'' + pid + '\')">' +
        '<svg class="ax-ico" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M21.5 2.5 10.8 13.2"/><path d="M21.5 2.5 14.7 21.5l-3.9-8.3-8.3-3.9Z"/></svg></button>' +
      '<span class="ax-post-views"><svg class="ax-ico ax-ico-eye" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M2 12s3.5-6.5 10-6.5S22 12 22 12s-3.5 6.5-10 6.5S2 12 2 12Z"/><circle cx="12" cy="12" r="2.6"/></svg> ' + axCount(p.view_count) + '</span>' +
    '</div>' +
    // Caption is clamped to 2 lines; "more" (and tapping the post) opens the
    // expanded view with the full text + reactions + comments.
    (p.description
      ? '<div class="ax-post-desc-wrap">' +
          '<p class="ax-post-desc is-clamped" onclick="axOpenPost(\'' + pid + '\')"><b>' + axEsc(p.user_name) + '</b> ' + axEsc(p.description) + '</p>' +
          '<button type="button" class="ax-post-more" hidden onclick="axOpenPost(\'' + pid + '\')">… more</button>' +
        '</div>'
      : '') +
    (p.comment_count > 0
      ? '<button type="button" class="ax-post-viewcomments" onclick="axOpenPost(\'' + pid + '\')">View all ' + axCount(p.comment_count) + ' comments</button>'
      : '') +
  '</article>';
}

/* Tap a post's music chip to play/stop its track — reuses the shared
 * generative audio engine defined in ax-stories.js (only one track plays
 * app-wide at a time, matching how the story viewer behaves). */
function axFeedToggleMusic(btn, name) {
  if (typeof axStoryPlayMusic !== 'function' || typeof axStoryStopMusic !== 'function') return;
  const wasPlaying = btn.classList.contains('playing');
  document.querySelectorAll('.ax-post-music-chip.playing').forEach(function (b) { b.classList.remove('playing'); });
  if (wasPlaying) { axStoryStopMusic(); return; }
  axStoryPlayMusic(name);
  btn.classList.add('playing');
}

function axFeedShopsStripHtml(idx) {
  const shops = window._axTopShops || [];
  if (!shops.length) return '';
  const start = (idx * 3) % Math.max(shops.length, 1);
  const pick = shops.slice(start, start + 3).concat(shops.slice(0, Math.max(0, start + 3 - shops.length)));
  return '<div class="ax-feed-shops-strip">' +
    '<div class="ax-feed-shops-title"><i class="fa-solid fa-trophy"></i> Star Performer Shops</div>' +
    '<div class="ax-feed-shops-row">' +
      pick.map(function (s) {
        const name = s.shop_name || 'Shop';
        const initials = name.trim().split(/\s+/).map(function (w) { return w[0]; }).join('').slice(0, 2).toUpperCase();
        return '<button type="button" class="ax-star-shop-cell" onclick="navigateToShop(\'' + axEsc(s.shop_id) + '\')">' +
          (s.shop_logo_url
            ? '<img class="ax-star-shop-photo" src="' + axEsc(s.shop_logo_url) + '" alt="">'
            : '<div class="ax-star-shop-photo ax-star-shop-initials">' + axEsc(initials || 'S') + '</div>') +
          '<div class="ax-star-shop-name">' + axEsc(name) + '</div>' +
          '<div class="ax-star-shop-meta"><span class="ax-star-shop-rating"><i class="fa-solid fa-star"></i> ' + (s.avg_rating || 0) + '</span>' +
          '<span class="ax-star-shop-likes"><i class="fa-solid fa-heart"></i> ' + (s.like_count || 0) + '</span></div>' +
        '</button>';
      }).join('') +
    '</div></div>';
}

/* ── view counting (IntersectionObserver, batched) ── */
function axObserveViews() {
  if (!('IntersectionObserver' in window)) return;
  if (_axFeedObserver) _axFeedObserver.disconnect();
  _axFeedObserver = new IntersectionObserver(function (entries) {
    entries.forEach(function (en) {
      if (!en.isIntersecting) return;
      const id = en.target.getAttribute('data-post-id');
      if (!id || _axViewedIds[id]) return;
      _axViewedIds[id] = true;
      _axViewQueue.push(id);
      _axFeedObserver.unobserve(en.target);
    });
    if (_axViewQueue.length) {
      clearTimeout(_axViewTimer);
      _axViewTimer = setTimeout(function () {
        const ids = _axViewQueue.splice(0, 25);
        mpApi('/feed/view', { method: 'POST', body: JSON.stringify({ post_ids: ids }) }).catch(function () {});
      }, 1200);
    }
  }, { threshold: 0.55 });
  document.querySelectorAll('#axFeedList .ax-post-card').forEach(function (el) {
    _axFeedObserver.observe(el);
  });
}

/* ── like / comment / share ── */
/* ══════════════════ POST MEDIA RATIO + EXPANDED VIEW ══════════════════ */
/* Show media at its TRUE aspect ratio (no crop, no black filler): once loaded
   we just flag the wrapper `is-fitted`, which drops the placeholder aspect-ratio
   so the box hugs the media's natural height. Width is capped by the feed
   column (narrow + centered on desktop) so a tall reel never dominates. */
function axFitPostMedia(el) {
  const wrap = el.parentElement;
  if (wrap) wrap.classList.add('is-fitted');
}

/* Reveal the "… more" affordance only on captions that actually overflow the
   2-line clamp (checked after layout, per card). */
function axSyncPostClamps(root) {
  (root || document).querySelectorAll('.ax-post-desc.is-clamped').forEach(function (el) {
    const more = el.parentElement && el.parentElement.querySelector('.ax-post-more');
    if (!more) return;
    more.hidden = el.scrollHeight <= el.clientHeight + 1;
  });
}

/* Expanded post view — full caption, media, reactions, and comments inline. */
async function axOpenPost(postId) {
  const p = _axFeedPosts.find(function (x) { return x.post_id === postId; });
  if (!p) return;
  _axCommentsPostId = postId;
  let ov = document.getElementById('axPostDetail');
  if (ov) ov.remove();
  ov = document.createElement('div');
  ov.id = 'axPostDetail';
  ov.className = 'ax-comments-overlay';
  const media = p.media_url
    ? '<div class="ax-post-media-wrap">' + (p.media_type === 'video'
        ? '<video class="ax-post-media" src="' + axEsc(p.media_url) + '" controls playsinline onloadedmetadata="axFitPostMedia(this)"></video>'
        : '<img class="ax-post-media" src="' + axEsc(p.media_url) + '" alt="" loading="lazy" onload="axFitPostMedia(this)">') + '</div>'
    : '';
  ov.innerHTML =
    '<div class="ax-postdetail-box">' +
      '<div class="ax-comments-head">' +
        axAvatarHtml(p.user_name, p.user_photo, 'ax-post-avatar') +
        '<div class="ax-post-head-text" style="flex:1"><b>' + axEsc(p.user_name) + '</b>' +
          '<small>' + axTimeAgo(p.created_at) + '</small></div>' +
        '<button type="button" class="ax-strip-icon-btn" onclick="axClosePost()" aria-label="Close"><i class="fa-solid fa-xmark"></i></button>' +
      '</div>' +
      '<div class="ax-postdetail-scroll">' +
        media +
        '<div class="ax-post-actions">' +
          '<button type="button" class="ax-post-act ax-react-btn' + (p.my_reaction ? ' reacted reaction-' + p.my_reaction : '') + '" onclick="axReactPicker(\'' + axEsc(postId) + '\', this)" aria-label="React">' +
            axReactionFace(p.my_reaction) +
            ' <span class="ax-react-count" onclick="event.stopPropagation();axShowLikers(\'' + axEsc(postId) + '\')">' + axCount(p.like_count) + '</span></button>' +
          '<button type="button" class="ax-post-act" onclick="document.getElementById(\'axPostDetailInput\').focus()">' +
            '<svg class="ax-ico" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M21 11.5c0 4.4-4 8-9 8-1.3 0-2.5-.2-3.6-.7L3 20l1.3-4.3C3.5 14.4 3 13 3 11.5c0-4.4 4-8 9-8s9 3.6 9 8Z"/></svg> <span>' + axCount(p.comment_count) + '</span></button>' +
          '<button type="button" class="ax-post-act" onclick="axSharePost(\'' + axEsc(postId) + '\')">' +
            '<svg class="ax-ico" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M21.5 2.5 10.8 13.2"/><path d="M21.5 2.5 14.7 21.5l-3.9-8.3-8.3-3.9Z"/></svg></button>' +
          '<span class="ax-post-views"><svg class="ax-ico ax-ico-eye" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M2 12s3.5-6.5 10-6.5S22 12 22 12s-3.5 6.5-10 6.5S2 12 2 12Z"/><circle cx="12" cy="12" r="2.6"/></svg> ' + axCount(p.view_count) + '</span>' +
        '</div>' +
        (p.description
          ? '<p class="ax-post-desc ax-post-desc-full"><b>' + axEsc(p.user_name) + '</b> ' + axEsc(p.description) + '</p>'
          : '') +
        '<div class="ax-comments-list" id="axPostDetailComments"><p class="ax-feed-loading"><i class="fa-solid fa-spinner fa-spin"></i> Loading comments…</p></div>' +
      '</div>' +
      '<div class="ax-comments-inputrow">' +
        '<input type="text" id="axPostDetailInput" maxlength="300" placeholder="Write a comment…" autocomplete="off">' +
        '<button type="button" class="btn-primary btn-sm" onclick="axSubmitComment()"><i class="fa-solid fa-paper-plane"></i></button>' +
      '</div>' +
    '</div>';
  ov.addEventListener('click', function (e) { if (e.target === ov) axClosePost(); });
  document.body.appendChild(ov);
  document.body.style.overflow = 'hidden';
  const inp = document.getElementById('axPostDetailInput');
  if (inp) inp.addEventListener('keydown', function (e) { if (e.key === 'Enter') axSubmitComment(); });
  await axLoadCommentsInto('axPostDetailComments', postId);
}
function axClosePost() {
  document.getElementById('axPostDetail')?.remove();
  document.body.style.overflow = '';
}

/* ── Facebook-style reactions (Batch I) ── */
const AX_REACTIONS = [
  { key: 'like', emoji: '👍', label: 'Like' },
  { key: 'love', emoji: '❤️', label: 'Love' },
  { key: 'haha', emoji: '😂', label: 'Haha' },
  { key: 'wow', emoji: '😮', label: 'Wow' },
  { key: 'sad', emoji: '😢', label: 'Sad' },
  { key: 'care', emoji: '🤗', label: 'Care' },
];
function axReactionFace(reaction) {
  if (!reaction) return '<svg class="ax-ico" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M12 20.3S3.6 15 3.6 9.2c0-2.6 2-4.6 4.5-4.6 1.7 0 3.1.9 3.9 2.3.8-1.4 2.2-2.3 3.9-2.3 2.5 0 4.5 2 4.5 4.6 0 5.8-8.4 11.1-8.4 11.1Z"/></svg>';
  const r = AX_REACTIONS.find(function (x) { return x.key === reaction; });
  return '<span class="ax-react-face">' + (r ? r.emoji : '👍') + '</span>';
}
function axCloseReactBar() {
  const bar = document.getElementById('axReactBar');
  if (bar) bar.remove();
  document.removeEventListener('click', axReactBarOutside, true);
}
function axReactBarOutside(e) {
  const bar = document.getElementById('axReactBar');
  if (bar && !bar.contains(e.target) && !e.target.closest('.ax-react-btn')) axCloseReactBar();
}
/* Tap the reaction button → open the emoji picker anchored above it. If the
   user already reacted, a plain tap toggles that reaction off (quick unlike). */
function axReactPicker(postId, btn) {
  const p = _axFeedPosts.find(function (x) { return x.post_id === postId; });
  if (p && p.my_reaction) { axReact(postId, p.my_reaction, btn); return; }
  axCloseReactBar();
  const bar = document.createElement('div');
  bar.id = 'axReactBar';
  bar.className = 'ax-react-bar';
  bar.innerHTML = AX_REACTIONS.map(function (r) {
    return '<button type="button" class="ax-react-opt" title="' + r.label + '" onclick="axReact(\'' + postId + '\',\'' + r.key + '\', document.querySelector(\'.ax-post-card[data-post-id=&quot;' + postId + '&quot;] .ax-react-btn\'))">' + r.emoji + '</button>';
  }).join('');
  document.body.appendChild(bar);
  const rect = btn.getBoundingClientRect();
  bar.style.left = Math.max(8, rect.left) + 'px';
  bar.style.top = (rect.top + window.scrollY - bar.offsetHeight - 8) + 'px';
  setTimeout(function () { document.addEventListener('click', axReactBarOutside, true); }, 0);
}
function _axPaintReact(btn, postId, reaction, count) {
  if (!btn) return;
  btn.className = 'ax-post-act ax-react-btn' + (reaction ? ' reacted reaction-' + reaction : '');
  btn.innerHTML = axReactionFace(reaction) +
    ' <span class="ax-react-count" onclick="event.stopPropagation();axShowLikers(\'' + postId + '\')">' + axCount(count) + '</span>';
}
async function axReact(postId, reaction, btn) {
  axCloseReactBar();
  const p = _axFeedPosts.find(function (x) { return x.post_id === postId; });
  // ── C3 · OPTIMISTIC: flip the UI instantly, confirm with the server after ──
  const prev = p ? { liked: p.liked_by_me, count: p.like_count, reaction: p.my_reaction } : null;
  const wasReacted = p ? !!p.my_reaction : !!(btn && btn.classList.contains('reacted'));
  const sameAsCurrent = p ? (p.my_reaction === reaction) : false;
  const nextReaction = (wasReacted && sameAsCurrent) ? null : reaction; // tap same reaction = remove
  const nextCount = p ? Math.max(0, (p.like_count || 0) + ((nextReaction ? 1 : 0) - (wasReacted ? 1 : 0))) : 0;
  if (p) { p.my_reaction = nextReaction; p.liked_by_me = !!nextReaction; p.like_count = nextCount; }
  _axPaintReact(btn, postId, nextReaction, nextCount);
  if (typeof axHaptic === 'function') axHaptic('light');
  if (nextReaction && typeof axBurst === 'function') {
    const em = (AX_REACTIONS.find(function (x) { return x.key === nextReaction; }) || {}).emoji || '❤️';
    axBurst(btn, em);
  }
  // ── Confirm; on failure REVERT to the previous state ──
  const data = await mpApi('/feed/like', { method: 'POST', body: JSON.stringify({ post_id: postId, reaction: reaction }) });
  if (!data || !data.success) {
    if (p && prev) { p.liked_by_me = prev.liked; p.like_count = prev.count; p.my_reaction = prev.reaction; }
    _axPaintReact(btn, postId, prev ? prev.reaction : null, prev ? prev.count : 0);
    showToast((data && data.error) || 'Could not react', 'error');
    return;
  }
  // Reconcile with authoritative server values.
  if (p) { p.liked_by_me = data.liked; p.like_count = data.like_count; p.my_reaction = data.reaction || null; }
  _axPaintReact(btn, postId, data.reaction, data.like_count);
}
/* Backwards-compat shim: any old caller of axToggleLike still works (quick like). */
function axToggleLike(postId, btn) { axReact(postId, 'like', btn); }

/* ── Follow / unfollow (Batch I) ── */
async function axToggleFollow(userSub, btn) {
  if (btn) btn.disabled = true;
  const data = await mpApi('/feed/follow', { method: 'POST', body: JSON.stringify({ user_sub: userSub }) });
  if (btn) btn.disabled = false;
  if (!data || !data.success) { showToast((data && data.error) || 'Could not update follow', 'error'); return; }
  // Keep every visible post by this author in sync, not just the tapped one.
  _axFeedPosts.forEach(function (p) { if (p.user_sub === userSub) p.followed_by_me = data.following; });
  document.querySelectorAll('.ax-post-card').forEach(function (card) {
    const b = card.querySelector('.ax-follow-btn');
    if (!b || b.getAttribute('onclick').indexOf(userSub) === -1) return;
    b.classList.toggle('following', data.following);
    b.innerHTML = data.following ? '<i class="fa-solid fa-check"></i> Following' : '<i class="fa-solid fa-plus"></i> Follow';
  });
  showToast(data.following ? 'Following' : 'Unfollowed', 'success');
}

/* Followers / following list for a user (defaults to me). */
async function axShowFollowers(userSub) {
  let sheet = document.getElementById('axFollowSheet');
  if (sheet) sheet.remove();
  sheet = document.createElement('div');
  sheet.id = 'axFollowSheet';
  sheet.className = 'ax-comments-overlay';
  sheet.innerHTML = '<div class="ax-comments-box">' +
    '<div class="ax-comments-head"><b>Followers</b>' +
      '<button type="button" class="ax-strip-icon-btn" onclick="document.getElementById(\'axFollowSheet\').remove()" aria-label="Close"><i class="fa-solid fa-xmark"></i></button></div>' +
    '<div class="ax-comments-list" id="axFollowList"><p class="ax-feed-loading"><i class="fa-solid fa-spinner fa-spin"></i> Loading…</p></div>' +
  '</div>';
  sheet.addEventListener('click', function (e) { if (e.target === sheet) sheet.remove(); });
  document.body.appendChild(sheet);
  const q = userSub ? ('?user_sub=' + encodeURIComponent(userSub)) : '';
  const data = await mpApi('/feed/follow/stats' + q);
  const list = document.getElementById('axFollowList');
  if (!list) return;
  const followers = (data && data.followers) || [];
  const head = '<div class="ax-follow-stats"><span><b>' + ((data && data.follower_count) || 0) + '</b> followers</span>' +
    '<span><b>' + ((data && data.following_count) || 0) + '</b> following</span></div>';
  list.innerHTML = head + (followers.length
    ? followers.map(function (f) {
        return '<div class="ax-liker-row">' + axAvatarHtml(f.user_name, f.user_photo, 'ax-liker-avatar') +
          '<b>' + axEsc(f.user_name) + '</b></div>';
      }).join('')
    : '<p class="ax-feed-empty">No followers yet.</p>');
}

/* Who reacted — tap the count. Shows names + each person's reaction emoji. */
async function axShowLikers(postId) {
  let sheet = document.getElementById('axLikersSheet');
  if (sheet) sheet.remove();
  sheet = document.createElement('div');
  sheet.id = 'axLikersSheet';
  sheet.className = 'ax-comments-overlay';
  sheet.innerHTML = '<div class="ax-comments-box">' +
    '<div class="ax-comments-head"><b>Reactions</b>' +
      '<button type="button" class="ax-strip-icon-btn" onclick="document.getElementById(\'axLikersSheet\').remove()" aria-label="Close"><i class="fa-solid fa-xmark"></i></button></div>' +
    '<div class="ax-comments-list" id="axLikersList"><p class="ax-feed-loading"><i class="fa-solid fa-spinner fa-spin"></i> Loading…</p></div>' +
  '</div>';
  sheet.addEventListener('click', function (e) { if (e.target === sheet) sheet.remove(); });
  document.body.appendChild(sheet);
  const data = await mpApi('/feed/likers?post_id=' + encodeURIComponent(postId));
  const list = document.getElementById('axLikersList');
  if (!list) return;
  const likers = (data && data.likers) || [];
  if (!likers.length) { list.innerHTML = '<p class="ax-feed-empty">No reactions yet.</p>'; return; }
  list.innerHTML = likers.map(function (l) {
    const r = AX_REACTIONS.find(function (x) { return x.key === (l.reaction || 'like'); });
    return '<div class="ax-liker-row">' + axAvatarHtml(l.user_name, l.user_photo, 'ax-liker-avatar') +
      '<b>' + axEsc(l.user_name) + '</b><span class="ax-liker-react">' + (r ? r.emoji : '👍') + '</span></div>';
  }).join('');
}

let _axCommentsPostId = null;
async function axOpenComments(postId) {
  _axCommentsPostId = postId;
  let sheet = document.getElementById('axCommentsSheet');
  if (sheet) sheet.remove();
  sheet = document.createElement('div');
  sheet.id = 'axCommentsSheet';
  sheet.className = 'ax-comments-overlay';
  sheet.innerHTML =
    '<div class="ax-comments-box">' +
      '<div class="ax-comments-head"><b>Comments</b>' +
        '<button type="button" class="ax-strip-icon-btn" onclick="document.getElementById(\'axCommentsSheet\').remove()" aria-label="Close"><i class="fa-solid fa-xmark"></i></button></div>' +
      '<div class="ax-comments-list" id="axCommentsList"><p class="ax-feed-loading"><i class="fa-solid fa-spinner fa-spin"></i> Loading…</p></div>' +
      '<div class="ax-comments-inputrow">' +
        '<input type="text" id="axCommentInput" maxlength="300" placeholder="Write a comment…" autocomplete="off">' +
        '<button type="button" class="btn-primary btn-sm" onclick="axSubmitComment()"><i class="fa-solid fa-paper-plane"></i></button>' +
      '</div>' +
    '</div>';
  sheet.addEventListener('click', function (e) { if (e.target === sheet) sheet.remove(); });
  document.body.appendChild(sheet);
  await axLoadCommentsInto('axCommentsList', postId);
  const inp = document.getElementById('axCommentInput');
  if (inp) {
    inp.addEventListener('keydown', function (e) { if (e.key === 'Enter') axSubmitComment(); });
    inp.focus();
  }
}

/* Shared comment renderer — used by both the comments sheet and the expanded
   post view, so threading/like/reply behaviour can never drift between them. */
function axCommentRowHtml(c, isReply) {
  return '<div class="ax-comment-row' + (isReply ? ' ax-comment-reply' : '') + '" data-comment-id="' + axEsc(c.comment_id) + '">' +
    axAvatarHtml(c.user_name, c.user_photo, 'ax-comment-avatar') +
    '<div class="ax-comment-body"><b>' + axEsc(c.user_name) + '</b> ' + axEsc(c.text) +
      '<div class="ax-comment-meta">' +
        '<small>' + axTimeAgo(c.created_at) + '</small>' +
        '<button type="button" class="ax-comment-like' + (c.liked_by_me ? ' liked' : '') + '" onclick="axLikeComment(\'' + axEsc(c.comment_id) + '\', this)">' +
          '<i class="fa-' + (c.liked_by_me ? 'solid' : 'regular') + ' fa-heart"></i> <span>' + axCount(c.like_count || 0) + '</span></button>' +
        (isReply ? '' : '<button type="button" class="ax-comment-reply-btn" onclick="axReplyTo(\'' + axEsc(c.comment_id) + '\',\'' + axEsc(c.user_name) + '\')">Reply</button>') +
      '</div>' +
    '</div></div>';
}
function axCommentsListHtml(comments) {
  // Thread replies under their parent (one level deep, Instagram-style).
  const tops = comments.filter(function (c) { return !c.parent_id; });
  const repliesOf = {};
  comments.forEach(function (c) {
    if (!c.parent_id) return;
    (repliesOf[c.parent_id] = repliesOf[c.parent_id] || []).push(c);
  });
  if (!tops.length) return '<p class="ax-feed-loading">No comments yet — be the first!</p>';
  return tops.map(function (c) {
    return axCommentRowHtml(c, false) +
      (repliesOf[c.comment_id] || []).map(function (r) { return axCommentRowHtml(r, true); }).join('');
  }).join('');
}
async function axLoadCommentsInto(listElId, postId) {
  const data = await mpApi('/feed/comments?post_id=' + encodeURIComponent(postId));
  const listEl = document.getElementById(listElId);
  if (!listEl) return;
  listEl.innerHTML = axCommentsListHtml((data && data.comments) || []);
}

/* Reply target (Batch I): set by the Reply button, cleared after posting. */
let _axReplyParentId = null;
/* Whichever comment surface is currently open (expanded post takes priority). */
function axActiveCommentInput() {
  return document.getElementById('axPostDetail')
    ? document.getElementById('axPostDetailInput')
    : document.getElementById('axCommentInput');
}
function axReplyTo(commentId, userName) {
  _axReplyParentId = commentId;
  const inp = axActiveCommentInput();
  if (inp) { inp.placeholder = 'Replying to ' + userName + '…'; inp.focus(); }
  let hint = document.getElementById('axReplyHint');
  if (!hint) {
    hint = document.createElement('div');
    hint.id = 'axReplyHint';
    hint.className = 'ax-reply-hint';
    const row = (inp && inp.closest('.ax-comments-inputrow'))
      || document.querySelector('#axPostDetail .ax-comments-inputrow')
      || document.querySelector('#axCommentsSheet .ax-comments-inputrow');
    if (row) row.parentNode.insertBefore(hint, row);
  }
  hint.innerHTML = '<span>Replying to <b>' + axEsc(userName) + '</b></span>' +
    '<button type="button" onclick="axCancelReply()" aria-label="Cancel reply"><i class="fa-solid fa-xmark"></i></button>';
}
function axCancelReply() {
  _axReplyParentId = null;
  const hint = document.getElementById('axReplyHint');
  if (hint) hint.remove();
  const inp = axActiveCommentInput();
  if (inp) inp.placeholder = 'Write a comment…';
}
async function axLikeComment(commentId, btn) {
  const data = await mpApi('/feed/comment/like', {
    method: 'POST',
    body: JSON.stringify({ post_id: _axCommentsPostId, comment_id: commentId }),
  });
  if (!data || !data.success) { showToast((data && data.error) || 'Could not like comment', 'error'); return; }
  if (btn) {
    btn.classList.toggle('liked', data.liked);
    btn.innerHTML = '<i class="fa-' + (data.liked ? 'solid' : 'regular') + ' fa-heart"></i> <span>' + axCount(data.like_count) + '</span>';
  }
}

async function axSubmitComment() {
  // Works from either surface: the comments sheet or the expanded post view.
  const detailInp = document.getElementById('axPostDetailInput');
  const inDetail = !!document.getElementById('axPostDetail');
  const inp = inDetail ? detailInp : document.getElementById('axCommentInput');
  const text = (inp && inp.value || '').trim();
  if (!text || !_axCommentsPostId) return;
  inp.value = '';
  const payload = { post_id: _axCommentsPostId, text: text };
  if (_axReplyParentId) payload.parent_id = _axReplyParentId;
  _axReplyParentId = null;
  axCancelReply();
  const data = await mpApi('/feed/comment', { method: 'POST', body: JSON.stringify(payload) });
  if (data && data.success) {
    const p = _axFeedPosts.find(function (x) { return x.post_id === _axCommentsPostId; });
    if (p) p.comment_count = (+p.comment_count || 0) + 1;
    if (inDetail) await axLoadCommentsInto('axPostDetailComments', _axCommentsPostId);
    else axOpenComments(_axCommentsPostId); // reload sheet
  } else {
    showToast((data && data.error) || 'Could not comment', 'error');
  }
}

async function axSharePost(postId) {
  const p = _axFeedPosts.find(function (x) { return x.post_id === postId; }) || {};
  const text = (p.user_name ? p.user_name + ' on Aarvex Global: ' : '') + (p.description || 'Check out this post on Aarvex Global!');
  const url = location.origin && location.origin !== 'null'
    ? location.origin + location.pathname + '?feed_post=' + encodeURIComponent(postId)
    : 'https://aarvexglobal.com/portal.html?feed_post=' + encodeURIComponent(postId);
  mpApi('/feed/share', { method: 'POST', body: JSON.stringify({ post_id: postId }) }).catch(function () {});
  if (navigator.share) {
    navigator.share({ title: 'Aarvex Global', text: text, url: url }).catch(function () {});
  } else if (typeof axCopyText === 'function') {
    axCopyText(url, null);
  }
}

/* ── owner menu: edit / delete ── */
function axPostMenu(postId) {
  const p = _axFeedPosts.find(function (x) { return x.post_id === postId; });
  let menu = document.getElementById('axPostMenuSheet');
  if (menu) menu.remove();
  menu = document.createElement('div');
  menu.id = 'axPostMenuSheet';
  menu.className = 'ax-comments-overlay';
  menu.innerHTML =
    '<div class="ax-postmenu-box">' +
      '<button type="button" class="ax-postmenu-item" onclick="axEditPost(\'' + axEsc(postId) + '\')"><i class="fa-solid fa-pen"></i> Edit caption</button>' +
      '<button type="button" class="ax-postmenu-item ax-postmenu-danger" onclick="axDeletePost(\'' + axEsc(postId) + '\')"><i class="fa-solid fa-trash-can"></i> Delete post</button>' +
      '<button type="button" class="ax-postmenu-item" onclick="document.getElementById(\'axPostMenuSheet\').remove()">Cancel</button>' +
    '</div>';
  menu.addEventListener('click', function (e) { if (e.target === menu) menu.remove(); });
  document.body.appendChild(menu);
}

async function axEditPost(postId) {
  document.getElementById('axPostMenuSheet')?.remove();
  const p = _axFeedPosts.find(function (x) { return x.post_id === postId; }) || {};
  const text = prompt('Edit your caption:', p.description || '');
  if (text == null) return;
  const data = await mpApi('/feed/edit', { method: 'POST', body: JSON.stringify({ post_id: postId, description: text.trim() }) });
  if (data && data.success) {
    if (p) p.description = text.trim();
    axRenderFeed();
    axLoadMyPosts();
    showToast('Post updated', 'success');
  } else showToast((data && data.error) || 'Could not update', 'error');
}

async function axDeletePost(postId) {
  document.getElementById('axPostMenuSheet')?.remove();
  if (!confirm('Delete this post permanently?')) return;
  const data = await mpApi('/feed/delete', { method: 'POST', body: JSON.stringify({ post_id: postId }) });
  if (data && data.success) {
    _axFeedPosts = _axFeedPosts.filter(function (x) { return x.post_id !== postId; });
    axRenderFeed();
    axLoadMyPosts();
    showToast('Post deleted', 'success');
  } else showToast((data && data.error) || 'Could not delete', 'error');
}

/* ── composer ── */
let _axComposeMedia = null; // legacy single { b64, type }
let _axComposeMediaList = []; // Batch 7: up to 3 [{ b64, type }]
let _axComposeMusic = ''; // set via the story-style editor's Music tab (Batch L)
let _axComposePickQueue = []; // files still waiting to go through the editor
let _axPromoIds = [];        // Batch 7: promoted product ids
function axOpenComposer(withMedia) {
  let modal = document.getElementById('axComposerModal');
  if (modal) modal.remove();
  _axComposeMedia = null;
  _axComposeMediaList = [];
  _axComposeMusic = '';
  _axComposePickQueue = [];
  _axPromoIds = [];
  _axPostAudience = [];
  // Honour the "default to followers-only posts" setting (Batch K).
  _axPostVisibility = (typeof axSettingOn === 'function' && axSettingOn('ax_posts_followers_only'))
    ? 'followers' : 'public';
  modal = document.createElement('div');
  modal.id = 'axComposerModal';
  modal.className = 'ax-comments-overlay';
  modal.innerHTML =
    '<div class="ax-composer-box">' +
      '<div class="ax-comments-head"><b>New Post</b>' +
        '<button type="button" class="ax-strip-icon-btn ax-sheet-close" onclick="axCloseComposerModal()" aria-label="Close"><i class="fa-solid fa-chevron-down"></i></button></div>' +
      '<textarea id="axComposeText" maxlength="1000" rows="3" placeholder="Write a description… (produce, prices, shop updates, delivery stories)"></textarea>' +
      '<div id="axComposePreview" class="ax-compose-preview ax-compose-multi" style="display:none"></div>' +
      '<div id="axComposeMusicRow" class="ax-compose-music-row" style="display:none"></div>' +
      '<div id="axPromoSelected" class="ax-promo-selected" style="display:none"></div>' +
      // Who can see this post (Batch 3): Public / Followers / Selected / Hide-from.
      '<div class="ax-privacy-row">' +
        '<span class="ax-privacy-label"><i class="fa-solid fa-eye"></i> Who can see this?</span>' +
        '<button type="button" class="ax-aud-chip" id="axComposeAudChip" onclick="axComposePickAudience()">' +
          '<i class="fa-solid ' + axAudienceIcon(_axPostVisibility) + '"></i> <span>' + axAudienceLabel(_axPostVisibility) + '</span></button>' +
      '</div>' +
      '<div class="ax-composer-actions">' +
        '<label class="btn-sm-outline" style="cursor:pointer"><i class="fa-solid fa-image"></i> Photos (max 3)' +
          '<input type="file" id="axComposeFile" accept="image/*,video/mp4,video/webm" multiple style="display:none" onchange="axComposeFilePicked(this)"></label>' +
        ((window.mpShop && mpShop.shop_id) ? '<button type="button" class="btn-sm-outline" onclick="axPromoOpen()"><i class="fa-solid fa-store"></i> Promote products</button>' : '') +
        '<button type="button" class="btn-primary" id="axComposeSubmitBtn" onclick="axSubmitPost()"><i class="fa-solid fa-paper-plane"></i> Post</button>' +
      '</div>' +
      '<p class="ax-radius-note">Photo/video max 5MB. Your name and profile photo appear with the post.</p>' +
    '</div>';
  modal.addEventListener('click', function (e) { if (e.target === modal) axCloseComposerModal(); });
  document.body.appendChild(modal);
  if (window.axSheetify) window.axSheetify(modal, { boxSel: '.ax-composer-box', onClose: () => modal.remove() });
  if (withMedia) document.getElementById('axComposeFile').click();
  else document.getElementById('axComposeText').focus();
}
function axCloseComposerModal() {
  if (typeof axStoryStopMusic === 'function') axStoryStopMusic();
  document.getElementById('axComposerModal')?.remove();
}

function axComposeFilePicked(input) {
  const files = Array.prototype.slice.call(input.files || []);
  if (!files.length) return;
  const room = 3 - _axComposeMediaList.length;
  if (room <= 0) { showToast('Max 3 photos per post', 'error'); input.value = ''; return; }
  input.value = '';
  const accepted = files.slice(0, room).filter(function (f) {
    if (f.size > 5 * 1024 * 1024) { showToast(f.name + ' is over 5MB — skipped', 'error'); return false; }
    return true;
  });
  if (!accepted.length) return;
  _axComposePickQueue = _axComposePickQueue.concat(accepted);
  axComposeProcessQueue();
}
/* Reads the next queued file and opens it in the editor; images go through
 * the full story-style editor (filters/text/stickers/draw/shapes/music),
 * videos are added as-is (matches the editor's own video handling). Runs one
 * at a time so picking several photos edits them back-to-back. */
function axComposeProcessQueue() {
  if (!_axComposePickQueue.length) return;
  const f = _axComposePickQueue.shift();
  const isVideo = /^video\//.test(f.type);
  const fr = new FileReader();
  fr.onload = function () {
    if (isVideo) {
      _axComposeMediaList.push({ b64: fr.result, type: 'video' });
      axRenderComposePreview();
      axComposeProcessQueue();
      return;
    }
    // Prefer the rich iframe editor (story-editor.html via axOpenEditor).
    if (typeof axOpenEditor === 'function') {
      axOpenEditor(fr.result, 'feed', function (finalB64, meta) {
        if (finalB64) {
          _axComposeMediaList.push({ b64: finalB64, type: 'image' });
          if (meta && meta.music) _axComposeMusic = meta.music;
          axRenderComposePreview();
          axRenderComposeMusicRow();
        }
        axComposeProcessQueue();
      }, function () {
        // Cancelled — skip this photo, continue queue.
        axComposeProcessQueue();
      });
      return;
    }
    // Fallback: legacy inline editor, or add as-is.
    if (typeof axMediaEditOpen === 'function') {
      axMediaEditOpen(fr.result, false, { mode: 'post' }, function (finalB64, music) {
        if (finalB64) {
          _axComposeMediaList.push({ b64: finalB64, type: 'image' });
          if (music) _axComposeMusic = music;
          axRenderComposePreview();
          axRenderComposeMusicRow();
        }
        axComposeProcessQueue();
      });
      return;
    }
    _axComposeMediaList.push({ b64: fr.result, type: 'image' });
    axRenderComposePreview();
    axComposeProcessQueue();
  };
  fr.readAsDataURL(f);
}
function axRenderComposeMusicRow() {
  const row = document.getElementById('axComposeMusicRow');
  if (!row) return;
  if (!_axComposeMusic) { row.style.display = 'none'; row.innerHTML = ''; return; }
  row.style.display = '';
  row.innerHTML = '<i class="fa-solid fa-music"></i> <span>' + axEsc(_axComposeMusic) + '</span>' +
    '<button type="button" onclick="axComposeRemoveMusic()" aria-label="Remove music"><i class="fa-solid fa-xmark"></i></button>';
}
function axComposeRemoveMusic() {
  _axComposeMusic = '';
  if (typeof axStoryStopMusic === 'function') axStoryStopMusic();
  axRenderComposeMusicRow();
}
function axRenderComposePreview() {
  const prev = document.getElementById('axComposePreview');
  if (!prev) return;
  if (!_axComposeMediaList.length) { prev.style.display = 'none'; prev.innerHTML = ''; return; }
  prev.style.display = '';
  prev.innerHTML = _axComposeMediaList.map(function (m, i) {
    return '<div class="ax-compose-thumb">' + (m.type === 'video'
      ? '<video src="' + m.b64 + '" muted></video>'
      : '<img src="' + m.b64 + '" alt="">') +
      (m.type === 'video' ? '' : '<button type="button" class="ax-strip-icon-btn ax-compose-edit" onclick="axComposeEditThumb(' + i + ')" aria-label="Edit photo"><i class="fa-solid fa-pen"></i></button>') +
      '<button type="button" class="ax-strip-icon-btn ax-compose-remove" onclick="axComposeRemoveMedia(' + i + ')"><i class="fa-solid fa-xmark"></i></button></div>';
  }).join('');
}
/* Reopen the shared editor on a photo already added to the post. */
function axComposeEditThumb(i) {
  const m = _axComposeMediaList[i];
  if (!m || m.type === 'video') return;
  if (typeof axOpenEditor === 'function') {
    axOpenEditor(m.b64, 'feed', function (finalB64, meta) {
      if (finalB64) {
        _axComposeMediaList[i] = { b64: finalB64, type: 'image' };
        if (meta && meta.music) _axComposeMusic = meta.music;
        axRenderComposePreview();
        axRenderComposeMusicRow();
      }
    });
    return;
  }
  if (typeof axMediaEditOpen !== 'function') return;
  axMediaEditOpen(m.b64, false, { mode: 'post' }, function (finalB64, music) {
    if (finalB64) {
      _axComposeMediaList[i] = { b64: finalB64, type: 'image' };
      if (music) _axComposeMusic = music;
      axRenderComposePreview();
      axRenderComposeMusicRow();
    }
  });
}
function axComposeRemoveMedia(i) {
  if (typeof i === 'number') _axComposeMediaList.splice(i, 1);
  else _axComposeMediaList = [];
  axRenderComposePreview();
}

/* Promote products picker (Batch 7) — shop owners only. */
async function axPromoOpen() {
  const data = await mpApi('/shop/products');
  const products = (data && data.products) || [];
  if (!products.length) { showToast('Add products to your shop first', 'info'); return; }
  let ov = document.getElementById('axPromoPickOverlay');
  if (ov) ov.remove();
  ov = document.createElement('div');
  ov.id = 'axPromoPickOverlay';
  ov.className = 'ax-comments-overlay';
  ov.innerHTML = '<div class="ax-comments-box"><div class="ax-comments-head"><b>Promote products</b>' +
    '<button type="button" class="ax-strip-icon-btn" onclick="document.getElementById(\'axPromoPickOverlay\').remove()"><i class="fa-solid fa-xmark"></i></button></div>' +
    '<div class="ax-privacy-scroll"><p class="ax-prof-empty-sm" style="text-align:left">Pick at least 3 for a nice grid. Buyers can buy straight from your post.</p>' +
    '<div class="ax-promo-pick">' + products.map(function (pr) {
      const on = _axPromoIds.indexOf(pr.product_id) !== -1;
      const img = pr.image_url || pr.image || '';
      return '<label class="ax-promo-pick-cell' + (on ? ' on' : '') + '">' +
        (img ? '<img src="' + axEsc(img) + '">' : '<div class="ax-promo-noimg"><i class="fa-solid fa-seedling"></i></div>') +
        '<span>' + axEsc(pr.product_name || pr.name || 'Product') + '</span>' +
        '<input type="checkbox" data-id="' + axEsc(pr.product_id) + '"' + (on ? ' checked' : '') + ' onchange="axPromoToggle(this)"></label>';
    }).join('') + '</div>' +
    '<button type="button" class="btn-primary ax-privacy-save" onclick="axPromoDone()">Done</button></div></div>';
  ov.addEventListener('click', function (e) { if (e.target === ov) ov.remove(); });
  document.body.appendChild(ov);
}
function axPromoToggle(cb) {
  const id = cb.dataset.id;
  const i = _axPromoIds.indexOf(id);
  if (cb.checked && i === -1) _axPromoIds.push(id);
  else if (!cb.checked && i !== -1) _axPromoIds.splice(i, 1);
  const cell = cb.closest('.ax-promo-pick-cell'); if (cell) cell.classList.toggle('on', cb.checked);
}
function axPromoDone() {
  const ov = document.getElementById('axPromoPickOverlay'); if (ov) ov.remove();
  const box = document.getElementById('axPromoSelected');
  if (!box) return;
  if (_axPromoIds.length) { box.style.display = ''; box.innerHTML = '<i class="fa-solid fa-store"></i> ' + _axPromoIds.length + ' product' + (_axPromoIds.length > 1 ? 's' : '') + ' selected' + (_axPromoIds.length < 3 ? ' — add ' + (3 - _axPromoIds.length) + ' more for a grid' : ''); }
  else { box.style.display = 'none'; box.innerHTML = ''; }
}

/* Composer audience (Batch 3) — Public / Followers / Selected / Hide-from,
   chosen via the shared picker in ax-social.js. */
let _axPostVisibility = 'public';
let _axPostAudience = [];
function axComposePickAudience() {
  if (typeof axOpenAudiencePicker !== 'function') return;
  axOpenAudiencePicker({ visibility: _axPostVisibility, audience_subs: _axPostAudience }, function (r) {
    _axPostVisibility = r.visibility;
    _axPostAudience = r.audience_subs || [];
    const chip = document.getElementById('axComposeAudChip');
    if (chip) chip.innerHTML = '<i class="fa-solid ' + axAudienceIcon(r.visibility) + '"></i> <span>' + axAudienceLabel(r.visibility) + '</span>';
  });
}

async function axSubmitPost() {
  const btn = document.getElementById('axComposeSubmitBtn');
  const text = (document.getElementById('axComposeText')?.value || '').trim();
  if (!text && !_axComposeMediaList.length && !_axPromoIds.length) { showToast('Add a photo, products, or a description', 'error'); return; }
  if (btn) { btn.disabled = true; btn.innerHTML = '<span class="spinner"></span> Posting…'; }
  const data = await mpApi('/feed/post', {
    method: 'POST',
    body: JSON.stringify({
      description: text,
      media_items: _axComposeMediaList.map(function (m) { return m.b64; }),
      promo_product_ids: _axPromoIds,
      visibility: _axPostVisibility,
      audience_subs: _axPostAudience,
      music: _axComposeMusic,
    }),
  });
  if (data && data.success) {
    if (typeof axStoryStopMusic === 'function') axStoryStopMusic();
    document.getElementById('axComposerModal')?.remove();
    showToast('Posted to the community feed!', 'success');
    if (data.post) { _axFeedPosts.unshift(data.post); axRenderFeed(); }
    else axLoadFeed(true);
    axLoadMyPosts();
  } else {
    showToast((data && data.error) || 'Could not post', 'error');
    if (btn) { btn.disabled = false; btn.innerHTML = '<i class="fa-solid fa-paper-plane"></i> Post'; }
  }
}

function axOpenMedia(url) {
  // Use the zoomable lightbox (Phase 2 graphics) when available.
  if (typeof axLightbox === 'function') { axLightbox([url], 0); return; }
  let overlay = document.getElementById('axMediaOverlay');
  if (overlay) overlay.remove();
  overlay = document.createElement('div');
  overlay.id = 'axMediaOverlay';
  overlay.className = 'ax-media-overlay';
  overlay.innerHTML = '<img src="' + axEsc(url) + '" alt="">';
  overlay.addEventListener('click', function () { overlay.remove(); });
  document.body.appendChild(overlay);
}

/* ══════════════════ MY POSTS (profile grid) ══════════════════ */
async function axLoadMyPosts() {
  const grid = document.getElementById('axMyPostsGrid');
  if (!grid) return;
  const data = await mpApi('/feed?mine=1&limit=50');
  const posts = (data && data.posts) || [];
  if (!posts.length) {
    grid.innerHTML = '<p style="grid-column:1/-1;color:var(--c-text3);font-size:13px;text-align:center;padding:16px 0">No posts yet — share your first one from the Home tab.</p>';
    return;
  }
  // Keep them available for the edit/delete menu even if the home feed
  // hasn't loaded these posts.
  posts.forEach(function (p) {
    if (!_axFeedPosts.some(function (x) { return x.post_id === p.post_id; })) _axFeedPosts.push(p);
  });
  grid.innerHTML = posts.map(function (p) {
    const tile = p.media_url
      ? (p.media_type === 'video'
        ? '<video src="' + axEsc(p.media_url) + '" preload="metadata" muted></video><i class="fa-solid fa-play ax-mypost-play"></i>'
        : '<img src="' + axEsc(p.media_url) + '" alt="" loading="lazy">')
      : '<span class="ax-mypost-textonly">' + axEsc((p.description || '').slice(0, 60)) + '</span>';
    return '<button type="button" class="ax-mypost-tile" onclick="axPostMenu(\'' + axEsc(p.post_id) + '\')">' +
      tile +
      '<span class="ax-mypost-stats"><span><i class="fa-solid fa-heart"></i> ' + axCount(p.like_count) + '</span>' +
      '<span><i class="fa-solid fa-comment"></i> ' + axCount(p.comment_count) + '</span></span>' +
    '</button>';
  }).join('');
}

/* ══════════════════ PROFILE COVER ══════════════════ */
function axApplyCover(url) {
  const cover = document.getElementById('axProfileCover');
  if (!cover) return;
  // The cover's CSS gradient is set with `!important` (theme accent header), which
  // beats a plain inline background-image — so the uploaded photo never showed.
  // Set the image (and sizing) as inline `!important` so it wins over that gradient.
  if (url) {
    cover.style.setProperty('background-image', 'url("' + url + '")', 'important');
    cover.style.setProperty('background-size', 'cover', 'important');
    cover.style.setProperty('background-position', 'center', 'important');
  } else {
    cover.style.removeProperty('background-image');
    cover.style.removeProperty('background-size');
    cover.style.removeProperty('background-position');
  }
  cover.classList.toggle('has-cover', !!url);
}
async function axUploadCover(input) {
  const f = input.files && input.files[0];
  if (!f) return;
  if (f.size > 5 * 1024 * 1024) { showToast('Max 5MB', 'error'); input.value = ''; return; }
  const fr = new FileReader();
  fr.onload = async function () {
    showToast('Uploading cover…', 'info');
    const data = await mpApi('/profile/cover', { method: 'POST', body: JSON.stringify({ image_b64: fr.result }) });
    if (data && data.success) {
      axApplyCover(data.cover_photo_url);
      showToast('Cover photo updated', 'success');
    } else showToast((data && data.error) || 'Upload failed', 'error');
  };
  fr.readAsDataURL(f);
  input.value = '';
}
function axLoadCoverFromProfile() {
  try {
    if (typeof userProfile !== 'undefined' && userProfile && userProfile.cover_photo_url) {
      axApplyCover(userProfile.cover_photo_url);
    }
  } catch (e) {}
}

/* ══════════════════ FAVOURITES — Products | Shops ══════════════════ */
function axSetFavTab(tab) {
  document.querySelectorAll('.ax-fav-tab').forEach(function (b) {
    b.classList.toggle('active', b.dataset.favTab === tab);
  });
  const shops = document.getElementById('axFavShopsList');
  const grid = document.getElementById('favouritesGrid');
  const shopsSearch = document.getElementById('axFavShopsSearch');
  const prodSearch = document.getElementById('axFavProductsSearch');
  const isShops = tab === 'shops';
  if (shops) shops.style.display = isShops ? '' : 'none';
  if (grid) grid.style.display = isShops ? 'none' : '';
  if (shopsSearch) shopsSearch.style.display = isShops ? '' : 'none';
  if (prodSearch) prodSearch.style.display = isShops ? 'none' : '';
  if (isShops) axLoadFavShops();
}

// Kept so the Shops search box can re-filter without another network round-trip.
let _axFavShops = [];
async function axLoadFavShops() {
  const list = document.getElementById('axFavShopsList');
  if (!list) return;
  list.innerHTML = '<p class="ax-feed-loading"><i class="fa-solid fa-spinner fa-spin"></i> Loading your shops…</p>';
  const data = await mpApi('/shop/favourites');
  _axFavShops = (data && data.shops) || [];
  const q = (document.getElementById('favShopsSearchInput') || {}).value || '';
  axRenderFavShops(q);
}

/* Live-filter the saved shops by name/category as the user types (mirrors the
   Products tab's search). Renders straight from the already-loaded list. */
function axFilterFavShops(query) {
  axRenderFavShops(query || '');
}

function axRenderFavShops(query) {
  const list = document.getElementById('axFavShopsList');
  if (!list) return;
  const q = (query || '').trim().toLowerCase();
  const filtered = q
    ? _axFavShops.filter(function (s) {
        return ((s.shop_name || '') + ' ' + (s.shop_category || '') + ' ' +
                (s.address_city || '') + ' ' + (s.address_state || '')).toLowerCase().indexOf(q) !== -1;
      })
    : _axFavShops;
  if (!_axFavShops.length) {
    var shopsEmpty = (typeof CatalogueUI !== 'undefined')
      ? CatalogueUI.emptyStateHtml({
          icon: 'fa-heart',
          title: 'No favourite shops yet',
          message: 'Open any shop profile and tap the like button to save it here.'
        })
      : '<i class="fa-solid fa-heart"></i><b>No favourite shops yet</b>' +
        '<p>Open any shop profile and tap the like button to save it here.</p>';
    list.innerHTML = '<div class="ax-fav-empty">' + shopsEmpty + '</div>';
    return;
  }
  if (!filtered.length) {
    list.innerHTML = '<div class="ax-fav-empty"><i class="fa-solid fa-magnifying-glass"></i>' +
      '<b>No shops match “' + axEsc(q) + '”</b><p>Try a different name.</p></div>';
    return;
  }
  list.innerHTML = filtered.map(function (s) {
    const initials = (s.shop_name || 'S').trim().split(/\s+/).map(function (w) { return w[0]; }).join('').slice(0, 2).toUpperCase();
    const meta = [s.shop_category, [s.address_city, s.address_state].filter(Boolean).join(', ')].filter(Boolean).join(' · ');
    return '<button type="button" class="ax-shop-row" onclick="ProductModal.openShopProfile(\'' + axEsc(s.shop_id) + '\')">' +
      '<span class="ax-shop-row-avatar">' +
        (s.shop_logo_url ? '<img src="' + axEsc(s.shop_logo_url) + '" alt="">' : axEsc(initials)) +
      '</span>' +
      '<span class="ax-shop-row-info"><b>' + axEsc(s.shop_name) + '</b><small>' + axEsc(meta || 'Verified seller') + '</small></span>' +
      '<span class="ax-shop-row-meta"><span><i class="fa-solid fa-star"></i> ' + (s.avg_rating || 0) + '</span>' +
      '<span><i class="fa-solid fa-heart" style="color:#E1435A"></i> ' + (s.like_count || 0) + '</span></span>' +
    '</button>';
  }).join('');
}
window.axFilterFavShops = axFilterFavShops;

/* ══════════════════ NOTIFICATIONS — General | Feed tabs ══════════════════ */
let _axNotifTab = 'general';
function axSetNotifTab(tab) {
  _axNotifTab = tab;
  document.querySelectorAll('.ax-notif-tab').forEach(function (b) {
    b.classList.toggle('active', b.dataset.notifTab === tab);
  });
  axApplyNotifFilter();
}
function axApplyNotifFilter() {
  const list = document.getElementById('notificationsList');
  if (!list) return;
  let shown = 0;
  list.querySelectorAll('.notif-item').forEach(function (el) {
    const t = el.getAttribute('data-ntype') || '';
    const isFeed = t.indexOf('feed_') === 0;
    const show = _axNotifTab === 'feed' ? isFeed : !isFeed;
    el.style.display = show ? '' : 'none';
    if (show) shown++;
  });
  let emptyEl = document.getElementById('axNotifTabEmpty');
  if (!shown) {
    if (!emptyEl) {
      emptyEl = document.createElement('div');
      emptyEl.id = 'axNotifTabEmpty';
      emptyEl.className = 'ax-notif-empty';
      list.appendChild(emptyEl);
    }
    const isFeed = _axNotifTab === 'feed';
    emptyEl.innerHTML =
      '<div class="ax-notif-empty-ico" aria-hidden="true"><i class="fa-' +
      (isFeed ? 'solid fa-heart' : 'regular fa-bell') + '"></i></div>' +
      '<p class="ax-notif-empty-title">' + (isFeed ? 'No feed activity' : 'Nothing here yet') + '</p>' +
      '<p class="ax-notif-empty-sub">' +
      (isFeed
        ? 'Likes and comments on your posts will appear in this tab.'
        : 'Orders, delivery, KYC and admin alerts will show up here.') +
      '</p>';
    emptyEl.style.display = '';
  } else if (emptyEl) {
    emptyEl.style.display = 'none';
  }
}

/* ══════════════════ SETTINGS toggles ══════════════════ */
/* Most switches are opt-OUT (missing value = ON). These few are opt-IN, so a
   fresh account doesn't silently get restricted posting (Batch K). */
const AX_SETTINGS_DEFAULT_OFF = { ax_posts_followers_only: true };
function axSettingOn(key) {
  return AX_SETTINGS_DEFAULT_OFF[key]
    ? localStorage.getItem(key) === 'on'
    : localStorage.getItem(key) !== 'off';
}
function axToggleSetting(row, key) {
  const cur = axSettingOn(key);
  localStorage.setItem(key, cur ? 'off' : 'on');
  axSyncSettingPills();
  showToast(cur ? 'Turned off' : 'Turned on', 'info');
}
function axSyncSettingPills() {
  document.querySelectorAll('.ax-toggle-pill[data-setting]').forEach(function (pill) {
    pill.classList.toggle('on', axSettingOn(pill.dataset.setting));
  });
  // Role-aware shortcut rows mirror whichever nav items the user has unlocked.
  [['settingsShopRow', 'navShop'], ['settingsDeliveryRow', 'navDelivery']].forEach(function (pair) {
    const row = document.getElementById(pair[0]);
    const nav = document.getElementById(pair[1]);
    if (row) row.style.display = (nav && nav.style.display !== 'none') ? '' : 'none';
  });
}
function axClearCachedData() {
  try {
    if (typeof axCategoryImagesPromise !== 'undefined') axCategoryImagesPromise = null;
    if (typeof axShopsCache !== 'undefined') axShopsCache = null;
  } catch (e) {}
  if (typeof loadCatalogue === 'function') loadCatalogue();
  if (typeof loadTopShops === 'function') loadTopShops();
  showToast('Cached data cleared — everything refreshed', 'success');
}

/* ══════════════════ WIRE-UP ══════════════════ */
(function () {
  // Composer avatar mirrors the signed-in user.
  function syncComposerAvatar() {
    const slot = document.getElementById('axFeedComposerAvatar');
    if (!slot || typeof currentUser === 'undefined' || !currentUser) return;
    const photo = (typeof userProfile !== 'undefined' && userProfile && (userProfile.custom_photo_url || userProfile.photo_url)) || currentUser.picture || '';
    slot.innerHTML = axAvatarHtml(currentUser.name || currentUser.email, photo, 'ax-post-avatar');
  }

  // Panel hooks — extend switchPanel (wrappers already chain safely).
  const _origSwitch = typeof switchPanel === 'function' ? switchPanel : null;
  if (_origSwitch) {
    switchPanel = function (panelId) {
      const r = _origSwitch(panelId);
      if (panelId !== 'dashboard' && typeof axStoryStopMusic === 'function') axStoryStopMusic();
      if (panelId === 'dashboard') {
        axLoadFeed(true);
        syncComposerAvatar();
        if (typeof axLoadStories === 'function') axLoadStories();   // Batch J
      }
      if (panelId === 'profile') { axLoadMyPosts(); axLoadCoverFromProfile(); }
      if (panelId === 'notifications') { setTimeout(axApplyNotifFilter, 600); }
      return r;
    };
  }
  // mpLoadNotifications re-renders the list — reapply the active tab filter.
  if (typeof mpLoadNotifications === 'function') {
    const _origNotifs = mpLoadNotifications;
    mpLoadNotifications = async function () {
      const r = await _origNotifs();
      axApplyNotifFilter();
      return r;
    };
  }
  document.addEventListener('DOMContentLoaded', function () {
    axSyncSettingPills();
    // First feed load once signed-in state settles.
    setTimeout(function () {
      if (document.body.classList.contains('is-signed-in')) {
        axLoadFeed(true);
        syncComposerAvatar();
        // Dashboard is the default panel and never goes through switchPanel(),
        // so the stories tray needs seeding here too (Batch J).
        if (typeof axLoadStories === 'function') axLoadStories();
      }
    }, 900);
  });
})();
