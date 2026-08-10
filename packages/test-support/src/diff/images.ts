import { writeFile } from 'node:fs/promises';

import pixelmatch from 'pixelmatch';
import { PNG } from 'pngjs';

import type { CanonicalBounds } from '@pdf-editor/pdf-engine';

export type RgbaImage = Readonly<{
  width: number;
  height: number;
  rgba: Uint8Array;
}>;

export type ImageRegionMetrics = Readonly<{
  pixels: number;
  mismatchedPixels: number;
  mismatchRatio: number;
  ssim: number;
}>;

export type ImageDiffMetrics = Readonly<{
  edited: ImageRegionMetrics;
  unedited: ImageRegionMetrics;
}>;

export async function writeRgbaPng(path: string, image: RgbaImage): Promise<void> {
  assertImage(image);
  const png = new PNG({ width: image.width, height: image.height });
  png.data.set(image.rgba);
  await writeFile(path, PNG.sync.write(png));
}

function assertImage(image: RgbaImage): void {
  if (!Number.isSafeInteger(image.width) || image.width <= 0
      || !Number.isSafeInteger(image.height) || image.height <= 0
      || image.rgba.length !== image.width * image.height * 4) {
    throw new Error('RGBA image dimensions do not match its byte length');
  }
}

function structuralSimilarity(left: Uint8Array, right: Uint8Array): number {
  const pixels = left.length / 4;
  if (pixels === 0) return 1;
  const luminance = (bytes: Uint8Array, offset: number): number =>
    0.2126 * bytes[offset]! + 0.7152 * bytes[offset + 1]! + 0.0722 * bytes[offset + 2]!;
  let leftMean = 0;
  let rightMean = 0;
  for (let index = 0; index < left.length; index += 4) {
    leftMean += luminance(left, index);
    rightMean += luminance(right, index);
  }
  leftMean /= pixels;
  rightMean /= pixels;
  let leftVariance = 0;
  let rightVariance = 0;
  let covariance = 0;
  for (let index = 0; index < left.length; index += 4) {
    const leftDelta = luminance(left, index) - leftMean;
    const rightDelta = luminance(right, index) - rightMean;
    leftVariance += leftDelta * leftDelta;
    rightVariance += rightDelta * rightDelta;
    covariance += leftDelta * rightDelta;
  }
  const divisor = Math.max(1, pixels - 1);
  leftVariance /= divisor;
  rightVariance /= divisor;
  covariance /= divisor;
  const c1 = (0.01 * 255) ** 2;
  const c2 = (0.03 * 255) ** 2;
  const score = ((2 * leftMean * rightMean + c1) * (2 * covariance + c2))
    / ((leftMean ** 2 + rightMean ** 2 + c1) * (leftVariance + rightVariance + c2));
  return Number.isFinite(score) ? Math.max(-1, Math.min(1, score)) : 0;
}

function metrics(left: Uint8Array, right: Uint8Array): ImageRegionMetrics {
  const pixels = left.length / 4;
  const mismatchedPixels = pixels === 0
    ? 0
    : pixelmatch(left, right, undefined, pixels, 1, {
      threshold: 0.1,
      includeAA: false,
      checkerboard: false,
    });
  return Object.freeze({
    pixels,
    mismatchedPixels,
    mismatchRatio: pixels === 0 ? 0 : mismatchedPixels / pixels,
    ssim: structuralSimilarity(left, right),
  });
}

export function compareImages(
  original: RgbaImage,
  candidate: RgbaImage,
  editBounds: CanonicalBounds,
  canonicalPageSize: Readonly<{ width: number; height: number }>,
): ImageDiffMetrics {
  assertImage(original);
  assertImage(candidate);
  if (original.width !== candidate.width || original.height !== candidate.height) {
    throw new Error('Images must have equal dimensions');
  }
  if (canonicalPageSize.width <= 0 || canonicalPageSize.height <= 0) {
    throw new Error('Canonical page dimensions must be positive');
  }

  const xMinimum = Math.max(0, Math.floor(
    editBounds.x * original.width / canonicalPageSize.width,
  ));
  const xMaximum = Math.min(original.width, Math.ceil(
    (editBounds.x + editBounds.width) * original.width / canonicalPageSize.width,
  ));
  const yMinimum = Math.max(0, Math.floor(
    (canonicalPageSize.height - editBounds.y - editBounds.height)
      * original.height / canonicalPageSize.height,
  ));
  const yMaximum = Math.min(original.height, Math.ceil(
    (canonicalPageSize.height - editBounds.y) * original.height / canonicalPageSize.height,
  ));
  const editedPixels = Math.max(0, xMaximum - xMinimum) * Math.max(0, yMaximum - yMinimum);
  const uneditedPixels = original.width * original.height - editedPixels;
  const editedLeft = new Uint8Array(editedPixels * 4);
  const editedRight = new Uint8Array(editedPixels * 4);
  const uneditedLeft = new Uint8Array(uneditedPixels * 4);
  const uneditedRight = new Uint8Array(uneditedPixels * 4);
  let editedOffset = 0;
  let uneditedOffset = 0;

  for (let y = 0; y < original.height; y += 1) {
    for (let x = 0; x < original.width; x += 1) {
      const inside = x >= xMinimum && x < xMaximum && y >= yMinimum && y < yMaximum;
      const sourceOffset = (y * original.width + x) * 4;
      const left = inside ? editedLeft : uneditedLeft;
      const right = inside ? editedRight : uneditedRight;
      const targetOffset = inside ? editedOffset : uneditedOffset;
      left.set(original.rgba.subarray(sourceOffset, sourceOffset + 4), targetOffset);
      right.set(candidate.rgba.subarray(sourceOffset, sourceOffset + 4), targetOffset);
      if (inside) editedOffset += 4;
      else uneditedOffset += 4;
    }
  }

  return Object.freeze({
    edited: metrics(editedLeft, editedRight),
    unedited: metrics(uneditedLeft, uneditedRight),
  });
}
