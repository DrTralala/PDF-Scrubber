import { readFile, stat } from 'node:fs/promises';
import { resolve } from 'node:path';

import { expect, test, type Page } from '@playwright/test';
import { PNG } from 'pngjs';

import { installNoNetworkGuard } from '../../../tools/check-no-network';
import {
  reloadAfterDiscardingUnsavedChanges,
  useDownloadOnlyBrowser,
} from './editor-interactions';

function fixture(name: string): string {
  return resolve(process.cwd(), 'fixtures/generated', name);
}

function asymmetricPng(): Buffer {
  const png = new PNG({ width: 160, height: 80 });
  for (let y = 0; y < png.height; y += 1) {
    for (let x = 0; x < png.width; x += 1) {
      const offset = (png.width * y + x) << 2;
      const colour = y < 40
        ? x < 80 ? [240, 24, 20] : [24, 210, 30]
        : x < 80 ? [24, 48, 230] : [244, 214, 24];
      png.data[offset] = colour[0]!;
      png.data[offset + 1] = colour[1]!;
      png.data[offset + 2] = colour[2]!;
      png.data[offset + 3] = 255;
    }
  }
  return PNG.sync.write(png);
}

function oversizedPng(): Buffer {
  const png = new PNG({ width: 1_600, height: 1_200 });
  png.data.fill(210);
  return PNG.sync.write(png);
}

async function asymmetricJpeg(page: Page): Promise<Buffer> {
  const dataUrl = await page.evaluate(() => {
    const canvas = document.createElement('canvas');
    canvas.width = 160;
    canvas.height = 80;
    const context = canvas.getContext('2d');
    if (context === null) throw new Error('Canvas 2D is unavailable');
    context.fillStyle = 'rgb(240, 24, 20)';
    context.fillRect(0, 0, 80, 40);
    context.fillStyle = 'rgb(24, 210, 30)';
    context.fillRect(80, 0, 80, 40);
    context.fillStyle = 'rgb(24, 48, 230)';
    context.fillRect(0, 40, 80, 40);
    context.fillStyle = 'rgb(244, 214, 24)';
    context.fillRect(80, 40, 80, 40);
    return canvas.toDataURL('image/jpeg', 0.95);
  });
  return Buffer.from(dataUrl.slice(dataUrl.indexOf(',') + 1), 'base64');
}

function withExifOrientation(jpeg: Buffer, orientation: number): Buffer {
  const exif = Buffer.from([
    0x45, 0x78, 0x69, 0x66, 0x00, 0x00,
    0x49, 0x49, 0x2a, 0x00, 0x08, 0x00, 0x00, 0x00,
    0x01, 0x00,
    0x12, 0x01, 0x03, 0x00, 0x01, 0x00, 0x00, 0x00,
    orientation, 0x00, 0x00, 0x00,
    0x00, 0x00, 0x00, 0x00,
  ]);
  const segment = Buffer.alloc(4 + exif.length);
  segment[0] = 0xff;
  segment[1] = 0xe1;
  segment.writeUInt16BE(exif.length + 2, 2);
  exif.copy(segment, 4);
  return Buffer.concat([jpeg.subarray(0, 2), segment, jpeg.subarray(2)]);
}

async function visiblePageRegion(page: Page): Promise<Readonly<{
  left: number;
  top: number;
  right: number;
  bottom: number;
}>> {
  return page.locator('.page-frame').evaluate((frame) => {
    const pageRect = frame.getBoundingClientRect();
    const canvas = frame.closest('.document-canvas') as HTMLElement;
    const canvasRect = canvas.getBoundingClientRect();
    const left = Math.max(pageRect.left, canvasRect.left + canvas.clientLeft);
    const top = Math.max(pageRect.top, canvasRect.top + canvas.clientTop);
    const right = Math.min(
      pageRect.right,
      canvasRect.left + canvas.clientLeft + canvas.clientWidth,
    );
    const bottom = Math.min(
      pageRect.bottom,
      canvasRect.top + canvas.clientTop + canvas.clientHeight,
    );
    return { left, top, right, bottom };
  });
}

