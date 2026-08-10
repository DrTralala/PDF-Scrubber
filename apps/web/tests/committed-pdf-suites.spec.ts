import { readFile, stat } from 'node:fs/promises';
import { basename } from 'node:path';

import { expect, test, type Locator, type Page } from '@playwright/test';

import {
  loadCommittedPdfSuite,
  resolveCommittedFontPath,
  selectedCommittedPdfSuites,
  type CommittedPdfEdit,
  type LoadedCommittedPdfSuite,
} from '../../../tools/committed-pdf-suites';
import { installNoNetworkGuard } from '../../../tools/check-no-network';

const selectedSuites = new Set(
  selectedCommittedPdfSuites(process.env.PDF_SCRUBBER_COMMITTED_PDF_MODE),
);

async function openSuite(page: Page, loaded: LoadedCommittedPdfSuite): Promise<void> {
  await page.goto('/');
  await page.getByLabel('Open PDF').setInputFiles(loaded.pdfPath);
  await expect(page.getByTestId('pdf-canvas')).toBeVisible();
}

const FONT_REASON_COPY = Object.freeze({
  'embedded-not-reusable': 'Embedded for display, but PDF-Scrubber cannot reuse it for editing.',
});

async function assertFontInventoryRows(
  page: Page,
  loaded: LoadedCommittedPdfSuite,
): Promise<void> {
  const dialog = page.getByRole('dialog', { name: 'Fonts needed for editing' });
  const rows = dialog.locator('.missing-font-row');
  await expect(rows).toHaveCount(loaded.manifest.fonts.length);
  await expect(rows.locator('strong')).toHaveText(
    loaded.manifest.fonts.map(({ inventoryName }) => inventoryName),
  );

  for (const [index, font] of loaded.manifest.fonts.entries()) {
    const row = rows.nth(index);
    await expect(row).toHaveCount(1);
    await expect(row.locator('strong')).toHaveText(font.inventoryName);
    await expect(row.getByText(FONT_REASON_COPY[font.reason], { exact: true })).toBeVisible();
  }
}

async function assertFontInventory(
  page: Page,
  loaded: LoadedCommittedPdfSuite,
): Promise<void> {
  await page.getByRole('button', { name: 'Fonts needed for editing' }).click();
  const dialog = page.getByRole('dialog', { name: 'Fonts needed for editing' });
  await expect(dialog).toBeVisible();
  await assertFontInventoryRows(page, loaded);

  for (const [index, font] of loaded.manifest.fonts.entries()) {
    const row = dialog.locator('.missing-font-row').nth(index);
    const link = row.getByRole('link', { name: `Download ${font.inventoryName}` });
    await expect(link).toHaveAttribute('href', font.searchUrl);
    await expect(link).toHaveAttribute('target', '_blank');
    await expect(link).toHaveAttribute('rel', 'noopener noreferrer');
  }
}

async function importRequiredFaces(
  page: Page,
  loaded: LoadedCommittedPdfSuite,
): Promise<void> {
  const dialog = page.getByRole('dialog', { name: 'Fonts needed for editing' });
  const requiredNames = [...new Set(
    loaded.manifest.edits.map(({ fontInventoryName }) => fontInventoryName),
  )];

  for (const name of requiredNames) {
    const font = loaded.manifest.fonts.find(({ inventoryName }) => inventoryName === name);
    if (font === undefined) throw new Error(`Manifest edit references unknown font ${name}`);
    const fontIndex = loaded.manifest.fonts.findIndex(({ inventoryName }) => inventoryName === name);
    const row = dialog.locator('.missing-font-row').nth(fontIndex);
    await expect(row).toHaveCount(1);
    await row.getByLabel(`Choose font file for ${name}`, { exact: true })
      .setInputFiles(resolveCommittedFontPath(font));
    const success = row.getByText(`Imported ${name} successfully`, { exact: true });
    await expect(success).toBeVisible();
    await expect(success).toHaveClass(/font-import-success/);
    await assertFontInventoryRows(page, loaded);
  }
}

async function confirmedPageFrame(page: Page, pageIndex: number): Promise<Locator> {
  const expectedPage = String(pageIndex + 1);
  const editor = page.locator('.editor');
  await expect(editor).toHaveAttribute('data-phase', 'ready');
  const viewport = page.locator(
    `.page-viewport:has(canvas[aria-label="Page ${expectedPage}"])`,
  );
  await expect(viewport).toHaveCount(1);
  await expect(viewport.locator('.render-status')).toHaveCount(0);
  const frame = viewport.locator('.page-frame');
  const canvas = frame.locator(`canvas[aria-label="Page ${expectedPage}"]`);
  await expect(frame).toHaveCount(1);
  await expect(canvas).toBeVisible();
  return frame;
}

async function goToManifestPage(page: Page, pageIndex: number): Promise<Locator> {
  const pageNumber = page.getByLabel('Page number', { exact: true });
  const expectedPage = String(pageIndex + 1);
  if (Number.parseInt(await pageNumber.inputValue(), 10) === pageIndex + 1) {
    return confirmedPageFrame(page, pageIndex);
  }

  await pageNumber.fill(expectedPage);
  await pageNumber.press('Enter');
  await expect(pageNumber).toHaveValue(expectedPage);
  return confirmedPageFrame(page, pageIndex);
}

function editableOverlay(container: Locator, text: string): Locator {
  const escaped = text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return container.getByRole('button', {
    name: new RegExp(`^${escaped} — Editable(?: with font substitution)?$`),
  });
}

