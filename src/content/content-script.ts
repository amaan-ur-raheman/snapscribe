/**
 * Content script — runs in every page the user could capture. Handles:
 * - Full-page captures: scrolling, settling, hiding fixed/sticky elements
 * - Region drag-select and element picker overlays, viewport cropping, and
 *   the saved-toast
 *
 * All messages are members of the ContentRequest union; messages not
 * addressed to the content script are ignored so other listeners can
 * respond.
 */

import overlayCss from './overlay.css?inline';
import { buildFilename } from '../lib/filename';
import { loadImage } from '../lib/image';
import { getSettings } from '../lib/storage';
import { isContentRequest, sendRuntimeRequest } from '../types/messages';
import type {
  ContentRequest,
  PrepareResponse,
  ScrollResponse,
  SimpleOkResponse,
} from '../types/messages';

/** How long to wait after a scroll for lazy-loaded content to render. */
const LAZY_RENDER_DELAY_MS = 300;
/** How long to wait for a scroll to settle before giving up. */
const SCROLL_SETTLE_TIMEOUT_MS = 1000;
/** Attribute + selector pair used to hide fixed/sticky elements reversibly. */
const HIDDEN_ATTR = 'data-snapscribe-hidden';
/** Toast element id and how long it stays visible. */
const TOAST_ID = 'snapscribe-toast';
const TOAST_DURATION_MS = 3500;

interface HiddenElement {
  el: HTMLElement;
  rect: DOMRect;
}

/** A rectangle in viewport CSS pixels. */
interface Rect {
  x: number;
  y: number;
  width: number;
  height: number;
}

const hiddenElements: HiddenElement[] = [];
let hiddenStyle: HTMLStyleElement | null = null;
let initialScrollY = 0;
let hasInitialized = false;
let toastTimer: number | undefined;

// Inject the overlay styles ourselves — chrome.scripting.executeScript (the
// stale-tab fallback) injects only the script, never the manifest CSS, so a
// bare content script has to be self-styling.
const overlayStyle = document.createElement('style');
overlayStyle.textContent = overlayCss;
(document.head ?? document.documentElement).appendChild(overlayStyle);

chrome.runtime.onMessage.addListener((message: unknown, _sender, sendResponse) => {
  if (!isContentRequest(message)) return; // not addressed to the content script
  handleContentRequest(message)
    .then(sendResponse)
    .catch((err: unknown) =>
      sendResponse({ ok: false, error: err instanceof Error ? err.message : String(err) }),
    );
  return true; // keep the message channel open for the async response
});

async function handleContentRequest(
  msg: ContentRequest,
): Promise<PrepareResponse | ScrollResponse | SimpleOkResponse> {
  switch (msg.type) {
    case 'FULL_PAGE_PREPARE':
      return preparePage();
    case 'FULL_PAGE_SCROLL':
      return scrollToAndSettle(msg.y);
    case 'FULL_PAGE_RESTORE':
      return restorePage();
    case 'REGION_SELECT':
      return selectRegion();
    case 'ELEMENT_SELECT':
      return pickElement();
  }
}

// ---------------------------------------------------------------------------
// Full-page helpers
// ---------------------------------------------------------------------------

function preparePage(): PrepareResponse {
  const dpr = window.devicePixelRatio || 1;
  const innerHeight = window.innerHeight;
  const clientWidth = window.innerWidth;
  const scrollHeight = Math.max(
    document.documentElement.scrollHeight,
    document.body?.scrollHeight ?? 0,
  );

  collectFixedAndSticky();
  hideFixedAndSticky();

  return {
    ok: true,
    clientWidth,
    innerHeight,
    scrollHeight,
    dpr,
    fixedRects: hiddenElements.map(({ rect }) => ({
      x: rect.x,
      y: rect.y,
      width: rect.width,
      height: rect.height,
    })),
  };
}

async function scrollToAndSettle(y: number): Promise<ScrollResponse> {
  if (!hasInitialized) {
    initialScrollY = window.scrollY;
    hasInitialized = true;
  }
  window.scrollTo({ top: y, behavior: 'instant' });
  const settledY = await waitForScrollSettle();
  return { ok: true, scrollY: settledY };
}

function restorePage(): SimpleOkResponse {
  if (hiddenStyle) {
    hiddenStyle.remove();
    hiddenStyle = null;
  }
  for (const { el } of hiddenElements) el.removeAttribute(HIDDEN_ATTR);
  hiddenElements.length = 0;
  if (hasInitialized) {
    window.scrollTo({ top: initialScrollY, behavior: 'instant' });
    hasInitialized = false;
  }
  return { ok: true };
}

/**
 * Collect the fixed/sticky elements that would duplicate across stitched
 * strips: every `position: fixed` element (they sit at the same screen
 * position on every strip) and `position: sticky` elements visible in the
 * first viewport (they stick to the viewport while scrolled).
 *
 * Sticky elements below the fold are left in the flow untouched — hiding
 * them would leave blank holes in the final image.
 */
