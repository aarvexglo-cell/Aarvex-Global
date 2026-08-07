/* Aarvex Portal — Stories (Batch J)
 * WhatsApp-style 24h stories: tray at the top of the Home feed, full-screen
 * viewer with auto-advancing progress bars, tap/swipe navigation, like + reply.
 * Backend: /story/create | /story/list | /story/view | /story/like | /story/reply
 *          | /story/delete   (see marketplace.py — records auto-expire in 24h)
 * Depends on ax-feed.js helpers (axEsc, axAvatarHtml) and mpApi/showToast —
 * load AFTER ax-feed.js.
 */

let _axStoryGroups = [];
let _axStoryGroupIdx = 0;
let _axStoryIdx = 0;
let _axStoryTimer = null;
const AX_STORY_DURATION = 5000; // ms per image story

function axStoryEsc(s) {
  return (typeof axEsc === 'function') ? axEsc(s) : String(s == null ? '' : s);
}

/* ── Tray ─────────────────────────────────────────────────────────── */
async function axLoadStories() {
  const tray = document.getElementById('axStoriesTray');
  if (!tray) return;
  let data = {};
  try { data = await mpApi('/story/list'); } catch (e) { data = {}; }
  _axStoryGroups = (data && data.groups) || [];
  const mine = _axStoryGroups.find(function (g) { return g.is_mine; });
  const others = _axStoryGroups.filter(function (g) { return !g.is_mine; });

  // "Your story" always leads — it doubles as the add button.
  const myCell = '<button type="button" class="ax-story-cell ax-story-mine" onclick="' +
    (mine ? 'axOpenStoryViewer(' + _axStoryGroups.indexOf(mine) + ')' : 'axAddStory()') + '">' +
    '<span class="ax-story-ring' + (mine && mine.has_unseen ? ' unseen' : (mine ? ' seen' : '')) + '">' +
    (mine && mine.stories.length
      ? '<img class="ax-story-thumb" src="' + axStoryEsc(mine.stories[mine.stories.length - 1].media_url) + '" alt="">'
      : '<span class="ax-story-thumb ax-story-thumb-empty"><i class="fa-solid fa-user"></i></span>') +
    '<span class="ax-story-add" onclick="event.stopPropagation();axAddStory()"><i class="fa-solid fa-plus"></i></span>' +
    '</span>' +
    '<span class="ax-story-name">Your story</span></button>';

  const cells = others.map(function (g) {
    const i = _axStoryGroups.indexOf(g);
    const last = g.stories[g.stories.length - 1] || {};
    return '<button type="button" class="ax-story-cell" onclick="axOpenStoryViewer(' + i + ')">' +
      '<span class="ax-story-ring ' + (g.has_unseen ? 'unseen' : 'seen') + '">' +
      (last.media_url
        ? '<img class="ax-story-thumb" src="' + axStoryEsc(last.media_url) + '" alt="">'
        : '<span class="ax-story-thumb ax-story-thumb-empty"><i class="fa-solid fa-user"></i></span>') +
      '</span>' +
      '<span class="ax-story-name">' + axStoryEsc(g.user_name) + '</span></button>';
  }).join('');

  tray.innerHTML = myCell + cells;
  tray.style.display = '';
}

/* ── Add a story ──────────────────────────────────────────────────── */
function axAddStory() {
  let input = document.getElementById('axStoryFileInput');
  if (input) input.remove();
  input = document.createElement('input');
  input.type = 'file';
  input.id = 'axStoryFileInput';
  input.accept = 'image/*,video/mp4,video/webm';
  input.style.display = 'none';
  input.addEventListener('change', function () {
    const f = input.files && input.files[0];
    if (!f) return;
    if (f.size > 5 * 1024 * 1024) { showToast('Max 5MB for a story', 'error'); return; }
    const isVideo = /^video\//.test(f.type);
    const fr = new FileReader();
    fr.onload = function () {
      // Photos go through the rich iframe editor; flattened result lands on Share.
      // Videos skip editing and go straight to the share sheet.
      if (!isVideo && typeof axOpenEditor === 'function') {
        axOpenEditor(fr.result, 'story', function (finalB64, meta) {
          axStoryOpenShare(finalB64, (meta && meta.music) || '');
        });
      } else {
        axStoryOpenShare(fr.result, '');
      }
    };
    fr.readAsDataURL(f);
  });
  document.body.appendChild(input);
  input.click();
}

/* Story audience (Batch 3) — Public / Followers / Selected / Hide-from. */
let _axStoryVis = 'public';
let _axStoryAud = [];
function axStoryPickAudience() {
  if (typeof axOpenAudiencePicker !== 'function') return;
  axOpenAudiencePicker({ visibility: _axStoryVis, audience_subs: _axStoryAud }, function (r) {
    _axStoryVis = r.visibility;
    _axStoryAud = r.audience_subs || [];
    const chip = document.getElementById('axStoryAudChip');
    if (chip) chip.innerHTML = '<i class="fa-solid ' + axAudienceIcon(r.visibility) + '"></i> <span>' + axAudienceLabel(r.visibility) + '</span>';
  });
}

/* Story editor (Batch 10) — full-screen, tab-based editor. Every edit tool
   (Adjust, Filters, Draw, Text, Stickers, Shapes, Music) lives in its own top
   tab; tapping a tab opens that tool's controls in a panel under the stage
   while the stage itself always shows the photo live, with every change
   applied instantly. "Next" moves to a Share screen with the fully composited
   preview, caption, and audience. Everything is baked onto the image via
   canvas at post time (axStoryComposite) so it appears identically for every
   viewer. */
let _axStoryText = '', _axStoryTextColor = '#ffffff', _axStoryTextFont = 'Poppins', _axStoryTextBg = false,
  _axStoryTextSize = 32, _axStoryTextAlign = 'center', _axStoryTextBold = true,
  _axStoryTextPos = { x: 50, y: 80 }, _axStoryMusic = '', _axStoryCrop = false;
let _axStoryMode = 'story'; // 'story' | 'post' — 'post' is driven by the feed composer (ax-feed.js)
let _axStoryDoneCb = null;  // 'post' mode: called with (finalB64OrNull, musicLabel) when the editor closes
let _axStoryFilter = 'none';
let _axStoryRotate = 0; // 0 | 90 | 180 | 270
let _axStoryDrawColor = '#ffffff';
let _axStoryDrawTool = 'pen', _axStoryBrush = 8;
let _axStoryDraws = [];    // [{ color, pts:[{x,y}] }] — percentages of the stage
let _axStoryShapes = [];   // [{ id, type, x, y, color }]
let _axStoryStickers = []; // [{ id, emoji, x, y }]
let _axStoryActiveTab = null; // 'adjust' | 'filter' | 'draw' | 'text' | 'sticker' | 'shape' | 'music' | null
let _axStoryActionStack = []; // undo history: [{type:'draw'|'shape'|'sticker', id}]
let _axStoryObjSeq = 0;
let _axStoryScreen = 'edit'; // 'edit' | 'share'
let _axStoryOrigB64 = '';
let _axStoryFinalB64 = '';
let _axStoryIsVideo = false;
let _axStoryRichEdited = false; // true when image came from axOpenEditor (already flattened)

const AX_STORY_PALETTE = ['#3a3a3a', '#8a8a8a', '#ffffff', '#2f80ff', '#34c759', '#af52de', '#ff9500', '#ff3b30'];
const AX_STORY_FILTERS = {
  none: { label: 'None', css: 'none' },
  pop: { label: 'Pop', css: 'saturate(1.8) contrast(1.15)' },
  bw: { label: 'B&W', css: 'grayscale(1) contrast(1.1)' },
  cool: { label: 'Cool', css: 'contrast(1.05) saturate(1.1) hue-rotate(-6deg) brightness(1.05)' },
  chrome: { label: 'Chrome', css: 'contrast(1.25) saturate(1.3) brightness(0.95)' },
  film: { label: 'Film', css: 'sepia(0.35) contrast(0.9) brightness(1.05) saturate(0.85)' },
};
let _axStoryEmojiCat = 'Smileys';
const AX_STORY_EMOJI_CATS = {
  Smileys: ['😀', '😁', '😂', '🤣', '😊', '😍', '😘', '😎', '🤩', '🥳', '😴', '🤔', '😮', '😢', '😡', '🥰', '😇', '🤗', '😜', '🙄'],
  Hands: ['👍', '👎', '👏', '🙏', '💪', '🤝', '✌️', '🤞', '👌', '🤙', '👋', '🫶', '🤟', '✋'],
  Love: ['❤️', '🧡', '💛', '💚', '💙', '💜', '🖤', '💕', '💞', '💗', '💖', '💘', '💝', '❣️'],
  Nature: ['🌾', '🌱', '🌻', '🌸', '🌼', '🍅', '🥕', '🌶️', '🥬', '🍆', '🌽', '🍎', '🍇', '🥭', '☀️', '🌙', '⭐', '🔥', '💧', '🌈'],
  Misc: ['🎉', '🎊', '✨', '💯', '✅', '❌', '⚡', '🏆', '🎁', '📦', '🚚', '💰', '⏰', '📸', '🎵', '🛒', '🏪', '🧑‍🌾'],
};
const AX_STORY_EMOJIS = AX_STORY_EMOJI_CATS.Smileys;
const AX_STORY_TABS = [
  { key: 'adjust', label: 'Adjust', icon: 'fa-crop-simple' },
  { key: 'filter', label: 'Filters', icon: 'fa-wand-magic-sparkles' },
  { key: 'draw', label: 'Draw', icon: 'fa-pencil' },
  { key: 'text', label: 'Text', icon: null, isTextIcon: true },
  { key: 'sticker', label: 'Stickers', icon: 'fa-face-smile' },
  { key: 'shape', label: 'Shapes', icon: 'fa-shapes' },
  { key: 'music', label: 'Music', icon: 'fa-music' },
];