async function selectEditableText(
  page: Page,
  sourceText: string,
  destinationPage: Locator,
): Promise<Locator> {
  const overlay = editableOverlay(destinationPage, sourceText);
  await expect(overlay).toHaveCount(1);
  await expect(overlay).toBeVisible();
  await overlay.focus();
  await page.keyboard.press('Enter');
  await expect(overlay).toHaveAttribute('aria-pressed', 'true');
  const editor = page.getByLabel('Edit selected text');
  await expect(editor).toBeVisible();
  await expect(editor).toHaveValue(sourceText);
  return overlay;
}

async function chooseRegisteredFont(
  page: Page,
  loaded: LoadedCommittedPdfSuite,
  edit: CommittedPdfEdit,
): Promise<void> {
  const font = loaded.manifest.fonts.find(({ inventoryName }) => (
    inventoryName === edit.fontInventoryName
  ));
  if (font === undefined) throw new Error(`Manifest edit references unknown font ${edit.fontInventoryName}`);

  const fontSelect = page.getByLabel('Font', { exact: true });
  const expectedLabel = `${font.inventoryName} · upload`;
  const matchingOptions = fontSelect.locator('option').filter({
    hasText: `${font.inventoryName} · upload`,
  });
  await expect(matchingOptions).toHaveCount(1);
  await expect(matchingOptions).toHaveText(expectedLabel);
  const value = await matchingOptions.getAttribute('value');
  if (value === null) throw new Error(`Registered font option has no value for ${font.inventoryName}`);
  await fontSelect.selectOption(value);
  await expect(fontSelect.locator('option:checked')).toHaveText(expectedLabel);
}

async function applyEdit(
  page: Page,
  loaded: LoadedCommittedPdfSuite,
  edit: CommittedPdfEdit,
): Promise<void> {
  const destinationPage = await goToManifestPage(page, edit.pageIndex);
  const sourceOverlay = await selectEditableText(page, edit.sourceText, destinationPage);
  const editor = page.getByLabel('Edit selected text');
  await editor.fill(edit.replacementText);
  await editor.press('ControlOrMeta+A');
  await chooseRegisteredFont(page, loaded, edit);

  const fitStatus = page.locator('.fit-status');
  await expect(fitStatus).toContainText(/(?:Fits|Overflow):/);
  const fitLine = page.getByRole('button', { name: 'Fit line' });
  if (await fitLine.isVisible()) {
    await expect(fitStatus).toContainText('Overflow:');
    await fitLine.click();
    await expect(fitStatus).toContainText('Fits:');
  }

  const consents = page.locator('.font-requirements input[type="checkbox"]');
  for (let index = 0; index < await consents.count(); index += 1) {
    const consent = consents.nth(index);
    await expect(consent).toBeVisible();
    if (!(await consent.isChecked())) await consent.check();
  }

  const apply = page.getByRole('button', { name: 'Apply replacement' });
  await expect(apply).toBeEnabled();
  await apply.click();
  const appliedPage = await confirmedPageFrame(page, edit.pageIndex);
  await expect(sourceOverlay).toHaveCount(0);
  await expect(editableOverlay(appliedPage, edit.sourceText)).toHaveCount(0);
  await expect(editableOverlay(appliedPage, edit.replacementText)).toHaveCount(1);
  await expect(editableOverlay(appliedPage, edit.replacementText)).toBeVisible();
}

async function exportOnce(
  page: Page,
  loaded: LoadedCommittedPdfSuite,
): Promise<string> {
  const downloadEvent = page.waitForEvent('download');
  await page.getByRole('button', { name: 'Download copy' }).click();
  const download = await downloadEvent;
  expect(download.suggestedFilename()).toBe(
    `${basename(loaded.pdfPath, '.pdf')}-edited.pdf`,
  );
  const downloadedPath = await download.path();
  expect(downloadedPath).not.toBeNull();
  if (downloadedPath === null) throw new Error('Playwright did not provide a download path');
  expect((await stat(downloadedPath)).size).toBeGreaterThan(0);
  return downloadedPath;
}

async function reopenExport(
  page: Page,
  bytes: Uint8Array,
  edits: readonly CommittedPdfEdit[],
): Promise<void> {
  await page.reload();
  await page.getByLabel('Open PDF').setInputFiles({
    name: 'document-edited.pdf',
    mimeType: 'application/pdf',
    buffer: Buffer.from(bytes),
  });
  await expect(page.getByTestId('pdf-canvas')).toBeVisible();

  for (const edit of edits) {
    if (!edit.verifyAfterReopen) continue;
    const destinationPage = await goToManifestPage(page, edit.pageIndex);
    await expect(editableOverlay(destinationPage, edit.sourceText)).toHaveCount(0);
    await expect(editableOverlay(destinationPage, edit.replacementText)).toHaveCount(1);
    await expect(editableOverlay(destinationPage, edit.replacementText)).toBeVisible();
  }
}

for (const suite of [1, 2, 3] as const) {
  test(`committed PDF Suite ${suite} completes its full edit journey`, async ({ page }) => {
    test.skip(
      !selectedSuites.has(suite),
      'Committed PDF Suites 2 and 3 require npm run test:web -- --full',
    );
    test.setTimeout(suite === 3 ? 120_000 : 60_000);
    const loaded = loadCommittedPdfSuite(suite);
    const remoteRequests = await installNoNetworkGuard(page);
    await openSuite(page, loaded);
    await assertFontInventory(page, loaded);
    await importRequiredFaces(page, loaded);
    await page.getByRole('button', { name: 'Close' }).click();
    await expect(page.getByRole('button', { name: 'Fonts needed for editing' })).toBeFocused();
    for (const edit of loaded.manifest.edits) await applyEdit(page, loaded, edit);
    const downloadedPath = await exportOnce(page, loaded);
    const downloadedBytes = await readFile(downloadedPath);
    await reopenExport(page, downloadedBytes, loaded.manifest.edits);
    expect(remoteRequests).toEqual([]);
  });
}
