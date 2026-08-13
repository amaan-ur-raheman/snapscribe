/**
 * Renders a FullPageStitch onto a canvas and returns the result as a PNG
 * data URL. Runs in the popup (DOM context) — service workers have no canvas.
 */

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