function axInjectStoryEditorStyles() {
  if (document.getElementById('axStoryEditorCss')) return;
  const style = document.createElement('style');
  style.id = 'axStoryEditorCss';
  style.textContent =
    /* Full-screen shell */
    '.ax-story-editor-overlay{position:fixed;inset:0;z-index:9999;background:#0b0d0c;display:flex;flex-direction:column;color:#fff;font-family:"Plus Jakarta Sans",system-ui,sans-serif}' +
    '.ax-story-editor-top{display:flex;align-items:center;justify-content:space-between;gap:8px;padding:12px 14px;flex:0 0 auto}' +
    '.ax-story-editor-icon-btn{width:38px;height:38px;border-radius:50%;border:none;background:rgba(255,255,255,.08);color:#fff;display:flex;align-items:center;justify-content:center;font-size:16px;cursor:pointer;flex:0 0 auto}' +
    '.ax-story-editor-icon-btn:hover{background:rgba(255,255,255,.16)}' +
    '.ax-story-editor-title{font-size:14px;font-weight:600;color:#e9e9e7;letter-spacing:.2px}' +
    '.ax-story-editor-next{background:var(--c-leaf,#2E6B41);color:#eafff2;border:none;border-radius:20px;padding:9px 18px;font-size:13px;font-weight:700;display:flex;align-items:center;gap:6px;cursor:pointer;flex:0 0 auto;box-shadow:0 2px 10px rgba(46,107,65,.35)}' +
    '.ax-story-editor-next:hover{background:#255939}' +
    /* Tabs */
    '.ax-story-tabs{display:flex;gap:2px;overflow-x:auto;padding:0 10px 10px;flex:0 0 auto;scrollbar-width:none}' +
    '.ax-story-tabs::-webkit-scrollbar{display:none}' +
    '.ax-story-tab{flex:0 0 auto;display:flex;flex-direction:column;align-items:center;gap:4px;background:none;border:none;color:#8b8e8b;padding:6px 14px 9px;font-size:10.5px;font-weight:600;cursor:pointer;border-bottom:2px solid transparent;white-space:nowrap}' +
    '.ax-story-tab i,.ax-story-tab b{font-size:17px;line-height:1;font-style:normal}' +
    '.ax-story-tab.active{color:var(--c-gold,#C7993A);border-bottom-color:var(--c-gold,#C7993A)}' +
    /* Stage */
    '.ax-story-edit-stage{flex:1;position:relative;display:flex;align-items:center;justify-content:center;overflow:hidden;background:#000;min-height:0}' +
    '.ax-story-edit-stage img,.ax-story-edit-stage video{max-width:100%;max-height:100%;object-fit:contain;transition:filter .15s}' +
    /* Contextual bottom panel */
    '.ax-story-panel{flex:0 0 auto;background:#121513;border-top:0.5px solid #23261f;padding:14px 14px 18px;max-height:32vh;overflow-y:auto}' +
    '.ax-story-hint{text-align:center;font-size:11.5px;color:#8b8e8b;margin:8px 0 0}' +
    /* Adjust tab */
    '.ax-story-adjust-row{display:flex;gap:10px;justify-content:center}' +
    '.ax-story-adjust-btn{display:flex;flex-direction:column;align-items:center;gap:6px;background:rgba(255,255,255,.06);border:none;color:#e9e9e7;border-radius:12px;padding:12px 18px;font-size:11px;cursor:pointer;min-width:76px}' +
    '.ax-story-adjust-btn i{font-size:18px}' +
    '.ax-story-adjust-btn.on{background:var(--c-leaf,#2E6B41);color:#eafff2}' +
    '.ax-story-adjust-btn:disabled{opacity:.35;cursor:default}' +
    /* Filters */
    '.ax-story-filter-strip{display:flex;gap:12px;overflow-x:auto;padding:2px}' +
    '.ax-story-filter-item{background:none;border:none;display:flex;flex-direction:column;align-items:center;gap:6px;color:#c7c9c6;font-size:11px;flex:0 0 auto;cursor:pointer}' +
    '.ax-story-filter-thumb{width:52px;height:52px;border-radius:12px;background-size:cover;background-position:center;background-color:#222;border:2px solid transparent;display:block}' +
    '.ax-story-filter-item.on{color:var(--c-gold,#C7993A)}' +
    '.ax-story-filter-item.on .ax-story-filter-thumb{border-color:var(--c-gold,#C7993A)}' +
    /* Draw / text colour picker */
    '.ax-story-palette-row{display:flex;gap:10px;justify-content:center;flex-wrap:wrap;padding:2px 0}' +
    '.ax-story-palette-dot{width:28px;height:28px;border-radius:50%;border:2px solid transparent;cursor:pointer}' +
    '.ax-story-palette-dot.on{border-color:#fff}' +
    /* Text tab */
    '.ax-story-text-opts{display:flex;gap:8px;justify-content:center;margin-top:12px;flex-wrap:wrap}' +
    '.ax-story-text-opt-btn{background:rgba(255,255,255,.08);border:none;color:#fff;border-radius:16px;padding:8px 14px;font-size:12.5px;display:flex;align-items:center;gap:6px;cursor:pointer}' +
    '.ax-story-text-opt-btn.on{background:var(--c-leaf,#2E6B41);color:#eafff2}' +
    '.ax-story-text-opt-btn.danger{color:#ff6b6b}' +
    /* Shapes */
    '.ax-story-shape-grid{display:grid;grid-template-columns:repeat(4,1fr);gap:10px;max-width:280px;margin:0 auto}' +
    '.ax-story-shape-grid button{background:rgba(255,255,255,.06);border:none;color:#fff;border-radius:12px;padding:14px;font-size:18px;cursor:pointer}' +
    /* Stickers */
    '.ax-story-emoji-grid{display:grid;grid-template-columns:repeat(6,1fr);gap:8px;max-height:160px;overflow-y:auto}' +
    '.ax-story-emoji-grid button{background:none;border:none;font-size:24px;cursor:pointer;padding:6px}' +
    /* Music */
    '.ax-story-music-search{display:flex;align-items:center;gap:8px;background:rgba(255,255,255,.06);border-radius:10px;padding:9px 12px;color:#8b8e8b;margin-bottom:8px}' +
    '.ax-story-music-search input{flex:1;background:none;border:none;color:#fff;font-size:13px;outline:none}' +
    '.ax-story-music-list{display:flex;flex-direction:column;gap:2px;max-height:34vh;overflow-y:auto}' +
    '.ax-story-music-item{display:flex;align-items:center;gap:10px;background:none;border:none;color:#e9e9e7;font-size:13px;padding:9px 6px;border-radius:8px;cursor:pointer;text-align:left}' +
    '.ax-story-music-item:hover{background:rgba(255,255,255,.05)}' +
    '.ax-story-music-item.on{color:var(--c-gold,#C7993A)}' +
    '.ax-story-music-item.on i{color:var(--c-gold,#C7993A)}' +
    /* Music indicator in the share panel — sits below the preview, never on top of the photo */
    '.ax-story-music-row{display:flex;align-items:center;gap:8px;background:rgba(46,107,65,.14);color:#eafff2;border-radius:10px;padding:8px 10px;font-size:12.5px;font-weight:600}' +
    '.ax-story-music-row i:first-child{color:var(--c-gold,#C7993A)}' +
    '.ax-story-music-row span{flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}' +
    '.ax-story-music-row button{border:none;background:none;color:rgba(255,255,255,.6);cursor:pointer;font-size:12px;padding:2px}' +
    /* Draw canvas + draggable objects */
    '.ax-story-draw-canvas{position:absolute;inset:0;width:100%;height:100%;touch-action:none;pointer-events:none;z-index:5}' +
    '.ax-story-obj-layer{position:absolute;inset:0;pointer-events:none;z-index:6}' +
    '.ax-story-obj{position:absolute;transform:translate(-50%,-50%);pointer-events:auto;cursor:grab;touch-action:none}' +
    '.ax-story-obj-emoji{font-size:40px;line-height:1}' +
    '.ax-story-obj-del{position:absolute;top:-8px;right:-8px;width:18px;height:18px;border-radius:50%;background:#e1435a;color:#fff;font-size:12px;display:flex;align-items:center;justify-content:center;line-height:1}' +
    '.ax-story-text-layer{position:absolute;font-size:22px;font-weight:800;color:#fff;text-shadow:0 1px 4px rgba(0,0,0,.55);cursor:grab;touch-action:none;max-width:88%;text-align:center;z-index:7}' +
    /* Share screen */
    '.ax-story-share-stage{flex:1;position:relative;background:#000;display:flex;align-items:center;justify-content:center;overflow:hidden;min-height:0}' +
    '.ax-story-share-stage img,.ax-story-share-stage video{max-width:100%;max-height:100%;object-fit:contain}' +
    '.ax-story-share-panel{display:flex;flex-direction:column;gap:12px;max-height:46vh}' +
    '.ax-story-field-label{font-size:11.5px;color:#8b8e8b;display:flex;align-items:center;gap:6px;text-transform:uppercase;letter-spacing:.4px}' +
    '.ax-story-caption-input{background:rgba(255,255,255,.06);border:none;border-radius:10px;padding:10px 12px;color:#fff;font-size:13.5px;outline:none}' +
    '.ax-privacy-row{display:flex;align-items:center;justify-content:space-between;gap:10px}' +
    '.ax-privacy-label{font-size:13px;color:#c7c9c6;display:flex;align-items:center;gap:8px}' +
    '.ax-aud-chip{background:rgba(255,255,255,.08);border:none;color:#fff;border-radius:16px;padding:7px 14px;font-size:12.5px;display:flex;align-items:center;gap:6px;cursor:pointer}' +
    '.ax-story-share-btn{background:var(--c-leaf,#2E6B41);color:#eafff2;border:none;border-radius:12px;padding:13px;font-size:14px;font-weight:700;display:flex;align-items:center;justify-content:center;gap:8px;cursor:pointer;box-shadow:0 4px 14px rgba(46,107,65,.35)}' +
    '.ax-story-share-btn:hover{background:#255939}' +
    '.ax-story-share-btn:disabled{opacity:.5;cursor:default}' +
    '.ax-radius-note{text-align:center;font-size:11px;color:#71736f;margin:2px 0 0}';
  document.head.appendChild(style);
}

/* A searchable catalogue of track/mood names (WhatsApp-style picker). We
   don't stream copyrighted audio — the chosen name is stored as the story's
   music label — but the picker looks and searches like an online library. */
