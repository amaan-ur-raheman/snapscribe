/**
 * Post-capture editor (Phase 5).
 *
 * One canvas holds the document. The source image is immutable; `crop`
 * (source px) + `width`/`height` (canvas px) define the view transform, and
 * annotations live in canvas px. Every render redraws base + annotations, so
 * blur annotations can sample the underlying pixels. Undo/redo snapshots
 * { crop, width, height, annotations }.
 *
 * Export reuses the DOWNLOAD_CAPTURE message — the service worker already
 * handles PNG/JPEG/PDF conversion, quality, and sanitized filenames.
 */

import { buildFilename, extensionFor } from '../lib/filename';
import { loadImage } from '../lib/image';
import { takePendingEdit } from '../lib/pending-edit';
import { getSettings } from '../lib/storage';
import { sendRuntimeRequest } from '../types/messages';
import type { ExportFormat } from '../types/messages';
import type { Annotation, CropRect, EditorSnapshot, EditorTool, Point } from '../types/editor';

const MAX_HISTORY = 100;
/** Min drag size (canvas px) before a crop/rect/highlight/blur commits. */
const MIN_DRAG_SIZE = 4;
/** Min arrow length (canvas px) before it commits. */
const MIN_ARROW_LENGTH = 12;
/** Hit-test tolerance for select / move (canvas px). */
const HIT_TOLERANCE = 8;

const COLORS = [
  '#ef4444',
  '#f97316',
  '#facc15',
  '#22c55e',
  '#3b82f6',
  '#a855f7',
  '#ffffff',
  '#111827',
];

const $ = <T extends HTMLElement>(id: string): T => {
  const el = document.getElementById(id);
  if (!el) throw new Error(`Missing element #${id}`);
  return el as T;
};

const canvas = $<HTMLCanvasElement>('canvas');
const context = canvas.getContext('2d');
if (!context) throw new Error('Canvas 2D is not available');
/** Non-null alias — module-scope narrowing does not reach function bodies. */
const ctx = context;

const toolButtons = {
  select: $<HTMLButtonElement>('tool-select'),
  crop: $<HTMLButtonElement>('tool-crop'),
  rect: $<HTMLButtonElement>('tool-rect'),
  arrow: $<HTMLButtonElement>('tool-arrow'),
  pen: $<HTMLButtonElement>('tool-pen'),
  text: $<HTMLButtonElement>('tool-text'),
  highlight: $<HTMLButtonElement>('tool-highlight'),
  blur: $<HTMLButtonElement>('tool-blur'),
} as const;

const undoButton = $<HTMLButtonElement>('undo');
const redoButton = $<HTMLButtonElement>('redo');
const clearButton = $<HTMLButtonElement>('clear');
const closeButton = $<HTMLButtonElement>('close');
const swatchesEl = $<HTMLElement>('swatches');
const colorGroup = $<HTMLElement>('color-group');
const strokeGroup = $<HTMLElement>('stroke-group');
const strokeWidthInput = $<HTMLSelectElement>('stroke-width');
const fontGroup = $<HTMLElement>('font-group');
const fontSizeInput = $<HTMLSelectElement>('font-size');
const blurGroup = $<HTMLElement>('blur-group');
const blurRadiusInput = $<HTMLInputElement>('blur-radius');
const blurRadiusValue = $<HTMLElement>('blur-radius-value');
const resizeWidthInput = $<HTMLInputElement>('resize-width');
const resizeHeightInput = $<HTMLInputElement>('resize-height');
const resizeLockInput = $<HTMLInputElement>('resize-lock');
const resizeApplyButton = $<HTMLButtonElement>('resize-apply');
const formatPngButton = $<HTMLButtonElement>('format-png');
const formatJpegButton = $<HTMLButtonElement>('format-jpeg');
const formatPdfButton = $<HTMLButtonElement>('format-pdf');
const qualityRow = $<HTMLElement>('quality-row');
const qualityInput = $<HTMLInputElement>('quality');
const qualityValue = $<HTMLElement>('quality-value');
const copyButton = $<HTMLButtonElement>('copy');
const downloadButton = $<HTMLButtonElement>('download');
const statusLabel = $<HTMLElement>('status');
const dimsLabel = $<HTMLElement>('dims');

// ---------------------------------------------------------------------------
// Document state
// ---------------------------------------------------------------------------

let sourceImage: HTMLImageElement | null = null;
let sourceUrl = '';
let crop: CropRect = { x: 0, y: 0, width: 0, height: 0 };
let width = 0;
let height = 0;
let annotations: Annotation[] = [];
let history: EditorSnapshot[] = [];
let historyIndex = -1;

let tool: EditorTool = 'select';
let color = COLORS[0] ?? '#ef4444';
let strokeWidth = 4;
let fontSize = 24;
let blurRadius = 12;
let exportFormat: ExportFormat = 'png';
let jpegQuality = 90;