async function visiblePageCentre(page: Page): Promise<Readonly<{ x: number; y: number }>> {
  const region = await visiblePageRegion(page);
  return { x: (region.left + region.right) / 2, y: (region.top + region.bottom) / 2 };
}

async function canvasPixel(
  page: Page,
  canonical: Readonly<{ x: number; y: number }>,
): Promise<readonly [number, number, number]> {
  return page.getByTestId('pdf-canvas').evaluate((canvas, point) => {
    const element = canvas as HTMLCanvasElement;
    const rect = element.getBoundingClientRect();
    const [pageWidth, pageHeight] = [612, 792];
    const scale = rect.width / pageWidth;
    const x = Math.round(point.x * scale * element.width / rect.width);
    const y = Math.round((pageHeight - point.y) * scale * element.height / rect.height);
    const pixel = element.getContext('2d')!.getImageData(x, y, 1, 1).data;
    return [pixel[0]!, pixel[1]!, pixel[2]!] as const;
  }, canonical);
}

function expectColour(actual: readonly number[], expected: readonly number[]): void {
  for (let channel = 0; channel < 3; channel += 1) {
    expect(Math.abs(actual[channel]! - expected[channel]!)).toBeLessThan(32);
  }
}

test('inserts, moves, proportionally resizes, deselects, reselects and downloads a rendered image edit', async ({ page }) => {
  test.setTimeout(60_000);
  await page.setViewportSize({ width: 1440, height: 900 });
  const externalRequests = await installNoNetworkGuard(page);
  await useDownloadOnlyBrowser(page);
  const pageErrors: string[] = [];
  page.on('pageerror', (error) => pageErrors.push(error.message));

  await page.goto('/');
  await page.getByLabel('Open PDF').setInputFiles(fixture('01-simple-tj.pdf'));
  await expect(page.getByTestId('pdf-canvas')).toBeVisible();
  await expect(page.getByRole('button', { name: 'Insert image' })).toBeEnabled();
  await page.getByRole('button', { name: 'Zoom in' }).click();
  await page.getByRole('button', { name: 'Zoom in' }).click();
  await page.locator('.document-canvas').evaluate((element) => {
    const canvas = element as HTMLElement;
    canvas.scrollTop = 160;
    canvas.scrollLeft = 60;
    canvas.dispatchEvent(new Event('scroll'));
  });

  const fileChooserEvent = page.waitForEvent('filechooser');
  await page.getByRole('button', { name: 'Insert image' }).click();
  const fileChooser = await fileChooserEvent;
  await fileChooser.setFiles({
    name: 'asymmetric.png',
    mimeType: 'image/png',
    buffer: asymmetricPng(),
  });
  const placement = page.locator('.image-placement');
  await expect(placement).toBeVisible();
  const initialBounds = await placement.boundingBox();
  const visibleCentre = await visiblePageCentre(page);
  expect(initialBounds).not.toBeNull();
  expect((initialBounds!.x + initialBounds!.width / 2)).toBeCloseTo(visibleCentre.x, 0);
  expect((initialBounds!.y + initialBounds!.height / 2)).toBeCloseTo(visibleCentre.y, 0);
  expect(initialBounds!.width / initialBounds!.height).toBeCloseTo(2, 2);
  await expect(page.getByRole('button', { name: 'Save as...', exact: true })).toBeEnabled();

  const imageBody = page.getByRole('button', { name: 'Select inserted image 1' });
  const bodyBounds = await imageBody.boundingBox();
  expect(bodyBounds).not.toBeNull();
  await page.mouse.move(bodyBounds!.x + bodyBounds!.width / 2, bodyBounds!.y + bodyBounds!.height / 2);
  await page.mouse.down();
  await page.mouse.move(bodyBounds!.x + bodyBounds!.width / 2 + 40, bodyBounds!.y + bodyBounds!.height / 2 + 24);
  await page.mouse.up();
  const movedBounds = await placement.boundingBox();
  expect(movedBounds).not.toBeNull();
  expect(movedBounds!.x - initialBounds!.x).toBeCloseTo(40, 0);
  expect(movedBounds!.y - initialBounds!.y).toBeCloseTo(24, 0);

  const resizeHandle = page.getByRole('button', { name: 'Resize image at bottom-right' });
  const handleBounds = await resizeHandle.boundingBox();
  expect(handleBounds).not.toBeNull();
  await page.mouse.move(handleBounds!.x + handleBounds!.width / 2, handleBounds!.y + handleBounds!.height / 2);
  await page.mouse.down();
  await page.mouse.move(handleBounds!.x + handleBounds!.width / 2 + 36, handleBounds!.y + handleBounds!.height / 2 + 18);
  await page.mouse.up();
  const finalBounds = await placement.boundingBox();
  expect(finalBounds).not.toBeNull();
  expect(finalBounds!.width / finalBounds!.height).toBeCloseTo(2, 2);
  expect(finalBounds!.width).toBeGreaterThan(movedBounds!.width);

  const visibleRegion = await visiblePageRegion(page);
  await page.mouse.click(visibleRegion.left + 8, visibleRegion.top + 8);
  await expect(page.getByRole('button', { name: 'Resize image at bottom-right' })).toHaveCount(0);
  await imageBody.click();
  await expect(page.getByRole('button', { name: 'Resize image at bottom-right' })).toBeVisible();

  const style = await placement.evaluate((element) => {
    const image = element as HTMLElement;
    return {
      left: Number.parseFloat(image.style.left),
      top: Number.parseFloat(image.style.top),
      width: Number.parseFloat(image.style.width),
      height: Number.parseFloat(image.style.height),
      pageWidth: image.parentElement!.clientWidth,
    };
  });
  const scale = style.pageWidth / 612;
  const canonicalPlacement = {
    x: style.left / scale,
    y: 792 - (style.top + style.height) / scale,
    width: style.width / scale,
    height: style.height / scale,
  };

  const downloadEvent = page.waitForEvent('download');
  await page.getByRole('button', { name: 'Save as...', exact: true }).click();
  const download = await downloadEvent;
  expect(download.suggestedFilename()).toBe('01-simple-tj-edited.pdf');
  const downloadedPath = await download.path();
  expect(downloadedPath).not.toBeNull();
  expect((await stat(downloadedPath!)).size).toBeGreaterThan(0);
  const downloadedBytes = await readFile(downloadedPath!);

  await reloadAfterDiscardingUnsavedChanges(page);
  await page.getByLabel('Open PDF').setInputFiles({
    name: 'image-edited.pdf',
    mimeType: 'application/pdf',
    buffer: downloadedBytes,
  });
  await expect(page.getByTestId('pdf-canvas')).toBeVisible();
  await expect.poll(async () => page.getByTestId('pdf-canvas').evaluate(
    (element) => (element as HTMLCanvasElement).width,
  )).toBeGreaterThan(0);

  expectColour(await canvasPixel(page, {
    x: canonicalPlacement.x + canonicalPlacement.width * 0.25,
    y: canonicalPlacement.y + canonicalPlacement.height * 0.75,
  }), [240, 24, 20]);
  expectColour(await canvasPixel(page, {
    x: canonicalPlacement.x + canonicalPlacement.width * 0.75,
    y: canonicalPlacement.y + canonicalPlacement.height * 0.75,
  }), [24, 210, 30]);
  expectColour(await canvasPixel(page, {
    x: canonicalPlacement.x + canonicalPlacement.width * 0.25,
    y: canonicalPlacement.y + canonicalPlacement.height * 0.25,
  }), [24, 48, 230]);
  expectColour(await canvasPixel(page, {
    x: canonicalPlacement.x + canonicalPlacement.width * 0.75,
    y: canonicalPlacement.y + canonicalPlacement.height * 0.25,
  }), [244, 214, 24]);
  expect(externalRequests).toEqual([]);
  expect(pageErrors).toEqual([]);
});