const AX_STORY_MUSIC = [
  'Chill Vibes', 'Festive Dhol', 'Upbeat Pop', 'Calm Acoustic', 'Bollywood Hits',
  'Punjabi Beat', 'Lo-fi Study', 'Romantic', 'Sad Piano', 'Party Anthem',
  'Devotional Bhajan', 'Classical Sitar', 'Rap / Hip-hop', 'EDM Drop', 'Folk Rajasthani',
  'Garba Night', 'Sufi Soul', 'Motivational', 'Wedding Band', 'Retro 90s',
  'Haryanvi Desi', 'Tamil Kuthu', 'Ghazal', 'Instrumental Flute', 'Bhangra'
];
function axStoryMusicListHtml(query) {
  var q = (query || '').trim().toLowerCase();
  var rows = '<button type="button" class="ax-story-music-item' + (_axStoryMusic ? '' : ' on') +
    '" data-music="" onclick="axStorySetMusic(this)"><i class="fa-solid fa-ban"></i> No music</button>';
  AX_STORY_MUSIC.filter(function (m) { return !q || m.toLowerCase().indexOf(q) !== -1; })
    .forEach(function (m) {
      rows += '<button type="button" class="ax-story-music-item' + (_axStoryMusic === m ? ' on' : '') +
        '" data-music="' + axStoryEsc(m) + '" onclick="axStorySetMusic(this)">' +
        '<i class="fa-solid fa-music"></i> <span>' + axStoryEsc(m) + '</span></button>';
    });
  return rows;
}
function axStoryFilterMusic(q) {
  var list = document.getElementById('axStoryMusicList');
  if (list) list.innerHTML = axStoryMusicListHtml(q);
}
function axStoryMusicPanelHtml() {
  return '<div class="ax-story-music-search"><i class="fa-solid fa-magnifying-glass"></i>' +
    '<input type="text" id="axStoryMusicSearch" placeholder="Search music…" autocomplete="off" oninput="axStoryFilterMusic(this.value)"></div>' +
    '<div class="ax-story-music-list" id="axStoryMusicList">' + axStoryMusicListHtml('') + '</div>' +
    '<p class="ax-story-hint">Tap a track to preview it — it plays with your story too</p>';
}
function axStorySetMusic(btn) {
  _axStoryMusic = btn.dataset.music || '';
  document.querySelectorAll('.ax-story-music-item').forEach(function (b) { b.classList.toggle('on', b === btn); });
  if (_axStoryMusic) axStoryPlayMusic(_axStoryMusic); else axStoryStopMusic();
}

/* ── Music playback engine ───────────────────────────────────────────
 * The catalogue above is a mood/name picker, not a licensed audio library —
 * so there is nothing to actually stream. Instead we synthesize a soft,
 * looping ambient bed with the Web Audio API, keyed off the chosen track's
 * mood, so picking a track (in the editor, on the share screen, or in the
 * viewer) is always audible with no network request and no copyright risk. */
let _axMusicCtx = null;
let _axMusicNodes = null;
let _axMusicTimer = null;
let _axMusicCurrent = '';
const AX_MUSIC_MOODS = {
  calm: { root: 220, notes: [0, 5, 7, 12], step: 1500, wave: 'sine' },
  sad: { root: 196, notes: [0, 3, 7, 10], step: 1700, wave: 'sine' },
  upbeat: { root: 262, notes: [0, 4, 7, 11], step: 380, wave: 'triangle' },
  devo: { root: 246, notes: [0, 2, 7, 9], step: 950, wave: 'sine' },
};
function axMusicMoodFor(name) {
  const n = (name || '').toLowerCase();
  if (/party|edm|beat|dhol|bhangra|kuthu|desi|garba|rap|hip/.test(n)) return AX_MUSIC_MOODS.upbeat;
  if (/sad|ghazal/.test(n)) return AX_MUSIC_MOODS.sad;
  if (/bhajan|sufi|classical|devot|sitar/.test(n)) return AX_MUSIC_MOODS.devo;
  return AX_MUSIC_MOODS.calm;
}
function axMusicCtx() {
  if (!_axMusicCtx) {
    try { _axMusicCtx = new (window.AudioContext || window.webkitAudioContext)(); }
    catch (e) { return null; }
  }
  return _axMusicCtx;
}
function axStoryStopMusic() {
  clearTimeout(_axMusicTimer);
  _axMusicCurrent = '';
  const nodes = _axMusicNodes;
  _axMusicNodes = null;
  if (nodes && _axMusicCtx) {
    try {
      nodes.gain.gain.cancelScheduledValues(_axMusicCtx.currentTime);
      nodes.gain.gain.linearRampToValueAtTime(0, _axMusicCtx.currentTime + 0.15);
    } catch (e) { }
    setTimeout(function () { try { nodes.osc1.stop(); nodes.osc2.stop(); } catch (e) { } }, 200);
  }
}
function axStoryPlayMusic(name) {
  if (!name) { axStoryStopMusic(); return; }
  if (name === _axMusicCurrent && _axMusicNodes) return; // already playing this track
  axStoryStopMusic();
  const ctx = axMusicCtx();
  if (!ctx) return;
  if (ctx.state === 'suspended') ctx.resume();
  _axMusicCurrent = name;
  const mood = axMusicMoodFor(name);

  const gain = ctx.createGain();
  gain.gain.value = 0;
  gain.connect(ctx.destination);
  gain.gain.linearRampToValueAtTime(0.05, ctx.currentTime + 0.4);

  const osc1 = ctx.createOscillator();
  const osc2 = ctx.createOscillator();
  osc1.type = mood.wave; osc2.type = mood.wave;
  osc1.connect(gain); osc2.connect(gain);
  osc1.start(); osc2.start();
  _axMusicNodes = { gain: gain, osc1: osc1, osc2: osc2 };

  let step = 0;
  (function tick() {
    if (!_axMusicNodes) return;
    const semis = mood.notes[step % mood.notes.length];
    const freq = mood.root * Math.pow(2, semis / 12);
    const t = ctx.currentTime;
    osc1.frequency.setTargetAtTime(freq, t, 0.08);
    osc2.frequency.setTargetAtTime(freq * 1.005, t, 0.08); // slight detune for warmth
    step++;
    _axMusicTimer = setTimeout(tick, mood.step);
  })();
}
function axStoryPauseMusic() { if (_axMusicCtx && _axMusicCtx.state === 'running') _axMusicCtx.suspend(); }
function axStoryResumeMusic() { if (_axMusicCtx && _axMusicCtx.state === 'suspended' && _axMusicNodes) _axMusicCtx.resume(); }

/* ── Entry point after rich editor (or video pick): open Share screen ── */
function axStoryConfirm(b64, music) {
  axStoryOpenShare(b64, music || '');
}

/* Open the caption/audience Share screen with an already-flattened image
 * from story-editor.html (via axOpenEditor). Edit tools stay in the iframe
 * editor; this screen only handles caption, audience, and post. */
function axStoryOpenShare(b64, music) {
  axInjectStoryEditorStyles();
  axStoryStopMusic();
  _axStoryMode = 'story';
  _axStoryDoneCb = null;
  _axStoryVis = 'public'; _axStoryAud = [];
  _axStoryText = ''; _axStoryTextColor = '#ffffff'; _axStoryTextFont = 'sans'; _axStoryTextBg = false;
  _axStoryTextPos = { x: 50, y: 80 }; _axStoryMusic = music || ''; _axStoryCrop = false;
  _axStoryFilter = 'none'; _axStoryRotate = 0; _axStoryDrawColor = '#ffffff';
  _axStoryDraws = []; _axStoryShapes = []; _axStoryStickers = []; _axStoryActiveTab = null;
  _axStoryActionStack = []; _axStoryObjSeq = 0;
  _axStoryScreen = 'share';
  _axStoryOrigB64 = b64;
  _axStoryFinalB64 = b64;
  _axStoryIsVideo = /^data:video/.test(b64);
  _axStoryRichEdited = !_axStoryIsVideo; // image already baked by rich editor

  let modal = document.getElementById('axStoryComposer');
  if (modal) modal.remove();
  modal = document.createElement('div');
  modal.id = 'axStoryComposer';
  modal.className = 'ax-story-editor-overlay';
  document.body.appendChild(modal);
  document.body.style.overflow = 'hidden';
  axStoryRenderComposer();
}

/* Generic entry point — used by the story flow above AND by the feed post
 * composer (ax-feed.js calls this directly; both files share this one editor
 * so "story-style" editing — filters, text, stickers, draw, shapes, music —
 * looks and behaves identically everywhere in the app).
 * opts.mode: 'story' (default) goes on to the Share-to-story screen;
 *            'post' calls onDone(finalB64, musicLabel) and hands control
 *            straight back to the caller (the feed composer keeps its own
 *            caption/audience UI, so it doesn't need a share screen).
 * onDone (post mode only): called with (null, '') if the user cancels/discards. */
function axMediaEditOpen(b64, isVideo, opts, onDone) {
  opts = opts || {};
  axInjectStoryEditorStyles();
  axStoryStopMusic();
  _axStoryMode = opts.mode === 'post' ? 'post' : 'story';
  _axStoryDoneCb = (typeof onDone === 'function') ? onDone : null;
  _axStoryVis = 'public'; _axStoryAud = [];
  _axStoryText = ''; _axStoryTextColor = '#ffffff'; _axStoryTextFont = 'sans'; _axStoryTextBg = false;
  _axStoryTextPos = { x: 50, y: 80 }; _axStoryMusic = ''; _axStoryCrop = false;
  _axStoryFilter = 'none'; _axStoryRotate = 0; _axStoryDrawColor = '#ffffff';
  _axStoryDraws = []; _axStoryShapes = []; _axStoryStickers = []; _axStoryActiveTab = null;
  _axStoryActionStack = []; _axStoryObjSeq = 0;
  _axStoryScreen = 'edit'; _axStoryOrigB64 = b64; _axStoryFinalB64 = b64;
  _axStoryIsVideo = !!isVideo;
  _axStoryRichEdited = false;

  let modal = document.getElementById('axStoryComposer');
  if (modal) modal.remove();
  modal = document.createElement('div');
  modal.id = 'axStoryComposer';
  modal.className = 'ax-story-editor-overlay';
  document.body.appendChild(modal);
  document.body.style.overflow = 'hidden';
  axStoryRenderComposer();
}
window.axMediaEditOpen = axMediaEditOpen;

function axStoryRenderComposer() {
  const modal = document.getElementById('axStoryComposer');
  if (!modal) return;
  if (_axStoryScreen === 'share') { axStoryRenderShareScreen(modal); return; }

  const b64 = _axStoryOrigB64, isVideo = _axStoryIsVideo;
  modal.innerHTML =
    '<div class="ax-story-editor-top">' +
    '<button type="button" class="ax-story-editor-icon-btn" onclick="axStoryCloseComposer()" aria-label="Close"><i class="fa-solid fa-xmark"></i></button>' +
    '<span class="ax-story-editor-title">' + (_axStoryMode === 'post' ? 'Edit photo' : 'Edit story') + '</span>' +
    '<button type="button" class="ax-story-editor-next" onclick="axStoryGoNext()">' + (_axStoryMode === 'post' ? 'Done' : 'Next') + ' <i class="fa-solid fa-arrow-right"></i></button>' +
    '</div>' +
    (isVideo ? '' : '<div class="ax-story-tabs" id="axStoryTabs">' + AX_STORY_TABS.map(axStoryTabBtnHtml).join('') + '</div>') +
    '<div class="ax-story-edit-stage" id="axStoryStage">' +
    (isVideo ? '<video src="' + b64 + '" controls playsinline></video>' : '<img id="axStoryStageImg" src="' + b64 + '" alt="">') +
    '<div class="ax-story-text-layer" id="axStoryTextLayer" style="display:none;left:50%;top:80%;transform:translate(-50%,-50%)"></div>' +
    '</div>' +
    (isVideo ? '' : '<div class="ax-story-panel" id="axStoryPanel" style="display:none"></div>');

  axStoryInitDrag();
  axStoryBindHoldOriginal();
  if (!isVideo) {
    axStoryReapplyState();
    axStoryRenderStageObjects();
    if (_axStoryActiveTab) {
      document.querySelectorAll('.ax-story-tab').forEach(function (b) { b.classList.toggle('active', b.dataset.tab === _axStoryActiveTab); });
      axStorySetDrawMode(_axStoryActiveTab === 'draw');
      axStoryRenderPanel();
    }
  }
}

