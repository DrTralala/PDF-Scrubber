import { readFile, stat } from 'node:fs/promises';
import { resolve } from 'node:path';

import { expect, test, type Locator, type Page } from '@playwright/test';
import { PDFDocument, StandardFonts } from 'pdf-lib';

import { buildDecorationFixture } from '../../../packages/test-support/src/corpus/decorations';
import { installNoNetworkGuard } from '../../../tools/check-no-network';
import {
  acceptRichFontSubstitutions,
  activateByKeyboard,
  expandAllowedWidth,
} from './editor-interactions';

function fixture(name: string): string {
  return resolve(process.cwd(), 'fixtures/generated', name);
}

function projectFile(name: string): string {
  return resolve(process.cwd(), name);
}

async function selectByPointer(page: Page, overlay: Locator): Promise<void> {
  const bounds = await overlay.boundingBox();
  if (bounds === null) throw new Error('Text group overlay has no pointer bounds');
  await page.mouse.click(bounds.x + bounds.width / 2, bounds.y + bounds.height / 2);
}

async function twoPageFixture(): Promise<Buffer> {
  const document = await PDFDocument.create();
  const font = await document.embedFont(StandardFonts.Helvetica);
  document.addPage([612, 792]).drawText('Page 1 target', {
    x: 72,
    y: 700,
    font,
    size: 24,
  });
  document.addPage([612, 792]).drawText('Page 2 target', {
    x: 72,
    y: 700,
    font,
    size: 24,
  });
  return Buffer.from(await document.save({ useObjectStreams: false }));
}

async function fontUploadFixture(): Promise<Buffer> {
  const document = await PDFDocument.create();
  const page = document.addPage([612, 792]);
  const font = await document.embedFont(StandardFonts.Helvetica);
  page.drawText('Customer Name: Trevor Leong', {
    x: 72,
    y: 700,
    font,
    size: 24,
  });
  return Buffer.from(await document.save({ useObjectStreams: false }));
}

async function sellerAppendFixture(): Promise<Buffer> {
  const document = await PDFDocument.create();
  const page = document.addPage([595, 842]);
  const font = await document.embedFont(StandardFonts.Helvetica);
  page.drawText('Seller: BroadLink Official Store', {
    x: 72,
    y: 700,
    font,
    size: 22,
  });
  return Buffer.from(await document.save({ useObjectStreams: false }));
}

test('opens, applies two validated edits, downloads, and resets', async ({ page }, testInfo) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  const remoteRequests = await installNoNetworkGuard(page);
  await page.goto('/');
  await page.getByLabel('Open PDF').setInputFiles(fixture('01-simple-tj.pdf'));
  await expect(page.getByTestId('pdf-canvas')).toBeVisible();
  await activateByKeyboard(
    page,
    page.getByRole('button', { name: /Target 01 — Editable/ }),
  );

  const replacement = page.getByLabel('Edit selected text');
  const apply = page.getByRole('button', { name: 'Apply replacement' });
  await replacement.fill('Edited 01');
  await expect(apply).toBeDisabled();
  await expandAllowedWidth(page);
  await acceptRichFontSubstitutions(page);
  await expect(apply).toBeEnabled();
  await apply.click();
  await expect(page.getByText('Replacement applied')).toBeVisible();
  await activateByKeyboard(
    page,
    page.getByRole('button', { name: /Edited 01 — Editable/ }),
  );
  await page.screenshot({
    path: testInfo.outputPath('pdf-scrubber-desktop.png'),
    fullPage: true,
  });

  await replacement.fill('Edited 02');
  await expandAllowedWidth(page);
  await acceptRichFontSubstitutions(page);
  await expect(apply).toBeEnabled();
  await apply.click();
  await expect(page.getByRole('button', { name: /Edited 02 — Editable/ })).toBeVisible();

  const downloadEvent = page.waitForEvent('download');
  await page.getByRole('button', { name: 'Download copy' }).click();
  const download = await downloadEvent;
  expect(download.suggestedFilename()).toBe('01-simple-tj-edited.pdf');
  const downloadedPath = await download.path();
  expect(downloadedPath).not.toBeNull();
  expect((await stat(downloadedPath!)).size).toBeGreaterThan(0);

  await page.getByRole('button', { name: 'Reset' }).click();
  await page.getByRole('button', { name: 'Reset to original' }).click();
  await expect(page.getByRole('button', { name: /Target 01 — Editable/ })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Download copy' })).toBeDisabled();
  expect(remoteRequests).toEqual([]);
});

