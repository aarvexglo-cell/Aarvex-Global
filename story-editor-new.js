/* ═══════════════════════════════════════════════════════════════════════
   MODERN STORY EDITOR - Complete JavaScript
   Full-featured Instagram-style story editor
   ═══════════════════════════════════════════════════════════════════════ */

// ── STATE MANAGEMENT ─────────────────────────────────────────────────────
const state = {
  currentTool: 'adjust',
  currentFormat: '9:16',
  currentFilter: 'none',
  drawColor: '#ffffff',
  drawTool: 'pen',
  brushSize: 5,
  textColor: '#ffffff',
  textFont: 'Poppins',
  fontSize: 32,
  isDrawing: false,
  history: [],
  historyIndex: -1,
  rotation: 0,
  flipped: false,
  elements: {
    texts: [],
    stickers: [],
    shapes: []
  }
};

// ── DOM ELEMENTS ─────────────────────────────────────────────────────────
let DOM = {};

// ── INITIALIZATION ───────────────────────────────────────────────────────
function init() {
  // Initialize DOM references AFTER DOMContentLoaded
  DOM = {
    // Main elements
    canvas: document.getElementById('storyCanvas'),
    imageContainer: document.getElementById('imageContainer'),
    storyImage: document.getElementById('storyImage'),
    drawCanvas: document.getElementById('drawCanvas'),
    textLayers: document.getElementById('textLayers'),
    stickerLayers: document.getElementById('stickerLayers'),
    shapeLayers: document.getElementById('shapeLayers'),

    // Buttons
    btnClose: document.getElementById('btnClose'),
    btnNext: document.getElementById('btnNext'),
    btnUndo: document.getElementById('btnUndo'),
    btnRedo: document.getElementById('btnRedo'),
    btnChangeImage: document.getElementById('btnChangeImage'),
    btnClearDraw: document.getElementById('btnClearDraw'),
    btnAddText: document.getElementById('btnAddText'),

    // Tool panels
    panels: document.querySelectorAll('.tool-panel'),
    toolBtns: document.querySelectorAll('.tool-btn'),

    // Format buttons
    formatBtns: document.querySelectorAll('.format-btn'),

    // Adjust
    adjustBtns: document.querySelectorAll('.adjust-btn'),
    ratioBtns: document.querySelectorAll('.ratio-btn'),

    // Filters
    filterItems: document.querySelectorAll('.filter-item'),

    // Draw
    colorBtns: document.querySelectorAll('.color-btn'),
    drawToolBtns: document.querySelectorAll('.draw-tool-btn'),
    brushSlider: document.getElementById('brushSize'),

    // Text
    fontBtns: document.querySelectorAll('.font-btn'),
    fontSizeDisplay: document.getElementById('fontSizeDisplay'),
    btnDecreaseFontSize: document.getElementById('btnDecreaseFontSize'),
    btnIncreaseFontSize: document.getElementById('btnIncreaseFontSize'),
    btnTextAlign: document.getElementById('btnTextAlign'),
    btnTextBackground: document.getElementById('btnTextBackground'),
    btnTextBold: document.getElementById('btnTextBold'),

    // Stickers
    stickerCatBtns: document.querySelectorAll('.sticker-cat-btn'),
    stickerGrid: document.getElementById('stickerGrid'),
    stickerItems: document.querySelectorAll('.sticker-item'),

    // Shapes
    shapeBtns: document.querySelectorAll('.shape-btn'),
    btnShapeColor: document.getElementById('btnShapeColor'),
    btnShapeFill: document.getElementById('btnShapeFill'),

    // Modals
    shareModal: document.getElementById('shareModal')
  };

  setupCanvas();
  setupEventListeners();
  saveState();
  console.log('✅ Story Editor initialized');
}

// ── CANVAS SETUP ─────────────────────────────────────────────────────────
function setupCanvas() {
  const ctx = DOM.drawCanvas.getContext('2d');
  DOM.drawCanvas.width = DOM.imageContainer.offsetWidth;
  DOM.drawCanvas.height = DOM.imageContainer.offsetHeight;
  ctx.lineCap = 'round';
  ctx.lineJoin = 'round';
}