function axStoryGoNext() {
  if (_axStoryMode === 'post') { axStoryFinishPostEdit(); return; }
  axStoryGoShare();
}
async function axStoryFinishPostEdit() {
  let finalB64 = _axStoryOrigB64;
  if (!_axStoryIsVideo) {
    try { finalB64 = axStoryHasEdits() ? await axStoryComposite(_axStoryOrigB64) : _axStoryOrigB64; }
    catch (e) { finalB64 = _axStoryOrigB64; }
  }
  const music = _axStoryMusic;
  axStoryStopMusic();
  document.body.style.overflow = '';
  document.getElementById('axStoryComposer')?.remove();
  const cb = _axStoryDoneCb; _axStoryDoneCb = null;
  if (cb) cb(finalB64, music);
}
function axStoryCloseComposer() {
  const msg = _axStoryMode === 'post' ? 'Discard this photo\'s edits?' : 'Discard this story and its edits?';
  if (axStoryHasEdits() && !confirm(msg)) return;
  axStoryStopMusic();
  document.body.style.overflow = '';
  document.getElementById('axStoryComposer')?.remove();
  if (_axStoryMode === 'post') { const cb = _axStoryDoneCb; _axStoryDoneCb = null; if (cb) cb(null, ''); }
}

/* Re-apply rotate/filter/crop/text visuals after the stage DOM is rebuilt
   (happens whenever we come back from the Share screen). */
function axStoryReapplyState() {
  const img = document.getElementById('axStoryStageImg');
  if (img) {
    img.style.transform = _axStoryRotate ? 'rotate(' + _axStoryRotate + 'deg)' : '';
    const f = AX_STORY_FILTERS[_axStoryFilter];
    img.style.filter = (f && f.css !== 'none') ? f.css : '';
    img.style.aspectRatio = _axStoryCrop ? '9 / 16' : '';
    img.style.objectFit = _axStoryCrop ? 'cover' : '';
  }
  const stage = document.getElementById('axStoryStage');
  if (stage) {
    stage.style.aspectRatio = _axStoryCrop ? '9 / 16' : '';
    stage.style.maxWidth = _axStoryCrop ? 'none' : '';
    stage.style.width = _axStoryCrop ? 'auto' : '';
    stage.style.margin = _axStoryCrop ? '0 auto' : '';
  }
  const layer = document.getElementById('axStoryTextLayer');
  if (layer && _axStoryText) {
    layer.style.display = '';
    layer.textContent = _axStoryText;
    layer.style.color = _axStoryTextColor;
    layer.style.left = _axStoryTextPos.x + '%';
    layer.style.top = _axStoryTextPos.y + '%';
    layer.style.fontFamily = (_axStoryTextFont === 'serif') ? 'Georgia, serif' : '"Plus Jakarta Sans", system-ui, sans-serif';
    layer.style.background = _axStoryTextBg ? 'rgba(0,0,0,.45)' : 'transparent';
    layer.style.padding = _axStoryTextBg ? '4px 10px' : '0';
    layer.style.borderRadius = _axStoryTextBg ? '6px' : '0';
  }
}

/* ── Tabs: each opens its own panel below the stage ──────────────────── */
function axStoryTabBtnHtml(tab) {
  const inner = tab.isTextIcon ? '<b>Aa</b>' : '<i class="fa-solid ' + tab.icon + '"></i>';
  return '<button type="button" class="ax-story-tab' + (_axStoryActiveTab === tab.key ? ' active' : '') +
    '" data-tab="' + tab.key + '" onclick="axStorySelectTab(\'' + tab.key + '\')">' + inner + '<span>' + tab.label + '</span></button>';
}
function axStorySelectTab(key) {
  _axStoryActiveTab = (_axStoryActiveTab === key) ? null : key;
  document.querySelectorAll('.ax-story-tab').forEach(function (b) {
    b.classList.toggle('active', b.dataset.tab === _axStoryActiveTab);
  });
  axStorySetDrawMode(_axStoryActiveTab === 'draw');
  if (_axStoryActiveTab === 'text') axStoryAddText();
  axStoryRenderPanel();
}
function axStoryRenderPanel() {
  const panel = document.getElementById('axStoryPanel');
  if (!panel) return;
  if (!_axStoryActiveTab) { panel.innerHTML = ''; panel.style.display = 'none'; return; }
  panel.style.display = '';
  if (_axStoryActiveTab === 'adjust') panel.innerHTML = axStoryAdjustPanelHtml();
  else if (_axStoryActiveTab === 'filter') panel.innerHTML = axStoryFilterPanelHtml();
  else if (_axStoryActiveTab === 'draw') panel.innerHTML = axStoryPaletteRowHtml('draw') + '<p class="ax-story-hint">Draw directly on the photo with your finger or mouse</p>';
  else if (_axStoryActiveTab === 'text') panel.innerHTML = axStoryTextPanelHtml();
  else if (_axStoryActiveTab === 'sticker') panel.innerHTML = axStoryEmojiPanelHtml();
  else if (_axStoryActiveTab === 'shape') panel.innerHTML = axStoryShapePanelHtml();
  else if (_axStoryActiveTab === 'music') panel.innerHTML = axStoryMusicPanelHtml();
}

/* Adjust — rotate, 9:16 crop toggle, and undo, all in one place. */
function axStoryAdjustPanelHtml() {
  return '<div class="ax-story-adjust-row">' +
    '<button type="button" class="ax-story-adjust-btn" onclick="axStoryRotateStage()"><i class="fa-solid fa-arrow-rotate-right"></i><span>Rotate</span></button>' +
    '<button type="button" class="ax-story-adjust-btn' + (_axStoryCrop ? ' on' : '') + '" onclick="axStoryToggleCrop()"><i class="fa-solid fa-crop-simple"></i><span>' + (_axStoryCrop ? '9:16 on' : 'Crop 9:16') + '</span></button>' +
    '<button type="button" class="ax-story-adjust-btn" onclick="axStoryUndo()"' + (_axStoryActionStack.length ? '' : ' disabled') + '><i class="fa-solid fa-rotate-left"></i><span>Undo</span></button>' +
    '</div><p class="ax-story-hint">Rotate turns the photo 90°, crop frames it for stories</p>';
}
function axStoryRotateStage() {
  _axStoryRotate = (_axStoryRotate + 90) % 360;
  const img = document.getElementById('axStoryStageImg');
  if (img) img.style.transform = 'rotate(' + _axStoryRotate + 'deg)';
}
function axStoryToggleCrop() {
  _axStoryCrop = !_axStoryCrop;
  const stage = document.getElementById('axStoryStage');
  const img = document.getElementById('axStoryStageImg');
  if (img) { img.style.aspectRatio = _axStoryCrop ? '9 / 16' : ''; img.style.objectFit = _axStoryCrop ? 'cover' : ''; }
  if (stage) {
    stage.style.aspectRatio = _axStoryCrop ? '9 / 16' : '';
    stage.style.width = _axStoryCrop ? 'auto' : '';
    stage.style.margin = _axStoryCrop ? '0 auto' : '';
  }
  axStoryRenderPanel();
}
function axStoryUndo() {
  const last = _axStoryActionStack.pop();
  if (!last) return;
  if (last.type === 'draw') { _axStoryDraws.pop(); axStoryRedrawDraws(); }
  else if (last.type === 'shape') { _axStoryShapes = _axStoryShapes.filter(function (s) { return s.id !== last.id; }); axStoryRenderStageObjects(); }
  else if (last.type === 'sticker') { _axStoryStickers = _axStoryStickers.filter(function (s) { return s.id !== last.id; }); axStoryRenderStageObjects(); }
  axStoryRenderPanel();
}

/* Filters — shown as thumbnails of the actual photo with the CSS filter
   applied live; the same filter string is re-applied on the canvas via
   ctx.filter when the story is baked (axStoryComposite). */
function axStoryFilterPanelHtml() {
  const img = document.getElementById('axStoryStageImg');
  const src = img ? img.getAttribute('src') : '';
  return '<div class="ax-story-filter-strip">' + Object.keys(AX_STORY_FILTERS).map(function (key) {
    const f = AX_STORY_FILTERS[key];
    return '<button type="button" class="ax-story-filter-item' + (_axStoryFilter === key ? ' on' : '') + '" onclick="axStorySetFilter(\'' + key + '\')">' +
      '<span class="ax-story-filter-thumb" style="' + (src ? "background-image:url('" + src + "');" : '') + 'filter:' + f.css + '"></span>' +
      '<small>' + f.label + '</small></button>';
  }).join('') + '</div>';
}
function axStorySetFilter(key) {
  _axStoryFilter = key;
  const img = document.getElementById('axStoryStageImg');
  if (img) img.style.filter = (AX_STORY_FILTERS[key].css === 'none') ? '' : AX_STORY_FILTERS[key].css;
  axStoryRenderPanel();
}

/* Shared colour palette (used by both draw and text tools). */
function axStoryPaletteRowHtml(kind) {
  const current = kind === 'draw' ? _axStoryDrawColor : _axStoryTextColor;
  return '<div class="ax-story-palette-row">' + AX_STORY_PALETTE.map(function (c) {
    return '<button type="button" class="ax-story-palette-dot' + (current === c ? ' on' : '') +
      '" style="background:' + c + '" onclick="axStoryPickColor(\'' + kind + '\',\'' + c + '\')" aria-label="colour"></button>';
  }).join('') + '</div>';
}
function axStoryPickColor(kind, hex) {
  if (kind === 'draw') { _axStoryDrawColor = hex; }
  else {
    _axStoryTextColor = hex;
    const layer = document.getElementById('axStoryTextLayer');
    if (layer) layer.style.color = hex;
  }
  axStoryRenderPanel();
}

