# AGENTS.md

This file provides guidance to WARP (warp.dev) when working with code in this repository.

## Running Locally

No build step or package manager is needed. Start any static HTTP server from the repo root (ES modules and texture loading require HTTP, not `file://`):

```bash
python3 -m http.server 8000
# or
npx serve .
# or
php -S localhost:8000
```

Then open http://localhost:8000.

## Regenerating Texture Thumbnails

The preset swatches in `textures/thumbs/` are 80×80 WebP files pre-generated from `textures/`. To regenerate after adding or changing a texture image, run:

```bash
pip install Pillow
python3 generate_thumbs.py
```

The list of files to process is hardcoded at the top of `generate_thumbs.py`. Add new texture filenames there before running.

## Architecture

### No Build Pipeline

All JavaScript is vanilla ES modules. Dependencies (Three.js 0.170.0, fflate 0.8.2) are loaded at runtime via an `importmap` in `index.html`, pointing to jsDelivr CDN. There is no bundler, no transpiler, and no `node_modules`.

### Module Responsibilities

| File | Role |
|------|------|
| `js/main.js` | App entry point. Owns **all UI state** (current geometry, settings, exclusion sets, preview state). Wires every DOM event. Coordinates the export pipeline. |
| `js/viewer.js` | Three.js scene, camera, OrbitControls, mesh display. Accepts geometry/material updates from `main.js`. |
| `js/stlLoader.js` | Parses binary/ASCII STL, OBJ (via Three.js OBJLoader), and 3MF (via fflate). Returns a non-indexed `BufferGeometry`. |
| `js/mapping.js` | UV projection math (7 modes: Triplanar, Cubic/Box, Cylindrical, Spherical, Planar XY/XZ/YZ). Used by both the GLSL preview shader and the CPU export path. |
| `js/previewMaterial.js` | Custom Three.js `ShaderMaterial` that implements displacement preview, UV projection, angle masking, face-exclusion mask, and boundary falloff entirely on the GPU. |
| `js/subdivision.js` | CPU adaptive subdivision: splits edges longer than a target length while preserving sharp creases (>30° dihedral). Hard cap of 10 M triangles. |
| `js/displacement.js` | CPU vertex displacement: bilinear-samples the texture ImageData, displaces each vertex along its smooth normal, handles angle/face masking and boundary falloff. |
| `js/decimation.js` | QEM (Quadric Error Metrics) mesh simplification with boundary protection and normal-flip rejection. |
| `js/exporter.js` | Writes binary STL and 3MF (ZIP via fflate). |
| `js/exclusion.js` | Face-selection utilities: adjacency graph construction, bucket-fill BFS, exclusion overlay geometry, per-vertex face weights. |
| `js/presetTextures.js` | Defines 24 built-in texture presets, loads WebP thumbnails and full-res images on demand. |
| `js/i18n.js` | Lazy-loads per-language JS files from `js/i18n/`. Translates DOM elements via `data-i18n*` attributes. Supported languages: `en`, `de`, `it`, `es`, `pt`, `fr`, `ja`. |

### Export Pipeline (CPU, triggered by "Export STL / 3MF")

```
original non-indexed geometry
  → subdivide()     [subdivision.js]  — splits until edges ≤ refineLength
  → applyDisplacement()  [displacement.js]  — samples texture, moves vertices
  → decimate()      [decimation.js]   — reduces to maxTriangles
  → exportSTL() / export3MF()  [exporter.js]
```

All stages run on the main thread; progress is reported via `onProgress` callbacks that update a progress bar in the UI.

### Geometry Conventions

All geometry in this codebase is **non-indexed** (`BufferGeometry` with every triangle's vertices stored sequentially, no `index` attribute). `buildAdjacency` in `exclusion.js` constructs shared-edge adjacency by deduplicating vertex positions via a quantised string key (quantisation factor `1e4`).

The same deduplication strategy is used in `displacement.js` to ensure co-located vertices from different triangles displace to the same point (prevents cracks/gaps in the exported mesh).

### Preview vs. Export Parity

The GLSL shader in `previewMaterial.js` and the CPU path in `mapping.js` / `displacement.js` implement the **same UV projection formulas**. When changing projection logic, both must be updated together to keep the real-time preview matching the exported result.

### State Management

All mutable app state lives as module-level `let` variables in `main.js` — there is no reactive framework or state container. Async operations (precision masking subdivision, displacement preview subdivision, export) use integer **operation tokens** (`precisionToken`, `dispPreviewToken`, `exportToken`) that are incremented on every model load, allowing stale async results to silently abort.

### i18n

Translation strings are plain JS objects exported as `default` from `js/i18n/<lang>.js`. To add a new language, add its key to `TRANSLATIONS` in `js/i18n.js` and create the corresponding file. At `localhost`, the console will warn about keys present in `en.js` but missing in the active language.

### LocalStorage Keys

- `stlt-theme` — `'light'` or `'dark'`
- `stlt-lang` — active language code (e.g. `'de'`)
- `sessionStorage: stlt-no-sponsor` — suppresses the sponsor popup for the session