/** Annotation currently being dragged or drawn (not yet committed). */
type Draft =
  | { kind: 'crop'; x0: number; y0: number; x1: number; y1: number }
  | { kind: 'rect'; x: number; y: number; width: number; height: number }
  | { kind: 'arrow'; x1: number; y1: number; x2: number; y2: number }
  | { kind: 'pen'; points: Point[] }
  | { kind: 'highlight'; x: number; y: number; width: number; height: number }
  | { kind: 'blur'; x: number; y: number; width: number; height: number };

let draft: Draft | null = null;
let selectedIndex: number | null = null;
let pointerDown = false;
/** Offset between the pointer and the selected annotation's box origin. */
let moveOffset: Point | null = null;
/** Whether the pointer actually dragged since pointerdown (history gate). */
let movedDuringDrag = false;

// ---------------------------------------------------------------------------
// Initialization
// ---------------------------------------------------------------------------

const params = new URLSearchParams(window.location.search);
const editId = params.get('id');

void (async () => {
  // Apply the saved theme before rendering anything.
  const { theme } = await getSettings();
  document.documentElement.dataset.theme = theme;
  if (!editId) {
    setStatus('No capture was passed to the editor. Close this tab and capture again.', true);
    return;
  }
  try {
    const payload = await takePendingEdit(editId);
    if (!payload) {
      setStatus('This capture is no longer available. Close this tab and capture again.', true);
      return;
    }
    sourceUrl = payload.sourceUrl;
    sourceImage = await loadImage(payload.dataUrl);
    crop = { x: 0, y: 0, width: sourceImage.naturalWidth, height: sourceImage.naturalHeight };
    width = crop.width;
    height = crop.height;
    commitState();
    syncResizeInputs();
    setStatus('Ready. Pick a tool to annotate, or crop / resize below.');
    updateDims();
    render();
  } catch (error) {
    setStatus(error instanceof Error ? error.message : String(error), true);
  }
})();

// ---------------------------------------------------------------------------
// History (undo / redo)
// ---------------------------------------------------------------------------

function snapshot(): EditorSnapshot {
  return { crop: { ...crop }, width, height, annotations: structuredClone(annotations) };
}

/** Record the current state as the new head of history. */
function commitState(): void {
  history = history.slice(0, historyIndex + 1);
  history.push(snapshot());
  if (history.length > MAX_HISTORY) history.shift();
  historyIndex = history.length - 1;
  updateHistoryButtons();
}

function undo(): void {
  if (historyIndex <= 0) return;
  historyIndex -= 1;
  restore(history[historyIndex]!);
}

function redo(): void {
  if (historyIndex >= history.length - 1) return;
  historyIndex += 1;
  restore(history[historyIndex]!);
}

function restore(entry: EditorSnapshot): void {
  crop = { ...entry.crop };
  width = entry.width;
  height = entry.height;
  annotations = structuredClone(entry.annotations);
  selectedIndex = null;
  syncResizeInputs();
  updateDims();
  render();
  updateHistoryButtons();
}

function updateHistoryButtons(): void {
  undoButton.disabled = historyIndex <= 0;
  redoButton.disabled = historyIndex >= history.length - 1;
}

// ---------------------------------------------------------------------------
// Rendering
// ---------------------------------------------------------------------------

function render(): void {
  if (!sourceImage) return;
  canvas.width = width;
  canvas.height = height;

  ctx.fillStyle = '#ffffff';
  ctx.fillRect(0, 0, width, height);

  // Base image: source crop region → canvas.
  ctx.imageSmoothingEnabled = true;
  ctx.imageSmoothingQuality = 'high';
  ctx.drawImage(sourceImage, crop.x, crop.y, crop.width, crop.height, 0, 0, width, height);

  // Annotations, in array order (z-order).
  annotations.forEach((annotation, index) => {
    drawAnnotation(annotation);
    if (index === selectedIndex && tool === 'select') drawSelectionBox(annotation);
  });

  if (draft) drawDraft(draft);
  updateDims();
}

