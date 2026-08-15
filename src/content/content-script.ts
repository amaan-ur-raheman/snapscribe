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
import { buildFilename, extensionFor } from '../lib/filename';
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
  position: 'fixed' | 'sticky';
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

async function preparePage(): Promise<PrepareResponse> {
  collectFixedAndSticky();
  hideFixedAndSticky();
  await nextFrame();
  await nextFrame();

  const after = pageMeasurements();

  return {
    ok: true,
    ...after,
    fixedRects: hiddenElements.map(({ rect, position }) => ({
      x: rect.x,
      y: rect.y,
      width: rect.width,
      height: rect.height,
      position,
    })),
  };
}

function pageMeasurements(): Pick<
  PrepareResponse & { ok: true },
  'clientWidth' | 'innerHeight' | 'scrollHeight' | 'dpr'
> {
  return {
    clientWidth: document.documentElement.clientWidth,
    innerHeight: window.innerHeight,
    scrollHeight: Math.max(document.documentElement.scrollHeight, document.body?.scrollHeight ?? 0),
    dpr: window.devicePixelRatio || 1,
  };
}

async function scrollToAndSettle(y: number): Promise<ScrollResponse> {
  if (!hasInitialized) {
    initialScrollY = window.scrollY;
    hasInitialized = true;
  }
  // Use the coordinate overload so page CSS cannot turn this into a smooth
  // scroll and leave captureVisibleTab between two composited frames.
  window.scrollTo(0, y);
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
    window.scrollTo(0, initialScrollY);
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
    hiddenElements.push({ el, rect, position });
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
  hiddenStyle = document.createElement('style');
  hiddenStyle.textContent =
    `[${HIDDEN_ATTR}]{visibility:hidden!important}` +
    `html{scrollbar-gutter:stable!important;scrollbar-color:transparent transparent!important}` +
    `body{scrollbar-color:transparent transparent!important}` +
    `html::-webkit-scrollbar-thumb,body::-webkit-scrollbar-thumb{background:transparent!important;border-color:transparent!important}` +
    `html::-webkit-scrollbar-track,body::-webkit-scrollbar-track{background:transparent!important}` +
    `*,*::before,*::after{animation:none!important;transition:none!important;caret-color:transparent!important}`;
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
      // captureVisibleTab can otherwise observe the pre-scroll compositor
      // frame even after scrollY has stopped changing.
      await nextFrame();
      await nextFrame();
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
    hint.textContent = 'Drag to select (Esc to cancel)';
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
    hint.textContent = 'Click an element (Esc to cancel)';
    document.documentElement.append(highlight, hint);

    let rect: Rect | null = null;
    let hoveredEl: HTMLElement | null = null;
    let finished = false;

    const finish = (cancelled: boolean): void => {
      if (finished) return;
      finished = true;
      cleanup();
      resolve({ ok: true });
      if (cancelled || !rect) return;
      const original = rect;
      void (async () => {
        // A partially-visible element would crop blank canvas below the fold.
        // Scroll it fully into view first (unless it's already fully visible,
        // so an on-screen element never makes the page jump).
        if (hoveredEl && !isFullyVisible(hoveredEl)) {
          hoveredEl.scrollIntoView({ block: 'center', inline: 'nearest' });
          await nextFrame();
          await nextFrame();
          const bounds = hoveredEl.getBoundingClientRect();
          await completeSelectionCapture({
            x: bounds.x,
            y: bounds.y,
            width: bounds.width,
            height: bounds.height,
          });
          return;
        }
        await completeSelectionCapture(original);
      })();
    };

    const onMouseMove = (e: MouseEvent): void => {
      const el = elementAt(e.clientX, e.clientY);
      if (!el) {
        hoveredEl = null;
        highlight.style.display = 'none';
        rect = null;
        return;
      }
      hoveredEl = el;
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
      // A click can land without a prior mousemove (touch, or a fast click
      // right after the mode activates) — resolve the element from the event.
      const el = hoveredEl ?? elementAt(e.clientX, e.clientY);
      if (el) {
        hoveredEl = el;
        const bounds = el.getBoundingClientRect();
        rect = { x: bounds.x, y: bounds.y, width: bounds.width, height: bounds.height };
      }
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

/** Whether the element's bounds lie entirely within the current viewport. */
function isFullyVisible(el: HTMLElement): boolean {
  const r = el.getBoundingClientRect();
  return (
    r.top >= 0 && r.left >= 0 && r.bottom <= window.innerHeight && r.right <= window.innerWidth
  );
}

// ---------------------------------------------------------------------------
// Capture the selected rect (shared by region + element)
// ---------------------------------------------------------------------------

async function completeSelectionCapture(rect: Rect): Promise<void> {
  // The selection UI was just removed from the DOM; wait for the page to
  // repaint, or captureVisibleTab grabs the previous composited frame and
  // the hint pill / mask / highlight end up in the image.
  await nextFrame();
  await nextFrame();
  try {
    const response = await sendRuntimeRequest({ type: 'CAPTURE_VIEWPORT' });
    if (!response.ok) {
      showToast(response.error, true);
      return;
    }
    const crop = await cropViewport(response.dataUrl, rect);
    const settings = await getSettings();
    const filename = buildFilename(
      window.location.href,
      settings.filenamePattern,
      extensionFor(settings.defaultFormat),
    );
    const saved = await sendRuntimeRequest({
      type: 'DOWNLOAD_CAPTURE',
      dataUrl: crop.dataUrl,
      filename,
      format: settings.defaultFormat,
      quality: settings.jpegQuality,
    });
    if (saved.ok) {
      // Record into capture history (thumbnail + metadata) in the background.
      void sendRuntimeRequest({
        type: 'RECORD_HISTORY',
        dataUrl: crop.dataUrl,
        sourceUrl: window.location.href,
        width: crop.width,
        height: crop.height,
        dpr: window.devicePixelRatio || 1,
        format: settings.defaultFormat,
      }).catch(() => undefined);
    }
    showToast(saved.ok ? `Saved ${filename}` : saved.error, !saved.ok);
  } catch (err) {
    showToast(err instanceof Error ? err.message : String(err), true);
  }
}

/**
 * Crop the captured viewport (device pixels) to the selection (CSS px).
 * Returns the cropped image plus its pixel dimensions.
 */
async function cropViewport(
  dataUrl: string,
  rect: Rect,
): Promise<{ dataUrl: string; width: number; height: number }> {
  const dpr = window.devicePixelRatio || 1;
  const image = await loadImage(dataUrl);
  // Clamp the crop to the captured image: a selection that extends past the
  // viewport (an element taller than the screen, a drag past the edge) would
  // otherwise export blank canvas below the fold.
  const x = Math.max(0, Math.round(rect.x * dpr));
  const y = Math.max(0, Math.round(rect.y * dpr));
  const right = Math.min(Math.round((rect.x + rect.width) * dpr), image.width);
  const bottom = Math.min(Math.round((rect.y + rect.height) * dpr), image.height);
  const width = Math.max(1, right - x);
  const height = Math.max(1, bottom - y);
  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext('2d');
  if (!ctx) throw new Error('Canvas 2D is not available');
  ctx.drawImage(image, -x, -y);
  return { dataUrl: canvas.toDataURL('image/png'), width, height };
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
