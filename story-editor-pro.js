/* ══════════════════════════════════════════════════════════════════════
   STORY EDITOR PRO — Complete JavaScript Implementation
   Features: Manual crop, live filters, canvas text, emoji/shapes, music
   ══════════════════════════════════════════════════════════════════════ */

class StoryEditor {
    constructor() {
        this.canvas = document.getElementById('storyCanvas');
        this.ctx = this.canvas.getContext('2d', { willReadFrequently: true });

        // State
        this.originalImage = null;
        this.currentImage = null;
        this.history = [];
        this.historyIndex = -1;
        this.currentTab = 'adjust';
        this.currentFilter = 'none';
        this.isFilterHoldDown = false;

        // Elements on canvas (text, emoji, shapes)
        this.canvasElements = [];
        this.selectedElement = null;

        // Transform state
        this.isDragging = false;
        this.isResizing = false;
        this.isRotating = false;
        this.dragStart = { x: 0, y: 0 };
        this.resizeHandle = null;

        // Crop state
        this.isCropping = false;
        this.cropRect = { x: 0, y: 0, width: 0, height: 0 };
        this.cropDragHandle = null;

        // Draw state
        this.isDrawing = false;
        this.drawColor = '#FFFFFF';
        this.drawTool = 'pen';
        this.brushSize = 5;
        this.drawPoints = [];

        this.init();
    }

    init() {
        this.setupCanvas();
        this.loadDemoImage();
        this.setupEventListeners();
        this.generateFilters();
        this.generateEmojis();
        this.generateMusic();
    }

    setupCanvas() {
        const container = document.getElementById('canvasContainer');
        const rect = container.getBoundingClientRect();

        // 9:16 aspect ratio for stories
        const aspectRatio = 9 / 16;
        let width = rect.width * 0.9;
        let height = width / aspectRatio;

        if (height > rect.height * 0.9) {
            height = rect.height * 0.9;
            width = height * aspectRatio;
        }

        this.canvas.width = width;
        this.canvas.height = height;

        // Set CSS size
        this.canvas.style.width = width + 'px';
        this.canvas.style.height = height + 'px';
    }

    loadDemoImage() {
        // Create a demo gradient background
        const img = new Image();
        img.onload = () => {
            this.originalImage = img;
            this.currentImage = img;
            this.drawCanvas();
            this.saveHistory();
        };

        // Create canvas with gradient
        const tempCanvas = document.createElement('canvas');
        tempCanvas.width = 1080;
        tempCanvas.height = 1920;
        const tempCtx = tempCanvas.getContext('2d');

        const gradient = tempCtx.createLinearGradient(0, 0, 0, 1920);
        gradient.addColorStop(0, '#667eea');
        gradient.addColorStop(1, '#764ba2');
        tempCtx.fillStyle = gradient;
        tempCtx.fillRect(0, 0, 1080, 1920);

        // Add text
        tempCtx.fillStyle = '#FFFFFF';
        tempCtx.font = 'bold 80px Inter';
        tempCtx.textAlign = 'center';
        tempCtx.fillText('Story Editor Pro', 540, 960);

        img.src = tempCanvas.toDataURL();
    }

    drawCanvas() {
        if (!this.currentImage) return;

        // Clear canvas
        this.ctx.clearRect(0, 0, this.canvas.width, this.canvas.height);

        // Draw image
        this.ctx.drawImage(this.currentImage, 0, 0, this.canvas.width, this.canvas.height);

        // Apply current filter if any
        if (this.currentFilter !== 'none' && !this.isFilterHoldDown) {
            this.applyFilter(this.currentFilter);
        }

        // Draw canvas elements (text, emoji, shapes)
        this.drawCanvasElements();
    }

    drawCanvasElements() {
        this.canvasElements.forEach(element => {
            this.ctx.save();

            const centerX = element.x + element.width / 2;
            const centerY = element.y + element.height / 2;

            this.ctx.translate(centerX, centerY);
            this.ctx.rotate(element.rotation || 0);
            this.ctx.translate(-centerX, -centerY);

            if (element.type === 'text') {
                this.ctx.font = `${element.fontSize}px ${element.fontFamily}`;
                this.ctx.fillStyle = element.color;
                this.ctx.textAlign = 'left';
                this.ctx.textBaseline = 'top';
                this.ctx.fillText(element.content, element.x, element.y);
            } else if (element.type === 'emoji') {
                this.ctx.font = `${element.fontSize}px Arial`;
                this.ctx.fillText(element.content, element.x, element.y);
            } else if (element.type === 'shape') {
                this.ctx.fillStyle = element.color;
                this.ctx.strokeStyle = element.color;
                this.ctx.lineWidth = 3;
                this.drawShape(element);
            }

            this.ctx.restore();
        });
    }

