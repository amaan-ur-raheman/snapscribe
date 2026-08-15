/**
 * Generate a small JPEG thumbnail from a PNG data URL. DOM-free — uses
 * createImageBitmap + OffscreenCanvas, so it runs in the service worker.
 * Thumbnails keep history storage tiny (a full-page PNG data URL would
 * blow the chrome.storage.local quota in a few entries).
 */

import { bytesToBase64 } from './base64';

const THUMBNAIL_MAX_WIDTH = 320;
const THUMBNAIL_QUALITY = 0.7;

export async function makeThumbnail(dataUrl: string): Promise<string> {
  const blob = await (await fetch(dataUrl)).blob();
  const bitmap = await createImageBitmap(blob);
  try {
    const scale = Math.min(1, THUMBNAIL_MAX_WIDTH / bitmap.width);
    const width = Math.max(1, Math.round(bitmap.width * scale));
    const height = Math.max(1, Math.round(bitmap.height * scale));
    const canvas = new OffscreenCanvas(width, height);
    const ctx = canvas.getContext('2d');
    if (!ctx) throw new Error('OffscreenCanvas 2D is not available');
    ctx.drawImage(bitmap, 0, 0, width, height);
    const jpeg = await canvas.convertToBlob({ type: 'image/jpeg', quality: THUMBNAIL_QUALITY });
    return `data:image/jpeg;base64,${bytesToBase64(new Uint8Array(await jpeg.arrayBuffer()))}`;
  } finally {
    bitmap.close();
  }
}