/* Text — tapping the tab prompts for text, then this panel lets the
   person pick colour, font, background pill and clear it. */
function axStoryAddText() {
  const layer = document.getElementById('axStoryTextLayer');
  if (!layer) return;
  /* Inline on-canvas editing (WhatsApp / prototype style) — no native
     prompt box. Tap Text → caret appears on the photo; type directly;
     Enter or tapping away commits. Shift+Enter = new line. */
  layer.style.display = '';
  layer.style.color = _axStoryTextColor;
  layer.style.minWidth = '30px';
  layer.setAttribute('contenteditable', 'true');
  layer.setAttribute('data-editing', '1');
  layer.focus();
  try {
    const range = document.createRange(); range.selectNodeContents(layer);
    const sel = window.getSelection(); sel.removeAllRanges(); sel.addRange(range);
  } catch (e) { }
  const onKey = function (e) {
    if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); layer.blur(); }
  };
  const finish = function () {
    layer.removeAttribute('contenteditable');
    layer.removeAttribute('data-editing');
    _axStoryText = String(layer.textContent || '').replace(/ /g, ' ').slice(0, 120);
    layer.textContent = _axStoryText;
    if (!_axStoryText) { layer.style.display = 'none'; }
    layer.removeEventListener('blur', finish);
    layer.removeEventListener('keydown', onKey);
    axStoryRenderPanel();
  };
  layer.addEventListener('keydown', onKey);
  layer.addEventListener('blur', finish);
}
function axStoryTextPanelHtml() {
  return '<div class="ax-story-text-panel">' + axStoryPaletteRowHtml('text') +
    '<div class="ax-story-text-opts">' +
    '<button type="button" class="ax-story-text-opt-btn' + (_axStoryTextBg ? ' on' : '') + '" onclick="axStoryToggleTextBg()"><i class="fa-solid fa-highlighter"></i> Background</button>' +
    '<button type="button" class="ax-story-text-opt-btn" onclick="axStoryCycleFont()"><b>Aa</b> ' + (_axStoryTextFont === 'serif' ? 'Serif' : 'Sans Serif') + '</button>' +
    '<button type="button" class="ax-story-text-opt-btn" onclick="axStoryAddText()"><i class="fa-solid fa-pen"></i> Edit</button>' +
    '<button type="button" class="ax-story-text-opt-btn danger" onclick="axStoryClearText()"><i class="fa-regular fa-trash-can"></i> Clear</button>' +
    '</div></div>';
}
function axStoryToggleTextBg() {
  _axStoryTextBg = !_axStoryTextBg;
  const layer = document.getElementById('axStoryTextLayer');
  if (layer) {
    layer.style.background = _axStoryTextBg ? 'rgba(0,0,0,.45)' : 'transparent';
    layer.style.padding = _axStoryTextBg ? '4px 10px' : '0';
    layer.style.borderRadius = _axStoryTextBg ? '6px' : '0';
  }
  axStoryRenderPanel();
}
function axStoryCycleFont() {
  _axStoryTextFont = (_axStoryTextFont === 'serif') ? 'sans' : 'serif';
  const layer = document.getElementById('axStoryTextLayer');
  if (layer) layer.style.fontFamily = (_axStoryTextFont === 'serif') ? 'Georgia, serif' : '"Plus Jakarta Sans", system-ui, sans-serif';
  axStoryRenderPanel();
}
function axStoryClearText() {
  _axStoryText = '';
  const layer = document.getElementById('axStoryTextLayer');
  if (layer) { layer.style.display = 'none'; layer.textContent = ''; }
  _axStoryActiveTab = null;
  document.querySelectorAll('.ax-story-tab').forEach(function (b) { b.classList.remove('active'); });
  axStoryRenderPanel();
}

/* Shapes — square / circle / line / arrow, dropped centre-stage and then
   draggable like text; tap the × badge to remove. */
const AX_STORY_SHAPE_TYPES = ['square', 'circle', 'triangle', 'line', 'arrow', 'star', 'heart', 'hexagon', 'bubble'];
function axStoryShapePanelHtml() {
  return '<div class="ax-story-shape-grid">' + AX_STORY_SHAPE_TYPES.map(function (t) {
    return '<button type="button" onclick="axStoryAddShape(\'' + t + '\')" aria-label="' + t + '">' +
      axStoryShapeSvg(t, '#3EB489').replace('width="60" height="60"', 'width="30" height="30"') + '</button>';
  }).join('') + '</div>';
}
function axStoryShapeSvg(type, color) {
  const o = '<svg viewBox="0 0 60 60" width="60" height="60">';
  if (type === 'square') return o + '<rect x="6" y="6" width="48" height="48" rx="6" fill="none" stroke="' + color + '" stroke-width="4"/></svg>';
  if (type === 'circle') return o + '<circle cx="30" cy="30" r="24" fill="none" stroke="' + color + '" stroke-width="4"/></svg>';
  if (type === 'triangle') return o + '<polygon points="30,8 54,52 6,52" fill="none" stroke="' + color + '" stroke-width="4" stroke-linejoin="round"/></svg>';
  if (type === 'line') return o + '<line x1="8" y1="52" x2="52" y2="8" stroke="' + color + '" stroke-width="4" stroke-linecap="round"/></svg>';
  if (type === 'arrow') return o + '<line x1="8" y1="52" x2="46" y2="14" stroke="' + color + '" stroke-width="4" stroke-linecap="round"/><polygon points="46,14 34,18 42,26" fill="' + color + '"/></svg>';
  if (type === 'star') return o + '<polygon points="30,6 37,23 55,23 40,34 46,52 30,41 14,52 20,34 5,23 23,23" fill="none" stroke="' + color + '" stroke-width="3.5" stroke-linejoin="round"/></svg>';
  if (type === 'heart') return o + '<path d="M30 52 L11 33 A11 11 0 0 1 30 18 A11 11 0 0 1 49 33 Z" fill="none" stroke="' + color + '" stroke-width="4" stroke-linejoin="round"/></svg>';
  if (type === 'hexagon') return o + '<polygon points="30,6 52,18 52,42 30,54 8,42 8,18" fill="none" stroke="' + color + '" stroke-width="4" stroke-linejoin="round"/></svg>';
  if (type === 'bubble') return o + '<path d="M52 38 a6 6 0 0 1-6 6 H22 L10 54 V16 a6 6 0 0 1 6-6 h30 a6 6 0 0 1 6 6 Z" fill="none" stroke="' + color + '" stroke-width="4" stroke-linejoin="round"/></svg>';
  return o + '<rect x="6" y="6" width="48" height="48" rx="6" fill="none" stroke="' + color + '" stroke-width="4"/></svg>';
}
function axStoryAddShape(type) {
  const id = 'shp' + (++_axStoryObjSeq);
  _axStoryShapes.push({ id: id, type: type, x: 50, y: 50, color: _axStoryDrawColor, scale: 1, rot: 0 });
  _axStoryActionStack.push({ type: 'shape', id: id });
  axStoryRenderStageObjects();
  axStoryRenderPanel();
}

/* Stickers / emoji — category chips + a grid; tap to drop onto the photo. */
function axStoryEmojiPanelHtml() {
  const cats = Object.keys(AX_STORY_EMOJI_CATS);
  if (!AX_STORY_EMOJI_CATS[_axStoryEmojiCat]) _axStoryEmojiCat = cats[0];
  const chips = '<div class="ax-story-emoji-cats">' + cats.map(function (c) {
    return '<button type="button" class="ax-story-emoji-cat' + (c === _axStoryEmojiCat ? ' on' : '') +
      '" onclick="axStoryPickEmojiCat(\'' + c + '\')">' + c + '</button>';
  }).join('') + '</div>';
  const grid = '<div class="ax-story-emoji-grid">' + AX_STORY_EMOJI_CATS[_axStoryEmojiCat].map(function (e) {
    return '<button type="button" onclick="axStoryAddSticker(\'' + e + '\')">' + e + '</button>';
  }).join('') + '</div>';
  return chips + grid;
}
function axStoryPickEmojiCat(cat) { _axStoryEmojiCat = cat; axStoryRenderPanel(); }
function axStoryAddSticker(emoji) {
  const id = 'stk' + (++_axStoryObjSeq);
  _axStoryStickers.push({ id: id, emoji: emoji, x: 50, y: 50, scale: 1, rot: 0 });
  _axStoryActionStack.push({ type: 'sticker', id: id });
  axStoryRenderStageObjects();
  axStoryRenderPanel();
}

/* Render + drag for shape/sticker objects sitting on the stage. */
function axStoryRenderStageObjects() {
  const stage = document.getElementById('axStoryStage');
  if (!stage) return;
  let layer = document.getElementById('axStoryObjLayer');
  if (!layer) { layer = document.createElement('div'); layer.id = 'axStoryObjLayer'; layer.className = 'ax-story-obj-layer'; stage.appendChild(layer); }
  const handles =
    '<span class="ax-story-obj-del" data-role="del" aria-label="Remove">&times;</span>' +
    '<span class="ax-story-obj-rot" data-role="rot" aria-label="Rotate"><i class="fa-solid fa-rotate"></i></span>' +
    '<span class="ax-story-obj-scale" data-role="scale" aria-label="Resize"></span>';
  const shapeHtml = _axStoryShapes.map(function (s) {
    const sz = Math.round(60 * (s.scale || 1));
    const svg = axStoryShapeSvg(s.type, s.color).replace('width="60" height="60"', 'width="' + sz + '" height="' + sz + '"');
    return '<div class="ax-story-obj" data-id="' + s.id + '" data-kind="shape" style="left:' + s.x + '%;top:' + s.y + '%;transform:translate(-50%,-50%) rotate(' + (s.rot || 0) + 'deg)">' +
      svg + handles + '</div>';
  }).join('');
  const stickerHtml = _axStoryStickers.map(function (s) {
    return '<div class="ax-story-obj ax-story-obj-emoji" data-id="' + s.id + '" data-kind="sticker" style="left:' + s.x + '%;top:' + s.y + '%;transform:translate(-50%,-50%) rotate(' + (s.rot || 0) + 'deg)">' +
      '<span class="ax-story-obj-glyph" style="font-size:' + Math.round(40 * (s.scale || 1)) + 'px">' + s.emoji + '</span>' + handles + '</div>';
  }).join('');
  layer.innerHTML = shapeHtml + stickerHtml;
  layer.querySelectorAll('.ax-story-obj').forEach(axStoryMakeObjInteractive);
}
function axStoryRemoveObj(kind, id) {
  if (kind === 'shape') _axStoryShapes = _axStoryShapes.filter(function (s) { return s.id !== id; });
  else _axStoryStickers = _axStoryStickers.filter(function (s) { return s.id !== id; });
  axStoryRenderStageObjects();
}
/* Drag + resize + rotate for a stage object (shape / sticker). Handles:
   body = move, bottom-right dot = scale, top gold dot = rotate, × = delete.
   Uses pointer-capture on the element so we don't leak window listeners. */