// ── EVENT LISTENERS ──────────────────────────────────────────────────────
function setupEventListeners() {

  // Tool switching
  DOM.toolBtns.forEach(btn => {
    btn.addEventListener('click', () => {
      const tool = btn.dataset.tool;
      switchTool(tool);
    });
  });

  // Format toggle
  DOM.formatBtns.forEach(btn => {
    btn.addEventListener('click', () => {
      const format = btn.dataset.format;
      changeFormat(format);
    });
  });

  // Close button
  DOM.btnClose.addEventListener('click', () => {
    if (confirm('Are you sure you want to close? Unsaved changes will be lost.')) {
      window.history.back();
    }
  });

  // Next button
  DOM.btnNext.addEventListener('click', showShareModal);

  // Undo/Redo
  DOM.btnUndo.addEventListener('click', undo);
  DOM.btnRedo.addEventListener('click', redo);

  // Change Image
  DOM.btnChangeImage.addEventListener('click', changeImage);

  // Adjust actions
  DOM.adjustBtns.forEach(btn => {
    btn.addEventListener('click', () => {
      const action = btn.dataset.action;
      handleAdjustAction(action);
    });
  });

  // Ratio buttons
  DOM.ratioBtns.forEach(btn => {
    btn.addEventListener('click', () => {
      const ratio = btn.dataset.ratio;
      changeAspectRatio(ratio);
    });
  });

  // Filters
  DOM.filterItems.forEach(item => {
    item.addEventListener('click', () => {
      const filter = item.dataset.filter;
      applyFilter(filter);
    });
  });

  // Hold to view original (for filters)
  DOM.imageContainer.addEventListener('touchstart', showOriginalImage);
  DOM.imageContainer.addEventListener('touchend', hideOriginalImage);
  DOM.imageContainer.addEventListener('mousedown', showOriginalImage);
  DOM.imageContainer.addEventListener('mouseup', hideOriginalImage);

  // Draw color selection
  DOM.colorBtns.forEach(btn => {
    btn.addEventListener('click', () => {
      const color = btn.dataset.color;
      selectDrawColor(color);
    });
  });

  // Draw tool selection
  DOM.drawToolBtns.forEach(btn => {
    btn.addEventListener('click', () => {
      const tool = btn.dataset.tool;
      selectDrawTool(tool);
    });
  });

  // Brush size
  DOM.brushSlider.addEventListener('input', (e) => {
    state.brushSize = parseInt(e.target.value);
  });

  // Clear drawing
  DOM.btnClearDraw.addEventListener('click', clearDrawing);

  // Drawing on canvas
  setupDrawing();

  // Text controls
  DOM.btnAddText.addEventListener('click', addTextElement);
  DOM.btnDecreaseFontSize.addEventListener('click', () => changeFontSize(-4));
  DOM.btnIncreaseFontSize.addEventListener('click', () => changeFontSize(4));

  // Font selection
  DOM.fontBtns.forEach(btn => {
    btn.addEventListener('click', () => {
      const font = btn.dataset.font;
      selectFont(font);
    });
  });

  // Stickers
  DOM.stickerItems.forEach(item => {
    item.addEventListener('click', () => {
      const emoji = item.dataset.emoji;
      addStickerElement(emoji);
    });
  });

  // Shapes
  DOM.shapeBtns.forEach(btn => {
    btn.addEventListener('click', () => {
      const shape = btn.dataset.shape;
      addShapeElement(shape);
    });
  });

  // Shape fill toggle
  DOM.btnShapeFill.addEventListener('click', toggleShapeFill);
}

// ── TOOL SWITCHING ───────────────────────────────────────────────────────
function switchTool(tool) {
  state.currentTool = tool;

  // Update active tool button
  DOM.toolBtns.forEach(btn => {
    btn.classList.toggle('active', btn.dataset.tool === tool);
  });

  // Update active panel
  DOM.panels.forEach(panel => {
    const panelId = panel.id.replace('panel', '').toLowerCase();
    panel.classList.toggle('active', panelId === tool);
  });

  // Enable/disable drawing
  if (tool === 'draw') {
    DOM.drawCanvas.classList.add('active');
  } else {
    DOM.drawCanvas.classList.remove('active');
  }
}