test('keeps an oversized image at intrinsic size and exposes a visible resize control', async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  const externalRequests = await installNoNetworkGuard(page);
  await page.goto('/');
  await page.getByLabel('Open PDF').setInputFiles(fixture('01-simple-tj.pdf'));
  await expect(page.getByTestId('pdf-canvas')).toBeVisible();

  const fileChooserEvent = page.waitForEvent('filechooser');
  await page.getByRole('button', { name: 'Insert image' }).click();
  const fileChooser = await fileChooserEvent;
  await fileChooser.setFiles({
    name: 'oversized.png',
    mimeType: 'image/png',
    buffer: oversizedPng(),
  });

  const placement = page.locator('.image-placement');
  await expect(placement).toBeVisible();
  const initial = await placement.evaluate((element) => {
    const image = element as HTMLElement;
    const scale = image.parentElement!.clientWidth / 612;
    return {
      width: Number.parseFloat(image.style.width) / scale,
      height: Number.parseFloat(image.style.height) / scale,
    };
  });
  expect(Math.abs(initial.width - 1_600)).toBeLessThan(2);
  expect(Math.abs(initial.height - 1_200)).toBeLessThan(2);

  const frame = await page.locator('.page-frame').boundingBox();
  const handle = page.getByRole('button', { name: 'Resize image at top-left' });
  await expect(handle).toBeVisible();
  const handleBox = await handle.boundingBox();
  expect(frame).not.toBeNull();
  expect(handleBox).not.toBeNull();
  expect(handleBox!.x + handleBox!.width / 2).toBeGreaterThanOrEqual(frame!.x);
  expect(handleBox!.y + handleBox!.height / 2).toBeGreaterThanOrEqual(frame!.y);
  expect(handleBox!.x + handleBox!.width / 2).toBeLessThan(frame!.x + frame!.width);
  expect(handleBox!.y + handleBox!.height / 2).toBeLessThan(frame!.y + frame!.height);

  await page.mouse.move(handleBox!.x + handleBox!.width / 2, handleBox!.y + handleBox!.height / 2);
  await page.mouse.down();
  await page.mouse.move(handleBox!.x + handleBox!.width / 2 + 24, handleBox!.y + handleBox!.height / 2 + 24);
  await page.mouse.up();
  const resizedWidth = await placement.evaluate((element) => {
    const image = element as HTMLElement;
    return Number.parseFloat(image.style.width) / (image.parentElement!.clientWidth / 612);
  });
  expect(resizedWidth).toBeGreaterThan(0);
  expect(resizedWidth).toBeLessThan(initial.width);
  expect(externalRequests).toEqual([]);
});