test('edits inferred wkhtmltopdf groups and preserves mixed style runs', async ({ page }) => {
  const remoteRequests = await installNoNetworkGuard(page);
  await page.goto('/');
  await page.getByLabel('Open PDF').setInputFiles(
    fixture('30-wkhtmltopdf-rich-line.pdf'),
  );
  await expect(page.getByTestId('pdf-canvas')).toBeVisible();
  const colours = await page.evaluate(() => ({
    body: getComputedStyle(document.body).backgroundColor,
    inspector: getComputedStyle(document.querySelector('.inspector')!).backgroundColor,
    page: getComputedStyle(document.querySelector('.page-frame')!).backgroundColor,
    canvas: getComputedStyle(document.querySelector('[data-testid="pdf-canvas"]')!).backgroundColor,
  }));
  expect(colours).toEqual({
    body: 'rgb(11, 16, 22)',
    inspector: 'rgb(20, 27, 35)',
    page: 'rgb(255, 255, 255)',
    canvas: 'rgb(255, 255, 255)',
  });
  await expect(page.getByRole('button', { name: 'Shopee — Editable' })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Customer Name: — Editable' })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Alex Morgan — Editable' })).toBeVisible();
  await expect(page.getByRole('button', {
    name: 'this is a bold text — Editable',
  })).toBeVisible();

  await selectByPointer(
    page,
    page.getByRole('button', { name: 'Customer Name: — Editable' }),
  );
  const editor = page.getByLabel('Edit selected text');
  await expect(editor).toHaveValue('Customer Name:');
  await editor.fill('Account Name:');
  await acceptRichFontSubstitutions(page);
  await expect(page.getByRole('button', { name: 'Apply replacement' })).toBeEnabled();
  await page.getByRole('button', { name: 'Apply replacement' }).click();
  await expect(page.getByRole('button', { name: 'Account Name: — Editable' })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Alex Morgan — Editable' })).toBeVisible();

  await selectByPointer(
    page,
    page.getByRole('button', { name: 'this is a bold text — Editable' }),
  );
  await expect(editor).toHaveValue('this is a bold text');
  await editor.fill('this is a firm text');
  const richPreviewRuns = page.locator('.rich-preview-text span');
  await expect(richPreviewRuns).toHaveText(['this is a ', 'firm', ' text']);
  expect(await richPreviewRuns.evaluateAll((runs) => runs.map(
    (run) => getComputedStyle(run).fontWeight,
  ))).toEqual(['400', '700', '400']);
  await acceptRichFontSubstitutions(page);
  await expect(page.getByRole('button', { name: 'Apply replacement' })).toBeEnabled();
  await page.getByRole('button', { name: 'Apply replacement' }).click();
  await expect(page.getByRole('button', {
    name: 'this is a firm text — Editable',
  })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Download copy' })).toBeEnabled();
  expect(remoteRequests).toEqual([]);
});

test('auto-fits a safe horizontal Seller append without the width slider', async ({ page }) => {
  const remoteRequests = await installNoNetworkGuard(page);
  await page.goto('/');
  await page.getByLabel('Open PDF').setInputFiles({
    name: 'seller-append.pdf',
    mimeType: 'application/pdf',
    buffer: await sellerAppendFixture(),
  });
  await selectByPointer(
    page,
    page.getByRole('button', {
      name: 'Seller: BroadLink Official Store — Editable',
    }),
  );

  await page.getByLabel('Edit selected text').fill(
    'Seller: BroadLink Official Store Preferred',
  );
  await acceptRichFontSubstitutions(page);

  const widthSlider = page.getByLabel('Allowed width');
  const initialWidth = await widthSlider.inputValue();
  await expect(page.getByRole('button', { name: 'Apply replacement' })).toBeEnabled();
  expect(await widthSlider.inputValue()).not.toBe(initialWidth);
  await page.getByRole('button', { name: 'Apply replacement' }).click();
  await expect(page.getByRole('button', {
    name: 'Seller: BroadLink Official Store Preferred — Editable',
  })).toBeVisible();
  expect(remoteRequests).toEqual([]);
});