function axStoryMakeObjInteractive(el) {
  const stage = document.getElementById('axStoryStage');
  const objArr = function () { return el.dataset.kind === 'shape' ? _axStoryShapes : _axStoryStickers; };
  const getObj = function () { return objArr().find(function (o) { return o.id === el.dataset.id; }); };
  let mode = null, startAng = 0, startRot = 0, startDist = 0, startScale = 1;
  function centre() {
    const r = stage.getBoundingClientRect(); const o = getObj() || { x: 50, y: 50 };
    return { x: r.left + (o.x / 100) * r.width, y: r.top + (o.y / 100) * r.height, r: r };
  }
  el.addEventListener('pointerdown', function (e) {
    const role = e.target.getAttribute && e.target.getAttribute('data-role');
    if (role === 'del') { axStoryRemoveObj(el.dataset.kind, el.dataset.id); return; }
    e.stopPropagation(); e.preventDefault();
    const o = getObj(); if (!o) return;
    const c = centre();
    if (role === 'rot') { mode = 'rot'; startAng = Math.atan2(e.clientY - c.y, e.clientX - c.x); startRot = o.rot || 0; }
    else if (role === 'scale') { mode = 'scale'; startDist = Math.hypot(e.clientX - c.x, e.clientY - c.y) || 1; startScale = o.scale || 1; }
    else { mode = 'drag'; }
    try { el.setPointerCapture(e.pointerId); } catch (x) { }
  });
  el.addEventListener('pointermove', function (e) {
    if (!mode) return;
    const o = getObj(); if (!o) return;
    const c = centre();
    if (mode === 'drag') {
      o.x = Math.max(4, Math.min(96, ((e.clientX - c.r.left) / c.r.width) * 100));
      o.y = Math.max(4, Math.min(96, ((e.clientY - c.r.top) / c.r.height) * 100));
      el.style.left = o.x + '%'; el.style.top = o.y + '%';
    } else if (mode === 'rot') {
      const a = Math.atan2(e.clientY - c.y, e.clientX - c.x);
      o.rot = startRot + (a - startAng) * 180 / Math.PI;
      el.style.transform = 'translate(-50%,-50%) rotate(' + o.rot + 'deg)';
    } else if (mode === 'scale') {
      const d = Math.hypot(e.clientX - c.x, e.clientY - c.y);
      o.scale = Math.max(0.3, Math.min(6, startScale * (d / startDist)));
      if (el.dataset.kind === 'shape') {
        const svg = el.querySelector('svg'); const sz = Math.round(60 * o.scale);
        if (svg) { svg.setAttribute('width', sz); svg.setAttribute('height', sz); }
      } else {
        const g = el.querySelector('.ax-story-obj-glyph'); if (g) g.style.fontSize = Math.round(40 * o.scale) + 'px';
      }
    }
  });
  el.addEventListener('pointerup', function () { mode = null; });
  el.addEventListener('pointercancel', function () { mode = null; });
}

/* Freehand draw — a transparent canvas laid over the stage, only
   pointer-interactive while the draw tab is selected. */
function axStorySetDrawMode(on) {
  const stage = document.getElementById('axStoryStage');
  if (!stage) return;
  let canvas = document.getElementById('axStoryDrawCanvas');
  if (on) {
    if (!canvas) { canvas = document.createElement('canvas'); canvas.id = 'axStoryDrawCanvas'; canvas.className = 'ax-story-draw-canvas'; stage.appendChild(canvas); }
    axStorySizeDrawCanvas();
    canvas.style.pointerEvents = 'auto';
    canvas.onpointerdown = axStoryDrawStart;
  } else if (canvas) {
    canvas.style.pointerEvents = 'none';
  }
}
function axStorySizeDrawCanvas() {
  const stage = document.getElementById('axStoryStage');
  const canvas = document.getElementById('axStoryDrawCanvas');
  if (!stage || !canvas) return;
  const r = stage.getBoundingClientRect();
  canvas.width = r.width; canvas.height = r.height;
  axStoryRedrawDraws();
}
function axStoryDrawStart(e) {
  e.preventDefault();
  const canvas = document.getElementById('axStoryDrawCanvas');
  const r = canvas.getBoundingClientRect();
  const stroke = { color: _axStoryDrawColor, pts: [], tool: _axStoryDrawTool, w: _axStoryBrush };
  _axStoryDraws.push(stroke);
  _axStoryActionStack.push({ type: 'draw' });
  function addPt(ev) {
    const pt = ev.touches ? ev.touches[0] : ev;
    stroke.pts.push({ x: (pt.clientX - r.left) / r.width * 100, y: (pt.clientY - r.top) / r.height * 100 });
    axStoryRedrawDraws();
  }
  addPt(e);
  function onMove(ev) { addPt(ev); }
  function onUp() { window.removeEventListener('pointermove', onMove); window.removeEventListener('pointerup', onUp); axStoryRenderPanel(); }
  window.addEventListener('pointermove', onMove);
  window.addEventListener('pointerup', onUp);
}
function axStoryRedrawDraws() {
  const canvas = document.getElementById('axStoryDrawCanvas');
  if (!canvas) return;
  const ctx = canvas.getContext('2d');
  ctx.clearRect(0, 0, canvas.width, canvas.height);
  _axStoryDraws.forEach(function (stroke) { axStoryPaintStroke(ctx, stroke, canvas.width, canvas.height); });
}
/* Paint one stroke with its tool: pen (solid), marker (thick + translucent),
   neon (glow), eraser (cuts holes). Shared by the live canvas + the baker. */
function axStoryPaintStroke(ctx, stroke, W, H) {
  if (!stroke.pts || stroke.pts.length < 2) return;
  const tool = stroke.tool || 'pen';
  const base = Math.max(2, W * 0.006) * ((stroke.w || 8) / 8);
  ctx.save();
  ctx.lineCap = 'round'; ctx.lineJoin = 'round';
  ctx.globalCompositeOperation = (tool === 'eraser') ? 'destination-out' : 'source-over';
  ctx.globalAlpha = (tool === 'marker') ? 0.45 : 1;
  ctx.strokeStyle = (tool === 'eraser') ? 'rgba(0,0,0,1)' : stroke.color;
  ctx.lineWidth = base * (tool === 'marker' ? 2.4 : tool === 'eraser' ? 2 : 1.4);
  if (tool === 'neon') { ctx.shadowBlur = base * 3; ctx.shadowColor = stroke.color; }
  ctx.beginPath();
  stroke.pts.forEach(function (p, i) {
    const px = p.x / 100 * W, py = p.y / 100 * H;
    if (i === 0) ctx.moveTo(px, py); else ctx.lineTo(px, py);
  });
  ctx.stroke();
  ctx.restore();
}

function axStoryHasEdits() {
  return !!(_axStoryText || _axStoryCrop || _axStoryRotate || (_axStoryFilter && _axStoryFilter !== 'none') ||
    _axStoryDraws.length || _axStoryShapes.length || _axStoryStickers.length);
}

function axStoryInitDrag() {
  const stage = document.getElementById('axStoryStage');
  const layer = document.getElementById('axStoryTextLayer');
  if (!stage || !layer) return;
  let dragging = false;
  function move(e) {
    if (!dragging) return;
    const r = stage.getBoundingClientRect();
    const pt = e.touches ? e.touches[0] : e;
    let x = ((pt.clientX - r.left) / r.width) * 100;
    let y = ((pt.clientY - r.top) / r.height) * 100;
    x = Math.max(6, Math.min(94, x)); y = Math.max(6, Math.min(94, y));
    _axStoryTextPos = { x: x, y: y };
    layer.style.left = x + '%'; layer.style.top = y + '%';
  }
  layer.addEventListener('pointerdown', function (e) {
    /* While inline-editing the text, let taps place the caret instead of
       starting a drag. */
    if (layer.getAttribute('data-editing') === '1') return;
    dragging = true; e.preventDefault();
  });
  window.addEventListener('pointermove', move);
  window.addEventListener('pointerup', function () { dragging = false; });
}

/* Filters tab: press-and-hold the photo to peek the un-filtered original,
   release to return to the selected filter (matches the prototype). */
function axStoryBindHoldOriginal() {
  const img = document.getElementById('axStoryStageImg');
  if (!img || img._axHoldBound) return;
  img._axHoldBound = true;
  const restore = function () {
    const f = AX_STORY_FILTERS[_axStoryFilter];
    img.style.filter = (f && f.css !== 'none') ? f.css : '';
  };
  img.addEventListener('pointerdown', function () { if (_axStoryActiveTab === 'filter') img.style.filter = ''; });
  img.addEventListener('pointerup', function () { if (_axStoryActiveTab === 'filter') restore(); });
  img.addEventListener('pointerleave', function () { if (_axStoryActiveTab === 'filter') restore(); });
}

