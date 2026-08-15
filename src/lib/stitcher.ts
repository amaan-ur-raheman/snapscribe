/**
 * Renders a FullPageStitch onto a canvas and returns the result as a PNG
 * data URL. Runs in the popup (DOM context) — service workers have no canvas.
 */

import { bytesToBase64 } from './base64';
import { loadImage } from './image';
import type { FullPageStitch } from '../types/messages';

export async function stitchFullPage(stitch: FullPageStitch): Promise<string> {
  const canvas = document.createElement('canvas');
  canvas.width = stitch.width;
  canvas.height = stitch.height;
  const ctx = canvas.getContext('2d');
  if (!ctx) throw new Error('Canvas 2D is not available');
  ctx.imageSmoothingEnabled = false;

  // Opaque white backdrop so any missed pixels don't come out transparent.
  ctx.fillStyle = '#ffffff';
  ctx.fillRect(0, 0, canvas.width, canvas.height);

  const images = await Promise.all(stitch.strips.map((strip) => loadImage(strip.dataUrl)));
  for (const [index, strip] of stitch.strips.entries()) {
    const image = images[index];
    if (!image || strip.sourceHeight <= 0) continue;
    ctx.drawImage(
      image,
      0,
      strip.sourceY,
      image.width,
      strip.sourceHeight,
      0,
      strip.destY,
      image.width,
      strip.sourceHeight,
    );
  }

  // Fixed/sticky elements back on top, once, at their screen positions.
  for (const composite of stitch.composites) {
    const image = await loadImage(composite.sourceDataUrl);
    ctx.drawImage(
      image,
      composite.x,
      composite.y,
      composite.width,
      composite.height,
      composite.x,
      composite.y,
      composite.width,
      composite.height,
    );
  }

  return canvas.toDataURL('image/png');
}

/**
 * Same stitch, but runs in the service worker (no DOM): strips are decoded
 * with createImageBitmap and composited on an OffscreenCanvas. Used by the
 * keyboard-shortcut and context-menu captures, which have no popup to stitch
 * in. Returns a PNG data URL.
 */
export async function stitchFullPageWorker(stitch: FullPageStitch): Promise<string> {
  const canvas = new OffscreenCanvas(stitch.width, stitch.height);
  const ctx = canvas.getContext('2d');
  if (!ctx) throw new Error('OffscreenCanvas 2D is not available');
  ctx.imageSmoothingEnabled = false;
  ctx.fillStyle = '#ffffff';
  ctx.fillRect(0, 0, canvas.width, canvas.height);

  const bitmaps = await Promise.all(
    stitch.strips.map(async (strip) =>
      createImageBitmap(await (await fetch(strip.dataUrl)).blob()),
    ),
  );
  try {
    for (const [index, strip] of stitch.strips.entries()) {
      const bitmap = bitmaps[index];
      if (!bitmap || strip.sourceHeight <= 0) continue;
      ctx.drawImage(
        bitmap,
        0,
        strip.sourceY,
        bitmap.width,
        strip.sourceHeight,
        0,
        strip.destY,
        bitmap.width,
        strip.sourceHeight,
      );
    }
    for (const composite of stitch.composites) {
      const bitmap = await createImageBitmap(await (await fetch(composite.sourceDataUrl)).blob());
      try {
        ctx.drawImage(
          bitmap,
          composite.x,
          composite.y,
          composite.width,
          composite.height,
          composite.x,
          composite.y,
          composite.width,
          composite.height,
        );
      } finally {
        bitmap.close();
      }
    }
  } finally {
    for (const bitmap of bitmaps) bitmap.close();
  }

  const blob = await canvas.convertToBlob({ type: 'image/png' });
  return `data:image/png;base64,${bytesToBase64(new Uint8Array(await blob.arrayBuffer()))}`;
}