    drawShape(element) {
        const x = element.x;
        const y = element.y;
        const w = element.width;
        const h = element.height;

        this.ctx.beginPath();

        switch (element.shape) {
            case 'rectangle':
                this.ctx.fillRect(x, y, w, h);
                break;
            case 'circle':
                const radius = Math.min(w, h) / 2;
                this.ctx.arc(x + w / 2, y + h / 2, radius, 0, Math.PI * 2);
                this.ctx.fill();
                break;
            case 'line':
                this.ctx.moveTo(x, y + h / 2);
                this.ctx.lineTo(x + w, y + h / 2);
                this.ctx.stroke();
                break;
            case 'arrow':
                this.ctx.moveTo(x, y + h / 2);
                this.ctx.lineTo(x + w - 20, y + h / 2);
                this.ctx.lineTo(x + w - 30, y + h / 2 - 15);
                this.ctx.moveTo(x + w - 20, y + h / 2);
                this.ctx.lineTo(x + w - 30, y + h / 2 + 15);
                this.ctx.stroke();
                break;
            case 'star':
                this.drawStar(x + w / 2, y + h / 2, 5, w / 2, w / 4);
                this.ctx.fill();
                break;
            case 'heart':
                this.drawHeart(x + w / 2, y + h / 2, w / 2);
                this.ctx.fill();
                break;
        }
    }

    drawStar(cx, cy, spikes, outerRadius, innerRadius) {
        let rot = Math.PI / 2 * 3;
        let x = cx;
        let y = cy;
        const step = Math.PI / spikes;

        this.ctx.moveTo(cx, cy - outerRadius);
        for (let i = 0; i < spikes; i++) {
            x = cx + Math.cos(rot) * outerRadius;
            y = cy + Math.sin(rot) * outerRadius;
            this.ctx.lineTo(x, y);
            rot += step;

            x = cx + Math.cos(rot) * innerRadius;
            y = cy + Math.sin(rot) * innerRadius;
            this.ctx.lineTo(x, y);
            rot += step;
        }
        this.ctx.lineTo(cx, cy - outerRadius);
        this.ctx.closePath();
    }

    drawHeart(cx, cy, size) {
        const x = cx - size / 2;
        const y = cy - size / 2;

        this.ctx.moveTo(x + size / 2, y + size / 4);
        this.ctx.bezierCurveTo(x + size / 2, y, x, y, x, y + size / 4);
        this.ctx.bezierCurveTo(x, y + size / 2, x + size / 2, y + size * 0.75, x + size / 2, y + size);
        this.ctx.bezierCurveTo(x + size / 2, y + size * 0.75, x + size, y + size / 2, x + size, y + size / 4);
        this.ctx.bezierCurveTo(x + size, y, x + size / 2, y, x + size / 2, y + size / 4);
        this.ctx.closePath();
    }

    // ── HISTORY & UNDO/REDO ─────────────────────────────────────────────
    saveHistory() {
        const state = {
            image: this.currentImage,
            filter: this.currentFilter,
            elements: JSON.parse(JSON.stringify(this.canvasElements))
        };

        this.history = this.history.slice(0, this.historyIndex + 1);
        this.history.push(state);
        this.historyIndex++;

        // Update undo button
        const undoBtn = document.getElementById('btnUndo');
        if (undoBtn) {
            undoBtn.disabled = this.historyIndex <= 0;
        }
    }

    undo() {
        if (this.historyIndex > 0) {
            this.historyIndex--;
            const state = this.history[this.historyIndex];
            this.currentImage = state.image;
            this.currentFilter = state.filter;
            this.canvasElements = JSON.parse(JSON.stringify(state.elements));
            this.drawCanvas();

            document.getElementById('btnUndo').disabled = this.historyIndex <= 0;
        }
    }

    // ── FILTERS ─────────────────────────────────────────────────────────
    generateFilters() {
        const filters = [
            { name: 'None', filter: 'none' },
            { name: 'Pop', filter: 'pop' },
            { name: 'B&W', filter: 'bw' },
            { name: 'Cool', filter: 'cool' },
            { name: 'Chrome', filter: 'chrome' },
            { name: 'Warm', filter: 'warm' },
            { name: 'Vintage', filter: 'vintage' },
            { name: 'Fade', filter: 'fade' }
        ];

        const container = document.getElementById('filtersScroll');
        filters.forEach((f, index) => {
            const item = document.createElement('div');
            item.className = 'filter-item' + (index === 0 ? ' active' : '');
            item.innerHTML = `
                <div class="filter-preview">
                    <canvas width="80" height="100" data-filter="${f.filter}"></canvas>
                </div>
                <span class="filter-name">${f.name}</span>
            `;

            // Generate preview
            const previewCanvas = item.querySelector('canvas');
            const previewCtx = previewCanvas.getContext('2d');
            if (this.currentImage) {
                previewCtx.drawImage(this.currentImage, 0, 0, 80, 100);
                if (f.filter !== 'none') {
                    this.applyFilterToContext(previewCtx, f.filter, 80, 100);
                }
            }

            item.addEventListener('click', () => {
                document.querySelectorAll('.filter-item').forEach(el => el.classList.remove('active'));
                item.classList.add('active');
                this.currentFilter = f.filter;
                this.drawCanvas();
            });

            container.appendChild(item);
        });
    }

    applyFilter(filterName) {
        this.applyFilterToContext(this.ctx, filterName, this.canvas.width, this.canvas.height);
    }

