// ==================== НАСТРОЙКИ ====================
let BANNER_BOX = [91, 250, 1221, 620]; // [left, top, right, bottom] или null
let SS_BOXES = [
    [91, 680, 441, 880],
    [481, 680, 831, 880],
    [871, 680, 1221, 880]
];

const DEFAULT_BANNER_BOX = [91, 250, 1221, 620];
const DEFAULT_SS_BOXES = [
    [91, 680, 441, 880],
    [481, 680, 831, 880],
    [871, 680, 1221, 880]
];

let templateImg = null;
let isGenerating = false;
let stopGeneration = false;

const RESIZE_HIT = 10; // px — зона захвата края рамки

document.addEventListener('DOMContentLoaded', () => {
    const templateInput = document.getElementById('templateInput');
    const gamesListInput = document.getElementById('gamesList');
    const generateBtn = document.getElementById('generateBtn');
    const stopGenBtn = document.getElementById('stopGenBtn');
    const logsDiv = document.getElementById('logs');
    const exportLogsBtn = document.getElementById('exportLogsBtn');
    const previewCanvas = document.getElementById('previewCanvas');
    const previewCtx = previewCanvas.getContext('2d');

    const genModeSelect = document.getElementById('genModeSelect');
    const gamesListBlock = document.getElementById('gamesListBlock');
    const catalogBlock = document.getElementById('catalogBlock');
    const fetchCatalogBtn = document.getElementById('fetchCatalogBtn');
    const catalogStatus = document.getElementById('catalogStatus');

    const editorModal = document.getElementById('editorModal');
    const editorCanvas = document.getElementById('editorCanvas');
    const editorCtx = editorCanvas.getContext('2d');
    const btnOpenEditor = document.getElementById('btnOpenEditor');
    const btnCloseEditor = document.getElementById('btnCloseEditor');
    const helpModal = document.getElementById('helpModal');
    const btnHelp = document.getElementById('btnHelp');
    const btnCloseHelp = document.getElementById('btnCloseHelp');

    // --- Editor state ---
    let selectionMode = null;
    let isDrawing = false;
    let startX = 0, startY = 0;
    let currentRect = null;
    let currentMousePos = { x: 0, y: 0 };
    let isDraggingBox = false;
    let dragTarget = null;
    let dragTargetName = '';
    let dragLastPos = { x: 0, y: 0 };
    let isResizing = false;
    let resizeTarget = null; // { ref, name, handle }
    let resizeLast = { x: 0, y: 0 };
    let lastBoxWidth = 0, lastBoxHeight = 0;
    let hoveredBoxName = null;

    // ==========================================================
    // STORAGE
    // ==========================================================
    typeof chrome !== 'undefined' && chrome.storage && chrome.storage.local.get(
        ['generatorGamesList', 'generatorCoords', 'generatorSource', 'generatorMode', 'steamgriddbApiKey', 'generatorTemplate'], (res) => {
            if (res.generatorGamesList) gamesListInput.value = res.generatorGamesList;
            if (res.generatorCoords) {
                if ('banner' in res.generatorCoords) BANNER_BOX = res.generatorCoords.banner;
                if (res.generatorCoords.ss) SS_BOXES = res.generatorCoords.ss;
                log('⚙️ Загружены координаты.');
            }
            if (res.generatorSource) {
                document.getElementById('imageSourceSelect').value = res.generatorSource;
                updateSteamGridDbKeyVisibility(res.generatorSource);
            }
            if (res.steamgriddbApiKey) {
                const inp = document.getElementById('steamgriddbApiKey');
                if (inp) inp.value = res.steamgriddbApiKey;
            }
            if (res.generatorMode) {
                genModeSelect.value = res.generatorMode;
                updateGenModeUI(res.generatorMode);
            }
            if (res.generatorTemplate) {
                const img = new Image();
                img.onload = () => {
                    templateImg = img;
                    previewCanvas.width = img.width;
                    previewCanvas.height = img.height;
                    editorCanvas.width = img.width;
                    editorCanvas.height = img.height;
                    redrawPreviewCanvas();
                    log('⚙️ Шаблон восстановлен из кэша.');
                };
                img.src = res.generatorTemplate;
            }
            updateZonesUI();
        });

    gamesListInput.addEventListener('input', () => {
        chrome.storage.local.set({ generatorGamesList: gamesListInput.value });
    });

    function updateSteamGridDbKeyVisibility(source) {
        const row = document.getElementById('steamgriddbKeyRow');
        if (row) row.style.display = source === 'steamgriddb' ? 'block' : 'none';
    }

    document.getElementById('imageSourceSelect').addEventListener('change', (e) => {
        chrome.storage.local.set({ generatorSource: e.target.value });
        updateSteamGridDbKeyVisibility(e.target.value);
    });

    const sgdbKeyInput = document.getElementById('steamgriddbApiKey');
    sgdbKeyInput?.addEventListener('input', () => {
        chrome.storage.local.set({ steamgriddbApiKey: sgdbKeyInput.value });
    });
    genModeSelect.addEventListener('change', (e) => {
        chrome.storage.local.set({ generatorMode: e.target.value });
        updateGenModeUI(e.target.value);
    });

    const imageSourceRow = document.getElementById('imageSourceRow');

    function updateGenModeUI(mode) {
        if (mode === 'steampass_catalog') {
            gamesListBlock.style.display = 'none';
            catalogBlock.style.display = 'block';
            // In catalog mode image source is always SteamPass — hide selector
            if (imageSourceRow) imageSourceRow.style.display = 'none';
        } else {
            gamesListBlock.style.display = 'block';
            catalogBlock.style.display = 'none';
            if (imageSourceRow) imageSourceRow.style.display = 'block';
        }
        // Sync mode to shared key so auto-publisher can read it
        chrome.storage.local.set({ generatorMode: mode });
    }

    function saveCoords() {
        chrome.storage.local.set({ generatorCoords: { banner: BANNER_BOX, ss: SS_BOXES } });
    }

    // ==========================================================
    // LOGGING
    // ==========================================================
    const logLines = [];
    function log(msg) {
        const ts = new Date().toLocaleTimeString();
        const line = `[${ts}] ${msg}`;
        logLines.push(line);
        logsDiv.textContent += msg + '\n';
        logsDiv.scrollTop = logsDiv.scrollHeight;
        console.log('[Generator]', msg);
    }

    exportLogsBtn?.addEventListener('click', () => {
        const text = logLines.join('\n');
        const blob = new Blob([text], { type: 'text/plain' });
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = `generator_log_${new Date().toISOString().slice(0, 10)}.txt`;
        a.click();
        URL.revokeObjectURL(url);
    });

    // ==========================================================
    // TEMPLATE LOAD
    // ==========================================================
    templateInput.addEventListener('change', (e) => {
        const file = e.target.files[0];
        if (!file) return;
        const reader = new FileReader();
        reader.onload = (ev) => {
            const img = new Image();
            img.onload = () => {
                templateImg = img;
                previewCanvas.width = img.width;
                previewCanvas.height = img.height;
                editorCanvas.width = img.width;
                editorCanvas.height = img.height;
                redrawPreviewCanvas();
                log('✅ Шаблон загружен.');
            };
            img.src = ev.target.result;
            chrome.storage.local.set({ generatorTemplate: ev.target.result });
        };
        reader.readAsDataURL(file);
    });

    // ==========================================================
    // EDITOR OPEN/CLOSE
    // ==========================================================
    btnOpenEditor?.addEventListener('click', () => {
        if (!templateImg) { alert('Сначала загрузите шаблон!'); return; }
        editorModal.classList.remove('hidden');
        redrawEditorCanvas();
    });
    btnCloseEditor?.addEventListener('click', () => {
        editorModal.classList.add('hidden');
        setSelectionMode(null);
        redrawPreviewCanvas();
    });
    btnHelp?.addEventListener('click', () => helpModal.classList.remove('hidden'));
    btnCloseHelp?.addEventListener('click', () => helpModal.classList.add('hidden'));
    helpModal?.addEventListener('click', (e) => {
        if (e.target === helpModal) helpModal.classList.add('hidden');
    });

    // ==========================================================
    // DRAWING / CANVAS
    // ==========================================================
    function redrawPreviewCanvas() {
        if (!templateImg) return;
        previewCtx.clearRect(0, 0, previewCanvas.width, previewCanvas.height);
        previewCtx.drawImage(templateImg, 0, 0);
        if (BANNER_BOX) drawOverlayBox(previewCtx, BANNER_BOX, 'rgba(0,255,0,0.2)', 'rgba(0,255,0,0.8)', false);
        SS_BOXES.forEach((box, i) => {
            if (box) drawOverlayBox(previewCtx, box, 'rgba(0,150,255,0.2)', 'rgba(0,150,255,0.8)', false);
        });
    }

    function redrawEditorCanvas() {
        if (!templateImg) return;
        editorCtx.clearRect(0, 0, editorCanvas.width, editorCanvas.height);
        editorCtx.drawImage(templateImg, 0, 0);

        if (BANNER_BOX) {
            drawOverlayBox(editorCtx, BANNER_BOX, 'rgba(0,255,0,0.2)', 'rgba(0,255,0,0.9)', true);
            drawBoxLabel(editorCtx, BANNER_BOX, 'Баннер');
        }
        SS_BOXES.forEach((box, i) => {
            if (box) {
                drawOverlayBox(editorCtx, box, 'rgba(0,150,255,0.2)', 'rgba(0,150,255,0.9)', true);
                drawBoxLabel(editorCtx, box, `СС ${i + 1}`);
            }
        });

        if (isDrawing && currentRect) {
            const b = [
                Math.min(startX, currentRect.x), Math.min(startY, currentRect.y),
                Math.max(startX, currentRect.x), Math.max(startY, currentRect.y)
            ];
            drawOverlayBox(editorCtx, b, 'rgba(255,0,0,0.3)', 'rgba(255,0,0,1)', false);
            const w = b[2] - b[0], h = b[3] - b[1];
            drawTextLabel(editorCtx, `${Math.round(w)} × ${Math.round(h)} px`, b[2] + 5, b[3] + 5);
        } else if (selectionMode) {
            let txt = `X: ${Math.round(currentMousePos.x)}, Y: ${Math.round(currentMousePos.y)}`;
            if (lastBoxWidth > 0) txt += ` | Клик → ${Math.round(lastBoxWidth)}×${Math.round(lastBoxHeight)}`;
            drawTextLabel(editorCtx, txt, currentMousePos.x + 15, currentMousePos.y + 15);
        }
    }

    function drawOverlayBox(ctx, box, fill, stroke, showHandles) {
        if (!box) return;
        ctx.fillStyle = fill;
        ctx.strokeStyle = stroke;
        ctx.lineWidth = 2;
        const w = box[2] - box[0], h = box[3] - box[1];
        ctx.fillRect(box[0], box[1], w, h);
        ctx.strokeRect(box[0], box[1], w, h);
        if (showHandles) drawResizeHandles(ctx, box, stroke);
    }

    function drawResizeHandles(ctx, box, color) {
        const cx = (box[0] + box[2]) / 2, cy = (box[1] + box[3]) / 2;
        const pts = [
            [box[0], box[1]], [cx, box[1]], [box[2], box[1]],
            [box[0], cy],                   [box[2], cy],
            [box[0], box[3]], [cx, box[3]], [box[2], box[3]]
        ];
        ctx.fillStyle = '#fff';
        ctx.strokeStyle = color;
        ctx.lineWidth = 1.5;
        pts.forEach(([x, y]) => {
            ctx.beginPath();
            ctx.rect(x - 5, y - 5, 10, 10);
            ctx.fill();
            ctx.stroke();
        });
    }

    function drawBoxLabel(ctx, box, label) {
        const x = box[0] + 4, y = box[1] + 16;
        ctx.save();
        ctx.font = 'bold 13px Consolas, monospace';
        const m = ctx.measureText(label);
        ctx.fillStyle = 'rgba(0,0,0,0.6)';
        ctx.fillRect(x - 2, y - 13, m.width + 6, 17);
        ctx.fillStyle = '#fff';
        ctx.fillText(label, x, y);
        ctx.restore();
    }

    function drawTextLabel(ctx, text, x, y) {
        ctx.save();
        ctx.font = '13px Consolas, monospace';
        const tw = ctx.measureText(text).width;
        // clamp inside canvas
        const cx = Math.min(x, editorCanvas.width - tw - 12);
        const cy = Math.min(y, editorCanvas.height - 8);
        ctx.fillStyle = 'rgba(0,0,0,0.75)';
        ctx.fillRect(cx, cy - 14, tw + 8, 20);
        ctx.fillStyle = '#00ff00';
        ctx.fillText(text, cx + 4, cy);
        ctx.restore();
    }

    // ==========================================================
    // HIT DETECTION (interior → move, edge → resize)
    // ==========================================================
    function getResizeHandle(x, y) {
        const tryBox = (box, name) => {
            if (!box) return null;
            const cx = (box[0] + box[2]) / 2, cy = (box[1] + box[3]) / 2;
            const near = (a, b) => Math.abs(a - b) <= RESIZE_HIT;
            const nearTop = near(y, box[1]), nearBot = near(y, box[3]);
            const nearLeft = near(x, box[0]), nearRight = near(x, box[2]);
            const nearMidX = near(x, cx), nearMidY = near(y, cy);
            const insideX = x >= box[0] - RESIZE_HIT && x <= box[2] + RESIZE_HIT;
            const insideY = y >= box[1] - RESIZE_HIT && y <= box[3] + RESIZE_HIT;
            if (!insideX || !insideY) return null;

            if (nearTop && nearLeft) return { ref: box, name, handle: 'nw' };
            if (nearTop && nearRight) return { ref: box, name, handle: 'ne' };
            if (nearBot && nearLeft) return { ref: box, name, handle: 'sw' };
            if (nearBot && nearRight) return { ref: box, name, handle: 'se' };
            if (nearTop && nearMidX) return { ref: box, name, handle: 'n' };
            if (nearBot && nearMidX) return { ref: box, name, handle: 's' };
            if (nearLeft && nearMidY) return { ref: box, name, handle: 'w' };
            if (nearRight && nearMidY) return { ref: box, name, handle: 'e' };
            return null;
        };

        let r = BANNER_BOX ? tryBox(BANNER_BOX, 'banner') : null;
        if (r) return r;
        for (let i = 0; i < SS_BOXES.length; i++) {
            r = tryBox(SS_BOXES[i], `ss${i}`);
            if (r) return r;
        }
        return null;
    }

    function getHitBox(x, y) {
        const tryBox = (box, name) => {
            if (!box) return null;
            if (x >= box[0] + RESIZE_HIT && x <= box[2] - RESIZE_HIT &&
                y >= box[1] + RESIZE_HIT && y <= box[3] - RESIZE_HIT) {
                return { ref: box, name };
            }
            return null;
        };
        let r = BANNER_BOX ? tryBox(BANNER_BOX, 'banner') : null;
        if (r) return r;
        for (let i = 0; i < SS_BOXES.length; i++) {
            r = tryBox(SS_BOXES[i], `ss${i}`);
            if (r) return r;
        }
        return null;
    }

    const RESIZE_CURSORS = {
        n: 'n-resize', s: 's-resize', e: 'e-resize', w: 'w-resize',
        ne: 'ne-resize', nw: 'nw-resize', se: 'se-resize', sw: 'sw-resize'
    };

    function applyResize(box, handle, dx, dy) {
        if (handle.includes('n')) box[1] = Math.min(box[1] + dy, box[3] - 20);
        if (handle.includes('s')) box[3] = Math.max(box[3] + dy, box[1] + 20);
        if (handle.includes('w')) box[0] = Math.min(box[0] + dx, box[2] - 20);
        if (handle.includes('e')) box[2] = Math.max(box[2] + dx, box[0] + 20);
    }

    // ==========================================================
    // MOUSE EVENTS
    // ==========================================================
    function getCanvasPos(e) {
        const rect = editorCanvas.getBoundingClientRect();
        return {
            x: (e.clientX - rect.left) * (editorCanvas.width / rect.width),
            y: (e.clientY - rect.top) * (editorCanvas.height / rect.height)
        };
    }

    editorCanvas.addEventListener('mousedown', (e) => {
        if (!templateImg) return;
        if (e.button !== 0) return;
        const { x, y } = getCanvasPos(e);

        // 1. Resize handle?
        const rh = getResizeHandle(x, y);
        if (rh) {
            isResizing = true;
            resizeTarget = rh;
            resizeLast = { x, y };
            return;
        }

        // 2. Move interior?
        const hit = getHitBox(x, y);
        if (hit) {
            isDraggingBox = true;
            dragTarget = hit.ref;
            dragTargetName = hit.name;
            dragLastPos = { x, y };
            return;
        }

        // 3. Draw new box (if mode active)
        if (!selectionMode) return;
        startX = x; startY = y;
        isDrawing = true;
        currentRect = { x, y };
    });

    editorCanvas.addEventListener('mousemove', (e) => {
        const { x, y } = getCanvasPos(e);
        currentMousePos = { x, y };

        if (isResizing && resizeTarget) {
            const dx = Math.round(x - resizeLast.x);
            const dy = Math.round(y - resizeLast.y);
            applyResize(resizeTarget.ref, resizeTarget.handle, dx, dy);
            resizeLast = { x, y };
            redrawEditorCanvas();
            return;
        }

        if (isDraggingBox && dragTarget) {
            const dx = Math.round(x - dragLastPos.x);
            const dy = Math.round(y - dragLastPos.y);
            dragTarget[0] += dx; dragTarget[1] += dy;
            dragTarget[2] += dx; dragTarget[3] += dy;
            dragLastPos = { x, y };
            redrawEditorCanvas();
            return;
        }

        if (isDrawing) {
            currentRect = { x, y };
            redrawEditorCanvas();
            return;
        }

        // Cursor feedback
        const rh = getResizeHandle(x, y);
        if (rh) {
            editorCanvas.style.cursor = RESIZE_CURSORS[rh.handle] || 'pointer';
            hoveredBoxName = rh.name;
        } else {
            const hit = getHitBox(x, y);
            if (hit) {
                editorCanvas.style.cursor = 'move';
                hoveredBoxName = hit.name;
            } else if (selectionMode) {
                editorCanvas.style.cursor = 'crosshair';
                hoveredBoxName = null;
                redrawEditorCanvas();
            } else {
                editorCanvas.style.cursor = 'default';
                hoveredBoxName = null;
            }
        }
    });

    editorCanvas.addEventListener('mouseup', (e) => {
        if (isResizing) {
            isResizing = false;
            const name = resizeTarget?.name || '?';
            const box = resizeTarget?.ref;
            resizeTarget = null;
            saveCoords();
            if (box) log(`↔️ Размер изменён (${name}): ${box.map(Math.round).join(', ')}`);
            redrawEditorCanvas();
            return;
        }

        if (isDraggingBox) {
            isDraggingBox = false;
            saveCoords();
            log(`🚚 Перемещено (${dragTargetName}): ${JSON.stringify(dragTarget)}`);
            dragTarget = null;
            redrawEditorCanvas();
            return;
        }

        if (!isDrawing) return;
        isDrawing = false;

        const { x: endX, y: endY } = getCanvasPos(e);
        const dX = Math.abs(endX - startX), dY = Math.abs(endY - startY);

        let newBox;
        if (dX < 5 && dY < 5 && lastBoxWidth > 0) {
            const hw = lastBoxWidth / 2, hh = lastBoxHeight / 2;
            newBox = [Math.round(endX - hw), Math.round(endY - hh), Math.round(endX + hw), Math.round(endY + hh)];
            log(`📐 Клонирован размер: ${Math.round(lastBoxWidth)}×${Math.round(lastBoxHeight)} px`);
        } else {
            newBox = [
                Math.round(Math.min(startX, endX)), Math.round(Math.min(startY, endY)),
                Math.round(Math.max(startX, endX)), Math.round(Math.max(startY, endY))
            ];
        }

        if (newBox[2] - newBox[0] > 10 && newBox[3] - newBox[1] > 10) {
            lastBoxWidth = newBox[2] - newBox[0];
            lastBoxHeight = newBox[3] - newBox[1];

            if (selectionMode === 'banner') BANNER_BOX = newBox;
            else {
                const idx = parseInt(selectionMode.replace('ss', ''));
                if (!isNaN(idx)) {
                    while (SS_BOXES.length <= idx) SS_BOXES.push(null);
                    SS_BOXES[idx] = newBox;
                }
            }
            saveCoords();
            log(`🎯 Рамка (${selectionMode}): ${JSON.stringify(newBox)}`);
        }
        setSelectionMode(null);
        redrawEditorCanvas();
    });

    // Right-click: delete box
    editorCanvas.addEventListener('contextmenu', (e) => {
        e.preventDefault();
        const { x, y } = getCanvasPos(e);
        const rh = getResizeHandle(x, y) || getHitBox(x, y);
        if (!rh) return;
        const nameMap = { banner: 'Баннер' };
        SS_BOXES.forEach((_, i) => { nameMap[`ss${i}`] = `Скриншот ${i + 1}`; });
        if (confirm(`Удалить рамку "${nameMap[rh.name] || rh.name}"?`)) deleteBox(rh.name);
    });

    // Delete key
    document.addEventListener('keydown', (e) => {
        if (!editorModal || editorModal.classList.contains('hidden')) return;
        if (e.key === 'Delete' && hoveredBoxName) {
            const nameMap = { banner: 'Баннер' };
            SS_BOXES.forEach((_, i) => { nameMap[`ss${i}`] = `Скриншот ${i + 1}`; });
            if (confirm(`Удалить рамку "${nameMap[hoveredBoxName] || hoveredBoxName}"?`)) {
                deleteBox(hoveredBoxName);
                hoveredBoxName = null;
            }
        }
    });

    // ==========================================================
    // DELETE BOX
    // ==========================================================
    function deleteBox(name) {
        if (name === 'banner') {
            BANNER_BOX = null;
            log('🗑️ Баннер удалён.');
        } else {
            const idx = parseInt(name.replace('ss', ''));
            if (!isNaN(idx) && idx < SS_BOXES.length) {
                SS_BOXES[idx] = null;
                log(`🗑️ Скриншот ${idx + 1} удалён.`);
            }
        }
        saveCoords();
        updateZonesUI();
        redrawEditorCanvas();
        redrawPreviewCanvas();
    }

    // ==========================================================
    // ZONES PANEL (toolbar)
    // ==========================================================
    const btnToggleBanner = document.getElementById('btnToggleBanner');
    const btnAddSS = document.getElementById('btnAddSS');
    const btnRemoveSS = document.getElementById('btnRemoveSS');
    const ssCountDisplay = document.getElementById('ssCountDisplay');
    const drawBtnsContainer = document.getElementById('drawBtnsContainer');

    function updateZonesUI() {
        // Banner toggle button
        if (btnToggleBanner) {
            if (BANNER_BOX) {
                btnToggleBanner.textContent = '✅ Баннер';
                btnToggleBanner.style.background = '#1a3d1a';
                btnToggleBanner.style.color = '#4caf50';
            } else {
                btnToggleBanner.textContent = '⬜ Баннер';
                btnToggleBanner.style.background = '#333';
                btnToggleBanner.style.color = '#888';
            }
        }

        // Screenshot count
        const ssCount = SS_BOXES.length;
        if (ssCountDisplay) ssCountDisplay.textContent = ssCount;
        if (btnRemoveSS) btnRemoveSS.disabled = ssCount <= 0;
        if (btnAddSS) btnAddSS.disabled = ssCount >= 8;

        // Rebuild draw mode buttons
        if (!drawBtnsContainer) return;
        drawBtnsContainer.innerHTML = '';

        if (BANNER_BOX !== null) {
            const btn = makeModeBtn('banner', 'Баннер');
            drawBtnsContainer.appendChild(btn);
        }
        SS_BOXES.forEach((box, i) => {
            const btn = makeModeBtn(`ss${i}`, `СС ${i + 1}`);
            if (!box) btn.title = 'Не нарисовано — кликните чтобы нарисовать';
            drawBtnsContainer.appendChild(btn);
        });

        // Re-attach active state if still valid
        if (selectionMode) {
            const active = drawBtnsContainer.querySelector(`[data-mode="${selectionMode}"]`);
            if (active) active.classList.add('active');
        }
    }

    function makeModeBtn(mode, label) {
        const btn = document.createElement('button');
        btn.className = 'btn-toolbar';
        btn.dataset.mode = mode;
        btn.textContent = `✏️ ${label}`;
        btn.addEventListener('click', () => setSelectionMode(mode));
        return btn;
    }

    function setSelectionMode(mode) {
        if (selectionMode === mode) mode = null;
        selectionMode = mode;
        drawBtnsContainer?.querySelectorAll('.btn-toolbar').forEach(b => b.classList.remove('active'));
        if (mode) {
            const active = drawBtnsContainer?.querySelector(`[data-mode="${mode}"]`);
            if (active) active.classList.add('active');
            editorCanvas.style.cursor = 'crosshair';
        } else {
            editorCanvas.style.cursor = 'default';
        }
    }

    btnToggleBanner?.addEventListener('click', () => {
        if (BANNER_BOX) {
            BANNER_BOX = null;
            log('Баннер отключён.');
        } else {
            BANNER_BOX = [...DEFAULT_BANNER_BOX];
            log('Баннер включён (позиция по умолчанию, нарисуйте свою).');
        }
        saveCoords();
        updateZonesUI();
        redrawEditorCanvas();
        redrawPreviewCanvas();
    });

    btnAddSS?.addEventListener('click', () => {
        if (SS_BOXES.length >= 8) return;
        SS_BOXES.push(null);
        saveCoords();
        updateZonesUI();
        log(`➕ Добавлен слот скриншота ${SS_BOXES.length} (нарисуйте рамку).`);
        redrawEditorCanvas();
    });

    btnRemoveSS?.addEventListener('click', () => {
        if (SS_BOXES.length <= 0) return;
        const removed = SS_BOXES.pop();
        saveCoords();
        updateZonesUI();
        log(`➖ Слот скриншота ${SS_BOXES.length + 1} удалён.`);
        redrawEditorCanvas();
        redrawPreviewCanvas();
    });

    document.getElementById('btnResetCoords')?.addEventListener('click', () => {
        BANNER_BOX = [...DEFAULT_BANNER_BOX];
        SS_BOXES = JSON.parse(JSON.stringify(DEFAULT_SS_BOXES));
        saveCoords();
        setSelectionMode(null);
        updateZonesUI();
        redrawEditorCanvas();
        redrawPreviewCanvas();
        log('🔄 Координаты сброшены по умолчанию.');
    });

    // ==========================================================
    // STEAMPASS CATALOG FETCH
    // ==========================================================
    let catalogGames = [];

    fetchCatalogBtn?.addEventListener('click', async () => {
        fetchCatalogBtn.disabled = true;
        catalogStatus.textContent = '⏳ Загружаю каталог SteamPass...';
        log('📥 Загрузка каталога SteamPass...');
        try {
            catalogGames = await fetchSteamPassCatalog((done, total) => {
                catalogStatus.textContent = `⏳ Загружено: ${done}${total ? ' / ' + total : ''} игр`;
            });
            catalogStatus.textContent = `✅ Загружено ${catalogGames.length} игр`;
            log(`✅ Каталог: ${catalogGames.length} игр`);
        } catch (e) {
            catalogStatus.textContent = `❌ Ошибка: ${e.message}`;
            log(`❌ Каталог: ${e.message}`);
        }
        fetchCatalogBtn.disabled = false;
    });

    async function fetchSteamPassCatalog(onProgress) {
        // API: POST /api/product/filter?page=N&per_page=N
        // Body: { orders: [["release_date", "desc"]] }
        const PER_PAGE = 100;
        const BODY = JSON.stringify({ orders: [['release_date', 'desc']] });
        const all = [];
        let page = 1;
        let total = null;

        while (true) {
            const url = `https://steampass.gg/api/product/filter?page=${page}&per_page=${PER_PAGE}`;
            let data = null;
            try {
                const r = await fetch(url, {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: BODY
                });
                if (!r.ok) throw new Error(`HTTP ${r.status}`);
                data = await r.json();
            } catch (e) {
                throw new Error(`Страница ${page}: ${e.message}`);
            }

            const items = Array.isArray(data?.data) ? data.data : [];
            if (!items.length) break;

            // Capture total on first page
            if (page === 1) {
                total = data?.total || data?.meta?.total || data?.pagination?.total || null;
                log(`  ℹ️ Всего в каталоге: ${total ?? '???'} игр`);
            }

            items.forEach(item => all.push(mapItem(item)));
            if (onProgress) onProgress(all.length, total);

            if (items.length < PER_PAGE) break; // last page
            if (total && all.length >= total) break;
            page++;
            if (page > 300) break; // hard cap ~30 000 games

            await new Promise(r => setTimeout(r, 150));
        }

        return all.filter(i => i.name);
    }

    function mapItem(item) {
        return {
            name: item.name || item.title || item.product_name || '',
            id: item.id,
            banner: item.background_url || item.image_url || null,
            icon: item.icon_url || null
        };
    }

    // ==========================================================
    // IMAGE APIS
    // ==========================================================
    // Fetch screenshots (and optionally banner) from SteamPass product detail
    async function getSteamPassProductDetail(id) {
        try {
            const r = await fetch(`https://steampass.gg/api/product/${id}`);
            if (!r.ok) return { banner: null, screenshots: [] };
            const data = await r.json();
            const p = data?.product || data?.data || data;
            if (!p) return { banner: null, screenshots: [] };
            const banner = p.background_url || p.header_image_url || p.background ||
                p.image_url || p.thumbnail_url || null;
            const slotN = SS_BOXES.filter(Boolean).length || 3;
            // +1: если баннер забрал первый скрин, для 3 слотов всё ещё хватает уникальных URL
            const maxSS = Math.min(slotN + 1, 20);
            let screenshots = [];
            if (Array.isArray(p.screenshots)) {
                screenshots = p.screenshots.slice(0, maxSS)
                    .map(s => typeof s === 'string' ? s : (s.path_full || s.path || s.url))
                    .filter(Boolean);
            }
            return { banner, screenshots };
        } catch (e) {
            log(`[!] SteamPass product detail error: ${e.message}`);
            return { banner: null, screenshots: [] };
        }
    }

    /** Не использовать items[0] — часто попадает чужая популярная игра. Возвращает { item, score }. */
    function bestMatchByName(items, searchName, getNameFn) {
        if (!items || !items.length) return null;
        const norm = (s) => String(s || '').toLowerCase().trim().replace(/\s+/g, ' ');
        // Нормализация без ™/®/© для точного сравнения
        const normClean = (s) => norm(s).replace(/[™®©]/g, '').replace(/\s+/g, ' ').trim();
        const query = norm(searchName);
        const queryClean = normClean(searchName);
        const mainTitle = query.split(/[:\u2013\u2014\-]/)[0].trim();
        function scoreItem(itemName) {
            const n = norm(itemName);
            const nc = normClean(itemName);
            if (!n) return 0;
            // Точное совпадение с учётом ™/®
            if (n === query || nc === queryClean) return 100;
            if (mainTitle.length > 3 && (n === mainTitle || nc === mainTitle)) return 92;
            if (mainTitle.length > 3 && (n.startsWith(mainTitle) || nc.startsWith(mainTitle))) {
                // Тайбрейкер: штраф за лишние символы после mainTitle (чем длиннее — тем хуже)
                const extra = nc.length - queryClean.length;
                return Math.max(60, 80 - Math.min(18, extra * 2));
            }
            if (mainTitle.length > 3 && (n.includes(mainTitle) || nc.includes(mainTitle))) return 65;
            // Токенный матч: числа учитываем даже если короткие
            const tokenFilter = t => t.length > 2 || /^\d+$/.test(t);
            const qt = new Set(query.split(/\s+/).filter(tokenFilter));
            const nt = new Set(n.split(/\s+/).filter(tokenFilter));
            let inter = 0;
            for (const t of qt) if (nt.has(t)) inter++;
            const u = qt.size + nt.size - inter;
            return u ? Math.round((inter / u) * 55) : 0;
        }
        let best = null, bestScore = -1;
        for (const it of items) {
            const sc = scoreItem(getNameFn(it));
            if (sc > bestScore) { bestScore = sc; best = it; }
        }
        if (bestScore >= 38) return { item: best, score: bestScore };
        if (items.length === 1 && bestScore >= 22) return { item: best, score: bestScore };
        return null;
    }

    // Search SteamPass by name — лучшее совпадение по имени
    async function searchSteamPass(name) {
        const q = String(name || '').replace(/\s+/g, ' ').trim();
        try {
            const r = await fetch('https://steampass.gg/api/product/filter', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ name: q })
            });
            const data = await r.json();
            const items = data?.data || [];
            console.log('[CardGen][SteamPass filter]', { query: q, total: items.length, firstNames: items.slice(0, 6).map(i => i.name || i.title || '?') });
            const match = bestMatchByName(items, q, i => i.name || i.title || '');
            if (match) {
                const pick = match.item;
                const pickedName = pick.name || pick.title || '';
                console.log('[CardGen][SteamPass pick]', { id: pick.id, name: pickedName, score: match.score });
                log(`  📌 SteamPass: выбран id=${pick.id} «${pickedName}» (score ${match.score})`);
                return {
                    id: pick.id,
                    banner: pick.background_url || pick.image_url || null,
                    icon: pick.icon_url || null,
                    pickedName
                };
            }
            console.warn('[CardGen][SteamPass] нет совпадения по порогу score (нужно ≥38 или 1 результат ≥22)', { query: q, total: items.length });
            log(`  [!] SteamPass: нет уверенного совпадения для «${q}» (см. консоль F12)`);
        } catch (e) { log(`[!] SteamPass search error: ${e.message}`); console.error('[CardGen][SteamPass]', e); }
        return null;
    }

    /** Прямой фетч по Steam AppID — минует fuzzy-поиск */
    async function getAssetsSteamByAppId(appId) {
        try {
            const slotN = SS_BOXES.filter(Boolean).length || 3;
            const maxSS = Math.min(slotN + 1, 20);
            const r = await fetch(`https://store.steampowered.com/api/appdetails?appids=${appId}&cc=RU&l=russian`);
            const d2 = await r.json();
            if (d2?.[appId]?.success) {
                const d = d2[appId].data;
                log(`  📌 Steam AppID ${appId}: «${d.name}»`);
                return {
                    banner: d.background_raw || d.header_image,
                    screenshots: (d.screenshots || []).slice(0, maxSS).map(s => s.path_full)
                };
            }
        } catch (e) { console.error('[CardGen][Steam AppID]', e); }
        return { banner: null, screenshots: [] };
    }

    async function getAssetsSteam(name) {
        const q = String(name || '').replace(/\s+/g, ' ').trim();
        for (const { lang, cc } of [{ lang: 'english', cc: 'US' }, { lang: 'russian', cc: 'RU' }]) {
            try {
                const r1 = await fetch(`https://store.steampowered.com/api/storesearch/?term=${encodeURIComponent(q)}&l=${lang}&cc=${cc}`);
                const d1 = await r1.json();
                if (d1.total > 0 && d1.items?.length > 0) {
                    const match = bestMatchByName(d1.items, q, i => i.name || '');
                    if (!match) continue;
                    const chosen = match.item;
                    const appId = chosen.id;
                    const r2 = await fetch(`https://store.steampowered.com/api/appdetails?appids=${appId}&cc=RU&l=russian`);
                    const d2 = await r2.json();
                    if (d2?.[appId]?.success) {
                        const d = d2[appId].data;
                        const slotN = SS_BOXES.filter(Boolean).length || 3;
                        const maxSS = Math.min(slotN + 1, 20);
                        const apiName = d.name || chosen.name || '';
                        console.log('[CardGen][Steam]', { query: q, lang, cc, appId, chosenName: chosen.name, apiName, score: match.score });
                        log(`  📌 Steam: app ${appId} «${apiName}» (score ${match.score})`);
                        return {
                            banner: d.background_raw || d.header_image,
                            screenshots: (d.screenshots || []).slice(0, maxSS).map(s => s.path_full)
                        };
                    }
                }
            } catch (e) { console.error('[CardGen][Steam]', e); }
        }
        console.warn('[CardGen][Steam] пусто для', q);
        return { banner: null, screenshots: [] };
    }

    // ==========================================================
    // AG.RU — поиск игры + скриншоты
    // ==========================================================

    /** Поиск игры на ag.ru по названию. Возвращает { slug, name, banner } или null */
    async function searchAgRu(name) {
        const q = String(name || '').trim();
        if (!q) return null;
        try {
            const r = await fetch(`https://ag.ru/games?search=${encodeURIComponent(q)}`);
            if (!r.ok) throw new Error(`HTTP ${r.status}`);
            const html = await r.text();

            // Ищем все "g-{slug}": ключи и парсим каждый блок по позиции
            // (нельзя использовать [^}] — внутри блока есть вложенные объекты)
            const keyRe = /"g-[a-z0-9][a-z0-9\-]*":\{/g;
            const games = [];
            let km;
            while ((km = keyRe.exec(html)) !== null) {
                // Берём окно 1200 символов от начала блока
                const chunk = html.substring(km.index, km.index + 1200);
                const slugM = chunk.match(/"slug":"([^"]+)"/);
                const nameM = chunk.match(/"name":"([^"]+)"/);
                const imgM  = chunk.match(/"background_image":"(https:\\u002F\\u002Fcdn\.ag\.ru[^"]+)"/);
                if (slugM && nameM && imgM) {
                    games.push({
                        slug:   slugM[1],
                        name:   nameM[1],
                        banner: imgM[1].replace(/\\u002F/g, '/')
                    });
                }
            }

            if (!games.length) {
                log(`  [!] ag.ru: ничего не найдено для «${q}»`);
                return null;
            }

            console.log('[CardGen][ag.ru search]', { query: q, total: games.length, names: games.slice(0, 6).map(g => g.name) });
            const match = bestMatchByName(games, q, g => g.name);
            if (match) {
                const g = match.item;
                log(`  📌 ag.ru: «${g.name}» (slug: ${g.slug}, score ${match.score})`);
                return g;
            }
            log(`  [!] ag.ru: нет уверенного совпадения для «${q}» (всего в выдаче: ${games.length})`);
            return null;
        } catch (e) {
            log(`  [!] ag.ru search error: ${e.message}`);
            console.error('[CardGen][ag.ru]', e);
            return null;
        }
    }

    /** Получает скриншоты со страницы ag.ru/games/{slug}/screenshots */
    async function getAgRuScreenshots(slug) {
        if (!slug) return [];
        try {
            const slotN = SS_BOXES.filter(Boolean).length || 3;
            const maxSS = Math.min(slotN + 2, 12);
            const r = await fetch(`https://ag.ru/games/${encodeURIComponent(slug)}/screenshots`);
            if (!r.ok) throw new Error(`HTTP ${r.status}`);
            const html = await r.text();
            // Screenshots: "image":"https://cdn.ag.ru/media/screenshots/..."
            const re = /"image":"(https:\\u002F\\u002Fcdn\.ag\.ru\\u002Fmedia\\u002Fscreenshots[^"]+)"/g;
            const urls = [];
            let m;
            while ((m = re.exec(html)) !== null) {
                const url = m[1].replace(/\\u002F/g, '/');
                if (!urls.includes(url)) urls.push(url);
                if (urls.length >= maxSS) break;
            }
            return urls;
        } catch (e) {
            log(`  [!] ag.ru screenshots error: ${e.message}`);
            return [];
        }
    }

    // ==========================================================
    // STEAMGRIDDB — поиск игры + изображения высокого качества
    // ==========================================================

    function getSteamGridDbKey() {
        return (document.getElementById('steamgriddbApiKey')?.value || '').trim();
    }

    /**
     * Поиск игры на SteamGridDB по названию.
     * Возвращает { id, name } или null.
     */
    async function searchSteamGridDB(name) {
        const apiKey = getSteamGridDbKey();
        if (!apiKey) { log(`  [!] SteamGridDB: API-ключ не указан`); return null; }
        const q = String(name || '').trim();
        if (!q) return null;
        try {
            const r = await fetch(
                `https://www.steamgriddb.com/api/v2/search/autocomplete/${encodeURIComponent(q)}`,
                { headers: { Authorization: `Bearer ${apiKey}` } }
            );
            if (!r.ok) {
                if (r.status === 401) log(`  [!] SteamGridDB: неверный API-ключ (401)`);
                else log(`  [!] SteamGridDB search: HTTP ${r.status}`);
                return null;
            }
            const data = await r.json();
            const items = data?.data || [];
            if (!items.length) { log(`  [!] SteamGridDB: ничего не найдено для «${q}»`); return null; }
            const match = bestMatchByName(items, q, i => i.name || '');
            if (match) {
                log(`  📌 SteamGridDB: «${match.item.name}» (id: ${match.item.id}, score ${match.score})`);
                return match.item;
            }
            log(`  [!] SteamGridDB: нет уверенного совпадения для «${q}»`);
            return null;
        } catch (e) {
            log(`  [!] SteamGridDB search error: ${e.message}`);
            return null;
        }
    }

    /**
     * Получает изображения с SteamGridDB для найденной игры.
     * Возвращает { banner, screenshots }.
     * banner  = hero (широкий арт 1920x620 или аналог)
     * screenshots = grid горизонтальные обложки (920x430 или 460x215)
     */
    async function getSteamGridDBImages(gameId) {
        const apiKey = getSteamGridDbKey();
        if (!apiKey || !gameId) return { banner: null, screenshots: [] };

        const slotN = SS_BOXES.filter(Boolean).length || 3;
        const maxSS = Math.min(slotN + 2, 10);

        async function sgdbFetch(endpoint) {
            try {
                const url = `https://www.steamgriddb.com/api/v2/${endpoint}`;
                const r = await fetch(url, { headers: { Authorization: `Bearer ${apiKey}` } });
                console.log(`[SGDB] ${endpoint} → HTTP ${r.status}`);
                if (!r.ok) {
                    const txt = await r.text().catch(() => '');
                    console.warn(`[SGDB] ${endpoint} error body:`, txt.slice(0, 200));
                    return [];
                }
                const d = await r.json();
                console.log(`[SGDB] ${endpoint} → success:${d?.success}, count:${d?.data?.length}`, d?.data?.slice?.(0,2));
                return d?.data || [];
            } catch (e) {
                console.error(`[SGDB] ${endpoint} exception:`, e);
                return [];
            }
        }

        // Hero images — широкие баннеры (лучший источник для баннера карточки)
        const heroes = await sgdbFetch(`heroes/game/${gameId}`);
        const banner = heroes.find(h => h.url)?.url || null;
        if (banner) log(`  … SteamGridDB heroes: ${heroes.length} шт., баннер выбран`);

        // Screenshots — игровые скриншоты (основной источник для слотов карточки)
        const sgdbScreenshots = await sgdbFetch(`screenshots/game/${gameId}`);
        console.log(`[SGDB] screenshots raw count: ${sgdbScreenshots.length}`, sgdbScreenshots.slice(0,2));
        let screenshots = sgdbScreenshots.filter(s => s.url).slice(0, maxSS).map(s => s.url);
        if (screenshots.length) log(`  … SteamGridDB screenshots: ${screenshots.length} шт.`);

        // Если скриншотов нет — fallback на горизонтальные grids (460x215 / 920x430)
        if (!screenshots.length) {
            const allGrids = await sgdbFetch(`grids/game/${gameId}?dimensions=460x215,920x430`);
            console.log(`[SGDB] grids horz raw count: ${allGrids.length}`, allGrids.slice(0,2));
            const horzGrids = allGrids.filter(g => g.url);
            if (horzGrids.length) {
                screenshots = horzGrids.slice(0, maxSS).map(g => g.url);
                log(`  … SteamGridDB grids (горизонтальные): ${screenshots.length} шт.`);
            }
        }

        // Если всё пусто — дополнительные heroes как скриншоты
        if (!screenshots.length) {
            console.log(`[SGDB] all empty, heroes extra:`, heroes.length);
            const extra = heroes.filter(h => h.url).slice(1, maxSS + 1).map(h => h.url);
            return { banner, screenshots: extra };
        }
        console.log(`[SGDB] final screenshots:`, screenshots);

        return { banner, screenshots };
    }

    // ==========================================================
    // IMAGE LOAD (blob) — как content_bridge: альтернативы CDN + запас из скрина
    // ==========================================================
    function extractSteamAppId(url) {
        const m = String(url || '').match(/\/apps\/(\d+)\//);
        return m ? m[1] : null;
    }

    function steamHeaderAlternateUrls(appId) {
        return [
            `https://cdn.akamai.steamstatic.com/steam/apps/${appId}/header.jpg`,
            `https://steamcdn-a.akamaihd.net/steam/apps/${appId}/header.jpg`,
            `https://cdn.cloudflare.steamstatic.com/steam/apps/${appId}/header.jpg`,
            `https://cdn.akamai.steamstatic.com/steam/apps/${appId}/library_hero.jpg`,
            `https://cdn.akamai.steamstatic.com/steam/apps/${appId}/capsule_616x353.jpg`
        ];
    }

    /** Порядок: основной баннер, затем те же пути на других CDN по appid (из баннера или из 1-го скрина). */
    function buildBannerCandidateUrls(primaryBanner, screenshotUrls) {
        const out = [];
        const push = (u) => {
            const s = String(u || '').trim();
            if (s && !out.includes(s)) out.push(s);
        };
        push(primaryBanner);
        let aid = extractSteamAppId(primaryBanner);
        if (!aid && Array.isArray(screenshotUrls) && screenshotUrls[0]) {
            aid = extractSteamAppId(screenshotUrls[0]);
        }
        if (aid) for (const u of steamHeaderAlternateUrls(aid)) push(u);
        return out;
    }

    const IMAGE_FETCH_MS = 20000;

    async function loadImage(url) {
        if (!url) return null;
        const ctrl = new AbortController();
        const timer = setTimeout(() => ctrl.abort(), IMAGE_FETCH_MS);
        try {
            const r = await fetch(url, { signal: ctrl.signal });
            if (!r.ok) return null;
            const blob = await r.blob();
            return await new Promise((resolve) => {
                const img = new Image();
                img.onload = () => { URL.revokeObjectURL(img.src); resolve(img); };
                img.onerror = () => resolve(null);
                img.src = URL.createObjectURL(blob);
            });
        } catch (e) {
            return null;
        } finally {
            clearTimeout(timer);
        }
    }

    async function loadImageFirstOk(urls) {
        if (!urls || !urls.length) return { img: null, usedUrl: null };
        for (const u of urls) {
            const img = await loadImage(u);
            if (img) return { img, usedUrl: u };
        }
        return { img: null, usedUrl: null };
    }

    /** Уникальные URL подряд (API иногда дублирует). */
    function uniqScreenshotUrls(pool) {
        const seen = new Set();
        const out = [];
        for (const u of pool || []) {
            const s = String(u || '').trim();
            if (!s || seen.has(s)) continue;
            seen.add(s);
            out.push(s);
        }
        return out;
    }

    /**
     * URL для каждого слота миниатюр: один раз убираем кадр, ушедший в баннер (часто ss[0]),
     * затем добиваем слоты циклом по пулу — иначе при 3 скринах и fallback-баннере 3-й слот пустой.
     */
    function thumbSlotUrls(ssPool, bannerUsedUrl, numSlots) {
        const pool = uniqScreenshotUrls(ssPool);
        if (!numSlots) return [];
        const skip = bannerUsedUrl ? String(bannerUsedUrl).trim() : '';
        const out = [];
        let skippedOnce = false;
        for (const u of pool) {
            if (!skippedOnce && skip && u === skip) {
                skippedOnce = true;
                continue;
            }
            out.push(u);
            if (out.length >= numSlots) return out.slice(0, numSlots);
        }
        let p = out.length;
        while (out.length < numSlots && pool.length) {
            out.push(pool[p % pool.length]);
            p++;
        }
        return out.slice(0, numSlots);
    }

    // ==========================================================
    // ROUNDED RECT DRAW
    // ==========================================================
    function drawRoundedRect(ctx, img, x, y, w, h, radius) {
        ctx.save();
        ctx.beginPath();
        ctx.moveTo(x + radius, y);
        ctx.lineTo(x + w - radius, y);
        ctx.quadraticCurveTo(x + w, y, x + w, y + radius);
        ctx.lineTo(x + w, y + h - radius);
        ctx.quadraticCurveTo(x + w, y + h, x + w - radius, y + h);
        ctx.lineTo(x + radius, y + h);
        ctx.quadraticCurveTo(x, y + h, x, y + h - radius);
        ctx.lineTo(x, y + radius);
        ctx.quadraticCurveTo(x, y, x + radius, y);
        ctx.closePath();
        ctx.clip();
        ctx.drawImage(img, x, y, w, h);
        ctx.restore();
    }

    /** Стереть демо из шаблона (иначе при сбое load остаётся Spider-Man и т.п.). */
    function fillRoundedRectPreview(ctx, fillStyle, x, y, w, h, radius) {
        ctx.save();
        ctx.beginPath();
        ctx.moveTo(x + radius, y);
        ctx.lineTo(x + w - radius, y);
        ctx.quadraticCurveTo(x + w, y, x + w, y + radius);
        ctx.lineTo(x + w, y + h - radius);
        ctx.quadraticCurveTo(x + w, y + h, x + w - radius, y + h);
        ctx.lineTo(x + radius, y + h);
        ctx.quadraticCurveTo(x, y + h, x, y + h - radius);
        ctx.lineTo(x, y + radius);
        ctx.quadraticCurveTo(x, y, x + radius, y);
        ctx.closePath();
        ctx.fillStyle = fillStyle;
        ctx.fill();
        ctx.restore();
    }

    // ==========================================================
    // DOWNLOAD
    // ==========================================================
    async function downloadImage(dataUrl, filename) {
        if (typeof chrome !== 'undefined' && chrome.downloads) {
            return new Promise(res => {
                chrome.downloads.download({
                    url: dataUrl,
                    filename: `output_cards/${filename.replace(/[\/\\]/g, '_')}`,
                    saveAs: false, conflictAction: 'overwrite'
                }, () => res());
            });
        }
        const a = document.createElement('a');
        a.href = dataUrl; a.download = filename; a.click();
    }

    // ==========================================================
    // GENERATE
    // ==========================================================
    generateBtn.addEventListener('click', async () => {
        if (!templateImg) { alert('Сначала загрузите шаблон!'); return; }

        const mode = genModeSelect?.value || 'list';
        const imageSource = document.getElementById('imageSourceSelect')?.value || 'steam';

        let gameEntries = []; // { name, uuid? }

        if (mode === 'steampass_catalog') {
            if (!catalogGames.length) {
                alert('Сначала загрузите каталог SteamPass (нажмите "Загрузить каталог")!');
                return;
            }
            gameEntries = catalogGames;
        } else {
            const text = gamesListInput.value.trim();
            if (!text) { alert('Введите хотя бы одну игру!'); return; }
            gameEntries = text.split('\n').map(g => g.trim()).filter(Boolean).map(n => ({ name: n }));
        }

        isGenerating = true;
        stopGeneration = false;
        generateBtn.disabled = true;
        if (stopGenBtn) { stopGenBtn.disabled = false; stopGenBtn.style.display = 'inline-block'; }
        logsDiv.textContent = '';
        const srcLabel = mode === 'steampass_catalog' ? 'SteamPass (каталог)'
            : imageSource === 'steampass' ? 'SteamPass'
            : imageSource === 'agru' ? 'AG.ru'
            : imageSource === 'steamgriddb' ? 'SteamGridDB'
            : 'Steam';
        log(`🚀 Генерация: ${gameEntries.length} игр | Источник: ${srcLabel}`);

        const activeSS = SS_BOXES.filter(Boolean);

        for (let i = 0; i < gameEntries.length; i++) {
            if (stopGeneration) { log('⏹ Остановлено.'); break; }
            const entry = gameEntries[i];
            const rawName = entry.name || entry;
            // Извлекаем явный Steam AppID формата "Название [1238810]" или "Название[1238810]"
            const appIdMatch = rawName.match(/\[(\d{4,10})\]\s*$/);
            const forcedAppId = appIdMatch ? appIdMatch[1] : null;
            const cleanName = rawName
                .replace(/\[\d{4,10}\]\s*$/, '')   // убираем [AppID] из отображаемого имени
                .replace(/[✨🎮]/g, '')
                .replace(/ОФФЛАЙН АКТИВАЦИЯ/gi, '')
                .trim();

            log(`\n⏳ [${i + 1}/${gameEntries.length}] ${cleanName}${forcedAppId ? ` [AppID: ${forcedAppId}]` : ''}`);

            let banner = null, screenshots = [];

            try {
                if (mode === 'steampass_catalog') {
                    // Catalog mode: banner already in entry, only need to fetch screenshots
                    banner = entry.banner || null;
                    if (entry.id) {
                        const detail = await getSteamPassProductDetail(entry.id);
                        if (detail.screenshots.length) screenshots = detail.screenshots;
                        if (!banner && detail.banner) banner = detail.banner;
                    }
                    if (!banner) log(`  [!] Нет баннера для: ${cleanName}`);
                } else {
                    // List mode: source = steam (default) or steampass
                    if (forcedAppId) {
                        // Явный AppID — идём прямо в Steam, поиск не нужен
                        const assets = await getAssetsSteamByAppId(forcedAppId);
                        banner = assets.banner;
                        screenshots = assets.screenshots;
                        if (!banner) {
                            log(`  ↳ Прямой AppID ${forcedAppId}: баннер не получен, пробую SteamPass...`);
                            const found = await searchSteamPass(cleanName);
                            if (found) {
                                const d = await getSteamPassProductDetail(found.id);
                                banner = found.banner || d.banner;
                                if (d.screenshots && d.screenshots.length) screenshots = d.screenshots;
                            }
                        }
                    } else if (imageSource === 'steamgriddb') {
                        // SteamGridDB source
                        const found = await searchSteamGridDB(cleanName);
                        if (found) {
                            const imgs = await getSteamGridDBImages(found.id);
                            banner = imgs.banner;
                            screenshots = imgs.screenshots;
                            // Если heroes пустые — фолбэк на Steam
                            if (!banner && !screenshots.length) {
                                log(`  ↳ SteamGridDB: нет изображений → фолбэк на Steam`);
                                const fb = await getAssetsSteam(cleanName);
                                banner = fb.banner; screenshots = fb.screenshots;
                            }
                        } else {
                            log(`  ↳ SteamGridDB не нашёл → фолбэк на Steam`);
                            const fb = await getAssetsSteam(cleanName);
                            banner = fb.banner; screenshots = fb.screenshots;
                        }
                    } else if (imageSource === 'agru') {
                        // AG.ru source
                        const found = await searchAgRu(cleanName);
                        if (found) {
                            banner = found.banner;
                            const agScreenshots = await getAgRuScreenshots(found.slug);
                            screenshots = agScreenshots;
                            log(`  … ag.ru: баннер ${banner ? 'да' : 'нет'}, скринов ${screenshots.length}`);
                            if (!banner && !screenshots.length) {
                                log(`  ↳ ag.ru пусто → фолбэк на Steam`);
                                const fb = await getAssetsSteam(cleanName);
                                banner = fb.banner;
                                screenshots = fb.screenshots;
                            } else if (!banner && screenshots.length) {
                                // Нет баннера — берём первый скриншот как баннер
                                banner = screenshots[0];
                            }
                        } else {
                            log(`  ↳ ag.ru не нашёл → фолбэк на Steam`);
                            const fb = await getAssetsSteam(cleanName);
                            banner = fb.banner;
                            screenshots = fb.screenshots;
                        }
                    } else if (imageSource === 'steampass') {
                        let found = entry.id
                            ? { id: entry.id, banner: entry.banner }
                            : await searchSteamPass(cleanName);
                        if (found) {
                            banner = found.banner;
                            const detail = await getSteamPassProductDetail(found.id);
                            screenshots = detail.screenshots || [];
                            if (!banner) banner = detail.banner;
                            console.log('[CardGen] SteamPass detail', { productId: found.id, ssCount: screenshots.length, hasBanner: !!banner });
                            log(`  … detail: скринов ${screenshots.length}, баннер ${banner ? 'да' : 'нет'}`);
                            // Если в API нет скринов — подмешивать только Steam целиком, иначе типичный баг: баннер с обложки одного товара + скрины из другого поиска
                            if (!screenshots.length) {
                                log(`  ↳ В карточке SteamPass нет скринов → полный набор из Steam (один источник)`);
                                const fb = await getAssetsSteam(cleanName);
                                if (fb.screenshots.length) {
                                    screenshots = fb.screenshots;
                                    banner = fb.banner || banner;
                                }
                            }
                        } else {
                            log(`  ↳ SteamPass filter не вернул совпадение → только Steam`);
                            const fb = await getAssetsSteam(cleanName);
                            banner = fb.banner;
                            screenshots = fb.screenshots;
                        }
                        if (!banner) {
                            log(`  ↳ Всё ещё без баннера, добор Steam...`);
                            const fb = await getAssetsSteam(cleanName);
                            banner = fb.banner;
                            if (!screenshots.length) screenshots = fb.screenshots;
                        }
                    } else {
                        // Steam (default for list mode)
                        const assets = await getAssetsSteam(cleanName);
                        banner = assets.banner;
                        screenshots = assets.screenshots;
                        if (!banner) {
                            log(`  ↳ Steam без баннера, пробую SteamPass...`);
                            const found = await searchSteamPass(cleanName);
                            if (found) {
                                const d = await getSteamPassProductDetail(found.id);
                                banner = found.banner || d.banner;
                                if (!banner) banner = d.banner;
                                // Один товар SteamPass: и баннер, и скрины из detail (не смешивать со Steam)
                                if (d.screenshots && d.screenshots.length) screenshots = d.screenshots;
                                log(`  … SteamPass detail: скринов ${(d.screenshots || []).length}`);
                            }
                        }
                    }
                }
            } catch (e) {
                log(`  ❌ Ошибка поиска: ${e.message}`);
            }

            // Render: сначала шаблон, затем затираем зоны баннера/скринов (убираем демо из PNG), потом картинки
            previewCtx.clearRect(0, 0, previewCanvas.width, previewCanvas.height);
            previewCtx.drawImage(templateImg, 0, 0);
            let drawn = false;

            const ssPool = uniqScreenshotUrls((screenshots || []).filter(u => u && String(u).trim()));
            /** URL, реально отрисованный в баннере (для thumbSlotUrls: один раз не дублировать тот же кадр). */
            let bannerUsedUrl = null;

            if (BANNER_BOX) {
                const bx = BANNER_BOX[0], by = BANNER_BOX[1];
                const bw = BANNER_BOX[2] - BANNER_BOX[0], bh = BANNER_BOX[3] - BANNER_BOX[1];
                fillRoundedRectPreview(previewCtx, '#1e1e1e', bx, by, bw, bh, 35);
                if (banner || ssPool.length) {
                    let cand = buildBannerCandidateUrls(banner, ssPool);
                    let { img: bImg, usedUrl: used } = await loadImageFirstOk(cand);
                    if (!bImg && ssPool.length) {
                        const fb = await loadImageFirstOk([ssPool[0]]);
                        bImg = fb.img; used = fb.usedUrl;
                    }
                    if (bImg) {
                        drawRoundedRect(previewCtx, bImg, bx, by, bw, bh, 35);
                        bannerUsedUrl = used;
                        drawn = true;
                    } else if (banner || ssPool.length) {
                        log(`  [!] Баннер не загрузился (все кандидаты/запасной скрин) — зона серая`);
                        console.warn('[CardGen] banner load fail', { banner: banner?.slice?.(0, 120), ss0: ssPool[0]?.slice?.(0, 120) });
                        drawn = true;
                    }
                }
            }

            const ssSlotCount = SS_BOXES.filter(Boolean).length;
            const thumbUrls = thumbSlotUrls(ssPool, bannerUsedUrl, ssSlotCount);
            for (let j = 0; j < SS_BOXES.length; j++) {
                const box = SS_BOXES[j];
                if (!box) continue;
                const bw = box[2] - box[0], bh = box[3] - box[1];
                fillRoundedRectPreview(previewCtx, '#1e1e1e', box[0], box[1], bw, bh, 20);
                const primary = thumbUrls[j];
                const candidates = [];
                if (primary) candidates.push(primary);
                for (const u of ssPool) if (u && u !== primary && !candidates.includes(u)) candidates.push(u);
                const { img } = await loadImageFirstOk(candidates);
                if (img) {
                    drawRoundedRect(previewCtx, img, box[0], box[1], bw, bh, 20);
                    drawn = true;
                }
            }

            if (drawn) {
                const safeName = cleanName.replace(/[:*?"<>|\\/]/g, '_') + '.png';
                await downloadImage(previewCanvas.toDataURL('image/png'), safeName);
                log(`✅ Сохранено: ${safeName}`);
            } else {
                log(`[!] Картинки не найдены, пропуск.`);
            }

            await new Promise(r => setTimeout(r, 800));
        }

        log('\n🎉 Генерация завершена! Папка: Загрузки/output_cards');
        isGenerating = false;
        generateBtn.disabled = false;
        if (stopGenBtn) { stopGenBtn.disabled = true; stopGenBtn.style.display = 'none'; }
    });

    stopGenBtn?.addEventListener('click', () => {
        stopGeneration = true;
        stopGenBtn.disabled = true;
    });

    // Initial zones render
    updateZonesUI();
});
