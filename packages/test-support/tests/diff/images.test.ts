import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { PNG } from 'pngjs';
import { describe, expect, test } from 'vitest';

import {
  compareImages,
  writeRgbaPng,
  type RgbaImage,
} from '../../src/diff/images';

function image(changes: readonly [number, number, number][]): RgbaImage {
  const rgba = new Uint8Array(10 * 10 * 4).fill(255);
  for (const [x, y, value] of changes) {
    const offset = (y * 10 + x) * 4;
    rgba[offset] = value;
    rgba[offset + 1] = value;
    rgba[offset + 2] = value;
  }
  return Object.freeze({ width: 10, height: 10, rgba });
}

describe('masked image comparison', () => {
  test('reports edit-mask and unedited-region metrics independently', () => {
    const metrics = compareImages(
      image([]),
      image([[3, 6, 0]]),
      { x: 2, y: 2, width: 4, height: 4 },
      { width: 10, height: 10 },
    );

    expect(metrics.edited.mismatchedPixels).toBe(1);
    expect(metrics.unedited.mismatchedPixels).toBe(0);
    expect(metrics.edited.ssim).toBeLessThan(1);
    expect(metrics.unedited.ssim).toBe(1);
  });

  test('detects a mutation outside the edit mask', () => {
    const metrics = compareImages(
      image([]),
      image([[9, 0, 0]]),
      { x: 2, y: 2, width: 4, height: 4 },
      { width: 10, height: 10 },
    );

    expect(metrics.unedited.mismatchedPixels).toBe(1);
    expect(metrics.unedited.mismatchRatio).toBeGreaterThan(0);
  });

  test('persists exact RGBA evidence as a PNG', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'pdf-editor-image-test-'));
    const path = join(directory, 'evidence.png');
    const expected = image([[4, 5, 17]]);
    try {
      await writeRgbaPng(path, expected);
      const decoded = PNG.sync.read(await readFile(path));
      expect(decoded.width).toBe(expected.width);
      expect(decoded.height).toBe(expected.height);
      expect(new Uint8Array(decoded.data)).toEqual(expected.rgba);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });
});