    applyFilterToContext(ctx, filterName, width, height) {
        const imageData = ctx.getImageData(0, 0, width, height);
        const data = imageData.data;

        switch (filterName) {
            case 'bw':
                for (let i = 0; i < data.length; i += 4) {
                    const gray = data[i] * 0.299 + data[i + 1] * 0.587 + data[i + 2] * 0.114;
                    data[i] = data[i + 1] = data[i + 2] = gray;
                }
                break;
            case 'pop':
                for (let i = 0; i < data.length; i += 4) {
                    data[i] = Math.min(255, data[i] * 1.3);
                    data[i + 1] = Math.min(255, data[i + 1] * 1.3);
                    data[i + 2] = Math.min(255, data[i + 2] * 1.3);
                }
                break;
            case 'cool':
                for (let i = 0; i < data.length; i += 4) {
                    data[i] = Math.max(0, data[i] * 0.8);
                    data[i + 2] = Math.min(255, data[i + 2] * 1.2);
                }
                break;
            case 'warm':
                for (let i = 0; i < data.length; i += 4) {
                    data[i] = Math.min(255, data[i] * 1.2);
                    data[i + 1] = Math.min(255, data[i + 1] * 1.1);
                    data[i + 2] = Math.max(0, data[i + 2] * 0.8);
                }
                break;
            case 'chrome':
                for (let i = 0; i < data.length; i += 4) {
                    data[i] = Math.min(255, data[i] * 1.1);
                    data[i + 1] = Math.min(255, data[i + 1] * 1.1);
                    data[i + 2] = Math.min(255, data[i + 2] * 1.1);
                }
                break;
            case 'vintage':
                for (let i = 0; i < data.length; i += 4) {
                    const r = data[i];
                    const g = data[i + 1];
                    const b = data[i + 2];
                    data[i] = r * 0.393 + g * 0.769 + b * 0.189;
                    data[i + 1] = r * 0.349 + g * 0.686 + b * 0.168;
                    data[i + 2] = r * 0.272 + g * 0.534 + b * 0.131;
                }
                break;
            case 'fade':
                for (let i = 0; i < data.length; i += 4) {
                    data[i] = data[i] + (255 - data[i]) * 0.2;
                    data[i + 1] = data[i + 1] + (255 - data[i + 1]) * 0.2;
                    data[i + 2] = data[i + 2] + (255 - data[i + 2]) * 0.2;
                }
                break;
        }

        ctx.putImageData(imageData, 0, 0);
    }

    // ── ADJUST TAB ──────────────────────────────────────────────────────
    rotate90() {
        const tempCanvas = document.createElement('canvas');
        tempCanvas.width = this.canvas.height;
        tempCanvas.height = this.canvas.width;
        const tempCtx = tempCanvas.getContext('2d');

        tempCtx.translate(tempCanvas.width / 2, tempCanvas.height / 2);
        tempCtx.rotate(Math.PI / 2);
        tempCtx.drawImage(this.canvas, -this.canvas.width / 2, -this.canvas.height / 2);

        const img = new Image();
        img.onload = () => {
            this.currentImage = img;
            this.drawCanvas();
            this.saveHistory();
        };
        img.src = tempCanvas.toDataURL();
    }

    crop916() {
        const aspectRatio = 9 / 16;
        const currentRatio = this.canvas.width / this.canvas.height;

        let cropWidth, cropHeight, cropX, cropY;

        if (currentRatio > aspectRatio) {
            cropHeight = this.canvas.height;
            cropWidth = cropHeight * aspectRatio;
            cropX = (this.canvas.width - cropWidth) / 2;
            cropY = 0;
        } else {
            cropWidth = this.canvas.width;
            cropHeight = cropWidth / aspectRatio;
            cropX = 0;
            cropY = (this.canvas.height - cropHeight) / 2;
        }

        this.performCrop(cropX, cropY, cropWidth, cropHeight);
    }

    startManualCrop() {
        this.isCropping = true;
        const overlay = document.getElementById('cropOverlay');
        const cropBox = document.getElementById('cropBox');

        // Initialize crop rect
        const margin = 40;
        this.cropRect = {
            x: margin,
            y: margin,
            width: this.canvas.width - margin * 2,
            height: this.canvas.height - margin * 2
        };

        this.updateCropBox();
        overlay.style.display = 'flex';

        this.setupCropHandlers();
    }

    updateCropBox() {
        const cropBox = document.getElementById('cropBox');
        const canvasRect = this.canvas.getBoundingClientRect();

        cropBox.style.left = (canvasRect.left + this.cropRect.x) + 'px';
        cropBox.style.top = (canvasRect.top + this.cropRect.y) + 'px';
        cropBox.style.width = this.cropRect.width + 'px';
        cropBox.style.height = this.cropRect.height + 'px';
    }

    setupCropHandlers() {
        const handles = document.querySelectorAll('.crop-handle');
        handles.forEach(handle => {
            handle.addEventListener('mousedown', (e) => this.startCropDrag(e, handle));
            handle.addEventListener('touchstart', (e) => this.startCropDrag(e, handle));
        });
    }

    startCropDrag(e, handle) {
        e.preventDefault();
        e.stopPropagation();

        this.cropDragHandle = handle;
        const point = e.touches ? e.touches[0] : e;
        this.dragStart = { x: point.clientX, y: point.clientY };

        const onMove = (e) => this.handleCropDrag(e);
        const onEnd = () => {
            document.removeEventListener('mousemove', onMove);
            document.removeEventListener('mouseup', onEnd);
            document.removeEventListener('touchmove', onMove);
            document.removeEventListener('touchend', onEnd);
            this.cropDragHandle = null;
        };

        document.addEventListener('mousemove', onMove);
        document.addEventListener('mouseup', onEnd);
        document.addEventListener('touchmove', onMove);
        document.addEventListener('touchend', onEnd);
    }

