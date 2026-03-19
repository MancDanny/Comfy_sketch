# Comfy Sketch Pad — ComfyUI Custom Node

An interactive drawing and annotation canvas for ComfyUI. Load an image, paint coloured annotations with R/G/B brushes, freehand or with the polyline tool, and output the original and annotated images.

---

## Features

### Brushes & Tools
| Tool | Description |
|------|-------------|
| **R / G / B** | Red, green, blue brush — choose your annotation colour |
| **Draw** | Freehand brush mode (toggle back from line mode) |
| **Eraser (E)** | Erase painted strokes |
| **Line** | Polyline tool — click to place anchor points, right-click to finish |

### Brush Controls
- **Size slider** — adjusts brush/eraser radius
- **Lazy slider** — lazy mouse radius (default: max). Higher values smooth out shaky strokes by lagging the pen behind the cursor. Set to 0 to disable.

### Canvas Navigation
- **Zoom**: Scroll wheel (centred on cursor)
- **Pan**: Space + drag, or middle-mouse drag
- **Fit**: Reset zoom/pan so the image fills the view

### Editing
- **↩ / ↪** — Undo / Redo (up to 30 steps per session)
- **X** — Clear all strokes
- **Copy** — Copy the annotated image to the clipboard
- **Paste** — Paste an image from the clipboard (Ctrl+V also works) — useful for pasting directly from Photoshop or Affinity

### Image Input
- **File picker**: Select any image from the ComfyUI input folder (with upload support)
- **input_image slot**: Connect an upstream IMAGE node — the canvas loads automatically

### Aspect Ratio & Resize
- Node resizes maintain the image's aspect ratio — the canvas never gets squashed

### Node Outputs
| Output | Type | Description |
|--------|------|-------------|
| `original_image` | IMAGE | The source image, unchanged |
| `annotated_image` | IMAGE | The source image composited with your strokes |

---

## Installation

### Option A — ComfyUI Manager (recommended)
Search for **"Sketch Pad"** in ComfyUI Manager and click Install.

### Option B — Manual
```bash
cd ComfyUI/custom_nodes
git clone https://github.com/MancDanny/Comfy_sketch.git
```
Then restart ComfyUI.

### Option C — Direct download
Download the ZIP from the [Releases](https://github.com/MancDanny/Comfy_sketch/releases) page, extract to `ComfyUI/custom_nodes/Comfy_sketch/`, restart ComfyUI.

**No extra Python dependencies** — uses only `torch`, `numpy`, `Pillow`, and `folder_paths` (all included in ComfyUI).

---

## Usage

1. Add the **Sketch Pad** node (search "Sketch" or find under `image/sketch`)
2. Select an image from the file picker, or connect an upstream IMAGE to `input_image`
3. Choose a colour (R/G/B) and paint annotations on the canvas
4. Use the **Line** tool for straight polylines — right-click to finish a line
5. Use the **Lazy** slider to smooth freehand strokes
6. Click **Queue Prompt** to output the original and annotated images

### Lazy Mouse
The lazy mouse works by keeping a virtual pen position that chases your cursor. The pen only moves once your cursor is more than the lazy radius away from it. This decouples fast hand movements from the stroke, resulting in smooth, organic lines. Reduce the slider to 0 for direct 1:1 drawing.

### Polyline Tool
Click to place anchor points. Right-click (or press Escape) to finalise the line. Each segment uses the current brush colour and size.

---

## Companion Node

**Zoom Crop** (`Zoom_Crop`) — An interactive crop tool. Use its Push button to send a cropped region directly into Sketch Pad for annotation.

---

## Changelog

### v2.0.0
- Dual-canvas architecture (offscreen draw canvas at native resolution + display canvas)
- Lazy mouse with RAF loop — slider from 0 (off) to max, enabled by default
- Polyline tool with click-to-place anchors, right-click to finish
- Draw button — toggle back to freehand from line mode
- Fit button moved next to Eraser
- Fill tool removed
- Copy button — copies annotated image to clipboard
- Paste button + Ctrl+V — paste images from Photoshop, Affinity, etc.
- Aspect ratio maintained on node resize
- `input_image` optional slot — connect upstream IMAGE nodes
- Outputs simplified to `original_image` + `annotated_image`
- Toolbar order: R | G | B | Draw | Fit | E | Line | Size | Lazy | ↩ ↪ X | Paste | Copy

### v1.0.0
- Initial release
- Single canvas with zoom/pan
- R/G/B brush, eraser, fill
- Undo/redo, clear
- Base64 PNG serialisation for canvas data
- Outputs: original_image, annotated_image, red/green/blue/combined masks

---

## License

MIT