/** Draw a committed annotation. Blur samples the pixels already on canvas. */
function drawAnnotation(annotation: Annotation): void {
  ctx.save();
  switch (annotation.kind) {
    case 'rect':
      ctx.strokeStyle = annotation.color;
      ctx.lineWidth = annotation.strokeWidth;
      ctx.strokeRect(annotation.x, annotation.y, annotation.width, annotation.height);
      break;
    case 'arrow':
      strokeArrow(
        annotation.x1,
        annotation.y1,
        annotation.x2,
        annotation.y2,
        annotation.color,
        annotation.strokeWidth,
      );
      break;
    case 'pen':
      strokePolyline(annotation.points, annotation.color, annotation.strokeWidth);
      break;
    case 'text':
      ctx.fillStyle = annotation.color;
      ctx.font = `600 ${annotation.fontSize}px system-ui, sans-serif`;
      ctx.textBaseline = 'top';
      ctx.fillText(annotation.text, annotation.x, annotation.y);
      break;
    case 'highlight':
      ctx.globalCompositeOperation = 'multiply';
      ctx.globalAlpha = 0.45;
      ctx.fillStyle = annotation.color;
      ctx.fillRect(annotation.x, annotation.y, annotation.width, annotation.height);
      break;
    case 'blur':
      blurRegion(
        annotation.x,
        annotation.y,
        annotation.width,
        annotation.height,
        annotation.radius,
      );
      break;
  }
  ctx.restore();
}

function drawDraft(d: Draft): void {
  ctx.save();
  switch (d.kind) {
    case 'crop': {
      const rect = normalizeRect({ x: d.x0, y: d.y0 }, { x: d.x1, y: d.y1 });
      ctx.setLineDash([6, 4]);
      ctx.strokeStyle = '#6366f1';
      ctx.lineWidth = 2;
      ctx.strokeRect(rect.x, rect.y, rect.width, rect.height);
      // Dim everything outside the selection.
      ctx.fillStyle = 'rgba(0, 0, 0, 0.45)';
      ctx.fillRect(0, 0, width, rect.y);
      ctx.fillRect(0, rect.y + rect.height, width, height - rect.y - rect.height);
      ctx.fillRect(0, rect.y, rect.x, rect.height);
      ctx.fillRect(rect.x + rect.width, rect.y, width - rect.x - rect.width, rect.height);
      break;
    }
    case 'rect':
      ctx.strokeStyle = color;
      ctx.lineWidth = strokeWidth;
      ctx.strokeRect(d.x, d.y, d.width, d.height);
      break;
    case 'arrow':
      strokeArrow(d.x1, d.y1, d.x2, d.y2, color, strokeWidth);
      break;
    case 'pen':
      strokePolyline(d.points, color, strokeWidth);
      break;
    case 'highlight':
      ctx.globalCompositeOperation = 'multiply';
      ctx.globalAlpha = 0.45;
      ctx.fillStyle = color;
      ctx.fillRect(d.x, d.y, d.width, d.height);
      break;
    case 'blur':
      blurRegion(d.x, d.y, d.width, d.height, blurRadius);
      break;
  }
  ctx.restore();
}

function strokeArrow(x1: number, y1: number, x2: number, y2: number, c: string, w: number): void {
  ctx.strokeStyle = c;
  ctx.lineWidth = w;
  ctx.lineCap = 'round';
  ctx.beginPath();
  ctx.moveTo(x1, y1);
  ctx.lineTo(x2, y2);
  ctx.stroke();

  const angle = Math.atan2(y2 - y1, x2 - x1);
  const headLength = Math.max(10, w * 3);
  ctx.beginPath();
  ctx.moveTo(x2, y2);
  ctx.lineTo(
    x2 - headLength * Math.cos(angle - Math.PI / 6),
    y2 - headLength * Math.sin(angle - Math.PI / 6),
  );
  ctx.moveTo(x2, y2);
  ctx.lineTo(
    x2 - headLength * Math.cos(angle + Math.PI / 6),
    y2 - headLength * Math.sin(angle + Math.PI / 6),
  );
  ctx.stroke();
}

function strokePolyline(points: Point[], c: string, w: number): void {
  if (points.length < 2) return;
  ctx.strokeStyle = c;
  ctx.lineWidth = w;
  ctx.lineCap = 'round';
  ctx.lineJoin = 'round';
  ctx.beginPath();
  ctx.moveTo(points[0]!.x, points[0]!.y);
  for (let i = 1; i < points.length; i++) {
    ctx.lineTo(points[i]!.x, points[i]!.y);
  }
  ctx.stroke();
}

/** Blur the pixels already on the canvas inside the given rect. */
function blurRegion(x: number, y: number, w: number, h: number, radius: number): void {
  ctx.save();
  ctx.beginPath();
  ctx.rect(x, y, w, h);
  ctx.clip();
  ctx.filter = `blur(${radius}px)`;
  ctx.drawImage(canvas, x, y, w, h, x, y, w, h);
  ctx.restore();
}

function drawSelectionBox(annotation: Annotation): void {
  const box = bboxOf(annotation);
  if (!box) return;
  ctx.setLineDash([5, 3]);
  ctx.strokeStyle = '#6366f1';
  ctx.lineWidth = 1.5;
  ctx.strokeRect(box.x - 4, box.y - 4, box.width + 8, box.height + 8);
  ctx.setLineDash([]);
}

