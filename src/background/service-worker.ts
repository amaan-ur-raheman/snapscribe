/**
 * SnapScribe service worker — the only place that talks to the browser's
 * capture and download APIs. Every inbound message is a member of the typed
 * RuntimeRequest union; responses are typed and always `{ ok: true | false }`.
 */

import { DEFAULT_SETTINGS } from '../lib/storage';
import { isRuntimeRequest } from '../types/messages';
import type { CaptureResponse, DownloadResponse, RuntimeRequest } from '../types/messages';

// Seed settings once so reads never return a partial object.
chrome.runtime.onInstalled.addListener(() => {
  void chrome.storage.local.get('settings').then((stored) => {
    if (!stored.settings) {
      void chrome.storage.local.set({ settings: DEFAULT_SETTINGS });
    }
  });
});

chrome.runtime.onMessage.addListener((message: unknown, _sender, sendResponse) => {
  if (!isRuntimeRequest(message)) {
    sendResponse({ ok: false, error: 'Unknown message' });
    return;
  }
  handleRequest(message)
    .then(sendResponse)
    .catch((err: unknown) =>
      sendResponse({ ok: false, error: err instanceof Error ? err.message : String(err) }),
    );
  return true; // keep the message channel open for the async response
});

async function handleRequest(msg: RuntimeRequest): Promise<CaptureResponse | DownloadResponse> {
  switch (msg.type) {
    case 'CAPTURE_VISIBLE':
      return captureVisible(msg.tabId);
    case 'DOWNLOAD_CAPTURE':
      return downloadCapture(msg.dataUrl, msg.filename);
    // Remaining modes land in later phases; fail loudly rather than silently.
    default:
      return { ok: false, error: `Message type not implemented yet: ${msg.type}` };
  }
}

async function captureVisible(tabId: number): Promise<CaptureResponse> {
  const tab = await chrome.tabs.get(tabId);
  // captureVisibleTab keys on window id, not tab id.
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
