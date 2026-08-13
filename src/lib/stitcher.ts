/**
 * Renders a FullPageStitch onto a canvas and returns the result as a PNG
 * data URL. Runs in the popup (DOM context) — service workers have no canvas.
 */

import type { FullPageStitch } from '../types/messages';

export async function stitchFullPage(stitch: FullPageStitch): Promise<string> {
  const canvas = document.createElement('canvas');
  canvas.width = stitch.width;
  canvas.height = stitch.height;
  const ctx = canvas.getContext('2d');
  if (!ctx) throw new Error('Canvas 2D is not available');

  // Opaque white backdrop so any missed pixels don't come out transparent.
  ctx.fillStyle = '#ffffff';
  ctx.fillRect(0, 0, canvas.width, canvas.height);

  for (const strip of stitch.strips) {
    const image = await loadImage(strip.dataUrl);
    ctx.drawImage(image, 0, strip.y);
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

function loadImage(dataUrl: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const image = new Image();
    image.onload = () => resolve(image);
    image.onerror = () => reject(new Error('Failed to decode a captured strip'));
    image.src = dataUrl;
  });
}