// ── FORMAT CHANGE ────────────────────────────────────────────────────────
function changeFormat(format) {
  state.currentFormat = format;

  // Update active format button
  DOM.formatBtns.forEach(btn => {
    btn.classList.toggle('active', btn.dataset.format === format);
  });

  // Update canvas aspect ratio
  DOM.canvas.classList.remove('ratio-4-5', 'ratio-1-1', 'ratio-16-9');
  if (format === '4:5') {
    DOM.canvas.classList.add('ratio-4-5');
  } else if (format === '1:1') {
    DOM.canvas.classList.add('ratio-1-1');
  } else if (format === '16:9') {
    DOM.canvas.classList.add('ratio-16-9');
  }

  // Resize draw canvas
  setTimeout(setupCanvas, 100);
}

// ── ADJUST ACTIONS ───────────────────────────────────────────────────────
function handleAdjustAction(action) {
  switch (action) {
    case 'rotate':
      rotateImage();
      break;
    case 'flip':
      flipImage();
      break;
    case 'crop':
      enableManualCrop();
      break;
    case 'reset':
      resetImage();
      break;
  }
  saveState();
}

function rotateImage() {
  state.rotation = (state.rotation + 90) % 360;
  DOM.storyImage.style.transform = `rotate(${state.rotation}deg) ${state.flipped ? 'scaleX(-1)' : ''}`;
}

function flipImage() {
  state.flipped = !state.flipped;
  DOM.storyImage.style.transform = `rotate(${state.rotation}deg) ${state.flipped ? 'scaleX(-1)' : ''}`;
}

function enableManualCrop() {
  alert('Manual crop: Charon side ke handles drag karke apne hisaab se cut karo (Feature coming soon!)');
}

function resetImage() {
  state.rotation = 0;
  state.flipped = false;
  DOM.storyImage.style.transform = '';
  DOM.storyImage.style.filter = '';
  state.currentFilter = 'none';

  // Update filter selection
  DOM.filterItems.forEach(item => {
    item.classList.toggle('active', item.dataset.filter === 'none');
  });
}

function changeAspectRatio(ratio) {
  // Update active ratio button
  DOM.ratioBtns.forEach(btn => {
    btn.classList.toggle('active', btn.dataset.ratio === ratio);
  });

  // Apply ratio to canvas
  DOM.canvas.classList.remove('ratio-4-5', 'ratio-1-1', 'ratio-16-9');

  if (ratio === '4:5') {
    DOM.canvas.classList.add('ratio-4-5');
  } else if (ratio === '1:1') {
    DOM.canvas.classList.add('ratio-1-1');
  } else if (ratio === '16:9') {
    DOM.canvas.classList.add('ratio-16-9');
  }

  setTimeout(setupCanvas, 100);
}

// ── FILTERS ──────────────────────────────────────────────────────────────
function applyFilter(filter) {
  state.currentFilter = filter;

  // Update active filter
  DOM.filterItems.forEach(item => {
    item.classList.toggle('active', item.dataset.filter === filter);
  });

  // Apply filter to image
  let filterCSS = '';

  switch (filter) {
    case 'pop':
      filterCSS = 'contrast(1.3) saturate(1.3)';
      break;
    case 'bw':
      filterCSS = 'grayscale(1)';
      break;
    case 'cool':
      filterCSS = 'hue-rotate(180deg) saturate(1.2)';
      break;
    case 'chrome':
      filterCSS = 'contrast(1.5) brightness(1.1)';
      break;
    case 'film':
      filterCSS = 'sepia(0.5) contrast(1.2)';
      break;
    default:
      filterCSS = '';
  }

  DOM.storyImage.style.filter = filterCSS;
  saveState();
}

function showOriginalImage(e) {
  if (state.currentFilter !== 'none') {
    DOM.storyImage.style.filter = '';
  }
}

function hideOriginalImage(e) {
  if (state.currentFilter !== 'none') {
    applyFilter(state.currentFilter);
  }
}