    handleCropDrag(e) {
        if (!this.cropDragHandle) return;

        const point = e.touches ? e.touches[0] : e;
        const dx = point.clientX - this.dragStart.x;
        const dy = point.clientY - this.dragStart.y;

        const classList = this.cropDragHandle.classList;

        if (classList.contains('top-left')) {
            this.cropRect.x += dx;
            this.cropRect.y += dy;
            this.cropRect.width -= dx;
            this.cropRect.height -= dy;
        } else if (classList.contains('top-right')) {
            this.cropRect.y += dy;
            this.cropRect.width += dx;
            this.cropRect.height -= dy;
        } else if (classList.contains('bottom-left')) {
            this.cropRect.x += dx;
            this.cropRect.width -= dx;
            this.cropRect.height += dy;
        } else if (classList.contains('bottom-right')) {
            this.cropRect.width += dx;
            this.cropRect.height += dy;
        } else if (classList.contains('top')) {
            this.cropRect.y += dy;
            this.cropRect.height -= dy;
        } else if (classList.contains('bottom')) {
            this.cropRect.height += dy;
        } else if (classList.contains('left')) {
            this.cropRect.x += dx;
            this.cropRect.width -= dx;
        } else if (classList.contains('right')) {
            this.cropRect.width += dx;
        }

        // Constraints
        this.cropRect.width = Math.max(100, Math.min(this.cropRect.width, this.canvas.width));
        this.cropRect.height = Math.max(100, Math.min(this.cropRect.height, this.canvas.height));
        this.cropRect.x = Math.max(0, Math.min(this.cropRect.x, this.canvas.width - this.cropRect.width));
        this.cropRect.y = Math.max(0, Math.min(this.cropRect.y, this.canvas.height - this.cropRect.height));

        this.dragStart = { x: point.clientX, y: point.clientY };
        this.updateCropBox();
    }

    finalizeCrop() {
        this.performCrop(this.cropRect.x, this.cropRect.y, this.cropRect.width, this.cropRect.height);
        this.cancelCrop();
    }

    cancelCrop() {
        this.isCropping = false;
        document.getElementById('cropOverlay').style.display = 'none';
    }

    performCrop(x, y, width, height) {
        const tempCanvas = document.createElement('canvas');
        tempCanvas.width = width;
        tempCanvas.height = height;
        const tempCtx = tempCanvas.getContext('2d');

        tempCtx.drawImage(this.canvas, x, y, width, height, 0, 0, width, height);

        const img = new Image();
        img.onload = () => {
            this.currentImage = img;
            this.drawCanvas();
            this.saveHistory();
        };
        img.src = tempCanvas.toDataURL();
    }

    // ── TEXT TAB ────────────────────────────────────────────────────────
    addText(x, y) {
        const element = {
            type: 'text',
            content: 'Tap to edit',
            x: x - 50,
            y: y - 16,
            width: 200,
            height: 40,
            fontSize: 32,
            fontFamily: 'Inter',
            color: '#FFFFFF',
            rotation: 0
        };

        this.canvasElements.push(element);
        this.selectElement(element);
        this.drawCanvas();
        this.saveHistory();

        // Show text toolbar
        document.getElementById('textToolbar').style.display = 'flex';

        // Create editable textarea
        this.createTextInput(element);
    }

    createTextInput(element) {
        const textarea = document.createElement('textarea');
        textarea.className = 'canvas-text-input';
        textarea.value = element.content;
        textarea.style.left = element.x + 'px';
        textarea.style.top = element.y + 'px';
        textarea.style.fontSize = element.fontSize + 'px';
        textarea.style.fontFamily = element.fontFamily;
        textarea.style.color = element.color;

        const container = document.getElementById('canvasContainer');
        container.appendChild(textarea);

        textarea.focus();
        textarea.select();

        textarea.addEventListener('input', () => {
            element.content = textarea.value;
            this.drawCanvas();
        });

        textarea.addEventListener('blur', () => {
            if (textarea.value.trim() === '') {
                this.canvasElements = this.canvasElements.filter(el => el !== element);
                this.selectedElement = null;
                this.hideTransformControls();
            }
            textarea.remove();
            this.drawCanvas();
            this.saveHistory();
        });
    }

    // ── EMOJI & SHAPES ──────────────────────────────────────────────────
    generateEmojis() {
        const emojis = ['😀', '😁', '😂', '🤣', '😊', '😍', '🥰', '😘', '😎', '🤔', '😢', '😭', '😡', '🤬', '🙏', '👍', '👎', '👏', '💪', '🎉', '🔥', '✨', '💯', '🙌', '❤️', '💚', '💙', '💛', '🧡', '💜', '🖤', '🤍', '🤎', '💔', '❤️‍🔥', '💖', '💗', '💓', '💞', '💕', '💘', '💝', '🌹', '🌸', '🌺', '🌻', '🌼', '🌷'];

        const container = document.getElementById('emojiGrid');
        emojis.forEach(emoji => {
            const btn = document.createElement('button');
            btn.className = 'emoji-btn';
            btn.textContent = emoji;
            btn.addEventListener('click', () => this.addEmoji(emoji));
            container.appendChild(btn);
        });
    }