test('inserts and downloads a locally decoded JPEG image', async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  const externalRequests = await installNoNetworkGuard(page);
  await useDownloadOnlyBrowser(page);
  await page.goto('/');
  await page.getByLabel('Open PDF').setInputFiles(fixture('01-simple-tj.pdf'));
  await expect(page.getByTestId('pdf-canvas')).toBeVisible();

  const fileChooserEvent = page.waitForEvent('filechooser');
  await page.getByRole('button', { name: 'Insert image' }).click();
  const fileChooser = await fileChooserEvent;
  await fileChooser.setFiles({
    name: 'asymmetric.jpeg',
    mimeType: 'image/jpeg',
    buffer: await asymmetricJpeg(page),
  });
  await expect(page.locator('.image-placement')).toBeVisible();
  await expect(page.getByRole('button', { name: 'Save as...', exact: true })).toBeEnabled();

  const downloadEvent = page.waitForEvent('download');
  await page.getByRole('button', { name: 'Save as...', exact: true }).click();
  const download = await downloadEvent;
  const downloadedPath = await download.path();
  expect(download.suggestedFilename()).toBe('01-simple-tj-edited.pdf');
  expect(downloadedPath).not.toBeNull();
  expect((await stat(downloadedPath!)).size).toBeGreaterThan(0);
  expect(externalRequests).toEqual([]);
});

