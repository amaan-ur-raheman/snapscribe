/**
 * SnapScribe service worker — the only place that talks to the browser's
 * capture and download APIs. Every inbound message is a member of the typed
 * RuntimeRequest union; responses are typed and always `{ ok: true | false }`.
 */

import { bytesToBase64 } from '../lib/base64';
import { buildFilename, extensionFor } from '../lib/filename';
import { generatePdf, splitIntoPdfPages } from '../lib/pdf-generator';
import { stitchFullPageWorker } from '../lib/stitcher';
import { addHistoryEntry, DEFAULT_SETTINGS, getSettings } from '../lib/storage';
import { makeThumbnail } from '../lib/thumbnail';
import { isRuntimeRequest, sendContentRequest } from '../types/messages';
import type {
  CaptureResponse,
  ContentRequest,
  ContentResponseFor,
  DownloadResponse,
  ExportFormat,
  FixedComposite,
  FullPageCaptureResponse,
  RecordHistoryMsg,
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
/** Overlap adjacent viewport captures to hide scroll/DPR seam rounding. */
const SCROLL_OVERLAP_PX = 64;
/** Give an injected module content script time to register its listener. */
const CONTENT_SCRIPT_RETRY_DELAY_MS = 50;
const CONTENT_SCRIPT_RETRIES = 5;

let lastCaptureAt = 0;

// Seed settings and register the right-click menu once.
chrome.runtime.onInstalled.addListener(() => {
  void chrome.storage.local.get('settings').then((stored) => {
    if (!stored.settings) {
      void chrome.storage.local.set({ settings: DEFAULT_SETTINGS });
    }
  });
  void chrome.contextMenus.removeAll().then(() => {
    chrome.contextMenus.create({
      id: 'capture-page',
      title: 'Capture this page (SnapScribe)',
      contexts: ['page'],
    });
    chrome.contextMenus.create({
      id: 'capture-element',
      title: 'Capture this element (SnapScribe)',
      contexts: ['all'],
    });
  });
});

// Keyboard shortcuts (commands API) — capture the active tab and save
// directly, no popup involved.
chrome.commands.onCommand.addListener((command) => {
  void handleCommand(command);
});

// Right-click menu items.
chrome.contextMenus.onClicked.addListener((info, tab) => {
  if (!tab?.id) return;
  if (info.menuItemId === 'capture-page') {
    void captureAndSave(tab.id, 'full');
  } else if (info.menuItemId === 'capture-element') {
    void startSelection(tab.id, 'ELEMENT_SELECT');
  }
});

chrome.runtime.onMessage.addListener((message: unknown, sender, sendResponse) => {
  if (!isRuntimeRequest(message)) {
    sendResponse({ ok: false, error: 'Unknown message' });
    return;
  }
  handleRequest(message, sender.tab?.id, sender.id, sender.url)
    .then(sendResponse)
    .catch((err: unknown) =>
      sendResponse({ ok: false, error: err instanceof Error ? err.message : String(err) }),
    );
  return true; // keep the message channel open for the async response
});

async function handleRequest(
  msg: RuntimeRequest,
  senderTabId: number | undefined,
  senderId: string | undefined,
  senderUrl: string | undefined,
): Promise<
  | CaptureResponse
  | DownloadResponse
  | FullPageCaptureResponse
  | ViewportCaptureResponse
  | SimpleOkResponse
> {
  switch (msg.type) {
    case 'CAPTURE_VISIBLE':
      if (!isExtensionUiMessage(senderId, senderTabId, senderUrl)) return unauthorizedResponse();
      return captureVisible(msg.tabId);
    case 'CAPTURE_FULL_PAGE':
      if (!isExtensionUiMessage(senderId, senderTabId, senderUrl)) return unauthorizedResponse();
      return captureFullPage(msg.tabId);
    case 'START_REGION_SELECTION':
      if (!isExtensionUiMessage(senderId, senderTabId, senderUrl)) return unauthorizedResponse();
      return startSelection(msg.tabId, 'REGION_SELECT');
    case 'START_ELEMENT_SELECTION':
      if (!isExtensionUiMessage(senderId, senderTabId, senderUrl)) return unauthorizedResponse();
      return startSelection(msg.tabId, 'ELEMENT_SELECT');
    case 'CAPTURE_VIEWPORT':
      if (senderTabId === undefined) return unauthorizedResponse();
      return captureViewport(senderTabId);
    case 'DOWNLOAD_CAPTURE':
      return downloadCapture(msg.dataUrl, msg.filename, msg.format, msg.quality);
    case 'RECORD_HISTORY':
      return recordHistory(msg);
  }
}

/**
 * Commands API handler: Alt+Shift+S captures the visible area, Alt+Shift+F
 * the full page. Both save through the default export settings.
 */
async function handleCommand(command: string): Promise<void> {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab?.id) return;
  if (command === 'capture-visible') await captureAndSave(tab.id, 'visible');
  else if (command === 'capture-full-page') await captureAndSave(tab.id, 'full');
}

