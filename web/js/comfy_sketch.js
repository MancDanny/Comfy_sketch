import { app } from "../../../scripts/app.js";
import { api } from "../../../scripts/api.js";

// ── Constants ────────────────────────────────────────────────────────────
const BRUSH_SIZE_KEY = "comfy_sketch_brush_size";

// ── Snapshot helpers ─────────────────────────────────────────────────────
function saveSnapshot(state, drawCanvas) {
    state.undoStack.push(drawCanvas.toDataURL());
    if (state.undoStack.length > state.maxUndoSteps) state.undoStack.shift();
    state.redoStack = [];
}

function restoreSnapshot(ctx, canvas, snapshot, callback) {
    const img = new window.Image();
    img.onload = () => {
        ctx.clearRect(0, 0, canvas.width, canvas.height);
        ctx.globalCompositeOperation = "source-over";
        ctx.drawImage(img, 0, 0);
        if (callback) callback();
    };
    img.src = snapshot;
}

// ── Main extension ───────────────────────────────────────────────────────
app.registerExtension({
    name: "Comfy.SketchPad",

    async nodeCreated(node) {
        if (node.comfyClass !== "SketchPad") return;

        // ── Prevent duplicate image preview ──
        Object.defineProperty(node, "imgs", {
            get() { return null; },
            set(_v) {},
            configurable: true,
        });
        node.onDrawBackground = function () {};

        // ── State ──
        const savedBrush = localStorage.getItem(BRUSH_SIZE_KEY);
        const state = {
            currentColor: "#FF0000",
            brushSize: savedBrush ? parseInt(savedBrush) : 8,
            tool: "brush",       // brush | eraser | line
            isDrawing: false,
            undoStack: [],
            redoStack: [],
            maxUndoSteps: 30,
            lastImageSrc: null,
            imageWidth: 512,
            imageHeight: 512,
            // Zoom / Pan
            zoom: 1,
            panX: 0,
            panY: 0,
            _bgImage: null,
            // Line / polyline tool
            lineStart: null,
            lineCurrent: null,
            // Shift+click straight line
            lastBrushPoint: null,
            // Paste toggle
            _pasteToggle: false,
            // Info label ref
            _infoLabel: null,
            // Min height for widget
            _minHeight: 340,
            // Lazy mouse
            lazyEnabled: true,
            lazyRadius: 60,
            _lazyX: 0,
            _lazyY: 0,
            _lazyCursorX: 0,
            _lazyCursorY: 0,
            _lazyActive: false,
            _lazyRafId: null,
        };

        // ── Offscreen draw canvas (native image resolution) ──
        const drawCanvas = document.createElement("canvas");
        drawCanvas.width = 512;
        drawCanvas.height = 512;
        const drawCtx = drawCanvas.getContext("2d");
        drawCtx.lineCap = "round";
        drawCtx.lineJoin = "round";

        // ── Container ──
        const container = document.createElement("div");
        container.style.cssText = `
            display: flex; flex-direction: column;
            width: 100%; background: #222;
            border-radius: 4px; overflow: hidden;
        `;

        // ── Toolbar ──
        const toolbar = document.createElement("div");
        toolbar.style.cssText = `
            display: flex; align-items: center; gap: 3px;
            padding: 4px 6px; background: #1e1e2e;
            border-bottom: 1px solid #333; flex-wrap: wrap;
            min-height: 28px; user-select: none;
        `;

        function makeBtn(label, title, onClick, extraStyle) {
            const b = document.createElement("button");
            b.textContent = label;
            b.title = title;
            b.style.cssText = `
                min-width: 26px; height: 24px; border: 2px solid transparent;
                color: #fff; font-weight: bold; border-radius: 4px;
                cursor: pointer; font-size: 11px; padding: 0 4px;
                ${extraStyle || "background: #444;"}
            `;
            b.addEventListener("mousedown", (e) => e.stopPropagation());
            b.onclick = (e) => {
                e.preventDefault();
                e.stopPropagation();
                onClick(e);
            };
            return b;
        }

        function sep() {
            const s = document.createElement("div");
            s.style.cssText = "width:1px; height:20px; background:#444; margin:0 2px;";
            return s;
        }

        // ── Color buttons ──
        const colors = [
            { label: "R", color: "#FF0000", name: "Red" },
            { label: "G", color: "#00FF00", name: "Green" },
            { label: "B", color: "#0000FF", name: "Blue" },
        ];
        const colorBtns = [];
        colors.forEach(({ label, color, name }) => {
            const b = makeBtn(label, `Draw ${name}`, () => {
                state.tool = "brush";
                state.currentColor = color;
                endPolyline();
                highlightActive();
            }, `background: ${color};`);
            colorBtns.push(b);
            toolbar.appendChild(b);
        });
        toolbar.appendChild(sep());

        // ── Tool buttons ──
        const drawBtn = makeBtn("Draw", "Freehand brush (return from line mode)", () => {
            state.tool = "brush";
            endPolyline();
            highlightActive();
        });
        // Fit placed here — left of Eraser
        const fitBtn = makeBtn("Fit", "Zoom to fit image in view", () => fitToView());
        const eraserBtn = makeBtn("E", "Eraser", () => {
            state.tool = "eraser";
            endPolyline();
            highlightActive();
        });
        const lineBtn = makeBtn("Line", "Polyline (left-click points, right-click to finish)", () => {
            state.tool = "line";
            state.lineStart = null;
            state.lineCurrent = null;
            highlightActive();
        });
        toolbar.appendChild(drawBtn);
        toolbar.appendChild(fitBtn);
        toolbar.appendChild(eraserBtn);
        toolbar.appendChild(lineBtn);
        toolbar.appendChild(sep());

        // ── Brush size ──
        const sizeLabel = document.createElement("span");
        sizeLabel.textContent = "Size:";
        sizeLabel.style.cssText = "color:#aaa; font-size:10px;";
        toolbar.appendChild(sizeLabel);

        const sizeSlider = document.createElement("input");
        sizeSlider.type = "range";
        sizeSlider.min = "1";
        sizeSlider.max = "50";
        sizeSlider.value = String(state.brushSize);
        sizeSlider.style.cssText = "width:55px; height:14px; cursor:pointer;";
        sizeSlider.addEventListener("mousedown", (e) => e.stopPropagation());
        sizeSlider.oninput = (e) => {
            e.stopPropagation();
            state.brushSize = parseInt(e.target.value);
            localStorage.setItem(BRUSH_SIZE_KEY, String(state.brushSize));
        };
        toolbar.appendChild(sizeSlider);

        // ── Lazy mouse ──
        const lazyLabel = document.createElement("span");
        lazyLabel.textContent = "Lazy:";
        lazyLabel.style.cssText = "color:#aaa; font-size:10px; margin-left:4px;";
        toolbar.appendChild(lazyLabel);

        const lazySlider = document.createElement("input");
        lazySlider.type = "range";
        lazySlider.min = "0";
        lazySlider.max = "60";
        lazySlider.value = "60";
        lazySlider.title = "Lazy mouse radius (0 = off, higher = smoother/laggier)";
        lazySlider.style.cssText = "width:45px; height:14px; cursor:pointer;";
        lazySlider.addEventListener("mousedown", (e) => e.stopPropagation());
        lazySlider.oninput = (e) => {
            e.stopPropagation();
            state.lazyRadius = parseInt(e.target.value);
            state.lazyEnabled = state.lazyRadius > 0;
        };
        toolbar.appendChild(lazySlider);
        toolbar.appendChild(sep());

        // ── Undo / Redo / Clear ──
        const undoBtn = makeBtn("\u21A9", "Undo (Ctrl+Z)", () => doUndo());
        const redoBtn = makeBtn("\u21AA", "Redo (Ctrl+Y)", () => doRedo());
        const clearBtn = makeBtn("X", "Clear all drawings", () => {
            saveSnapshot(state, drawCanvas);
            drawCtx.clearRect(0, 0, drawCanvas.width, drawCanvas.height);
            redraw();
        });
        toolbar.appendChild(undoBtn);
        toolbar.appendChild(redoBtn);
        toolbar.appendChild(clearBtn);
        toolbar.appendChild(sep());

        // ── Paste / Copy ──
        const pasteBtn = makeBtn("Paste", "Paste image from clipboard (Ctrl+V)", () => pasteFromClipboard());
        pasteBtn.style.background = "#2a3a5a";
        pasteBtn.style.color = "#8cf";
        pasteBtn.addEventListener("mouseenter", () => { pasteBtn.style.background = "#3a5a7a"; });
        pasteBtn.addEventListener("mouseleave", () => { pasteBtn.style.background = "#2a3a5a"; });
        toolbar.appendChild(pasteBtn);

        const copyBtn = makeBtn("Copy", "Copy composite to clipboard (Ctrl+C)", () => copyToClipboard());
        copyBtn.style.background = "#2a3a5a";
        copyBtn.style.color = "#8cf";
        copyBtn.addEventListener("mouseenter", () => { copyBtn.style.background = "#3a5a7a"; });
        copyBtn.addEventListener("mouseleave", () => { copyBtn.style.background = "#2a3a5a"; });
        toolbar.appendChild(copyBtn);
        toolbar.appendChild(sep());

        // ── Info label ──
        const infoLabel = document.createElement("span");
        infoLabel.style.cssText = "color: #aaa; font-size: 10px; margin-left: auto;";
        infoLabel.textContent = "No image";
        state._infoLabel = infoLabel;
        toolbar.appendChild(infoLabel);

        container.appendChild(toolbar);

        // ── Canvas wrapper ──
        const canvasWrapper = document.createElement("div");
        canvasWrapper.style.cssText = `
            position: relative; overflow: hidden;
            min-height: 256px; background: #222;
            touch-action: none;
        `;

        // ── View canvas (visible, display resolution) ──
        const viewCanvas = document.createElement("canvas");
        viewCanvas.width = 512;
        viewCanvas.height = 400;
        viewCanvas.style.cssText = `
            position: absolute; top: 0; left: 0;
            width: 100%; height: 100%;
            cursor: crosshair;
        `;
        canvasWrapper.appendChild(viewCanvas);
        container.appendChild(canvasWrapper);

        // ── Coordinate conversion ──
        function toImageCoords(e) {
            const rect = viewCanvas.getBoundingClientRect();
            const scaleX = viewCanvas.width / rect.width;
            const scaleY = viewCanvas.height / rect.height;
            const clientX = e.touches ? e.touches[0].clientX : e.clientX;
            const clientY = e.touches ? e.touches[0].clientY : e.clientY;
            const screenX = (clientX - rect.left) * scaleX;
            const screenY = (clientY - rect.top) * scaleY;
            return {
                x: (screenX - state.panX) / state.zoom,
                y: (screenY - state.panY) / state.zoom,
            };
        }

        function clampToImage(pos) {
            return {
                x: Math.max(0, Math.min(pos.x, state.imageWidth)),
                y: Math.max(0, Math.min(pos.y, state.imageHeight)),
            };
        }

        // ── Redraw (composites bg + drawing + overlays onto viewCanvas) ──
        function redraw() {
            const vw = viewCanvas.width;
            const vh = viewCanvas.height;
            if (vw === 0 || vh === 0) return;

            const vCtx = viewCanvas.getContext("2d");
            vCtx.clearRect(0, 0, vw, vh);

            if (!state._bgImage) {
                vCtx.fillStyle = "#333";
                vCtx.fillRect(0, 0, vw, vh);
                vCtx.fillStyle = "#666";
                vCtx.font = "14px sans-serif";
                vCtx.textAlign = "center";
                vCtx.fillText("Select or paste an image", vw / 2, vh / 2);
                return;
            }

            vCtx.save();
            vCtx.translate(state.panX, state.panY);
            vCtx.scale(state.zoom, state.zoom);

            // Background image
            vCtx.drawImage(state._bgImage, 0, 0, state.imageWidth, state.imageHeight);

            // Drawing overlay
            vCtx.drawImage(drawCanvas, 0, 0, state.imageWidth, state.imageHeight);

            // Line tool preview
            if (state.tool === "line" && state.lineStart && state.lineCurrent) {
                vCtx.beginPath();
                vCtx.moveTo(state.lineStart.x, state.lineStart.y);
                vCtx.lineTo(state.lineCurrent.x, state.lineCurrent.y);
                vCtx.strokeStyle = state.currentColor;
                vCtx.lineWidth = state.brushSize;
                vCtx.lineCap = "round";
                vCtx.globalAlpha = 0.5;
                vCtx.stroke();
                vCtx.globalAlpha = 1.0;
            }

            vCtx.restore();

            // Image boundary indicator (subtle border around the image area)
            const ix = state.panX;
            const iy = state.panY;
            const iw = state.imageWidth * state.zoom;
            const ih = state.imageHeight * state.zoom;
            vCtx.strokeStyle = "rgba(255,255,255,0.15)";
            vCtx.lineWidth = 1;
            vCtx.strokeRect(ix, iy, iw, ih);

            // Update info label
            if (state._infoLabel) {
                const zoomPct = Math.round(state.zoom * 100);
                state._infoLabel.textContent = `${state.imageWidth}\u00D7${state.imageHeight} | ${zoomPct}%`;
            }
        }

        // ── Fit to view ──
        function fitToView() {
            const vw = viewCanvas.width || 512;
            const vh = viewCanvas.height || 400;
            if (!state._bgImage) return;
            state.zoom = Math.min(vw / state.imageWidth, vh / state.imageHeight);
            state.panX = (vw - state.imageWidth * state.zoom) / 2;
            state.panY = (vh - state.imageHeight * state.zoom) / 2;
            redraw();
        }

        // ── Update view canvas size from wrapper ──
        function updateCanvasSize() {
            const rect = canvasWrapper.getBoundingClientRect();
            const w = Math.round(rect.width);
            const h = Math.round(rect.height);
            if (w > 0 && h > 0 && (viewCanvas.width !== w || viewCanvas.height !== h)) {
                viewCanvas.width = w;
                viewCanvas.height = h;
                redraw();
            }
        }

        const resizeObserver = new ResizeObserver(() => {
            updateCanvasSize();
        });
        resizeObserver.observe(canvasWrapper);

        // ── Undo / Redo helpers ──
        function doUndo() {
            if (state.undoStack.length === 0) return;
            state.redoStack.push(drawCanvas.toDataURL());
            restoreSnapshot(drawCtx, drawCanvas, state.undoStack.pop(), redraw);
        }

        function doRedo() {
            if (state.redoStack.length === 0) return;
            state.undoStack.push(drawCanvas.toDataURL());
            restoreSnapshot(drawCtx, drawCanvas, state.redoStack.pop(), redraw);
        }

        // ── End polyline (line tool) ──
        function endPolyline() {
            state.lineStart = null;
            state.lineCurrent = null;
            redraw();
        }

        // ── Highlight active tool ──
        function highlightActive() {
            colorBtns.forEach((b, i) => {
                const isActive = state.tool === "brush" && state.currentColor === colors[i].color;
                b.style.border = isActive ? "2px solid #fff" : "2px solid transparent";
            });
            drawBtn.style.border = state.tool === "brush" ? "2px solid #fff" : "2px solid transparent";
            eraserBtn.style.border = state.tool === "eraser" ? "2px solid #fff" : "2px solid transparent";
            lineBtn.style.border = state.tool === "line" ? "2px solid #fff" : "2px solid transparent";
        }
        highlightActive();

        // ── Interaction state ──
        let mode = null;        // null | "draw" | "pan"
        let spaceDown = false;
        let panStartX = 0, panStartY = 0;

        // ── Pointer handlers ──
        function onPointerDown(e) {
            e.preventDefault();
            e.stopPropagation();

            const { x: screenX, y: screenY } = getScreenCoords(e);

            // Pan: space + left click, or middle mouse
            if (spaceDown || e.button === 1) {
                mode = "pan";
                panStartX = screenX;
                panStartY = screenY;
                viewCanvas.style.cursor = "grabbing";
                return;
            }

            // Right-click: end polyline (line tool only)
            if (e.button === 2) {
                if (state.tool === "line") endPolyline();
                return;
            }

            // Only left click for remaining tools
            if (e.button !== 0) return;

            const raw = toImageCoords(e);
            const pos = clampToImage(raw);

            // ── Line tool ──
            if (state.tool === "line") {
                if (!state.lineStart) {
                    state.lineStart = pos;
                    state.lineCurrent = pos;
                    redraw();
                } else {
                    saveSnapshot(state, drawCanvas);
                    drawCtx.beginPath();
                    drawCtx.moveTo(state.lineStart.x, state.lineStart.y);
                    drawCtx.lineTo(pos.x, pos.y);
                    drawCtx.globalCompositeOperation = "source-over";
                    drawCtx.strokeStyle = state.currentColor;
                    drawCtx.lineWidth = state.brushSize;
                    drawCtx.stroke();
                    state.lineStart = pos;
                    state.lineCurrent = pos;
                    redraw();
                }
                return;
            }

            // ── Brush / Eraser ──
            // Shift+click: straight line from last brush point
            if (e.shiftKey && state.lastBrushPoint) {
                saveSnapshot(state, drawCanvas);
                drawCtx.beginPath();
                drawCtx.moveTo(state.lastBrushPoint.x, state.lastBrushPoint.y);
                drawCtx.lineTo(pos.x, pos.y);
                if (state.tool === "eraser") {
                    drawCtx.globalCompositeOperation = "destination-out";
                    drawCtx.strokeStyle = "rgba(0,0,0,1)";
                } else {
                    drawCtx.globalCompositeOperation = "source-over";
                    drawCtx.strokeStyle = state.currentColor;
                }
                drawCtx.lineWidth = state.brushSize;
                drawCtx.stroke();
                state.lastBrushPoint = pos;
                redraw();
                return;
            }

            mode = "draw";
            state.isDrawing = true;
            saveSnapshot(state, drawCanvas);

            drawCtx.beginPath();
            drawCtx.moveTo(pos.x, pos.y);

            if (state.tool === "eraser") {
                drawCtx.globalCompositeOperation = "destination-out";
                drawCtx.strokeStyle = "rgba(0,0,0,1)";
            } else {
                drawCtx.globalCompositeOperation = "source-over";
                drawCtx.strokeStyle = state.currentColor;
            }
            drawCtx.lineWidth = state.brushSize;
            state.lastBrushPoint = pos;

            // Lazy mouse: initialise position and start RAF loop
            if (state.lazyEnabled && state.tool === "brush") {
                state._lazyX = pos.x;
                state._lazyY = pos.y;
                state._lazyCursorX = pos.x;
                state._lazyCursorY = pos.y;
                state._lazyActive = true;
                state._lazyRafId = requestAnimationFrame(lazyLoop);
            }
        }

        function onPointerMove(e) {
            if (mode === "pan") {
                e.preventDefault();
                e.stopPropagation();
                const { x: screenX, y: screenY } = getScreenCoords(e);
                state.panX += screenX - panStartX;
                state.panY += screenY - panStartY;
                panStartX = screenX;
                panStartY = screenY;
                redraw();
                return;
            }

            if (mode === "draw" && state.isDrawing) {
                e.preventDefault();
                e.stopPropagation();
                const pos = clampToImage(toImageCoords(e));
                if (state.lazyEnabled && state.tool === "brush") {
                    // Lazy mode: update cursor target only; RAF loop does the drawing
                    state._lazyCursorX = pos.x;
                    state._lazyCursorY = pos.y;
                } else {
                    drawCtx.lineTo(pos.x, pos.y);
                    drawCtx.stroke();
                    state.lastBrushPoint = pos;
                    redraw();
                }
                return;
            }

            // Line tool preview (no drag mode, just hovering)
            if (state.tool === "line" && state.lineStart) {
                const pos = clampToImage(toImageCoords(e));
                state.lineCurrent = pos;
                redraw();
                return;
            }

            // Update cursor
            if (!mode) {
                viewCanvas.style.cursor = spaceDown ? "grab" : "crosshair";
            }
        }

        // ── Lazy mouse RAF loop ──
        function lazyLoop() {
            if (!state._lazyActive) return;
            const radius = state.lazyRadius / state.zoom;
            const dx = state._lazyCursorX - state._lazyX;
            const dy = state._lazyCursorY - state._lazyY;
            const dist = Math.sqrt(dx * dx + dy * dy);
            if (dist > radius) {
                state._lazyX += dx * (1 - radius / dist);
                state._lazyY += dy * (1 - radius / dist);
                const clamped = clampToImage({ x: state._lazyX, y: state._lazyY });
                drawCtx.lineTo(clamped.x, clamped.y);
                drawCtx.stroke();
                state.lastBrushPoint = clamped;
                redraw();
            }
            state._lazyRafId = requestAnimationFrame(lazyLoop);
        }

        function onPointerUp(e) {
            if (mode === "draw") {
                // Stop lazy loop if active
                if (state._lazyActive) {
                    state._lazyActive = false;
                    if (state._lazyRafId) {
                        cancelAnimationFrame(state._lazyRafId);
                        state._lazyRafId = null;
                    }
                }
                state.isDrawing = false;
                drawCtx.closePath();
                redraw();
            }
            if (mode === "pan") {
                viewCanvas.style.cursor = spaceDown ? "grab" : "crosshair";
            }
            mode = null;
        }

        function getScreenCoords(e) {
            const rect = viewCanvas.getBoundingClientRect();
            const scaleX = viewCanvas.width / rect.width;
            const scaleY = viewCanvas.height / rect.height;
            const clientX = e.touches ? e.touches[0].clientX : e.clientX;
            const clientY = e.touches ? e.touches[0].clientY : e.clientY;
            return {
                x: (clientX - rect.left) * scaleX,
                y: (clientY - rect.top) * scaleY,
            };
        }

        // ── Scroll wheel zoom ──
        function onWheel(e) {
            e.preventDefault();
            e.stopPropagation();

            const { x: mouseX, y: mouseY } = getScreenCoords(e);
            const oldZoom = state.zoom;
            const factor = e.deltaY < 0 ? 1.15 : 1 / 1.15;
            state.zoom = Math.max(0.05, Math.min(30, state.zoom * factor));

            // Zoom towards cursor
            state.panX = mouseX - (mouseX - state.panX) * (state.zoom / oldZoom);
            state.panY = mouseY - (mouseY - state.panY) * (state.zoom / oldZoom);

            redraw();
        }

        // ── Event listeners on viewCanvas ──
        viewCanvas.addEventListener("pointerdown", (e) => {
            e.stopPropagation();
            e.preventDefault();
            onPointerDown(e);
        }, true);

        document.addEventListener("pointermove", (e) => {
            if (mode) {
                onPointerMove(e);
            } else if (state.tool === "line" && state.lineStart && viewCanvas.offsetParent) {
                // Line preview even without drag
                onPointerMove(e);
            }
        }, true);

        document.addEventListener("pointerup", (e) => {
            if (mode) {
                onPointerUp(e);
            }
        }, true);

        viewCanvas.addEventListener("wheel", (e) => {
            e.stopPropagation();
            e.preventDefault();
            onWheel(e);
        }, { capture: true, passive: false });

        // Suppress context menu on canvas (right-click is used to end the line tool)
        viewCanvas.addEventListener("contextmenu", (e) => {
            e.preventDefault();
            e.stopPropagation();
        }, true);

        // ── Keyboard shortcuts ──
        function onKeyDown(e) {
            if (!viewCanvas.offsetParent) return;

            // Space for pan
            if (e.code === "Space" && !spaceDown) {
                spaceDown = true;
                if (!mode) viewCanvas.style.cursor = "grab";
                e.preventDefault();
                return;
            }

            const ctrl = e.ctrlKey || e.metaKey;

            // Escape: end polyline
            if (e.key === "Escape") {
                endPolyline();
                return;
            }

            // Ctrl+Z: undo
            if (ctrl && e.key === "z" && !e.shiftKey) {
                e.preventDefault();
                doUndo();
                return;
            }

            // Ctrl+Y or Ctrl+Shift+Z: redo
            if (ctrl && (e.key === "y" || (e.key === "z" && e.shiftKey))) {
                e.preventDefault();
                doRedo();
                return;
            }

            // Ctrl+C: copy composite to clipboard
            if (ctrl && e.key === "c") {
                e.preventDefault();
                copyToClipboard();
                return;
            }
        }

        function onKeyUp(e) {
            if (e.code === "Space") {
                spaceDown = false;
                if (!mode) viewCanvas.style.cursor = "crosshair";
            }
        }

        document.addEventListener("keydown", onKeyDown);
        document.addEventListener("keyup", onKeyUp);

        // ── Clipboard: paste (via paste event for Ctrl+V) ──
        function onPaste(e) {
            if (!viewCanvas.offsetParent) return;
            const items = e.clipboardData?.items;
            if (!items) return;
            for (const item of items) {
                if (item.type.startsWith("image/")) {
                    e.preventDefault();
                    const blob = item.getAsFile();
                    uploadAndSetImage(blob);
                    return;
                }
            }
        }
        document.addEventListener("paste", onPaste);

        // Paste button handler (uses async Clipboard API)
        async function pasteFromClipboard() {
            try {
                const items = await navigator.clipboard.read();
                for (const item of items) {
                    const imageType = item.types.find((t) => t.startsWith("image/"));
                    if (!imageType) continue;
                    const blob = await item.getType(imageType);
                    await uploadAndSetImage(blob);
                    return;
                }
            } catch (err) {
                console.error("SketchPad paste failed:", err);
            }
        }

        async function uploadAndSetImage(blob) {
            state._pasteToggle = !state._pasteToggle;
            const name = state._pasteToggle ? "sketch_paste_a.png" : "sketch_paste_b.png";
            const formData = new FormData();
            formData.append("image", blob, name);
            formData.append("overwrite", "true");

            try {
                const resp = await api.fetchApi("/upload/image", {
                    method: "POST",
                    body: formData,
                });
                if (!resp.ok) throw new Error(`Upload failed: ${resp.status}`);
                const result = await resp.json();

                const imageWidget = node.widgets?.find((w) => w.name === "image");
                if (imageWidget) {
                    imageWidget.value = result.name;
                    if (imageWidget.callback) imageWidget.callback(result.name);
                }
            } catch (err) {
                console.error("SketchPad upload failed:", err);
            }
        }

        // Ctrl+C: copy composite (background + drawing) to clipboard
        async function copyToClipboard() {
            if (!state._bgImage) return;
            const composite = document.createElement("canvas");
            composite.width = state.imageWidth;
            composite.height = state.imageHeight;
            const compCtx = composite.getContext("2d");
            compCtx.drawImage(state._bgImage, 0, 0);
            compCtx.drawImage(drawCanvas, 0, 0);

            try {
                const blob = await new Promise((resolve) =>
                    composite.toBlob(resolve, "image/png")
                );
                await navigator.clipboard.write([
                    new ClipboardItem({ "image/png": blob }),
                ]);
            } catch (err) {
                console.error("SketchPad copy failed:", err);
            }
        }

        // ── Register DOM widget ──
        const widget = node.addDOMWidget(
            "canvas_data", "customwidget", container,
            {
                getValue: () => drawCanvas.toDataURL("image/png"),
                setValue: (v) => {
                    if (v && typeof v === "string" && v.startsWith("data:")) {
                        const img = new window.Image();
                        img.onload = () => {
                            drawCtx.clearRect(0, 0, drawCanvas.width, drawCanvas.height);
                            drawCtx.globalCompositeOperation = "source-over";
                            drawCtx.drawImage(img, 0, 0);
                            redraw();
                        };
                        img.src = v;
                    }
                },
                getMinHeight: () => state._minHeight || 340,
            }
        );

        widget.serializeValue = async () => drawCanvas.toDataURL("image/png");

        // ── Watch image widget for background ──
        function loadBackground(imageName) {
            if (!imageName) return;

            // Allow reload of same image (for paste toggle)
            const isSame = imageName === state.lastImageSrc;
            state.lastImageSrc = imageName;

            let subfolder = "";
            let filename = imageName;
            const si = imageName.lastIndexOf("/");
            if (si > -1) {
                subfolder = imageName.substring(0, si);
                filename = imageName.substring(si + 1);
            }

            const cacheBust = `&t=${Date.now()}`;
            const url = api.apiURL(
                `/view?filename=${encodeURIComponent(filename)}&type=input&subfolder=${encodeURIComponent(subfolder)}${cacheBust}`
            );

            const img = new window.Image();
            img.crossOrigin = "anonymous";
            img.onload = () => {
                const oldW = state.imageWidth;
                const oldH = state.imageHeight;
                state.imageWidth = img.naturalWidth;
                state.imageHeight = img.naturalHeight;
                state._bgImage = img;

                // Resize offscreen draw canvas if image dimensions changed
                if (img.naturalWidth !== oldW || img.naturalHeight !== oldH) {
                    drawCanvas.width = img.naturalWidth;
                    drawCanvas.height = img.naturalHeight;
                    drawCtx.lineCap = "round";
                    drawCtx.lineJoin = "round";
                    // Clear undo/redo (wrong dimensions)
                    state.undoStack = [];
                    state.redoStack = [];
                }

                // Set canvas wrapper height to maintain aspect ratio
                const aspect = img.naturalWidth / img.naturalHeight;
                const nodeWidth = Math.max(380, node.size[0]);
                const canvasDisplayH = Math.round(nodeWidth / aspect);
                canvasWrapper.style.height = canvasDisplayH + "px";
                state._minHeight = canvasDisplayH + 60;
                node.setSize([nodeWidth, canvasDisplayH + 160]);

                // After layout, update view canvas and fit
                requestAnimationFrame(() => {
                    updateCanvasSize();
                    fitToView();
                });
            };
            img.src = url;
        }

        let lastVal = null;
        const interval = setInterval(() => {
            const iw = node.widgets?.find((w) => w.name === "image");
            if (iw && iw.value !== lastVal) {
                lastVal = iw.value;
                loadBackground(iw.value);
            }
        }, 500);

        // ── Node resize handler ──
        let _resizing = false;
        const origOnResize = node.onResize;
        node.onResize = function (size) {
            origOnResize?.apply(this, arguments);
            if (state._bgImage && !_resizing) {
                const aspect = state.imageWidth / state.imageHeight;
                const canvasDisplayH = Math.round(size[0] / aspect);
                canvasWrapper.style.height = canvasDisplayH + "px";
                state._minHeight = canvasDisplayH + 60;
                // Force node height to maintain image aspect ratio
                const targetH = canvasDisplayH + 160;
                if (Math.abs(size[1] - targetH) > 2) {
                    _resizing = true;
                    node.setSize([size[0], targetH]);
                    _resizing = false;
                }
            }
            requestAnimationFrame(() => {
                updateCanvasSize();
                const vw = viewCanvas.width;
                const vh = viewCanvas.height;
                if (state._bgImage) {
                    const fitZoom = Math.min(vw / state.imageWidth, vh / state.imageHeight);
                    if (state.zoom < fitZoom) {
                        fitToView();
                    } else {
                        redraw();
                    }
                }
            });
        };

        // ── Hide auto-generated image preview ──
        node.setSizeForImage = function () {};
        const hidePreview = () => {
            const pw = node.widgets?.find(
                (w) => w.name === "$$canvas-image-preview" || w.name === "preview"
            );
            if (pw) {
                pw.computeSize = () => [0, -4];
                if (pw.element) pw.element.style.display = "none";
            }
        };
        hidePreview();
        setTimeout(hidePreview, 500);
        setTimeout(hidePreview, 1500);

        // ── Cleanup ──
        const origOnRemoved = node.onRemoved;
        node.onRemoved = function () {
            clearInterval(interval);
            resizeObserver.disconnect();
            document.removeEventListener("keydown", onKeyDown);
            document.removeEventListener("keyup", onKeyUp);
            document.removeEventListener("paste", onPaste);
            document.removeEventListener("pointermove", onPointerMove, true);
            document.removeEventListener("pointerup", onPointerUp, true);
            origOnRemoved?.apply(this, arguments);
        };

        // ── Initial load ──
        requestAnimationFrame(() => {
            const iw = node.widgets?.find((w) => w.name === "image");
            if (iw?.value) loadBackground(iw.value);
        });

        node.setSize([400, 520]);
        node.setDirtyCanvas(true, true);
    },

    // ── Restore canvas on workflow load ──
    async beforeRegisterNodeDef(nodeType, nodeData, _app) {
        if (nodeData.name !== "SketchPad") return;

        const origOnConfigure = nodeType.prototype.onConfigure;
        nodeType.prototype.onConfigure = function (info) {
            origOnConfigure?.apply(this, arguments);
            if (!info?.widgets_values) return;

            const vals = info.widgets_values;
            let canvasData = null;
            if (Array.isArray(vals)) {
                canvasData = vals.find(
                    (v) => typeof v === "string" && v.startsWith("data:image")
                );
            } else if (vals.canvas_data) {
                canvasData = vals.canvas_data;
            }

            if (canvasData) {
                requestAnimationFrame(() => {
                    const w = this.widgets?.find((w) => w.name === "canvas_data");
                    if (w?.options?.setValue) {
                        w.options.setValue(canvasData);
                    }
                });
            }
        };
    },
});