/** Bounding box of an annotation in canvas px, or null for empty ones. */
function bboxOf(
  annotation: Annotation,
): { x: number; y: number; width: number; height: number } | null {
  switch (annotation.kind) {
    case 'rect':
    case 'highlight':
    case 'blur':
      return {
        x: annotation.x,
        y: annotation.y,
        width: annotation.width,
        height: annotation.height,
      };
    case 'arrow': {
      const x = Math.min(annotation.x1, annotation.x2);
      const y = Math.min(annotation.y1, annotation.y2);
      return {
        x,
        y,
        width: Math.abs(annotation.x2 - annotation.x1),
        height: Math.abs(annotation.y2 - annotation.y1),
      };
    }
    case 'pen': {
      if (annotation.points.length === 0) return null;
      const xs = annotation.points.map((p) => p.x);
      const ys = annotation.points.map((p) => p.y);
      const minX = Math.min(...xs);
      const maxX = Math.max(...xs);
      const minY = Math.min(...ys);
      const maxY = Math.max(...ys);
      return { x: minX, y: minY, width: maxX - minX, height: maxY - minY };
    }
    case 'text':
      return {
        x: annotation.x,
        y: annotation.y,
        width: Math.max(24, annotation.text.length * annotation.fontSize * 0.6),
        height: annotation.fontSize,
      };
  }
}

// ---------------------------------------------------------------------------
// Pointer interaction
// ---------------------------------------------------------------------------

function toCanvasCoords(event: PointerEvent): Point {
  const rect = canvas.getBoundingClientRect();
  return {
    x: ((event.clientX - rect.left) * canvas.width) / rect.width,
    y: ((event.clientY - rect.top) * canvas.height) / rect.height,
  };
}

function onPointerDown(event: PointerEvent): void {
  if (!sourceImage || draft) return;
  const point = toCanvasCoords(event);
  pointerDown = true;
  // The text tool must not capture the pointer: capture would route the
  // subsequent click back to the canvas, blurring the just-created input and
  // removing it before the user can type.
  if (tool !== 'text') canvas.setPointerCapture(event.pointerId);

  if (tool === 'select') {
    const hit = hitTest(point);
    selectedIndex = hit;
    const box = hit !== null ? bboxOf(annotations[hit]!) : null;
    moveOffset = box ? { x: point.x - box.x, y: point.y - box.y } : null;
    movedDuringDrag = false;
    render();
    return;
  }
  if (tool === 'text') {
    showTextInput(point);
    return;
  }
  if (tool === 'crop') {
    draft = { kind: 'crop', x0: point.x, y0: point.y, x1: point.x, y1: point.y };
  } else if (tool === 'rect') {
    draft = { kind: 'rect', x: point.x, y: point.y, width: 0, height: 0 };
  } else if (tool === 'arrow') {
    draft = { kind: 'arrow', x1: point.x, y1: point.y, x2: point.x, y2: point.y };
  } else if (tool === 'pen') {
    draft = { kind: 'pen', points: [point] };
  } else if (tool === 'highlight') {
    draft = { kind: 'highlight', x: point.x, y: point.y, width: 0, height: 0 };
  } else if (tool === 'blur') {
    draft = { kind: 'blur', x: point.x, y: point.y, width: 0, height: 0 };
  }
  render();
}

function onPointerMove(event: PointerEvent): void {
  if (!sourceImage) return;
  const point = toCanvasCoords(event);

  if (tool === 'select' && pointerDown && selectedIndex !== null && moveOffset) {
    movedDuringDrag = true;
    moveSelectedTo(point);
    render();
    return;
  }
  if (!draft) return;
  switch (draft.kind) {
    case 'crop':
      draft.x1 = point.x;
      draft.y1 = point.y;
      break;
    case 'rect':
      draft.width = point.x - draft.x;
      draft.height = point.y - draft.y;
      break;
    case 'arrow':
      draft.x2 = point.x;
      draft.y2 = point.y;
      break;
    case 'pen':
      draft.points.push(point);
      break;
    case 'highlight':
      draft.width = point.x - draft.x;
      draft.height = point.y - draft.y;
      break;
    case 'blur':
      draft.width = point.x - draft.x;
      draft.height = point.y - draft.y;
      break;
  }
  render();
}

function onPointerUp(_event: PointerEvent): void {
  pointerDown = false;
  if (!sourceImage) return;

  if (draft) {
    const committed = commitDraft(draft);
    draft = null;
    if (committed) {
      commitState();
      setStatus(toolStatus(tool));
    }
    render();
    return;
  }

  if (tool === 'select' && movedDuringDrag && selectedIndex !== null) {
    movedDuringDrag = false;
    moveOffset = null;
    commitState();
    setStatus('Moved annotation');
  }
  moveOffset = null;
}

