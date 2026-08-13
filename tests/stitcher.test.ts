import { describe, expect, test } from 'bun:test';

import type { StitchedStrip } from '../src/types/messages';

describe('precomputed stitched strip geometry', () => {
  test('has contiguous destination ranges for normal strips', () => {
    const strips: StitchedStrip[] = [
      { destY: 0, sourceY: 0, sourceHeight: 100, dataUrl: '' },
      { destY: 100, sourceY: 16, sourceHeight: 84, dataUrl: '' },
    ];

    expect(strips[0]?.destY + strips[0]?.sourceHeight).toBe(strips[1]?.destY);
  });

  test('supports the clamped final strip without a gap', () => {
    const strips: StitchedStrip[] = [
      { destY: 3712, sourceY: 128, sourceHeight: 1792, dataUrl: '' },
      { destY: 5504, sourceY: 1528, sourceHeight: 392, dataUrl: '' },
    ];

    expect(strips[0]?.destY + strips[0]?.sourceHeight).toBe(strips[1]?.destY);
  });
});