    addEmoji(emoji) {
        const element = {
            type: 'emoji',
            content: emoji,
            x: this.canvas.width / 2 - 30,
            y: this.canvas.height / 2 - 30,
            width: 60,
            height: 60,
            fontSize: 48,
            rotation: 0
        };

        this.canvasElements.push(element);
        this.selectElement(element);
        this.drawCanvas();
        this.saveHistory();
    }

    addShape(shapeName) {
        const element = {
            type: 'shape',
            shape: shapeName,
            x: this.canvas.width / 2 - 60,
            y: this.canvas.height / 2 - 60,
            width: 120,
            height: 120,
            color: '#FFFFFF',
            rotation: 0
        };

        this.canvasElements.push(element);
        this.selectElement(element);
        this.drawCanvas();
        this.saveHistory();

        // Show color picker
        document.getElementById('shapeColors').style.display = 'flex';
    }

    // ── ELEMENT SELECTION & TRANSFORM ───────────────────────────────────
    selectElement(element) {
        this.selectedElement = element;
        this.showTransformControls(element);
    }

    showTransformControls(element) {
        const controls = document.getElementById('transformControls');
        const box = document.getElementById('transformBox');
        const canvasRect = this.canvas.getBoundingClientRect();

        box.style.left = (canvasRect.left + element.x) + 'px';
        box.style.top = (canvasRect.top + element.y) + 'px';
        box.style.width = element.width + 'px';
        box.style.height = element.height + 'px';
        box.style.transform = `rotate(${element.rotation}rad)`;

        controls.style.display = 'block';
    }

    hideTransformControls() {
        document.getElementById('transformControls').style.display = 'none';
        this.selectedElement = null;
    }

    setupTransformHandlers() {
        const box = document.getElementById('transformBox');
        const handles = box.querySelectorAll('.transform-handle:not(.rotate-handle)');
        const rotateHandle = box.querySelector('.rotate-handle');

        // Drag to move
        box.addEventListener('mousedown', (e) => {
            if (e.target === box) this.startDrag(e);
        });

        // Resize handles
        handles.forEach(handle => {
            handle.addEventListener('mousedown', (e) => this.startResize(e, handle));
            handle.addEventListener('touchstart', (e) => this.startResize(e, handle));
        });

        // Rotate handle
        rotateHandle.addEventListener('mousedown', (e) => this.startRotate(e));
        rotateHandle.addEventListener('touchstart', (e) => this.startRotate(e));

        // Delete button
        document.getElementById('deleteSelected').addEventListener('click', () => {
            this.deleteSelectedElement();
        });
    }

    startDrag(e) {
        if (!this.selectedElement) return;
        e.preventDefault();

        this.isDragging = true;
        const point = e.touches ? e.touches[0] : e;
        this.dragStart = { x: point.clientX, y: point.clientY };

        const onMove = (e) => this.handleDrag(e);
        const onEnd = () => {
            this.isDragging = false;
            document.removeEventListener('mousemove', onMove);
            document.removeEventListener('mouseup', onEnd);
            document.removeEventListener('touchmove', onMove);
            document.removeEventListener('touchend', onEnd);
            this.saveHistory();
        };

        document.addEventListener('mousemove', onMove);
        document.addEventListener('mouseup', onEnd);
        document.addEventListener('touchmove', onMove);
        document.addEventListener('touchend', onEnd);
    }

    handleDrag(e) {
        if (!this.isDragging || !this.selectedElement) return;

        const point = e.touches ? e.touches[0] : e;
        const dx = point.clientX - this.dragStart.x;
        const dy = point.clientY - this.dragStart.y;

        this.selectedElement.x += dx;
        this.selectedElement.y += dy;

        this.dragStart = { x: point.clientX, y: point.clientY };
        this.drawCanvas();
        this.showTransformControls(this.selectedElement);
    }

    startResize(e, handle) {
        if (!this.selectedElement) return;
        e.preventDefault();
        e.stopPropagation();

        this.isResizing = true;
        this.resizeHandle = handle;
        const point = e.touches ? e.touches[0] : e;
        this.dragStart = { x: point.clientX, y: point.clientY };

        const onMove = (e) => this.handleResize(e);
        const onEnd = () => {
            this.isResizing = false;
            this.resizeHandle = null;
            document.removeEventListener('mousemove', onMove);
            document.removeEventListener('mouseup', onEnd);
            document.removeEventListener('touchmove', onMove);
            document.removeEventListener('touchend', onEnd);
            this.saveHistory();
        };

        document.addEventListener('mousemove', onMove);
        document.addEventListener('mouseup', onEnd);
        document.addEventListener('touchmove', onMove);
        document.addEventListener('touchend', onEnd);
    }