// ── DRAWING ──────────────────────────────────────────────────────────────
function setupDrawing() {
  const canvas = DOM.drawCanvas;
  const ctx = canvas.getContext('2d');

  let isDrawing = false;
  let lastX = 0;
  let lastY = 0;

  function startDrawing(e) {
    if (state.currentTool !== 'draw') return;

    isDrawing = true;
    const rect = canvas.getBoundingClientRect();
    const touch = e.touches ? e.touches[0] : e;
    lastX = touch.clientX - rect.left;
    lastY = touch.clientY - rect.top;
  }

  function draw(e) {
    if (!isDrawing || state.currentTool !== 'draw') return;

    e.preventDefault();

    const rect = canvas.getBoundingClientRect();
    const touch = e.touches ? e.touches[0] : e;
    const x = touch.clientX - rect.left;
    const y = touch.clientY - rect.top;

    ctx.strokeStyle = state.drawColor;
    ctx.lineWidth = state.brushSize;

    // Set tool-specific properties
    if (state.drawTool === 'marker') {
      ctx.globalAlpha = 0.5;
      ctx.lineWidth = state.brushSize * 2;
    } else if (state.drawTool === 'neon') {
      ctx.shadowBlur = 10;
      ctx.shadowColor = state.drawColor;
      ctx.globalAlpha = 0.8;
    } else if (state.drawTool === 'eraser') {
      ctx.globalCompositeOperation = 'destination-out';
      ctx.lineWidth = state.brushSize * 2;
    } else {
      ctx.globalAlpha = 1;
      ctx.globalCompositeOperation = 'source-over';
      ctx.shadowBlur = 0;
    }

    ctx.beginPath();
    ctx.moveTo(lastX, lastY);
    ctx.lineTo(x, y);
    ctx.stroke();

    lastX = x;
    lastY = y;
  }

  function stopDrawing() {
    if (isDrawing) {
      isDrawing = false;
      saveState();
    }
  }

  // Mouse events
  canvas.addEventListener('mousedown', startDrawing);
  canvas.addEventListener('mousemove', draw);
  canvas.addEventListener('mouseup', stopDrawing);
  canvas.addEventListener('mouseout', stopDrawing);

  // Touch events
  canvas.addEventListener('touchstart', startDrawing, { passive: false });
  canvas.addEventListener('touchmove', draw, { passive: false });
  canvas.addEventListener('touchend', stopDrawing);
}

function selectDrawColor(color) {
  state.drawColor = color;

  // Update active color button
  DOM.colorBtns.forEach(btn => {
    btn.classList.toggle('active', btn.dataset.color === color);
  });
}

function selectDrawTool(tool) {
  state.drawTool = tool;

  // Update active tool button
  DOM.drawToolBtns.forEach(btn => {
    btn.classList.toggle('active', btn.dataset.tool === tool);
  });
}

function clearDrawing() {
  const ctx = DOM.drawCanvas.getContext('2d');
  ctx.clearRect(0, 0, DOM.drawCanvas.width, DOM.drawCanvas.height);
  saveState();
}

// ── TEXT FUNCTIONS ───────────────────────────────────────────────────────
function addTextElement() {
  const textEl = document.createElement('div');
  textEl.className = 'text-element';
  textEl.contentEditable = true;
  textEl.textContent = 'Tap to edit';
  textEl.style.color = state.textColor;
  textEl.style.fontFamily = state.textFont;
  textEl.style.fontSize = state.fontSize + 'px';
  textEl.style.fontWeight = '600';
  textEl.style.left = '50%';
  textEl.style.top = '50%';
  textEl.style.transform = 'translate(-50%, -50%)';

  // Make draggable
  makeDraggable(textEl);

  // Select on click
  textEl.addEventListener('click', (e) => {
    e.stopPropagation();
    selectElement(textEl);
  });

  // Focus for editing
  textEl.focus();
  document.execCommand('selectAll', false, null);

  DOM.textLayers.style.pointerEvents = 'auto';
  DOM.textLayers.appendChild(textEl);

  state.elements.texts.push(textEl);
  saveState();
}

function selectFont(font) {
  state.textFont = font;

  // Update active font button
  DOM.fontBtns.forEach(btn => {
    btn.classList.toggle('active', btn.dataset.font === font);
  });

  // Apply to selected text elements
  const selectedText = document.querySelector('.text-element.selected');
  if (selectedText) {
    selectedText.style.fontFamily = font;
  }
}