test('uploads and applies an arbitrary Noto Sans font, then downloads and reopens the edited PDF', async ({ page }) => {
  test.setTimeout(60_000);
  const remoteRequests = await installNoNetworkGuard(page);
  await page.goto('/');
  await page.getByLabel('Open PDF').setInputFiles({
    name: 'font-upload.pdf',
    mimeType: 'application/pdf',
    buffer: await fontUploadFixture(),
  });
  await expect(page.getByTestId('pdf-canvas')).toBeVisible();
  await selectByPointer(
    page,
    page.getByRole('button', { name: 'Customer Name: Trevor Leong — Editable' }),
  );
  const editor = page.getByLabel('Edit selected text');
  await expect(editor).toHaveValue('Customer Name: Trevor Leong');
  await editor.evaluate((element) => {
    const input = element as HTMLTextAreaElement;
    input.focus();
    input.setSelectionRange(0, 14);
    input.dispatchEvent(new Event('select', { bubbles: true }));
  });

  await page.getByLabel('Upload and apply font').setInputFiles(
    projectFile('node_modules/@fontsource/noto-sans/files/noto-sans-latin-400-normal.woff'),
  );
  await expect(page.getByText('Noto Sans Regular applied. Reshaping text…')).toBeVisible();
  const fontSelect = page.getByLabel('Font', { exact: true });
  await expect(fontSelect).toHaveValue(/font:/);
  await expect(fontSelect.locator('option:checked')).toContainText(
    'Noto Sans Regular · bundled',
  );

  await editor.fill('Account Name: Trevor Leong');
  await expandAllowedWidth(page);
  const apply = page.getByRole('button', { name: 'Apply replacement' });
  await expect(apply).toBeEnabled();
  await apply.click();
  await expect(page.getByRole('button', {
    name: 'Account Name: Trevor Leong — Editable',
  })).toBeVisible();

  const downloadEvent = page.waitForEvent('download');
  await page.getByRole('button', { name: 'Download copy' }).click();
  const downloadedPath = await (await downloadEvent).path();
  expect(downloadedPath).not.toBeNull();
  const downloadedBytes = await readFile(downloadedPath!);
  await page.reload();
  await page.getByLabel('Open PDF').setInputFiles({
    name: 'sample-edited.pdf',
    mimeType: 'application/pdf',
    buffer: downloadedBytes,
  });
  await expect(page.getByRole('button', {
    name: 'Account Name: Trevor Leong — Editable',
  })).toBeVisible();
  expect(remoteRequests).toEqual([]);
});

test('recognises a source underline and round-trips combined decorations', async ({ page }) => {
  test.setTimeout(60_000);
  const remoteRequests = await installNoNetworkGuard(page);
  await page.goto('/');
  await page.getByLabel('Open PDF').setInputFiles({
    name: 'source-underline.pdf',
    mimeType: 'application/pdf',
    buffer: Buffer.from(await buildDecorationFixture('stroked-underline')),
  });
  await activateByKeyboard(
    page,
    page.getByRole('button', { name: 'Decorated text — Editable' }),
  );

  const underline = page.getByRole('button', { name: 'Underline' });
  const strikethrough = page.getByRole('button', { name: 'Strikethrough' });
  await expect(underline).toHaveAttribute('aria-pressed', 'true');
  await expect(strikethrough).toHaveAttribute('aria-pressed', 'false');
  await strikethrough.click();
  await expect(underline).toHaveAttribute('aria-pressed', 'true');
  await expect(strikethrough).toHaveAttribute('aria-pressed', 'true');

  await page.getByLabel('Edit selected text').fill('Marked text');
  await expandAllowedWidth(page);
  await acceptRichFontSubstitutions(page);
  await page.getByRole('button', { name: 'Apply replacement' }).click();
  await expect(page.getByRole('button', { name: 'Marked text — Editable' })).toBeVisible();

  const downloadEvent = page.waitForEvent('download');
  await page.getByRole('button', { name: 'Download copy' }).click();
  const downloadedPath = await (await downloadEvent).path();
  expect(downloadedPath).not.toBeNull();
  const downloadedBytes = await readFile(downloadedPath!);
  await page.reload();
  await page.getByLabel('Open PDF').setInputFiles({
    name: 'combined-edited.pdf',
    mimeType: 'application/pdf',
    buffer: downloadedBytes,
  });
  await activateByKeyboard(
    page,
    page.getByRole('button', { name: 'Marked text — Editable' }),
  );
  await expect(page.getByRole('button', { name: 'Underline' }))
    .toHaveAttribute('aria-pressed', 'true');
  await expect(page.getByRole('button', { name: 'Strikethrough' }))
    .toHaveAttribute('aria-pressed', 'true');
  expect(remoteRequests).toEqual([]);
});