function collectFixedAndSticky(): void {
  const viewport = { top: 0, bottom: window.innerHeight, left: 0, right: window.innerWidth };
  for (const el of document.querySelectorAll<HTMLElement>('*')) {
    if (el === document.documentElement || el === document.body) continue;
    const position = getComputedStyle(el).position;
    if (position !== 'fixed' && position !== 'sticky') continue;
    const rect = el.getBoundingClientRect();
    if (rect.width === 0 || rect.height === 0) continue; // hidden or empty
    if (position === 'sticky' && !intersectsViewport(rect, viewport)) continue;
    hiddenElements.push({ el, rect });
  }
}

function intersectsViewport(
  rect: { left: number; right: number; top: number; bottom: number },
  viewport: { left: number; right: number; top: number; bottom: number },
): boolean {
  return (
    rect.left < viewport.right &&
    rect.right > viewport.left &&
    rect.top < viewport.bottom &&
    rect.bottom > viewport.top
  );
}

/** Hide the collected elements with visibility (layout untouched). */
function hideFixedAndSticky(): void {
  if (hiddenElements.length === 0) return;
  hiddenStyle = document.createElement('style');
  hiddenStyle.textContent = `[${HIDDEN_ATTR}]{visibility:hidden!important}`;
  document.documentElement.appendChild(hiddenStyle);
  for (const { el } of hiddenElements) el.setAttribute(HIDDEN_ATTR, '');
}

async function waitForScrollSettle(): Promise<number> {
  const start = performance.now();
  let lastY = window.scrollY;
  while (performance.now() - start < SCROLL_SETTLE_TIMEOUT_MS) {
    await nextFrame();
    const currentY = window.scrollY;
    if (currentY === lastY) {
      // Stable for a frame — give lazy-loaded content time to render.
      await delay(LAZY_RENDER_DELAY_MS);
      return window.scrollY;
    }
    lastY = currentY;
  }
  return window.scrollY;
}

function nextFrame(): Promise<void> {
  return new Promise((resolve) => requestAnimationFrame(() => resolve()));
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// ---------------------------------------------------------------------------
// Region drag-select
// ---------------------------------------------------------------------------

function selectRegion(): Promise<SimpleOkResponse> {
  return new Promise((resolve) => {
    const overlay = document.createElement('div');
    overlay.className = 'snapscribe-overlay';
    const selection = document.createElement('div');
    selection.className = 'snapscribe-selection';
    selection.style.display = 'none';
    const sizeLabel = document.createElement('div');
    sizeLabel.className = 'snapscribe-size-label';
    sizeLabel.style.display = 'none';
    const hint = document.createElement('div');
    hint.className = 'snapscribe-hint';
    hint.textContent = 'Drag to select — Esc to cancel';
    overlay.append(selection, sizeLabel, hint);
    document.documentElement.appendChild(overlay);

    let dragStart: { x: number; y: number } | null = null;
    let rect: Rect | null = null;
    let finished = false;

    const finish = (cancelled: boolean): void => {
      if (finished) return;
      finished = true;
      cleanup();
      resolve({ ok: true });
      if (!cancelled && rect) void completeSelectionCapture(rect);
    };

    const onMouseDown = (e: MouseEvent): void => {
      e.preventDefault(); // stop the page from selecting text
      dragStart = { x: e.clientX, y: e.clientY };
      rect = { x: dragStart.x, y: dragStart.y, width: 0, height: 0 };
      updateSelection();
    };
    const onMouseMove = (e: MouseEvent): void => {
      if (!dragStart) return;
      rect = normalizeRect(dragStart, { x: e.clientX, y: e.clientY });
      updateSelection();
    };
    const onMouseUp = (e: MouseEvent): void => {
      if (!dragStart) return;
      rect = normalizeRect(dragStart, { x: e.clientX, y: e.clientY });
      dragStart = null;
      finish(false);
    };
    const onKeyDown = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') finish(true);
    };
    const onContextMenu = (e: MouseEvent): void => e.preventDefault();

    overlay.addEventListener('mousedown', onMouseDown);
    window.addEventListener('mousemove', onMouseMove);
    window.addEventListener('mouseup', onMouseUp);
    window.addEventListener('keydown', onKeyDown);
    overlay.addEventListener('contextmenu', onContextMenu);

    const updateSelection = (): void => {
      if (!rect) return;
      selection.style.display = 'block';
      selection.style.left = `${rect.x}px`;
      selection.style.top = `${rect.y}px`;
      selection.style.width = `${rect.width}px`;
      selection.style.height = `${rect.height}px`;
      sizeLabel.style.display = 'block';
      sizeLabel.textContent = `${Math.round(rect.width)} × ${Math.round(rect.height)}`;
      sizeLabel.style.left = `${rect.x}px`;
      sizeLabel.style.top = rect.y >= 24 ? `${rect.y - 22}px` : `${rect.y + rect.height + 6}px`;
    };

    const cleanup = (): void => {
      overlay.removeEventListener('mousedown', onMouseDown);
      window.removeEventListener('mousemove', onMouseMove);
      window.removeEventListener('mouseup', onMouseUp);
      window.removeEventListener('keydown', onKeyDown);
      overlay.removeEventListener('contextmenu', onContextMenu);
      overlay.remove();
    };
  });
}