function changeFontSize(delta) {
  state.fontSize = Math.max(12, Math.min(72, state.fontSize + delta));
  DOM.fontSizeDisplay.textContent = state.fontSize;

  const selectedText = document.querySelector('.text-element.selected');
  if (selectedText) {
    selectedText.style.fontSize = state.fontSize + 'px';
  }
}

// ── STICKER FUNCTIONS ────────────────────────────────────────────────────
function addStickerElement(emoji) {
  const stickerEl = document.createElement('div');
  stickerEl.className = 'sticker-element';
  stickerEl.textContent = emoji;
  stickerEl.style.left = '50%';
  stickerEl.style.top = '50%';
  stickerEl.style.transform = 'translate(-50%, -50%)';

  // Make draggable
  makeDraggable(stickerEl);

  // Select on click
  stickerEl.addEventListener('click', (e) => {
    e.stopPropagation();
    selectElement(stickerEl);
  });

  DOM.stickerLayers.style.pointerEvents = 'auto';
  DOM.stickerLayers.appendChild(stickerEl);

  state.elements.stickers.push(stickerEl);
  saveState();
}

// ── SHAPE FUNCTIONS ──────────────────────────────────────────────────────
function addShapeElement(shape) {
  const shapeEl = document.createElement('div');
  shapeEl.className = 'shape-element';
  shapeEl.dataset.shape = shape;
  shapeEl.style.left = '50%';
  shapeEl.style.top = '50%';
  shapeEl.style.transform = 'translate(-50%, -50%)';
  shapeEl.style.width = '80px';
  shapeEl.style.height = '80px';

  // Get SVG from shape button
  const shapeBtn = document.querySelector(`.shape-btn[data-shape="${shape}"]`);
  if (shapeBtn) {
    shapeEl.innerHTML = shapeBtn.querySelector('svg').outerHTML;
  }

  // Make draggable
  makeDraggable(shapeEl);

  // Select on click
  shapeEl.addEventListener('click', (e) => {
    e.stopPropagation();
    selectElement(shapeEl);
  });

  DOM.shapeLayers.style.pointerEvents = 'auto';
  DOM.shapeLayers.appendChild(shapeEl);

  state.elements.shapes.push(shapeEl);
  saveState();
}

function toggleShapeFill() {
  const fillStatus = document.getElementById('fillStatus');
  const currentFill = fillStatus.textContent;
  const newFill = currentFill === 'On' ? 'Off' : 'On';
  fillStatus.textContent = newFill;

  // Apply to selected shape
  const selectedShape = document.querySelector('.shape-element.selected');
  if (selectedShape) {
    const svg = selectedShape.querySelector('svg *[fill]');
    if (svg) {
      svg.setAttribute('fill', newFill === 'On' ? 'currentColor' : 'none');
    }
  }
}

// ── DRAGGABLE ELEMENTS ───────────────────────────────────────────────────
function makeDraggable(element) {
  let isDragging = false;
  let startX, startY, initialLeft, initialTop;

  function onStart(e) {
    isDragging = true;
    const touch = e.touches ? e.touches[0] : e;
    startX = touch.clientX;
    startY = touch.clientY;

    const rect = element.getBoundingClientRect();
    const parentRect = element.parentElement.getBoundingClientRect();
    initialLeft = rect.left - parentRect.left;
    initialTop = rect.top - parentRect.top;

    element.style.transform = 'none';
  }

  function onMove(e) {
    if (!isDragging) return;
    e.preventDefault();

    const touch = e.touches ? e.touches[0] : e;
    const deltaX = touch.clientX - startX;
    const deltaY = touch.clientY - startY;

    element.style.left = (initialLeft + deltaX) + 'px';
    element.style.top = (initialTop + deltaY) + 'px';
  }

  function onEnd() {
    if (isDragging) {
      isDragging = false;
      saveState();
    }
  }

  element.addEventListener('mousedown', onStart);
  document.addEventListener('mousemove', onMove);
  document.addEventListener('mouseup', onEnd);

  element.addEventListener('touchstart', onStart, { passive: false });
  document.addEventListener('touchmove', onMove, { passive: false });
  document.addEventListener('touchend', onEnd);
}