/** Apply the finished draft to the document; returns false if too small. */
function commitDraft(d: Draft): boolean {
  switch (d.kind) {
    case 'crop': {
      const rect = normalizeRect({ x: d.x0, y: d.y0 }, { x: d.x1, y: d.y1 });
      if (rect.width < MIN_DRAG_SIZE || rect.height < MIN_DRAG_SIZE) return false;
      // Canvas coords → source coords.
      const scaleX = width / crop.width;
      const scaleY = height / crop.height;
      const newCrop: CropRect = {
        x: crop.x + rect.x / scaleX,
        y: crop.y + rect.y / scaleY,
        width: rect.width / scaleX,
        height: rect.height / scaleY,
      };
      // Drop annotations fully outside the crop, offset the rest.
      const kept: Annotation[] = [];
      for (const annotation of annotations) {
        const box = bboxOf(annotation);
        if (!box) continue;
        const inside =
          box.x >= rect.x - HIT_TOLERANCE &&
          box.y >= rect.y - HIT_TOLERANCE &&
          box.x + box.width <= rect.x + rect.width + HIT_TOLERANCE &&
          box.y + box.height <= rect.y + rect.height + HIT_TOLERANCE;
        if (!inside) continue;
        kept.push(offsetAnnotation(annotation, -rect.x, -rect.y));
      }
      crop = newCrop;
      width = rect.width;
      height = rect.height;
      annotations = kept;
      selectedIndex = null;
      syncResizeInputs();
      return true;
    }
    case 'rect': {
      const rect = normalizeRect({ x: d.x, y: d.y }, { x: d.x + d.width, y: d.y + d.height });
      if (rect.width < MIN_DRAG_SIZE || rect.height < MIN_DRAG_SIZE) return false;
      annotations.push({ kind: 'rect', ...rect, color, strokeWidth });
      return true;
    }
    case 'arrow': {
      if (Math.hypot(d.x2 - d.x1, d.y2 - d.y1) < MIN_ARROW_LENGTH) return false;
      annotations.push({
        kind: 'arrow',
        x1: d.x1,
        y1: d.y1,
        x2: d.x2,
        y2: d.y2,
        color,
        strokeWidth,
      });
      return true;
    }
    case 'pen':
      if (d.points.length < 2) return false;
      annotations.push({ kind: 'pen', points: d.points, color, strokeWidth });
      return true;
    case 'highlight': {
      const rect = normalizeRect({ x: d.x, y: d.y }, { x: d.x + d.width, y: d.y + d.height });
      if (rect.width < MIN_DRAG_SIZE || rect.height < MIN_DRAG_SIZE) return false;
      annotations.push({ kind: 'highlight', ...rect, color });
      return true;
    }
    case 'blur': {
      const rect = normalizeRect({ x: d.x, y: d.y }, { x: d.x + d.width, y: d.y + d.height });
      if (rect.width < MIN_DRAG_SIZE || rect.height < MIN_DRAG_SIZE) return false;
      annotations.push({ kind: 'blur', ...rect, radius: blurRadius });
      return true;
    }
  }
}

function offsetAnnotation(annotation: Annotation, dx: number, dy: number): Annotation {
  switch (annotation.kind) {
    case 'rect':
    case 'highlight':
    case 'blur':
      return { ...annotation, x: annotation.x + dx, y: annotation.y + dy };
    case 'arrow':
      return {
        ...annotation,
        x1: annotation.x1 + dx,
        y1: annotation.y1 + dy,
        x2: annotation.x2 + dx,
        y2: annotation.y2 + dy,
      };
    case 'pen':
      return {
        ...annotation,
        points: annotation.points.map((p) => ({ x: p.x + dx, y: p.y + dy })),
      };
    case 'text':
      return { ...annotation, x: annotation.x + dx, y: annotation.y + dy };
  }
}

/** Move the selected annotation so the grab point follows the pointer. */
function moveSelectedTo(point: Point): void {
  const annotation = annotations[selectedIndex ?? -1];
  if (!annotation || !moveOffset) return;
  const dx = point.x - moveOffset.x - (bboxOf(annotation)?.x ?? 0);
  const dy = point.y - moveOffset.y - (bboxOf(annotation)?.y ?? 0);
  annotations[selectedIndex!] = offsetAnnotation(annotation, dx, dy);
}

// ---------------------------------------------------------------------------
// Hit testing (select tool)
// ---------------------------------------------------------------------------