    handleResize(e) {
        if (!this.isResizing || !this.selectedElement) return;

        const point = e.touches ? e.touches[0] : e;
        const dx = point.clientX - this.dragStart.x;
        const dy = point.clientY - this.dragStart.y;

        const classList = this.resizeHandle.classList;

        if (classList.contains('bottom-right')) {
            this.selectedElement.width += dx;
            this.selectedElement.height += dy;
        } else if (classList.contains('bottom-left')) {
            this.selectedElement.x += dx;
            this.selectedElement.width -= dx;
            this.selectedElement.height += dy;
        } else if (classList.contains('top-right')) {
            this.selectedElement.y += dy;
            this.selectedElement.width += dx;
            this.selectedElement.height -= dy;
        } else if (classList.contains('top-left')) {
            this.selectedElement.x += dx;
            this.selectedElement.y += dy;
            this.selectedElement.width -= dx;
            this.selectedElement.height -= dy;
        }

        // Min size
        this.selectedElement.width = Math.max(30, this.selectedElement.width);
        this.selectedElement.height = Math.max(30, this.selectedElement.height);

        // Update font size for text/emoji
        if (this.selectedElement.type === 'text' || this.selectedElement.type === 'emoji') {
            this.selectedElement.fontSize = Math.max(12, Math.min(this.selectedElement.width, this.selectedElement.height));
        }

        this.dragStart = { x: point.clientX, y: point.clientY };
        this.drawCanvas();
        this.showTransformControls(this.selectedElement);
    }

    startRotate(e) {
        if (!this.selectedElement) return;
        e.preventDefault();
        e.stopPropagation();

        this.isRotating = true;
        const element = this.selectedElement;
        const centerX = element.x + element.width / 2;
        const centerY = element.y + element.height / 2;

        const point = e.touches ? e.touches[0] : e;
        const startAngle = Math.atan2(point.clientY - centerY, point.clientX - centerX);

        const onMove = (e) => {
            const point = e.touches ? e.touches[0] : e;
            const currentAngle = Math.atan2(point.clientY - centerY, point.clientX - centerX);
            element.rotation = currentAngle - startAngle;
            this.drawCanvas();
            this.showTransformControls(element);
        };

        const onEnd = () => {
            this.isRotating = false;
            document.removeEventListener('mousemove', onMove);
            document.removeEventListener('mouseup', onEnd);
            document.removeEventListener('touchmove', onMove);
            document.removeEventListener('touchend', onEnd);
            this.saveHistory();
        };

        document.addEventListener('mousemove', onMove);
        document.addEventListener('mouseup', onEnd);
        document.addEventListener('touchmove', onMove);
        document.addEventListener('touchend', onEnd);
    }

    deleteSelectedElement() {
        if (this.selectedElement) {
            this.canvasElements = this.canvasElements.filter(el => el !== this.selectedElement);
            this.selectedElement = null;
            this.hideTransformControls();
            this.drawCanvas();
            this.saveHistory();
        }
    }

    // ── MUSIC ───────────────────────────────────────────────────────────
    generateMusic() {
        const trendingSongs = [
            { title: 'Blinding Lights', artist: 'The Weeknd', cover: '🎵' },
            { title: 'Shape of You', artist: 'Ed Sheeran', cover: '🎸' },
            { title: 'Dance Monkey', artist: 'Tones and I', cover: '🎹' },
            { title: 'Levitating', artist: 'Dua Lipa', cover: '✨' },
            { title: 'Save Your Tears', artist: 'The Weeknd', cover: '💧' },
            { title: 'Good 4 U', artist: 'Olivia Rodrigo', cover: '🎤' },
            { title: 'Stay', artist: 'Justin Bieber', cover: '🎧' },
            { title: 'Heat Waves', artist: 'Glass Animals', cover: '🌊' }
        ];

        const container = document.getElementById('trendingMusic');
        trendingSongs.forEach(song => {
            const item = document.createElement('div');
            item.className = 'music-item';
            item.innerHTML = `
                <div class="music-cover">
                    <span style="font-size: 28px;">${song.cover}</span>
                </div>
                <div class="music-info">
                    <div class="music-title">${song.title}</div>
                    <div class="music-artist">${song.artist}</div>
                </div>
                <button class="music-action">
                    <i class="fa-solid fa-plus"></i>
                </button>
            `;

            item.querySelector('.music-action').addEventListener('click', (e) => {
                e.stopPropagation();
                this.addMusicToStory(song);
            });

            container.appendChild(item);
        });

        // Search functionality
        document.getElementById('musicSearch').addEventListener('input', (e) => {
            this.searchMusic(e.target.value);
        });
    }

    searchMusic(query) {
        const resultsContainer = document.getElementById('searchResults');
        if (!query.trim()) {
            resultsContainer.style.display = 'none';
            return;
        }

        resultsContainer.style.display = 'block';
        resultsContainer.innerHTML = '<p style="color: rgba(255,255,255,0.6); padding: 12px;">Searching...</p>';

        // Simulate search (in real app, call API)
        setTimeout(() => {
            resultsContainer.innerHTML = `
                <div class="music-item">
                    <div class="music-cover"><span style="font-size: 28px;">🎵</span></div>
                    <div class="music-info">
                        <div class="music-title">Search result for "${query}"</div>
                        <div class="music-artist">Various Artists</div>
                    </div>
                    <button class="music-action"><i class="fa-solid fa-plus"></i></button>
                </div>
            `;
        }, 500);
    }