function selectElement(element) {
  // Deselect all
  document.querySelectorAll('.text-element, .sticker-element, .shape-element').forEach(el => {
    el.classList.remove('selected');
  });

  // Select this one
  element.classList.add('selected');
}

// ── UNDO/REDO ────────────────────────────────────────────────────────────
function saveState() {
  // Capture current state
  const currentState = {
    rotation: state.rotation,
    flipped: state.flipped,
    filter: state.currentFilter,
    drawData: DOM.drawCanvas.toDataURL(),
    textElements: Array.from(DOM.textLayers.children).map(el => ({
      html: el.outerHTML,
      text: el.textContent
    })),
    stickerElements: Array.from(DOM.stickerLayers.children).map(el => el.outerHTML),
    shapeElements: Array.from(DOM.shapeLayers.children).map(el => el.outerHTML)
  };

  // Remove states after current index
  state.history = state.history.slice(0, state.historyIndex + 1);

  // Add new state
  state.history.push(currentState);
  state.historyIndex++;

  // Limit history size
  if (state.history.length > 50) {
    state.history.shift();
    state.historyIndex--;
  }

  // Update undo/redo buttons
  updateUndoRedoButtons();
}

function undo() {
  if (state.historyIndex > 0) {
    state.historyIndex--;
    restoreState(state.history[state.historyIndex]);
    updateUndoRedoButtons();
  }
}

function redo() {
  if (state.historyIndex < state.history.length - 1) {
    state.historyIndex++;
    restoreState(state.history[state.historyIndex]);
    updateUndoRedoButtons();
  }
}

function restoreState(savedState) {
  // Restore rotation and flip
  state.rotation = savedState.rotation;
  state.flipped = savedState.flipped;
  DOM.storyImage.style.transform = `rotate(${state.rotation}deg) ${state.flipped ? 'scaleX(-1)' : ''}`;

  // Restore filter
  applyFilter(savedState.filter);

  // Restore drawing
  const img = new Image();
  img.onload = () => {
    const ctx = DOM.drawCanvas.getContext('2d');
    ctx.clearRect(0, 0, DOM.drawCanvas.width, DOM.drawCanvas.height);
    ctx.drawImage(img, 0, 0);
  };
  img.src = savedState.drawData;

  // Restore text elements
  DOM.textLayers.innerHTML = '';
  savedState.textElements.forEach(item => {
    const temp = document.createElement('div');
    temp.innerHTML = item.html;
    const el = temp.firstChild;
    makeDraggable(el);
    el.addEventListener('click', (e) => {
      e.stopPropagation();
      selectElement(el);
    });
    DOM.textLayers.appendChild(el);
  });

  // Restore stickers
  DOM.stickerLayers.innerHTML = '';
  savedState.stickerElements.forEach(html => {
    const temp = document.createElement('div');
    temp.innerHTML = html;
    const el = temp.firstChild;
    makeDraggable(el);
    el.addEventListener('click', (e) => {
      e.stopPropagation();
      selectElement(el);
    });
    DOM.stickerLayers.appendChild(el);
  });

  // Restore shapes
  DOM.shapeLayers.innerHTML = '';
  savedState.shapeElements.forEach(html => {
    const temp = document.createElement('div');
    temp.innerHTML = html;
    const el = temp.firstChild;
    makeDraggable(el);
    el.addEventListener('click', (e) => {
      e.stopPropagation();
      selectElement(el);
    });
    DOM.shapeLayers.appendChild(el);
  });
}

function updateUndoRedoButtons() {
  DOM.btnUndo.disabled = state.historyIndex <= 0;
  DOM.btnRedo.disabled = state.historyIndex >= state.history.length - 1;
}

// ── UTILITIES ────────────────────────────────────────────────────────────
function changeImage() {
  const input = document.createElement('input');
  input.type = 'file';
  input.accept = 'image/*';

  input.addEventListener('change', (e) => {
    const file = e.target.files[0];
    if (file) {
      const reader = new FileReader();
      reader.onload = (event) => {
        DOM.storyImage.src = event.target.result;
        resetImage();
        saveState();
      };
      reader.readAsDataURL(file);
    }
  });

  input.click();
}