function hitTest(point: Point): number | null {
  for (let i = annotations.length - 1; i >= 0; i--) {
    const annotation = annotations[i]!;
    switch (annotation.kind) {
      case 'rect':
      case 'highlight':
      case 'blur':
        if (pointInRect(point, annotation.x, annotation.y, annotation.width, annotation.height))
          return i;
        break;
      case 'arrow':
        if (
          distanceToSegment(
            point,
            { x: annotation.x1, y: annotation.y1 },
            { x: annotation.x2, y: annotation.y2 },
          ) <
          HIT_TOLERANCE + annotation.strokeWidth
        )
          return i;
        break;
      case 'pen':
        if (
          annotation.points.some((p, idx) => {
            if (idx === 0) return Math.hypot(point.x - p.x, point.y - p.y) < HIT_TOLERANCE;
            const prev = annotation.points[idx - 1]!;
            return distanceToSegment(point, prev, p) < HIT_TOLERANCE + annotation.strokeWidth;
          })
        )
          return i;
        break;
      case 'text': {
        const box = bboxOf(annotation)!;
        if (
          pointInRect(
            point,
            box.x - HIT_TOLERANCE,
            box.y - HIT_TOLERANCE,
            box.width + HIT_TOLERANCE * 2,
            box.height + HIT_TOLERANCE * 2,
          )
        )
          return i;
        break;
      }
    }
  }
  return null;
}

function pointInRect(p: Point, x: number, y: number, w: number, h: number): boolean {
  const left = Math.min(x, x + w);
  const right = Math.max(x, x + w);
  const top = Math.min(y, y + h);
  const bottom = Math.max(y, y + h);
  return p.x >= left && p.x <= right && p.y >= top && p.y <= bottom;
}

function distanceToSegment(p: Point, a: Point, b: Point): number {
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const lengthSq = dx * dx + dy * dy;
  if (lengthSq === 0) return Math.hypot(p.x - a.x, p.y - a.y);
  let t = ((p.x - a.x) * dx + (p.y - a.y) * dy) / lengthSq;
  t = Math.max(0, Math.min(1, t));
  return Math.hypot(p.x - (a.x + t * dx), p.y - (a.y + t * dy));
}

// ---------------------------------------------------------------------------
// Text tool
// ---------------------------------------------------------------------------

let textInputEl: HTMLInputElement | null = null;

function showTextInput(point: Point): void {
  hideTextInput();
  const input = document.createElement('input');
  input.className = 'text-input';
  input.placeholder = 'Type…';
  const rect = canvas.getBoundingClientRect();
  input.style.left = `${rect.left + (point.x / canvas.width) * rect.width}px`;
  input.style.top = `${rect.top + (point.y / canvas.height) * rect.height}px`;
  input.style.fontSize = `${fontSize}px`;
  input.style.color = color;
  document.body.appendChild(input);
  textInputEl = input;
  // Focus after the current click finishes — focusing during pointerdown lets
  // the click's default blur win and the input vanishes before typing.
  window.setTimeout(() => {
    if (textInputEl === input) input.focus();
  }, 0);

  const commit = (): void => {
    // Removing a focused input fires blur synchronously, which re-enters this
    // handler — only the first pass may commit.
    if (textInputEl !== input) return;
    hideTextInput();
    const text = input.value.trim();
    if (!text) return;
    annotations.push({ kind: 'text', x: point.x, y: point.y, text, color, fontSize });
    commitState();
    setStatus(toolStatus('text'));
    render();
  };
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      commit();
    } else if (e.key === 'Escape') {
      e.preventDefault();
      hideTextInput();
      render();
    }
  });
  input.addEventListener('blur', commit);
}

function hideTextInput(): void {
  const el = textInputEl;
  // Null before remove: removing a focused input fires blur synchronously,
  // which would otherwise re-enter and try to remove the same node twice.
  textInputEl = null;
  if (el) el.remove();
}

// ---------------------------------------------------------------------------
// Toolbar wiring
// ---------------------------------------------------------------------------

for (const [name, button] of Object.entries(toolButtons) as [EditorTool, HTMLButtonElement][]) {
  button.addEventListener('click', () => selectTool(name));
}

undoButton.addEventListener('click', () => {
  undo();
  setStatus('Undid');
});
redoButton.addEventListener('click', () => {
  redo();
  setStatus('Redid');
});
clearButton.addEventListener('click', () => {
  if (annotations.length === 0) return;
  annotations = [];
  commitState();
  setStatus('Cleared all annotations');
  render();
});
closeButton.addEventListener('click', () => window.close());

// Color swatches.
for (const swatchColor of COLORS) {
  const button = document.createElement('button');
  button.type = 'button';
  button.className = 'swatch';
  button.style.background = swatchColor;
  button.setAttribute('aria-label', `Color ${swatchColor}`);
  button.addEventListener('click', () => {
    color = swatchColor;
    swatchesEl.querySelectorAll('.swatch').forEach((el) => el.classList.remove('active'));
    button.classList.add('active');
  });
  swatchesEl.appendChild(button);
}
const firstSwatch = swatchesEl.querySelector('.swatch');
firstSwatch?.classList.add('active');