/** Capture (visible or full page) and save it via the default settings. */
async function captureAndSave(tabId: number, mode: 'visible' | 'full'): Promise<void> {
  try {
    const settings = await getSettings();
    if (mode === 'visible') {
      const response = await captureVisible(tabId);
      if (!response.ok) return;
      const result = response.result;
      const filename = buildFilename(
        result.sourceUrl,
        settings.filenamePattern,
        extensionFor(settings.defaultFormat),
      );
      await downloadCapture(result.dataUrl, filename, settings.defaultFormat, settings.jpegQuality);
      await recordHistory({
        type: 'RECORD_HISTORY',
        dataUrl: result.dataUrl,
        sourceUrl: result.sourceUrl,
        width: result.width,
        height: result.height,
        dpr: result.dpr,
        format: settings.defaultFormat,
      });
    } else {
      const response = await captureFullPage(tabId);
      if (!response.ok) return;
      const dataUrl = await stitchFullPageWorker(response.stitch);
      const filename = buildFilename(
        response.stitch.sourceUrl,
        settings.filenamePattern,
        extensionFor(settings.defaultFormat),
      );
      await downloadCapture(dataUrl, filename, settings.defaultFormat, settings.jpegQuality);
      await recordHistory({
        type: 'RECORD_HISTORY',
        dataUrl,
        sourceUrl: response.stitch.sourceUrl,
        width: response.stitch.width,
        height: response.stitch.height,
        dpr: response.stitch.dpr,
        format: settings.defaultFormat,
      });
    }
  } catch (err) {
    console.error('[SnapScribe] Command/context capture failed:', err);
  }
}