test('edits rotated and sheared decorated text', async ({ page }) => {
  test.setTimeout(60_000);
  const cases = [
    ['rotated', 'Underline', 'Turned text'],
    ['sheared', 'Strikethrough', 'Slanted text'],
  ] as const;

  for (const [kind, activeDecoration, replacement] of cases) {
    await page.goto('/');
    await page.getByLabel('Open PDF').setInputFiles({
      name: `${kind}.pdf`,
      mimeType: 'application/pdf',
      buffer: Buffer.from(await buildDecorationFixture(kind)),
    });
    await activateByKeyboard(
      page,
      page.getByRole('button', { name: 'Decorated text — Editable' }),
    );
    await expect(page.getByRole('button', { name: activeDecoration }))
      .toHaveAttribute('aria-pressed', 'true');
    await page.getByLabel('Edit selected text').fill(replacement);
    await expandAllowedWidth(page);
    await acceptRichFontSubstitutions(page);
    await page.getByRole('button', { name: 'Apply replacement' }).click();
    await expect(page.getByRole('button', {
      name: `${replacement} — Editable`,
    })).toBeVisible();
  }
});

test('preserves ambiguous nearby line artwork and keeps its warning visible', async ({ page }) => {
  test.setTimeout(60_000);
  await page.goto('/');
  await page.getByLabel('Open PDF').setInputFiles({
    name: 'ambiguous-decoration.pdf',
    mimeType: 'application/pdf',
    buffer: Buffer.from(await buildDecorationFixture('ambiguous-owner')),
  });
  const sourceOverlay = page.getByRole('button', { name: /Left.*Editable/ }).first();
  await activateByKeyboard(page, sourceOverlay);
  const warning = page.getByRole('status', { name: 'Decoration warning' });
  await expect(warning).toContainText('Nearby line artwork could not be identified safely.');

  const editor = page.getByLabel('Edit selected text');
  const original = await editor.inputValue();
  const replacement = original.replace('Left', 'West');
  expect(replacement).not.toBe(original);
  await editor.fill(replacement);
  await expandAllowedWidth(page);
  await acceptRichFontSubstitutions(page);
  await page.getByRole('button', { name: 'Apply replacement' }).click();
  const editedOverlay = page.getByRole('button', { name: /West.*Editable/ }).first();
  await expect(editedOverlay).toBeVisible();
  await activateByKeyboard(page, editedOverlay);
  await expect(page.getByRole('status', { name: 'Decoration warning' }))
    .toContainText('It will be preserved and may not resize with edited text.');
});

test('navigates and keeps overlays aligned while zooming', async ({ page }) => {
  await page.goto('/');
  await page.getByLabel('Open PDF').setInputFiles({
    name: 'two-pages.pdf',
    mimeType: 'application/pdf',
    buffer: await twoPageFixture(),
  });
  await page.getByRole('button', { name: 'Next page' }).click();
  await expect(page.getByLabel('Page number')).toHaveValue('2');
  const overlay = page.getByRole('button', { name: /Page 2 target — Editable/ });
  const beforeCanvas = (await page.getByTestId('pdf-canvas').boundingBox())!;
  const beforeOverlay = (await overlay.boundingBox())!;
  const relativeBefore = (beforeOverlay.x - beforeCanvas.x) / beforeCanvas.width;
  await page.getByRole('button', { name: 'Zoom in' }).click();
  await expect.poll(async () => {
    const afterCanvas = await page.getByTestId('pdf-canvas').boundingBox();
    const afterOverlay = await overlay.boundingBox();
    if (
      afterCanvas === null
      || afterOverlay === null
      || afterCanvas.width <= beforeCanvas.width
    ) return Number.NaN;
    return (afterOverlay.x - afterCanvas.x) / afterCanvas.width;
  }).toBeCloseTo(relativeBefore, 2);
});

test('explains unsupported input precisely', async ({ page }) => {
  await page.goto('/');
  await page.getByLabel('Open PDF').setInputFiles(fixture('25-encryption-marker.pdf'));
  await expect(page.getByText(
    'This release cannot open encrypted or unsupported PDFs.',
  )).toBeVisible();
});

test('restores the last good bytes after runtime validation rejects a candidate', async ({ page }) => {
  const remoteRequests = await installNoNetworkGuard(page);
  await page.addInitScript(() => {
    sessionStorage.setItem('pdf-scrubber:reject-validation', '1');
  });
  await page.goto('/');
  await page.getByLabel('Open PDF').setInputFiles(fixture('01-simple-tj.pdf'));
  await activateByKeyboard(
    page,
    page.getByRole('button', { name: /Target 01 — Editable/ }),
  );
  await page.getByLabel('Edit selected text').fill('Rejected edit');
  await expandAllowedWidth(page);
  await acceptRichFontSubstitutions(page);
  await page.getByRole('button', { name: 'Apply replacement' }).click();

  await expect(page.getByText(
    'Replacement was not applied; the last validated document was restored.',
  )).toBeVisible();
  await expect(page.getByRole('button', { name: /Target 01 — Editable/ })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Download copy' })).toBeDisabled();
  expect(remoteRequests).toEqual([]);
});
