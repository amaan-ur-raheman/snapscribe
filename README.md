# SnapScribe

**Capture. Annotate. Export. Nothing leaves your browser.**

SnapScribe is a privacy-first screenshot extension for Chrome (Manifest V3), written in
TypeScript. Grab the visible area, the full page, a selected region, or a single element,
then annotate on a built-in canvas and export as PNG, JPEG, or multi-page PDF. Every pixel
is processed locally on your device. There is no account, no analytics, and no server.

---

## ✨ Features

| Capture | Edit | Export |
| --- | --- | --- |
| **Visible area** - one click, ready to share | **Annotate** - arrows, rectangles, freehand pen, text labels, highlighter | **PNG** - lossless, the default |
| **Full page** - automatic scroll-and-stitch with sticky-header dedup and retina (DPR) normalization | **Crop & resize** - with aspect-ratio lock | **JPEG** - adjustable quality |
| **Region** - drag to select exactly what you want | **Blur / redact** - hide sensitive information | **PDF** - multi-page A4 for tall pages |
| **Element** - hover to highlight, click to capture | **Undo / redo** - full history for every change | **Clipboard** - copy in one click |

Plus:

- **Capture history** with thumbnails in the popup
- **Keyboard shortcuts** - `Alt+Shift+S` (visible area), `Alt+Shift+F` (full page)
- **Right-click menu** - "Capture this page" and "Capture this element"
- **Custom filename patterns** - `{site}-{date}-{time}`, whatever you like
- **Light and dark themes**, on every surface

---

## 🚀 Getting started

**Prerequisites:** [bun](https://bun.sh) (used for install, scripts, and tests) and a recent
version of Chrome (111+).

```bash
# 1. Install dependencies
bun install

# 2. Develop with hot reload (crxjs)
bun run dev

# 3. Build the production bundle into dist/
bun run build
```

**Load the unpacked extension:**

1. Open `chrome://extensions`
2. Enable **Developer mode** (top-right)
3. Click **Load unpacked** and select the `dist/` folder
4. Pin SnapScribe to the toolbar and click the icon to capture

### Scripts

| Command | What it does |
| --- | --- |
| `bun run dev` | Start the Vite dev server with crxjs HMR |
| `bun run build` | Typecheck, then build into `dist/` |
| `bun run typecheck` | `tsc --noEmit` |
| `bun run lint` | ESLint |
| `bun run format` | Prettier write |
| `bun run format:check` | Prettier check |
| `bun run test` | Run tests |

---

## 🧰 Usage

### Keyboard shortcuts

| Shortcut | Action |
| --- | --- |
| `Alt+Shift+S` | Capture the visible area |
| `Alt+Shift+F` | Capture the full page |

### Editor keys

| Key | Tool |
| --- | --- |
| `V` | Select / move |
| `C` | Crop |
| `R` | Rectangle |
| `A` | Arrow |
| `P` | Freehand pen |
| `T` | Text label |
| `H` | Highlighter |
| `B` | Blur / redact |
| `Ctrl+Z` / `Ctrl+Shift+Z` | Undo / redo |

---

## 🎨 Design

SnapScribe ships a small, deliberate design system in `src/styles/tokens.css`:

- **One source of truth** for dark/light palettes, typography, radii, elevation, and motion,
  shared by the popup, editor, and options pages
- A **coral "shutter" accent** on cool graphite neutrals (dark) and cool paper (light)
- **Monospace reserved for readouts** - dimensions, timestamps, status, and filename patterns
- A consistent **hand-drawn SVG icon set** (one stroke weight, `currentColor` states)
- Motion is transform/opacity only, ease-out, and fully gated behind `prefers-reduced-motion`

---

## 🔒 Privacy

SnapScribe is built to never see your data:

- **No servers, no accounts, no analytics** - all capture, stitching, editing, and encoding
  runs on your device
- **No remote code** - the bundle is fully self-contained
- **Permissions are scoped and explained**: `activeTab` + `scripting` for capture,
  `downloads` for saving files, `storage` for your local settings/history,
  `contextMenus` for the right-click menu, `clipboardWrite` for copy
- **Host access to all URLs** exists so region and element capture can run on any site;
  SnapScribe only touches a page when you choose to capture it

### Known limitations

- **Cross-origin iframes** cannot be captured (a browser security boundary that cannot be
  bypassed)
- **Extremely long pages** are guarded by a max-scroll safeguard; giant captures encode as
  large data URLs, which browsers may refuse to download beyond a size threshold

---

## 🗂 Project structure

```
snapscribe/
├── manifest.config.ts        # crxjs manifest definition (MV3)
├── vite.config.ts
├── tsconfig.json
├── package.json
├── src/
│   ├── background/
│   │   └── service-worker.ts # capture, export, history, shortcuts, context menu
│   ├── content/
│   │   ├── content-script.ts # region/element selection overlays
│   │   └── overlay.css
│   ├── popup/                # capture UI, preview, history strip
│   ├── editor/               # annotation canvas, crop/resize, export
│   ├── options/              # format, quality, filename pattern, theme
│   ├── styles/tokens.css     # shared design system
│   ├── lib/
│   │   ├── pdf-generator.ts  # hand-written minimal PDF encoder (no deps)
│   │   ├── stitcher.ts       # full-page scroll-and-stitch
│   │   ├── storage.ts        # typed settings + history wrapper
│   │   ├── pending-edit.ts   # IndexedDB handoff: popup -> editor
│   │   ├── thumbnail.ts      # DOM-free history thumbnails
│   │   ├── base64.ts         # chunked base64 encoding
│   │   ├── filename.ts       # filename patterns
│   │   └── image.ts          # shared image decoding
│   └── types/                # discriminated-union message contracts
├── icons/                    # 16/32/48/128 store icons
└── dist/                     # build output (load unpacked from here)
```

---

## 🛠 Tech stack

| Layer | Choice |
| --- | --- |
| Language | TypeScript, strict mode |
| Bundler | Vite + [@crxjs/vite-plugin](https://crxjs.dev) |
| Extension | Chrome Manifest V3 |
| PDF | Hand-written encoder in `lib/pdf-generator.ts` (zero dependencies) |
| Runtime dependencies | **None** - no UI framework, no third-party libs in the bundle |
| Lint / format | ESLint + Prettier |

---

## 📄 License

Private project. All rights reserved.