    addMusicToStory(song) {
        alert(`Added "${song.title}" to your story! 🎵`);
    }

    // ── EVENT LISTENERS ─────────────────────────────────────────────────
    setupEventListeners() {
        // Tab switching
        document.querySelectorAll('.story-tab').forEach(tab => {
            tab.addEventListener('click', () => {
                this.switchTab(tab.dataset.tab);
            });
        });

        // Adjust controls
        document.getElementById('btnRotate').addEventListener('click', () => this.rotate90());
        document.getElementById('btnCrop916').addEventListener('click', () => this.crop916());
        document.getElementById('btnManualCrop').addEventListener('click', () => this.startManualCrop());
        document.getElementById('btnUndo').addEventListener('click', () => this.undo());

        // Crop controls
        document.getElementById('cropCancel').addEventListener('click', () => this.cancelCrop());
        document.getElementById('cropDone').addEventListener('click', () => this.finalizeCrop());

        // Text controls
        document.getElementById('btnAddText').addEventListener('click', () => {
            this.addText(this.canvas.width / 2, this.canvas.height / 2);
        });

        document.getElementById('fontFamily').addEventListener('change', (e) => {
            if (this.selectedElement && this.selectedElement.type === 'text') {
                this.selectedElement.fontFamily = e.target.value;
                this.drawCanvas();
                this.saveHistory();
            }
        });

        document.getElementById('textSizeUp').addEventListener('click', () => {
            if (this.selectedElement && this.selectedElement.type === 'text') {
                this.selectedElement.fontSize += 2;
                document.getElementById('textSizeDisplay').textContent = this.selectedElement.fontSize;
                this.drawCanvas();
                this.saveHistory();
            }
        });

        document.getElementById('textSizeDown').addEventListener('click', () => {
            if (this.selectedElement && this.selectedElement.type === 'text') {
                this.selectedElement.fontSize = Math.max(12, this.selectedElement.fontSize - 2);
                document.getElementById('textSizeDisplay').textContent = this.selectedElement.fontSize;
                this.drawCanvas();
                this.saveHistory();
            }
        });

        // Text colors
        document.querySelectorAll('#textColors .color-btn').forEach(btn => {
            btn.addEventListener('click', () => {
                if (this.selectedElement && this.selectedElement.type === 'text') {
                    document.querySelectorAll('#textColors .color-btn').forEach(b => b.classList.remove('active'));
                    btn.classList.add('active');
                    this.selectedElement.color = btn.dataset.color;
                    this.drawCanvas();
                    this.saveHistory();
                }
            });
        });

        // Shape buttons
        document.querySelectorAll('.shape-btn').forEach(btn => {
            btn.addEventListener('click', () => {
                this.addShape(btn.dataset.shape);
            });
        });

        // Shape colors
        document.querySelectorAll('#shapeColors .color-btn').forEach(btn => {
            btn.addEventListener('click', () => {
                if (this.selectedElement && this.selectedElement.type === 'shape') {
                    document.querySelectorAll('#shapeColors .color-btn').forEach(b => b.classList.remove('active'));
                    btn.classList.add('active');
                    this.selectedElement.color = btn.dataset.color;
                    this.drawCanvas();
                    this.saveHistory();
                }
            });
        });

        // Draw color
        document.querySelectorAll('#drawColors .color-btn').forEach(btn => {
            btn.addEventListener('click', () => {
                document.querySelectorAll('#drawColors .color-btn').forEach(b => b.classList.remove('active'));
                btn.classList.add('active');
                this.drawColor = btn.dataset.color;
            });
        });

        // Draw tools
        document.querySelectorAll('.tool-btn').forEach(btn => {
            btn.addEventListener('click', () => {
                document.querySelectorAll('.tool-btn').forEach(b => b.classList.remove('active'));
                btn.classList.add('active');
                this.drawTool = btn.dataset.tool;
            });
        });

        document.getElementById('brushSize').addEventListener('input', (e) => {
            this.brushSize = parseInt(e.target.value);
        });

        // Canvas interactions
        this.canvas.addEventListener('click', (e) => this.handleCanvasClick(e));
        this.canvas.addEventListener('mousedown', (e) => this.handleCanvasMouseDown(e));
        this.canvas.addEventListener('touchstart', (e) => this.handleCanvasTouchStart(e));

        // Filter hold down (to show original)
        this.canvas.addEventListener('mousedown', () => {
            if (this.currentTab === 'filters' && this.currentFilter !== 'none') {
                this.isFilterHoldDown = true;
                this.drawCanvas();
            }
        });

        this.canvas.addEventListener('mouseup', () => {
            if (this.isFilterHoldDown) {
                this.isFilterHoldDown = false;
                this.drawCanvas();
            }
        });

        this.canvas.addEventListener('touchstart', () => {
            if (this.currentTab === 'filters' && this.currentFilter !== 'none') {
                this.isFilterHoldDown = true;
                this.drawCanvas();
            }
        });

        this.canvas.addEventListener('touchend', () => {
            if (this.isFilterHoldDown) {
                this.isFilterHoldDown = false;
                this.drawCanvas();
            }
        });

        // Transform controls setup
        this.setupTransformHandlers();

        // Close button
        document.getElementById('btnClose').addEventListener('click', () => {
            if (confirm('Close story editor? Changes will be lost.')) {
                window.close();
            }
        });

        // Next button
        document.getElementById('btnNext').addEventListener('click', () => {
            this.exportStory();
        });
    }