/* ── Share screen — full composited preview, caption, audience, send ──── */
function axStoryGoShare() {
  _axStoryScreen = 'share';
  axStoryRenderComposer();
}
function axStoryBackToEdit() {
  // Prefer re-opening the rich iframe editor when the photo was designed there.
  if (_axStoryRichEdited && !_axStoryIsVideo && typeof axOpenEditor === 'function') {
    const current = _axStoryFinalB64 || _axStoryOrigB64;
    axOpenEditor(current, 'story', function (finalB64, meta) {
      _axStoryOrigB64 = finalB64;
      _axStoryFinalB64 = finalB64;
      if (meta && meta.music) _axStoryMusic = meta.music;
      _axStoryScreen = 'share';
      axStoryRenderComposer();
    }, function () {
      // User closed editor without saving — stay on Share with previous image.
      _axStoryScreen = 'share';
      axStoryRenderComposer();
    });
    return;
  }
  _axStoryScreen = 'edit';
  axStoryRenderComposer();
}
async function axStoryRenderShareScreen(modal) {
  modal.innerHTML =
    '<div class="ax-story-editor-top">' +
    '<button type="button" class="ax-story-editor-icon-btn" onclick="axStoryBackToEdit()" aria-label="Back to edit"><i class="fa-solid fa-arrow-left"></i></button>' +
    '<span class="ax-story-editor-title">Share to story</span>' +
    '<span style="width:38px"></span>' +
    '</div>' +
    '<div class="ax-story-share-stage" id="axStorySharePreview"><p class="ax-story-hint">Preparing preview…</p></div>' +
    '<div class="ax-story-panel ax-story-share-panel">' +
    (_axStoryMusic
      ? '<div class="ax-story-music-row"><i class="fa-solid fa-music"></i> <span>' + axStoryEsc(_axStoryMusic) + '</span>' +
      '<button type="button" onclick="axStoryClearShareMusic()" aria-label="Remove music"><i class="fa-solid fa-xmark"></i></button></div>'
      : '') +
    '<div class="ax-story-field-label"><i class="fa-solid fa-pen"></i> Caption</div>' +
    '<input type="text" id="axStoryCaption" maxlength="200" placeholder="Add a caption (shows at the bottom)…" class="ax-story-caption-input">' +
    '<div class="ax-privacy-row">' +
    '<span class="ax-privacy-label"><i class="fa-solid fa-eye"></i> Who can see this?</span>' +
    '<button type="button" class="ax-aud-chip" id="axStoryAudChip" onclick="axStoryPickAudience()">' +
    '<i class="fa-solid ' + (typeof axAudienceIcon === 'function' ? axAudienceIcon(_axStoryVis) : 'fa-globe') + '"></i> <span>' +
    (typeof axAudienceLabel === 'function' ? axAudienceLabel(_axStoryVis) : 'Public') + '</span></button>' +
    '</div>' +
    '<button type="button" class="ax-story-share-btn" id="axStoryPostBtn"><i class="fa-solid fa-paper-plane"></i> Share to story</button>' +
    '<p class="ax-radius-note">Disappears after 24 hours</p>' +
    '</div>';
  document.getElementById('axStoryPostBtn').addEventListener('click', function () { axSubmitStory(this); });

  const holder = document.getElementById('axStorySharePreview');
  let previewSrc = _axStoryFinalB64 || _axStoryOrigB64;
  // Rich-editor output is already flattened — skip re-composite. Legacy inline
  // edits (if any) still bake via axStoryComposite.
  if (!_axStoryIsVideo && !_axStoryRichEdited) {
    try { previewSrc = axStoryHasEdits() ? await axStoryComposite(_axStoryOrigB64) : _axStoryOrigB64; }
    catch (e) { previewSrc = _axStoryOrigB64; }
  }
  _axStoryFinalB64 = previewSrc;
  if (!document.getElementById('axStorySharePreview')) return; // user navigated away mid-render
  holder.innerHTML = _axStoryIsVideo
    ? '<video src="' + previewSrc + '" autoplay loop playsinline></video>'
    : '<img src="' + previewSrc + '" alt="Story preview">';
  if (_axStoryMusic) axStoryPlayMusic(_axStoryMusic);
}
function axStoryClearShareMusic() {
  _axStoryMusic = '';
  axStoryStopMusic();
  axStoryRenderShareScreen(document.getElementById('axStoryComposer'));
}

function axStoryComposite(b64) {
  return new Promise(function (resolve, reject) {
    const img = new Image();
    img.onload = function () {
      let sx = 0, sy = 0, sw = img.naturalWidth || 1080, sh = img.naturalHeight || 1080;
      let cw = sw, ch = sh;
      if (_axStoryCrop) {
        const target = 9 / 16;
        if (sw / sh > target) { cw = Math.round(sh * target); ch = sh; sx = Math.round((sw - cw) / 2); }
        else { cw = sw; ch = Math.round(sw / target); sy = Math.round((sh - ch) / 2); }
        sw = cw; sh = ch;
      }
      const rotated = _axStoryRotate % 180 !== 0;
      const canvas = document.createElement('canvas');
      canvas.width = rotated ? ch : cw;
      canvas.height = rotated ? cw : ch;
      const ctx = canvas.getContext('2d');

      // Photo, with filter + rotation baked in.
      const filterCss = AX_STORY_FILTERS[_axStoryFilter] ? AX_STORY_FILTERS[_axStoryFilter].css : 'none';
      if (filterCss !== 'none') { try { ctx.filter = filterCss; } catch (e) { /* unsupported browser: skip filter */ } }
      ctx.save();
      ctx.translate(canvas.width / 2, canvas.height / 2);
      if (_axStoryRotate) ctx.rotate(_axStoryRotate * Math.PI / 180);
      ctx.drawImage(img, sx, sy, sw, sh, -cw / 2, -ch / 2, cw, ch);
      ctx.restore();
      ctx.filter = 'none';

      // Freehand drawings (percentages map directly onto this canvas).
      _axStoryDraws.forEach(function (stroke) {
        if (stroke.pts.length < 2) return;
        ctx.strokeStyle = stroke.color;
        ctx.lineWidth = Math.max(4, canvas.width * 0.012);
        ctx.lineCap = 'round'; ctx.lineJoin = 'round';
        ctx.beginPath();
        stroke.pts.forEach(function (p, i) {
          const px = p.x / 100 * canvas.width, py = p.y / 100 * canvas.height;
          if (i === 0) ctx.moveTo(px, py); else ctx.lineTo(px, py);
        });
        ctx.stroke();
      });

      // Shapes (with scale + rotation baked in).
      _axStoryShapes.forEach(function (shp) {
        const cx = shp.x / 100 * canvas.width, cy = shp.y / 100 * canvas.height;
        const size = canvas.width * 0.16 * (shp.scale || 1);
        ctx.save();
        ctx.translate(cx, cy);
        if (shp.rot) ctx.rotate(shp.rot * Math.PI / 180);
        ctx.strokeStyle = shp.color; ctx.fillStyle = shp.color;
        ctx.lineWidth = Math.max(3, canvas.width * 0.01);
        ctx.lineJoin = 'round'; ctx.lineCap = 'round';
        ctx.beginPath();
        const hs = size / 2;
        if (shp.type === 'square') ctx.strokeRect(-hs, -hs, size, size);
        else if (shp.type === 'circle') { ctx.arc(0, 0, hs, 0, Math.PI * 2); ctx.stroke(); }
        else if (shp.type === 'triangle') { ctx.moveTo(0, -hs); ctx.lineTo(hs, hs); ctx.lineTo(-hs, hs); ctx.closePath(); ctx.stroke(); }
        else if (shp.type === 'line') { ctx.moveTo(-hs, hs); ctx.lineTo(hs, -hs); ctx.stroke(); }
        else if (shp.type === 'hexagon') { for (let i = 0; i < 6; i++) { const a = Math.PI / 180 * (60 * i - 90); const x = Math.cos(a) * hs, y = Math.sin(a) * hs; i ? ctx.lineTo(x, y) : ctx.moveTo(x, y); } ctx.closePath(); ctx.stroke(); }
        else if (shp.type === 'star') { for (let i = 0; i < 10; i++) { const rr = (i % 2 ? size * 0.22 : hs); const a = Math.PI / 180 * (36 * i - 90); const x = Math.cos(a) * rr, y = Math.sin(a) * rr; i ? ctx.lineTo(x, y) : ctx.moveTo(x, y); } ctx.closePath(); ctx.stroke(); }
        else if (shp.type === 'heart') { ctx.moveTo(0, hs * 0.75); ctx.bezierCurveTo(-hs * 1.6, -hs * 0.2, -hs * 0.55, -size, 0, -hs * 0.25); ctx.bezierCurveTo(hs * 0.55, -size, hs * 1.6, -hs * 0.2, 0, hs * 0.75); ctx.closePath(); ctx.stroke(); }
        else if (shp.type === 'bubble') { const w = size, h = size * 0.82, r = size * 0.16, x0 = -hs, y0 = -hs; ctx.moveTo(x0 + r, y0); ctx.arcTo(x0 + w, y0, x0 + w, y0 + h, r); ctx.arcTo(x0 + w, y0 + h, x0, y0 + h, r); ctx.arcTo(x0, y0 + h, x0, y0, r); ctx.arcTo(x0, y0, x0 + w, y0, r); ctx.closePath(); ctx.stroke(); }
        else { /* arrow */
          ctx.moveTo(-hs, hs); ctx.lineTo(hs, -hs); ctx.stroke();
          ctx.beginPath();
          ctx.moveTo(hs, -hs);
          ctx.lineTo(hs - size * 0.25, -hs + size * 0.05);
          ctx.lineTo(hs - size * 0.05, -hs + size * 0.25);
          ctx.closePath(); ctx.fill();
        }
        ctx.restore();
      });

      // Emoji stickers (with scale + rotation baked in).
      _axStoryStickers.forEach(function (st) {
        const px = st.x / 100 * canvas.width, py = st.y / 100 * canvas.height;
        const size = Math.round(canvas.width * 0.1 * (st.scale || 1));
        ctx.save();
        ctx.translate(px, py);
        if (st.rot) ctx.rotate(st.rot * Math.PI / 180);
        ctx.font = size + 'px sans-serif';
        ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
        ctx.fillText(st.emoji, 0, 0);
        ctx.restore();
      });

      // Text (drawn last, on top of everything else).
      if (_axStoryText) {
        const fontSize = Math.round(canvas.width * 0.06);
        const fontFamily = (_axStoryTextFont === 'serif') ? 'Georgia, serif' : '"Plus Jakarta Sans", system-ui, sans-serif';
        ctx.font = '800 ' + fontSize + 'px ' + fontFamily;
        ctx.fillStyle = _axStoryTextColor; ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
        ctx.shadowColor = 'rgba(0,0,0,.6)'; ctx.shadowBlur = fontSize * 0.3; ctx.shadowOffsetY = 2;
        const maxW = canvas.width * 0.88;
        const words = _axStoryText.split(' '); let lines = [], line = '';
        words.forEach(function (w) {
          const test = line ? line + ' ' + w : w;
          if (ctx.measureText(test).width > maxW && line) { lines.push(line); line = w; } else line = test;
        });
        if (line) lines.push(line);
        const lh = fontSize * 1.2;
        const cy = canvas.height * _axStoryTextPos.y / 100 - (lines.length - 1) * lh / 2;
        const cx = canvas.width * _axStoryTextPos.x / 100;
        lines.forEach(function (ln, i) {
          const ly = cy + i * lh;
          if (_axStoryTextBg) {
            const tw = ctx.measureText(ln).width;
            ctx.save(); ctx.shadowColor = 'transparent'; ctx.fillStyle = 'rgba(0,0,0,.45)';
            ctx.fillRect(cx - tw / 2 - fontSize * 0.25, ly - lh / 2, tw + fontSize * 0.5, lh);
            ctx.restore(); ctx.fillStyle = _axStoryTextColor;
          }
          ctx.fillText(ln, cx, ly);
        });
      }
      resolve(canvas.toDataURL('image/jpeg', 0.92));
    };
    img.onerror = reject; img.src = b64;
  });
}