strokeWidthInput.addEventListener('change', () => {
  strokeWidth = Number(strokeWidthInput.value);
});
fontSizeInput.addEventListener('change', () => {
  fontSize = Number(fontSizeInput.value);
});
blurRadiusInput.addEventListener('input', () => {
  blurRadius = Number(blurRadiusInput.value);
  blurRadiusValue.textContent = String(blurRadius);
});

// Resize.
resizeLockInput.addEventListener('change', () => syncResizeInputs());
resizeWidthInput.addEventListener('input', () => {
  if (resizeLockInput.checked && sourceImage) {
    const ratio = height / width;
    resizeHeightInput.value = String(
      Math.max(1, Math.round(Number(resizeWidthInput.value) * ratio)),
    );
  }
});
resizeHeightInput.addEventListener('input', () => {
  if (resizeLockInput.checked && sourceImage) {
    const ratio = width / height;
    resizeWidthInput.value = String(
      Math.max(1, Math.round(Number(resizeHeightInput.value) * ratio)),
    );
  }
});
resizeApplyButton.addEventListener('click', () => applyResize());

function syncResizeInputs(): void {
  resizeWidthInput.value = String(Math.round(width));
  resizeHeightInput.value = String(Math.round(height));
}

function applyResize(): void {
  if (!sourceImage) return;
  const newWidth = Math.max(1, Math.round(Number(resizeWidthInput.value) || width));
  const newHeight = Math.max(1, Math.round(Number(resizeHeightInput.value) || height));
  if (newWidth === width && newHeight === height) return;

  const scaleX = newWidth / width;
  const scaleY = newHeight / height;
  const strokeScale = (scaleX + scaleY) / 2;

  annotations = annotations.map((annotation) => {
    switch (annotation.kind) {
      case 'rect':
        return {
          ...annotation,
          x: annotation.x * scaleX,
          y: annotation.y * scaleY,
          width: annotation.width * scaleX,
          height: annotation.height * scaleY,
          strokeWidth: Math.max(1, annotation.strokeWidth * strokeScale),
        };
      case 'arrow':
        return {
          ...annotation,
          x1: annotation.x1 * scaleX,
          y1: annotation.y1 * scaleY,
          x2: annotation.x2 * scaleX,
          y2: annotation.y2 * scaleY,
          strokeWidth: Math.max(1, annotation.strokeWidth * strokeScale),
        };
      case 'pen':
        return {
          ...annotation,
          points: annotation.points.map((p) => ({ x: p.x * scaleX, y: p.y * scaleY })),
          strokeWidth: Math.max(1, annotation.strokeWidth * strokeScale),
        };
      case 'text':
        return {
          ...annotation,
          x: annotation.x * scaleX,
          y: annotation.y * scaleY,
          fontSize: Math.max(6, annotation.fontSize * strokeScale),
        };
      case 'highlight':
        return {
          ...annotation,
          x: annotation.x * scaleX,
          y: annotation.y * scaleY,
          width: annotation.width * scaleX,
          height: annotation.height * scaleY,
        };
      case 'blur':
        return {
          ...annotation,
          x: annotation.x * scaleX,
          y: annotation.y * scaleY,
          width: annotation.width * scaleX,
          height: annotation.height * scaleY,
          radius: Math.max(1, annotation.radius * strokeScale),
        };
    }
  });

  width = newWidth;
  height = newHeight;
  commitState();
  syncResizeInputs();
  setStatus(`Resized to ${newWidth} × ${newHeight}`);
  render();
}

// ---------------------------------------------------------------------------
// Tool selection + option visibility
// ---------------------------------------------------------------------------

function selectTool(next: EditorTool): void {
  tool = next;
  hideTextInput();
  draft = null;
  selectedIndex = null;
  for (const [name, button] of Object.entries(toolButtons) as [EditorTool, HTMLButtonElement][]) {
    const active = name === next;
    button.setAttribute('aria-pressed', String(active));
  }
  // Contextual options.
  colorGroup.classList.toggle(
    'hidden',
    !['rect', 'arrow', 'pen', 'text', 'highlight'].includes(next),
  );
  strokeGroup.classList.toggle('hidden', !['rect', 'arrow', 'pen'].includes(next));
  fontGroup.classList.toggle('hidden', next !== 'text');
  blurGroup.classList.toggle('hidden', next !== 'blur');
  setStatus(toolStatus(next));
  render();
}

function toolStatus(next: EditorTool): string {
  switch (next) {
    case 'select':
      return 'Click an annotation to select it; drag to move; Delete removes it.';
    case 'crop':
      return 'Drag to crop. Annotations outside the crop are removed.';
    case 'rect':
      return 'Drag to draw a rectangle.';
    case 'arrow':
      return 'Drag from the tail to the head of the arrow.';
    case 'pen':
      return 'Drag to draw freehand.';
    case 'text':
      return 'Click where the label should start, then type.';
    case 'highlight':
      return 'Drag to highlight.';
    case 'blur':
      return 'Drag to blur / redact a region.';
  }
}