    switchTab(tabName) {
        this.currentTab = tabName;

        // Update tab buttons
        document.querySelectorAll('.story-tab').forEach(tab => {
            tab.classList.toggle('active', tab.dataset.tab === tabName);
        });

        // Update content panels
        document.querySelectorAll('.content-panel').forEach(panel => {
            panel.classList.toggle('active', panel.dataset.panel === tabName);
        });

        // Hide transform controls when switching tabs (except text/stickers/shapes)
        if (!['text', 'stickers', 'shapes'].includes(tabName)) {
            this.hideTransformControls();
        }
    }

    handleCanvasClick(e) {
        const rect = this.canvas.getBoundingClientRect();
        const x = e.clientX - rect.left;
        const y = e.clientY - rect.top;

        if (this.currentTab === 'text') {
            // Check if clicking on existing text
            let clickedElement = null;
            for (let i = this.canvasElements.length - 1; i >= 0; i--) {
                const el = this.canvasElements[i];
                if (el.type === 'text' && this.isPointInElement(x, y, el)) {
                    clickedElement = el;
                    break;
                }
            }

            if (clickedElement) {
                this.selectElement(clickedElement);
                this.createTextInput(clickedElement);
            } else {
                this.addText(x, y);
            }
        } else if (['stickers', 'shapes'].includes(this.currentTab)) {
            // Check if clicking on existing element
            let clickedElement = null;
            for (let i = this.canvasElements.length - 1; i >= 0; i--) {
                const el = this.canvasElements[i];
                if (this.isPointInElement(x, y, el)) {
                    clickedElement = el;
                    break;
                }
            }

            if (clickedElement) {
                this.selectElement(clickedElement);
            } else {
                this.hideTransformControls();
            }
        }
    }

    isPointInElement(x, y, element) {
        return x >= element.x && x <= element.x + element.width &&
            y >= element.y && y <= element.y + element.height;
    }

    handleCanvasMouseDown(e) {
        if (this.currentTab === 'draw') {
            this.startDrawing(e);
        }
    }

    handleCanvasTouchStart(e) {
        if (this.currentTab === 'draw') {
            e.preventDefault();
            this.startDrawing(e.touches[0]);
        }
    }

    startDrawing(e) {
        this.isDrawing = true;
        const rect = this.canvas.getBoundingClientRect();
        const x = e.clientX - rect.left;
        const y = e.clientY - rect.top;

        this.drawPoints = [{ x, y }];

        const onMove = (e) => {
            if (!this.isDrawing) return;
            const point = e.touches ? e.touches[0] : e;
            const x = point.clientX - rect.left;
            const y = point.clientY - rect.top;
            this.drawPoints.push({ x, y });
            this.drawLine();
        };

        const onEnd = () => {
            this.isDrawing = false;
            document.removeEventListener('mousemove', onMove);
            document.removeEventListener('mouseup', onEnd);
            document.removeEventListener('touchmove', onMove);
            document.removeEventListener('touchend', onEnd);
            this.saveHistory();
        };

        document.addEventListener('mousemove', onMove);
        document.addEventListener('mouseup', onEnd);
        document.addEventListener('touchmove', onMove);
        document.addEventListener('touchend', onEnd);
    }

    drawLine() {
        if (this.drawPoints.length < 2) return;

        this.ctx.strokeStyle = this.drawColor;
        this.ctx.lineWidth = this.brushSize;
        this.ctx.lineCap = 'round';
        this.ctx.lineJoin = 'round';

        if (this.drawTool === 'eraser') {
            this.ctx.globalCompositeOperation = 'destination-out';
        } else {
            this.ctx.globalCompositeOperation = 'source-over';
        }

        if (this.drawTool === 'marker') {
            this.ctx.globalAlpha = 0.5;
        } else {
            this.ctx.globalAlpha = 1.0;
        }

        this.ctx.beginPath();
        this.ctx.moveTo(this.drawPoints[this.drawPoints.length - 2].x, this.drawPoints[this.drawPoints.length - 2].y);
        this.ctx.lineTo(this.drawPoints[this.drawPoints.length - 1].x, this.drawPoints[this.drawPoints.length - 1].y);
        this.ctx.stroke();

        this.ctx.globalCompositeOperation = 'source-over';
        this.ctx.globalAlpha = 1.0;
    }

    exportStory() {
        // Merge all elements to final image
        const exportCanvas = document.createElement('canvas');
        exportCanvas.width = this.canvas.width;
        exportCanvas.height = this.canvas.height;
        const exportCtx = exportCanvas.getContext('2d');

        // Draw current canvas state
        exportCtx.drawImage(this.canvas, 0, 0);

        // Export as data URL
        const dataURL = exportCanvas.toDataURL('image/png');

        // Download
        const link = document.createElement('a');
        link.download = 'story-' + Date.now() + '.png';
        link.href = dataURL;
        link.click();

        alert('Story exported successfully! 🎉');
    }
}

// Initialize when DOM is ready
document.addEventListener('DOMContentLoaded', () => {
    window.storyEditor = new StoryEditor();
});