async function axSubmitStory(btn) {
  const caption = (document.getElementById('axStoryCaption')?.value || '').trim();
  if (btn) { btn.disabled = true; btn.innerHTML = '<span class="spinner"></span> Sharing…'; }
  const data = await mpApi('/story/create', {
    method: 'POST',
    body: JSON.stringify({ media_b64: _axStoryFinalB64, caption: caption, music: _axStoryMusic, visibility: _axStoryVis, audience_subs: _axStoryAud }),
  });
  if (data && data.success) {
    axStoryStopMusic();
    document.body.style.overflow = '';
    document.getElementById('axStoryComposer')?.remove();
    showToast('Story shared — live for 24 hours', 'success');
    axLoadStories();
  } else {
    showToast((data && data.error) || 'Could not share story', 'error');
    if (btn) { btn.disabled = false; btn.innerHTML = '<i class="fa-solid fa-paper-plane"></i> Share to story'; }
  }
}

/* ── Viewer ───────────────────────────────────────────────────────── */
function axOpenStoryViewer(groupIdx, storyIdx) {
  const g = _axStoryGroups[groupIdx];
  if (!g || !g.stories.length) return;
  _axStoryGroupIdx = groupIdx;
  // Resume at the first unseen story in this group (WhatsApp behaviour).
  if (storyIdx == null) {
    const firstUnseen = g.stories.findIndex(function (s) { return !s.seen; });
    _axStoryIdx = firstUnseen === -1 ? 0 : firstUnseen;
  } else {
    _axStoryIdx = storyIdx;
  }
  let v = document.getElementById('axStoryViewer');
  if (v) v.remove();
  v = document.createElement('div');
  v.id = 'axStoryViewer';
  v.className = 'ax-story-viewer';
  document.body.appendChild(v);
  document.body.style.overflow = 'hidden';
  axRenderStory();
}

function axRenderStory() {
  const v = document.getElementById('axStoryViewer');
  const g = _axStoryGroups[_axStoryGroupIdx];
  if (!v || !g) return axCloseStoryViewer();
  const s = g.stories[_axStoryIdx];
  if (!s) return axStoryNextGroup();

  const bars = g.stories.map(function (_, i) {
    const state = i < _axStoryIdx ? ' done' : (i === _axStoryIdx ? ' active' : '');
    return '<span class="ax-story-bar' + state + '"><i></i></span>';
  }).join('');

  v.innerHTML =
    '<div class="ax-story-progress">' + bars + '</div>' +
    '<div class="ax-story-topbar">' +
    (typeof axAvatarHtml === 'function' ? axAvatarHtml(g.user_name, g.user_photo, 'ax-story-avatar') : '') +
    '<div class="ax-story-who"><b>' + axStoryEsc(g.user_name) + '</b>' +
    '<small>' + (typeof axTimeAgo === 'function' ? axTimeAgo(s.created_at) : '') + '</small></div>' +
    (s.music ? '<span class="ax-story-music-chip" title="' + axStoryEsc(s.music) + '"><i class="fa-solid fa-music"></i> ' + axStoryEsc(s.music) + '</span>' : '') +
    (g.is_mine
      ? '<span class="ax-story-views"><i class="fa-regular fa-eye"></i> ' + (s.view_count || 0) + '</span>' +
      '<button type="button" class="ax-story-icon-btn" onclick="axDeleteStory(\'' + axStoryEsc(s.story_id) + '\')" aria-label="Delete story"><i class="fa-regular fa-trash-can"></i></button>'
      : '') +
    '<button type="button" class="ax-story-icon-btn" onclick="axCloseStoryViewer()" aria-label="Close"><i class="fa-solid fa-xmark"></i></button>' +
    '</div>' +
    '<div class="ax-story-media">' +
    (s.media_type === 'video'
      ? '<video src="' + axStoryEsc(s.media_url) + '" autoplay playsinline id="axStoryVideo"></video>'
      : '<img src="' + axStoryEsc(s.media_url) + '" alt="">') +
    (s.caption ? '<div class="ax-story-caption">' + axStoryEsc(s.caption) + '</div>' : '') +
    '</div>' +
    '<button type="button" class="ax-story-nav ax-story-prev" onclick="axStoryPrev()" aria-label="Previous"></button>' +
    '<button type="button" class="ax-story-nav ax-story-next" onclick="axStoryNext()" aria-label="Next"></button>' +
    '<div class="ax-story-footer">' +
    (g.is_mine
      ? '<span class="ax-story-own-note"><i class="fa-regular fa-eye"></i> ' + (s.view_count || 0) + ' views · <i class="fa-solid fa-heart"></i> ' + (s.like_count || 0) + '</span>'
      : '<input type="text" id="axStoryReplyInput" placeholder="Reply to ' + axStoryEsc(g.user_name) + '…" maxlength="300" autocomplete="off">' +
      '<button type="button" class="ax-story-send" onclick="axSendStoryReply()" aria-label="Send reply"><i class="fa-solid fa-paper-plane"></i></button>' +
      '<button type="button" class="ax-story-heart' + (s.liked_by_me ? ' liked' : '') + '" onclick="axLikeStory(this)" aria-label="Like story">' +
      '<i class="fa-' + (s.liked_by_me ? 'solid' : 'regular') + ' fa-heart"></i></button>') +
    '</div>';

  // Pause auto-advance while typing a reply.
  const reply = document.getElementById('axStoryReplyInput');
  if (reply) {
    reply.addEventListener('focus', axStoryPause);
    reply.addEventListener('blur', axStoryResume);
    reply.addEventListener('keydown', function (e) { if (e.key === 'Enter') axSendStoryReply(); });
  }
  if (s.music) axStoryPlayMusic(s.music); else axStoryStopMusic();
  axMarkStorySeen(s);
  axStoryStartTimer(s);
}

function axStoryStartTimer(s) {
  clearTimeout(_axStoryTimer);
  const bar = document.querySelector('#axStoryViewer .ax-story-bar.active i');
  const vid = document.getElementById('axStoryVideo');
  if (s.media_type === 'video' && vid) {
    // Videos advance on their own end event rather than a fixed timer.
    if (bar) bar.style.animation = 'none';
    vid.onended = axStoryNext;
    return;
  }
  if (bar) {
    bar.style.animation = 'none';
    void bar.offsetWidth; // restart the CSS animation
    bar.style.animation = 'axStoryFill ' + AX_STORY_DURATION + 'ms linear forwards';
  }
  _axStoryTimer = setTimeout(axStoryNext, AX_STORY_DURATION);
}
function axStoryPause() {
  clearTimeout(_axStoryTimer);
  const bar = document.querySelector('#axStoryViewer .ax-story-bar.active i');
  if (bar) bar.style.animationPlayState = 'paused';
  const vid = document.getElementById('axStoryVideo');
  if (vid) vid.pause();
  axStoryPauseMusic();
}
function axStoryResume() {
  const bar = document.querySelector('#axStoryViewer .ax-story-bar.active i');
  if (bar) bar.style.animationPlayState = 'running';
  axStoryResumeMusic();
  const vid = document.getElementById('axStoryVideo');
  if (vid) { vid.play(); return; }
  _axStoryTimer = setTimeout(axStoryNext, AX_STORY_DURATION);
}

function axStoryNext() {
  const g = _axStoryGroups[_axStoryGroupIdx];
  if (g && _axStoryIdx < g.stories.length - 1) { _axStoryIdx++; axRenderStory(); }
  else axStoryNextGroup();
}
function axStoryPrev() {
  if (_axStoryIdx > 0) { _axStoryIdx--; axRenderStory(); return; }
  if (_axStoryGroupIdx > 0) {
    _axStoryGroupIdx--;
    const g = _axStoryGroups[_axStoryGroupIdx];
    _axStoryIdx = Math.max(0, (g.stories.length || 1) - 1);
    axRenderStory();
  }
}
function axStoryNextGroup() {
  if (_axStoryGroupIdx < _axStoryGroups.length - 1) {
    _axStoryGroupIdx++;
    _axStoryIdx = 0;
    axRenderStory();
  } else {
    axCloseStoryViewer();
  }
}
function axCloseStoryViewer() {
  clearTimeout(_axStoryTimer);
  axStoryStopMusic();
  document.getElementById('axStoryViewer')?.remove();
  document.body.style.overflow = '';
  axLoadStories(); // refresh rings (seen state may have changed)
}

/* ── Actions ──────────────────────────────────────────────────────── */
function axMarkStorySeen(s) {
  if (!s || s.seen) return;
  s.seen = true;
  mpApi('/story/view', { method: 'POST', body: JSON.stringify({ story_id: s.story_id }) })
    .catch(function () { /* view counting is best-effort */ });
}
async function axLikeStory(btn) {
  const g = _axStoryGroups[_axStoryGroupIdx];
  const s = g && g.stories[_axStoryIdx];
  if (!s) return;
  const data = await mpApi('/story/like', { method: 'POST', body: JSON.stringify({ story_id: s.story_id }) });
  if (!data || !data.success) { showToast((data && data.error) || 'Could not like story', 'error'); return; }
  s.liked_by_me = data.liked;
  s.like_count = data.like_count;
  if (btn) {
    btn.classList.toggle('liked', data.liked);
    btn.innerHTML = '<i class="fa-' + (data.liked ? 'solid' : 'regular') + ' fa-heart"></i>';
  }
}
async function axSendStoryReply() {
  const inp = document.getElementById('axStoryReplyInput');
  const text = (inp && inp.value || '').trim();
  if (!text) return;
  const g = _axStoryGroups[_axStoryGroupIdx];
  const s = g && g.stories[_axStoryIdx];
  if (!s) return;
  inp.value = '';
  inp.blur();
  const data = await mpApi('/story/reply', {
    method: 'POST',
    body: JSON.stringify({ story_id: s.story_id, text: text }),
  });
  if (data && data.success) showToast('Reply sent to ' + g.user_name, 'success');
  else showToast((data && data.error) || 'Could not send reply', 'error');
}
async function axDeleteStory(storyId) {
  if (!confirm('Delete this story?')) return;
  const data = await mpApi('/story/delete', { method: 'POST', body: JSON.stringify({ story_id: storyId }) });
  if (data && data.success) {
    showToast('Story deleted', 'success');
    axCloseStoryViewer();
  } else showToast((data && data.error) || 'Could not delete story', 'error');
}

/* Keyboard support for the viewer (desktop). */
document.addEventListener('keydown', function (e) {
  if (!document.getElementById('axStoryViewer')) return;
  if (e.key === 'Escape') axCloseStoryViewer();
  else if (e.key === 'ArrowRight') axStoryNext();
  else if (e.key === 'ArrowLeft') axStoryPrev();
});