test('preserves EXIF-oriented JPEG appearance and geometry in the exported PDF', async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  const externalRequests = await installNoNetworkGuard(page);
  await useDownloadOnlyBrowser(page);
  const pageErrors: string[] = [];
  page.on('pageerror', (error) => pageErrors.push(error.message));
  await page.goto('/');
  await page.getByLabel('Open PDF').setInputFiles(fixture('01-simple-tj.pdf'));
  await expect(page.getByTestId('pdf-canvas')).toBeVisible();

  const fileChooserEvent = page.waitForEvent('filechooser');
  await page.getByRole('button', { name: 'Insert image' }).click();
  const fileChooser = await fileChooserEvent;
  await fileChooser.setFiles({
    name: 'oriented.jpeg',
    mimeType: 'image/jpeg',
    buffer: withExifOrientation(await asymmetricJpeg(page), 6),
  });

  const placement = page.locator('.image-placement');
  await expect(placement).toBeVisible();
  const initialBounds = await placement.boundingBox();
  expect(initialBounds).not.toBeNull();
  expect(initialBounds!.width / initialBounds!.height).toBeCloseTo(0.5, 2);
  const preview = await page.locator('.image-body img').evaluate(async (element) => {
    const image = element as HTMLImageElement;
    await image.decode();
    const canvas = document.createElement('canvas');
    canvas.width = image.naturalWidth;
    canvas.height = image.naturalHeight;
    const context = canvas.getContext('2d');
    if (context === null) throw new Error('Canvas 2D is unavailable');
    context.drawImage(image, 0, 0);
    const sample = (x: number, y: number) => {
      const rgba = context.getImageData(x, y, 1, 1).data;
      return [rgba[0]!, rgba[1]!, rgba[2]!] as const;
    };
    return {
      width: image.naturalWidth,
      height: image.naturalHeight,
      corners: [
        sample(Math.floor(image.naturalWidth / 4), Math.floor(image.naturalHeight / 4)),
        sample(Math.floor(image.naturalWidth * 3 / 4), Math.floor(image.naturalHeight / 4)),
        sample(Math.floor(image.naturalWidth / 4), Math.floor(image.naturalHeight * 3 / 4)),
        sample(Math.floor(image.naturalWidth * 3 / 4), Math.floor(image.naturalHeight * 3 / 4)),
      ],
    };
  });
  expect(preview.width).toBe(80);
  expect(preview.height).toBe(160);
  for (const [actual, expected] of preview.corners.map((colour, index) => [
    colour,
    [[24, 48, 230], [240, 24, 20], [244, 214, 24], [24, 210, 30]][index]!,
  ] as const)) expectColour(actual, expected);

  const style = await placement.evaluate((element) => {
    const image = element as HTMLElement;
    return {
      left: Number.parseFloat(image.style.left),
      top: Number.parseFloat(image.style.top),
      width: Number.parseFloat(image.style.width),
      height: Number.parseFloat(image.style.height),
      pageWidth: image.parentElement!.clientWidth,
    };
  });
  const scale = style.pageWidth / 612;
  const canonicalPlacement = {
    x: style.left / scale,
    y: 792 - (style.top + style.height) / scale,
    width: style.width / scale,
    height: style.height / scale,
  };

  const downloadEvent = page.waitForEvent('download');
  await page.getByRole('button', { name: 'Save as...', exact: true }).click();
  const download = await downloadEvent;
  const downloadedPath = await download.path();
  expect(download.suggestedFilename()).toBe('01-simple-tj-edited.pdf');
  expect(downloadedPath).not.toBeNull();
  const downloadedBytes = await readFile(downloadedPath!);

  await reloadAfterDiscardingUnsavedChanges(page);
  await page.getByLabel('Open PDF').setInputFiles({
    name: 'oriented-edited.pdf',
    mimeType: 'application/pdf',
    buffer: downloadedBytes,
  });
  await expect(page.getByTestId('pdf-canvas')).toBeVisible();
  expectColour(await canvasPixel(page, {
    x: canonicalPlacement.x + canonicalPlacement.width * 0.25,
    y: canonicalPlacement.y + canonicalPlacement.height * 0.75,
  }), [24, 48, 230]);
  expectColour(await canvasPixel(page, {
    x: canonicalPlacement.x + canonicalPlacement.width * 0.75,
    y: canonicalPlacement.y + canonicalPlacement.height * 0.75,
  }), [240, 24, 20]);
  expectColour(await canvasPixel(page, {
    x: canonicalPlacement.x + canonicalPlacement.width * 0.25,
    y: canonicalPlacement.y + canonicalPlacement.height * 0.25,
  }), [244, 214, 24]);
  expectColour(await canvasPixel(page, {
    x: canonicalPlacement.x + canonicalPlacement.width * 0.75,
    y: canonicalPlacement.y + canonicalPlacement.height * 0.25,
  }), [24, 210, 30]);
  expect(externalRequests).toEqual([]);
  expect(pageErrors).toEqual([]);
});
