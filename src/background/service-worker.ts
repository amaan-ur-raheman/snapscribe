/**
 * SnapScribe service worker — the only place that talks to the browser's
 * capture and download APIs. Every inbound message is a member of the typed
 * RuntimeRequest union; responses are typed and always `{ ok: true | false }`.
 */

import { DEFAULT_SETTINGS } from '../lib/storage';
import { isRuntimeRequest, sendContentRequest } from '../types/messages';
import type {
  CaptureResponse,
  ContentRequest,
  ContentResponseFor,
  DownloadResponse,
  FixedComposite,
  FullPageCaptureResponse,
  RuntimeRequest,
  SimpleOkResponse,
  StitchedStrip,
  ViewportCaptureResponse,
} from '../types/messages';

/** Safety cap on the number of stitched strips (infinite-scroll guard). */
const MAX_STRIPS = 100;
/** Chrome's canvas area limit is ~268M pixels; keep margin for safety. */
const MAX_TOTAL_PIXELS = 200_000_000;
/**
 * Chrome allows at most 2 captureVisibleTab calls per second per extension
 * (MAX_CAPTURE_VISIBLE_TAB_CALLS_PER_SECOND, Chrome 92+). 600ms keeps us
 * comfortably under that even when capture flows run back to back.
 */
const CAPTURE_INTERVAL_MS = 600;

let lastCaptureAt = 0;

// Seed settings once so reads never return a partial object.
chrome.runtime.onInstalled.addListener(() => {
  void chrome.storage.local.get('settings').then((stored) => {
    if (!stored.settings) {
      void chrome.storage.local.set({ settings: DEFAULT_SETTINGS });
    }
  });
});

chrome.runtime.onMessage.addListener((message: unknown, sender, sendResponse) => {
  if (!isRuntimeRequest(message)) {
    sendResponse({ ok: false, error: 'Unknown message' });
    return;
  }
  handleRequest(message, sender.tab?.id)
    .then(sendResponse)
    .catch((err: unknown) =>
      sendResponse({ ok: false, error: err instanceof Error ? err.message : String(err) }),
    );
  return true; // keep the message channel open for the async response
});

async function handleRequest(
  msg: RuntimeRequest,
  senderTabId: number | undefined,
): Promise<
  | CaptureResponse
  | DownloadResponse
  | FullPageCaptureResponse
  | ViewportCaptureResponse
  | SimpleOkResponse
> {
  switch (msg.type) {
    case 'CAPTURE_VISIBLE':
      return captureVisible(msg.tabId);
    case 'CAPTURE_FULL_PAGE':
      return captureFullPage(msg.tabId);
    case 'START_REGION_SELECTION':
      return startSelection(msg.tabId, 'REGION_SELECT');
    case 'START_ELEMENT_SELECTION':
      return startSelection(msg.tabId, 'ELEMENT_SELECT');
    case 'CAPTURE_VIEWPORT':
      return captureViewport(senderTabId);
    case 'DOWNLOAD_CAPTURE':
      return downloadCapture(msg.dataUrl, msg.filename);
  }
}

