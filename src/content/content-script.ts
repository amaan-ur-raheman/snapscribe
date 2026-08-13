/**
 * Content script — runs in every page the user could capture. Coordinates
 * full-page captures for the service worker: scrolling, waiting for the page
 * to settle (so lazy content can render), and hiding/restoring fixed &
 * sticky elements so they don't duplicate across stitched strips.
 *
 * All messages are members of the ContentRequest union. Messages not
 * addressed to the content script are ignored so other listeners can
 * respond.
 */

import { isContentRequest } from '../types/messages';
import type {
  ContentRequest,
  PrepareResponse,
  RestoreResponse,
  ScrollResponse,
} from '../types/messages';

/** How long to wait after a scroll for lazy-loaded content to render. */
const LAZY_RENDER_DELAY_MS = 300;
/** How long to wait for a scroll to settle before giving up. */
const SCROLL_SETTLE_TIMEOUT_MS = 1000;
/** Attribute + selector pair used to hide fixed/sticky elements reversibly. */
const HIDDEN_ATTR = 'data-snapscribe-hidden';

interface HiddenElement {
  el: HTMLElement;
  rect: DOMRect;
}

const hiddenElements: HiddenElement[] = [];
let hiddenStyle: HTMLStyleElement | null = null;
let initialScrollY = 0;
let hasInitialized = false;

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
): Promise<PrepareResponse | ScrollResponse | RestoreResponse> {
  switch (msg.type) {
    case 'FULL_PAGE_PREPARE':
      return preparePage();
    case 'FULL_PAGE_SCROLL':
      return scrollToAndSettle(msg.y);
    case 'FULL_PAGE_RESTORE':
      return restorePage();
  }
}

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

function restorePage(): RestoreResponse {
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