// ---------------------------------------------------------------------------
// Export
// ---------------------------------------------------------------------------

const formatButtons: Record<ExportFormat, HTMLButtonElement> = {
  png: formatPngButton,
  jpeg: formatJpegButton,
  pdf: formatPdfButton,
};

for (const format of ['png', 'jpeg', 'pdf'] as const) {
  formatButtons[format].addEventListener('click', () => selectFormat(format));
}

qualityInput.addEventListener('input', () => {
  jpegQuality = Number(qualityInput.value);
  qualityValue.textContent = String(jpegQuality);
});

function selectFormat(format: ExportFormat): void {
  exportFormat = format;
  for (const key of ['png', 'jpeg', 'pdf'] as const) {
    const active = key === format;
    formatButtons[key].classList.toggle('active', active);
    formatButtons[key].setAttribute('aria-pressed', String(active));
  }
  qualityRow.classList.toggle('hidden', format === 'png');
  downloadButton.textContent = `Download ${format.toUpperCase()}`;
}

downloadButton.addEventListener('click', () => void onDownloadClick());
copyButton.addEventListener('click', () => void onCopyClick());

async function onDownloadClick(): Promise<void> {
  if (!sourceImage) return;
  downloadButton.disabled = true;
  try {
    const settings = await getSettings();
    const filename = buildFilename(sourceUrl, settings.filenamePattern, extensionFor(exportFormat));
    const dataUrl = canvas.toDataURL('image/png');
    const response = await sendRuntimeRequest({
      type: 'DOWNLOAD_CAPTURE',
      dataUrl,
      filename,
      format: exportFormat,
      quality: jpegQuality,
    });
    if (!response.ok) {
      setStatus(response.error, true);
      return;
    }
    setStatus(`Saved ${filename}`);
  } catch (error) {
    setStatus(error instanceof Error ? error.message : String(error), true);
  } finally {
    downloadButton.disabled = false;
  }
}

async function onCopyClick(): Promise<void> {
  if (!sourceImage) return;
  copyButton.disabled = true;
  try {
    const blob = await (await fetch(canvas.toDataURL('image/png'))).blob();
    await navigator.clipboard.write([new ClipboardItem({ 'image/png': blob })]);
    setStatus('Copied');
  } catch (error) {
    setStatus(error instanceof Error ? error.message : String(error), true);
  } finally {
    copyButton.disabled = false;
  }
}

// ---------------------------------------------------------------------------
// Keyboard + misc
// ---------------------------------------------------------------------------

window.addEventListener('keydown', (event) => {
  const mod = event.ctrlKey || event.metaKey;
  if (mod && event.key.toLowerCase() === 'z') {
    event.preventDefault();
    if (event.shiftKey) redo();
    else undo();
    return;
  }
  if (mod && event.key.toLowerCase() === 'y') {
    event.preventDefault();
    redo();
    return;
  }
  if (event.key === 'Delete' || event.key === 'Backspace') {
    if (selectedIndex !== null && tool === 'select' && !textInputEl) {
      event.preventDefault();
      annotations.splice(selectedIndex, 1);
      selectedIndex = null;
      commitState();
      setStatus('Deleted annotation');
      render();
    }
    return;
  }
  if (event.key === 'Escape') {
    hideTextInput();
    draft = null;
    render();
    return;
  }
  const hotkeys: Record<string, EditorTool> = {
    v: 'select',
    c: 'crop',
    r: 'rect',
    a: 'arrow',
    p: 'pen',
    t: 'text',
    h: 'highlight',
    b: 'blur',
  };
  const target = event.target as HTMLElement | null;
  const typing =
    target?.tagName === 'INPUT' || target?.tagName === 'SELECT' || target?.tagName === 'TEXTAREA';
  if (!typing && hotkeys[event.key.toLowerCase()]) {
    selectTool(hotkeys[event.key.toLowerCase()]!);
  }
});

canvas.addEventListener('pointerdown', onPointerDown);
canvas.addEventListener('pointermove', onPointerMove);
canvas.addEventListener('pointerup', onPointerUp);
canvas.addEventListener('pointercancel', () => {
  pointerDown = false;
  draft = null;
  render();
});

function normalizeRect(
  a: Point,
  b: Point,
): { x: number; y: number; width: number; height: number } {
  return {
    x: Math.min(a.x, b.x),
    y: Math.min(a.y, b.y),
    width: Math.abs(b.x - a.x),
    height: Math.abs(b.y - a.y),
  };
}

function updateDims(): void {
  dimsLabel.textContent = `${Math.round(width)} × ${Math.round(height)}px`;
}

function setStatus(message: string, isError = false): void {
  statusLabel.textContent = message;
  statusLabel.classList.toggle('error', isError);
}