/** Generate a thumbnail and prepend the capture to history. */
async function recordHistory(msg: RecordHistoryMsg): Promise<SimpleOkResponse> {
  try {
    const thumbnailDataUrl = await makeThumbnail(msg.dataUrl);
    await addHistoryEntry({
      thumbnailDataUrl,
      width: msg.width,
      height: msg.height,
      dpr: msg.dpr,
      format: msg.format,
      timestamp: Date.now(),
      sourceUrl: msg.sourceUrl,
    });
    return { ok: true };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}

function isExtensionUiMessage(
  senderId: string | undefined,
  senderTabId: number | undefined,
  senderUrl: string | undefined,
): boolean {
  if (senderId !== chrome.runtime.id) return false;
  if (senderTabId !== undefined) {
    // A tab-based sender is ours only if the tab shows our own page.
    return senderUrl?.startsWith(chrome.runtime.getURL('')) ?? false;
  }
  return true;
}

function unauthorizedResponse(): { ok: false; error: string } {
  return { ok: false, error: 'This capture request is not authorized.' };
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
    // This is only a safety estimate. The first clean strip establishes the
    // actual bitmap scale after scrollbar suppression and layout settling.
    let captureDpr = dpr;
    let width = Math.round(clientWidth * dpr);
    let height = Math.round(scrollHeight * captureDpr);
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
    let previousBottomPx = 0;
    let reachedBottom = false;
    for (let i = 0; i < MAX_STRIPS; i++) {
      const step = await sendToContent(tabId, { type: 'FULL_PAGE_SCROLL', y });
      if (!step.ok) {
        await sendToContent(tabId, { type: 'FULL_PAGE_RESTORE' });
        return step;
      }
      if (i > 0 && step.scrollY <= previousY) break; // page won't scroll further
      await throttleCapture();
      const dataUrl = await chrome.tabs.captureVisibleTab(windowId, { format: 'png' });
      const size = pngDimensions(dataUrl);
      if (i === 0) {
        // Calibrate from the first strip captured in the final hidden state;
        // the pre-hide reference is only used for fixed-element pixels.
        captureDpr = size.height / innerHeight;
        width = size.width;
        height = Math.round(scrollHeight * captureDpr);
        if (width * height > MAX_TOTAL_PIXELS) {
          await sendToContent(tabId, { type: 'FULL_PAGE_RESTORE' });
          return {
            ok: false,
            error: `Page is too large to capture (${width} × ${height} device pixels exceeds the canvas limit).`,
          };
        }
      } else if (
        size.width !== width ||
        Math.abs(size.height - Math.round(innerHeight * captureDpr)) > 1
      ) {
        await sendToContent(tabId, { type: 'FULL_PAGE_RESTORE' });
        return {
          ok: false,
          error: 'The page layout changed during capture. Please try again after it settles.',
        };
      }
      const stripY = Math.round(step.scrollY * captureDpr);
      const overlap = i === 0 ? 0 : Math.max(0, previousBottomPx - stripY);
      const sourceY = Math.min(size.height, Math.round(overlap));
      const sourceHeight = Math.max(0, size.height - sourceY);
      strips.push({ destY: stripY + sourceY, sourceY, sourceHeight, dataUrl });
      previousBottomPx = Math.max(previousBottomPx, stripY + size.height);
      if (step.scrollY + innerHeight >= scrollHeight - 0.5) {
        reachedBottom = true;
        break;
      }
      previousY = step.scrollY;
      y = step.scrollY + Math.max(1, innerHeight - SCROLL_OVERLAP_PX);
    }

    // 5. Put the page back the way we found it.
    await sendToContent(tabId, { type: 'FULL_PAGE_RESTORE' });

    if (strips.length === 0) {
      return { ok: false, error: 'No strips were captured; the page may not be scrollable.' };
    }
    if (!reachedBottom) {
      return {
        ok: false,
        error: `Page is too tall to capture in one operation (maximum ${MAX_STRIPS} viewport strips).`,
      };
    }

    // 6. Fixed/sticky elements visible in the first viewport get composited
    //    back once, cropped from the reference strip at their screen position.
    const composites: FixedComposite[] = fixedRects
      .filter(
        (rect) =>
          (rect.position === 'fixed' || rect.position === 'sticky') &&
          rect.y + rect.height > 0 &&
          rect.y < innerHeight &&
          rect.y < innerHeight / 2,
      )
      .map((rect) => ({
        x: Math.round(rect.x * captureDpr),
        y: Math.round(rect.y * captureDpr),
        width: Math.round(rect.width * captureDpr),
        height: Math.round(rect.height * captureDpr),
        sourceDataUrl: reference,
      }));

    return {
      ok: true,
      stitch: {
        width,
        height,
        dpr: captureDpr,
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
    for (let attempt = 0; attempt < CONTENT_SCRIPT_RETRIES; attempt++) {
      try {
        return await sendContentRequest(tabId, msg);
      } catch (retryErr) {
        if (!isReceivingEndMissing(retryErr) || attempt === CONTENT_SCRIPT_RETRIES - 1) {
          throw retryErr;
        }
        await delay(CONTENT_SCRIPT_RETRY_DELAY_MS);
      }
    }
  }

  throw new Error('Could not connect to the page content script.');
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

async function downloadCapture(
  dataUrl: string,
  filename: string,
  format?: ExportFormat,
  quality?: number,
): Promise<DownloadResponse> {
  // Format/quality fall back to the user's settings when the caller omits
  // them (legacy flows like the content-script toast path).
  const settings = await getSettings();
  const resolvedFormat = format ?? settings.defaultFormat;
  const resolvedQuality = (quality ?? settings.jpegQuality) / 100;
  const extension = extensionFor(resolvedFormat);
  const safeFilename = sanitizeFilename(withExtension(filename, extension), extension);

  try {
    const url = await exportToDownloadUrl(dataUrl, resolvedFormat, resolvedQuality);
    const downloadId = await chrome.downloads.download({ url, filename: safeFilename });
    return { ok: true, downloadId };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}

/**
 * Produce a data URL chrome.downloads can fetch for the requested format.
 *
 * Extension service workers have no URL.createObjectURL (a documented MV3
 * limitation), so JPEG/PDF output is base64 data URLs. PNG passes through
 * unchanged. Conversion runs on OffscreenCanvas — no DOM needed — and PDF
 * splits tall captures into one page per chunk.
 */
async function exportToDownloadUrl(
  dataUrl: string,
  format: ExportFormat,
  quality: number,
): Promise<string> {
  switch (format) {
    case 'png':
      return dataUrl;
    case 'jpeg': {
      const bytes = await dataUrlToJpegBytes(dataUrl, quality);
      return `data:image/jpeg;base64,${bytesToBase64(bytes)}`;
    }
    case 'pdf': {
      const pages = await splitIntoPdfPages(dataUrl, { quality });
      const bytes = new Uint8Array(await generatePdf(pages).arrayBuffer());
      return `data:application/pdf;base64,${bytesToBase64(bytes)}`;
    }
  }
}

/** Re-encode a PNG data URL as JPEG bytes (white underlay for any alpha). */
async function dataUrlToJpegBytes(
  dataUrl: string,
  quality: number,
): Promise<Uint8Array<ArrayBuffer>> {
  const bitmap = await createImageBitmap(await (await fetch(dataUrl)).blob());
  try {
    const canvas = new OffscreenCanvas(bitmap.width, bitmap.height);
    const ctx = canvas.getContext('2d');
    if (!ctx) throw new Error('OffscreenCanvas 2D is not available');
    ctx.fillStyle = '#fff';
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    ctx.drawImage(bitmap, 0, 0);
    const jpeg = await canvas.convertToBlob({ type: 'image/jpeg', quality });
    return new Uint8Array(await jpeg.arrayBuffer());
  } finally {
    bitmap.close();
  }
}

/** Replace any trailing extension with the export format's extension. */
function withExtension(filename: string, ext: string): string {
  return `${filename.replace(/\.[a-z0-9]+$/i, '')}.${ext}`;
}

/** Strip path separators / traversal so a filename can't escape the Downloads dir. */
function sanitizeFilename(name: string, extension: string): string {
  const cleaned = name
    .replace(/[\\/:*?"<>|]/g, '-')
    .replace(/\.\./g, '')
    .replace(/^[/\\-]+/, '');
  return cleaned.length > 0 ? cleaned : `snapscribe-${Date.now()}.${extension}`;
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