function showShareModal() {
  DOM.shareModal.style.display = 'flex';
  DOM.shareModal.classList.add('fade-in');
}

function hideShareModal() {
  DOM.shareModal.style.display = 'none';
}

// Share modal buttons
document.querySelector('.btn-edit-more')?.addEventListener('click', hideShareModal);
document.querySelector('.btn-save-story')?.addEventListener('click', () => {
  // Export final story
  exportStory();
});

function exportStory() {
  // Create a composite canvas
  const exportCanvas = document.createElement('canvas');
  const exportCtx = exportCanvas.getContext('2d');

  exportCanvas.width = DOM.imageContainer.offsetWidth;
  exportCanvas.height = DOM.imageContainer.offsetHeight;

  // Draw base image
  exportCtx.drawImage(DOM.storyImage, 0, 0, exportCanvas.width, exportCanvas.height);

  // Draw drawing layer
  exportCtx.drawImage(DOM.drawCanvas, 0, 0);

  // TODO: Draw text, stickers, and shapes
  // (This would require html2canvas or similar library for production)

  // Download
  exportCanvas.toBlob((blob) => {
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `story-${Date.now()}.png`;
    a.click();
    URL.revokeObjectURL(url);

    alert('✅ Story saved successfully!');
    hideShareModal();
  }, 'image/png');
}

// Delete selected element (DEL/Backspace key)
document.addEventListener('keydown', (e) => {
  if (e.key === 'Delete' || e.key === 'Backspace') {
    const selected = document.querySelector('.text-element.selected, .sticker-element.selected, .shape-element.selected');
    if (selected && !selected.isContentEditable) {
      selected.remove();
      saveState();
    }
  }
});

// Deselect on canvas click
DOM.canvas.addEventListener('click', () => {
  document.querySelectorAll('.text-element, .sticker-element, .shape-element').forEach(el => {
    el.classList.remove('selected');
  });
});

// ── START APPLICATION ────────────────────────────────────────────────────
document.addEventListener('DOMContentLoaded', init);

// Listen for image data from parent window (when opened as popup)
window.addEventListener('message', (event) => {
  // Security: verify origin
  if (event.origin !== 'https://dskm35im55r5u.cloudfront.net') return;

  if (event.data && event.data.type === 'LOAD_IMAGE' && event.data.data) {
    const imageData = event.data.data;

    // Wait for editor to be initialized
    const waitForInit = setInterval(() => {
      const uploadInput = document.getElementById('uploadInput');
      if (uploadInput) {
        clearInterval(waitForInit);

        // Load image directly
        const img = new Image();
        img.onload = () => {
          state.originalImage = img;
          state.currentImage = img;
          updateCanvas();
          showEditor();
        };
        img.src = imageData;
      }
    }, 100);
  }
});

console.log('📱 Modern Story Editor - Ready!');

// ── LOAD IMAGE FROM URL PARAMETER ────────────────────────────────────────
// Check if image data is in sessionStorage (preferred) or URL parameter (fallback)
window.addEventListener('load', () => {
  // Try sessionStorage first (avoids URL length limits for base64 images)
  let imageData = null;
  try {
    imageData = sessionStorage.getItem('axStoryEditorImage');
    if (imageData) sessionStorage.removeItem('axStoryEditorImage'); // clean up after reading
  } catch (e) { /* sessionStorage unavailable */ }

  // Fallback to URL param if sessionStorage had nothing
  if (!imageData) {
    const params = new URLSearchParams(window.location.search);
    const raw = params.get('image');
    if (raw) imageData = decodeURIComponent(raw);
  }

  if (imageData) {
    console.log('🔄 Loading image for story editor...');
    try {
      const img = new Image();
      img.onload = () => {
        console.log('✅ Image loaded successfully!');
        DOM.storyImage.src = img.src;
        // Reset and save state
        state.rotation = 0;
        state.flipped = false;
        state.currentFilter = 'none';
        DOM.storyImage.style.transform = '';
        DOM.storyImage.style.filter = '';
        saveState();
      };
      img.onerror = () => {
        console.error('❌ Failed to load image');
      };
      img.src = imageData;
    } catch (e) {
      console.error('❌ Error loading image:', e);
    }
  }
});