/** Forward a selection request to the tab's content script. */
async function startSelection(
  tabId: number,
  mode: 'REGION_SELECT' | 'ELEMENT_SELECT',
): Promise<SimpleOkResponse> {
  try {
    await sendToContent(tabId, { type: mode });
    return { ok: true };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}

/** Capture the current viewport for the content script to crop. */
async function captureViewport(tabId: number | undefined): Promise<ViewportCaptureResponse> {
  if (tabId === undefined) {
    return { ok: false, error: 'Could not determine the tab to capture.' };
  }
  try {
    const tab = await chrome.tabs.get(tabId);
    await throttleCapture();
    const dataUrl = await chrome.tabs.captureVisibleTab(tab.windowId, { format: 'png' });
    return { ok: true, dataUrl };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}

async function captureVisible(tabId: number): Promise<CaptureResponse> {
  const tab = await chrome.tabs.get(tabId);
  // captureVisibleTab keys on window id, not tab id.
  await throttleCapture();
  const dataUrl = await chrome.tabs.captureVisibleTab(tab.windowId, { format: 'png' });
  const { width, height } = pngDimensions(dataUrl);
  return {
    ok: true,
    result: {
      format: 'png',
      width,
      height,
      dpr: await readDevicePixelRatio(tabId),
      dataUrl,
      sourceUrl: tab.url ?? '',
      timestamp: Date.now(),
    },
  };
}

/**
 * Full-page capture: scroll the page one viewport at a time, capture each
 * strip, and return everything the popup needs to stitch them.
 *
 * Fixed/sticky elements are hidden for the strip captures so they don't
 * duplicate; the popup composites them back once from a reference strip
 * captured before hiding. All coordinates are normalized to device pixels
 * via the page's devicePixelRatio.
 */
async function captureFullPage(tabId: number): Promise<FullPageCaptureResponse> {
  const tab = await chrome.tabs.get(tabId);
  const windowId = tab.windowId;

  try {
    // 1. Start at the top of the page.
    await sendToContent(tabId, { type: 'FULL_PAGE_SCROLL', y: 0 });

    // 2. Reference strip with fixed/sticky elements still visible — it
    //    supplies the pixels composited back over the clean stitch.
    await throttleCapture();
    const reference = await chrome.tabs.captureVisibleTab(windowId, { format: 'png' });

    // 3. Measure the page and hide fixed/sticky elements.
    const prep = await sendToContent(tabId, { type: 'FULL_PAGE_PREPARE' });
    if (!prep.ok) {
      await sendToContent(tabId, { type: 'FULL_PAGE_RESTORE' });
      return prep;
    }
    const { clientWidth, scrollHeight, innerHeight, dpr, fixedRects } = prep;

    const width = Math.round(clientWidth * dpr);
    const height = Math.round(scrollHeight * dpr);
    if (width * height > MAX_TOTAL_PIXELS) {
      await sendToContent(tabId, { type: 'FULL_PAGE_RESTORE' });
      return {
        ok: false,
        error: `Page is too large to capture (${width} × ${height} device pixels exceeds the canvas limit).`,
      };
    }

    // 4. Scroll + capture one strip per viewport, top to bottom.
    const strips: StitchedStrip[] = [];
    let y = 0;
    let previousY = -1;
    for (let i = 0; i < MAX_STRIPS; i++) {
      const step = await sendToContent(tabId, { type: 'FULL_PAGE_SCROLL', y });
      if (!step.ok) {
        await sendToContent(tabId, { type: 'FULL_PAGE_RESTORE' });
        return step;
      }
      if (i > 0 && step.scrollY <= previousY) break; // page won't scroll further
      await throttleCapture();
      const dataUrl = await chrome.tabs.captureVisibleTab(windowId, { format: 'png' });
      strips.push({ y: Math.round(step.scrollY * dpr), dataUrl });
      if (step.scrollY + innerHeight >= scrollHeight - 0.5) break; // reached the bottom
      previousY = step.scrollY;
      y = step.scrollY + innerHeight;
    }

    // 5. Put the page back the way we found it.
    await sendToContent(tabId, { type: 'FULL_PAGE_RESTORE' });

    if (strips.length === 0) {
      return { ok: false, error: 'No strips were captured; the page may not be scrollable.' };
    }

    // 6. Fixed/sticky elements visible in the first viewport get composited
    //    back once, cropped from the reference strip at their screen position.
    const composites: FixedComposite[] = fixedRects
      .filter((rect) => rect.y + rect.height > 0 && rect.y < innerHeight)
      .map((rect) => ({
        x: Math.round(rect.x * dpr),
        y: Math.round(rect.y * dpr),
        width: Math.round(rect.width * dpr),
        height: Math.round(rect.height * dpr),
        sourceDataUrl: reference,
      }));

    return {
      ok: true,
      stitch: {
        width,
        height,
        dpr,
        strips,
        composites,
        sourceUrl: tab.url ?? '',
        timestamp: Date.now(),
      },
    };
  } catch (err) {
    // Best-effort cleanup so the page isn't left with hidden headers.
    try {
      await sendToContent(tabId, { type: 'FULL_PAGE_RESTORE' });
    } catch {
      // Tab may have closed — nothing more we can do.
    }
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}

/**
 * Chrome throws this when chrome.tabs.sendMessage finds no content script
 * listening in the target tab.
 */
function isReceivingEndMissing(err: unknown): boolean {
  return err instanceof Error && err.message.includes('Receiving end does not exist');
}

/**
 * Send a typed request to the tab's content script, injecting the script
 * first when the tab predates the extension (pages loaded before install or
 * reload have no content script until they reload).
 */
async function sendToContent<T extends ContentRequest>(
  tabId: number,
  msg: T,
): Promise<ContentResponseFor<T>> {
  try {
    return await sendContentRequest(tabId, msg);
  } catch (err) {
    if (!isReceivingEndMissing(err)) throw err;
    await ensureContentScript(tabId);
    return await sendContentRequest(tabId, msg);
  }
}

/**
 * Inject the content script into a tab. The path comes from the built
 * manifest, so it works even though crxjs hashes the bundled file name.
 */
async function ensureContentScript(tabId: number): Promise<void> {
  const scripts = chrome.runtime.getManifest().content_scripts?.[0]?.js;
  if (!scripts || scripts.length === 0) {
    throw new Error('No content script is registered in the manifest.');
  }
  try {
    await chrome.scripting.executeScript({ target: { tabId }, files: scripts });
  } catch {
    throw new Error(
      'SnapScribe cannot run on this page — it may be a browser-internal page (chrome://, the Web Store) or the page may need a reload. Reload the page and try again.',
    );
  }
}

async function downloadCapture(dataUrl: string, filename: string): Promise<DownloadResponse> {
  const safeFilename = sanitizeFilename(filename);
  const downloadId = await chrome.downloads.download({ url: dataUrl, filename: safeFilename });
  return { ok: true, downloadId };
}

/** Strip path separators / traversal so a filename can't escape the Downloads dir. */
function sanitizeFilename(name: string): string {
  const cleaned = name
    .replace(/[\\/:*?"<>|]/g, '-')
    .replace(/\.\./g, '')
    .replace(/^[/\\-]+/, '');
  return cleaned.length > 0 ? cleaned : `snapscribe-${Date.now()}.png`;
}

/** Read the page's devicePixelRatio; falls back to 1 when injection fails. */
async function readDevicePixelRatio(tabId: number): Promise<number> {
  try {
    const [injection] = await chrome.scripting.executeScript({
      target: { tabId },
      func: () => window.devicePixelRatio,
    });
    return typeof injection?.result === 'number' ? injection.result : 1;
  } catch {
    return 1;
  }
}

/** Wait so consecutive captureVisibleTab calls stay at least CAPTURE_INTERVAL_MS apart. */
async function throttleCapture(): Promise<void> {
  const elapsed = Date.now() - lastCaptureAt;
  if (elapsed < CAPTURE_INTERVAL_MS) {
    await delay(CAPTURE_INTERVAL_MS - elapsed);
  }
  lastCaptureAt = Date.now();
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Read width/height straight from the PNG header (no DOM needed in the worker). */
function pngDimensions(dataUrl: string): { width: number; height: number } {
  const base64 = dataUrl.slice(dataUrl.indexOf(',') + 1);
  const bytes = Uint8Array.from(atob(base64), (c) => c.charCodeAt(0));
  if (bytes.length < 24 || bytes[0] !== 0x89 || bytes[1] !== 0x50) {
    throw new Error('Captured image is not a valid PNG');
  }
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  return { width: view.getUint32(16), height: view.getUint32(20) };
}