function normalizeRect(a: { x: number; y: number }, b: { x: number; y: number }): Rect {
  return {
    x: Math.min(a.x, b.x),
    y: Math.min(a.y, b.y),
    width: Math.abs(b.x - a.x),
    height: Math.abs(b.y - a.y),
  };
}

// ---------------------------------------------------------------------------
// Element picker
// ---------------------------------------------------------------------------

function pickElement(): Promise<SimpleOkResponse> {
  return new Promise((resolve) => {
    const highlight = document.createElement('div');
    highlight.className = 'snapscribe-highlight';
    highlight.style.display = 'none';
    const hint = document.createElement('div');
    hint.className = 'snapscribe-hint';
    hint.textContent = 'Click an element — Esc to cancel';
    document.documentElement.append(highlight, hint);

    let rect: Rect | null = null;
    let finished = false;

    const finish = (cancelled: boolean): void => {
      if (finished) return;
      finished = true;
      cleanup();
      resolve({ ok: true });
      if (!cancelled && rect) void completeSelectionCapture(rect);
    };

    const onMouseMove = (e: MouseEvent): void => {
      const el = elementAt(e.clientX, e.clientY);
      if (!el) {
        highlight.style.display = 'none';
        rect = null;
        return;
      }
      const bounds = el.getBoundingClientRect();
      rect = { x: bounds.x, y: bounds.y, width: bounds.width, height: bounds.height };
      highlight.style.display = 'block';
      highlight.style.left = `${bounds.x}px`;
      highlight.style.top = `${bounds.y}px`;
      highlight.style.width = `${bounds.width}px`;
      highlight.style.height = `${bounds.height}px`;
    };
    const onClick = (e: MouseEvent): void => {
      e.preventDefault();
      e.stopPropagation();
      finish(false);
    };
    const onKeyDown = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') finish(true);
    };

    document.addEventListener('mousemove', onMouseMove, true);
    document.addEventListener('click', onClick, true);
    window.addEventListener('keydown', onKeyDown);

    const cleanup = (): void => {
      document.removeEventListener('mousemove', onMouseMove, true);
      document.removeEventListener('click', onClick, true);
      window.removeEventListener('keydown', onKeyDown);
      highlight.remove();
      hint.remove();
    };
  });
}

/** The topmost element under the cursor (ignoring tiny or hidden ones). */
function elementAt(x: number, y: number): HTMLElement | null {
  const el = document.elementFromPoint(x, y);
  if (!(el instanceof HTMLElement)) return null;
  const rect = el.getBoundingClientRect();
  if (rect.width < 2 || rect.height < 2) return null;
  return el;
}

// ---------------------------------------------------------------------------
// Capture the selected rect (shared by region + element)
// ---------------------------------------------------------------------------

async function completeSelectionCapture(rect: Rect): Promise<void> {
  try {
    const response = await sendRuntimeRequest({ type: 'CAPTURE_VIEWPORT' });
    if (!response.ok) {
      showToast(response.error, true);
      return;
    }
    const dataUrl = await cropViewport(response.dataUrl, rect);
    const settings = await getSettings();
    const filename = buildFilename(window.location.href, settings.filenamePattern, 'png');
    const saved = await sendRuntimeRequest({ type: 'DOWNLOAD_CAPTURE', dataUrl, filename });
    showToast(saved.ok ? `Saved ${filename}` : saved.error, !saved.ok);
  } catch (err) {
    showToast(err instanceof Error ? err.message : String(err), true);
  }
}

/** Crop the captured viewport (device pixels) to the selection (CSS px). */
async function cropViewport(dataUrl: string, rect: Rect): Promise<string> {
  const dpr = window.devicePixelRatio || 1;
  const x = Math.round(rect.x * dpr);
  const y = Math.round(rect.y * dpr);
  const width = Math.max(1, Math.round(rect.width * dpr));
  const height = Math.max(1, Math.round(rect.height * dpr));
  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext('2d');
  if (!ctx) throw new Error('Canvas 2D is not available');
  const image = await loadImage(dataUrl);
  ctx.drawImage(image, -x, -y);
  return canvas.toDataURL('image/png');
}

// ---------------------------------------------------------------------------
// Saved-toast
// ---------------------------------------------------------------------------

function showToast(message: string, isError: boolean): void {
  let toast = document.getElementById(TOAST_ID);
  if (!toast) {
    toast = document.createElement('div');
    toast.id = TOAST_ID;
    toast.className = 'snapscribe-toast';
    document.documentElement.appendChild(toast);
  }
  toast.textContent = message;
  toast.classList.toggle('snapscribe-toast-error', isError);
  toast.classList.add('snapscribe-toast-visible');
  window.clearTimeout(toastTimer);
  toastTimer = window.setTimeout(
    () => toast?.classList.remove('snapscribe-toast-visible'),
    TOAST_DURATION_MS,
  );
}
