import { resolve } from 'node:path';

import { expect, test, type Page } from '@playwright/test';

function fixture(name: string): string {
  return resolve(process.cwd(), 'fixtures/generated', name);
}

async function openFixture(page: Page, name: string): Promise<void> {
  await page.goto('/');
  await page.getByLabel('Open PDF').setInputFiles(fixture(name));
  await expect(page.getByTestId('pdf-canvas')).toBeVisible();
}

async function activateByKeyboard(page: Page, name: RegExp): Promise<void> {
  const overlay = page.getByRole('button', { name }).first();
  await overlay.focus();
  await page.keyboard.press('Enter');
}

test('selects analysed text using the keyboard', async ({ page }) => {
  await openFixture(page, '01-simple-tj.pdf');
  const overlay = page.getByRole('button', { name: /Target 01 — Editable/ });
  await overlay.focus();
  await page.keyboard.press('Enter');
  await expect(page.getByRole('complementary', {
    name: 'Text replacement inspector',
  })).toContainText('Target 01');
});

test('removes non-essential motion', async ({ page }) => {
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await openFixture(page, '01-simple-tj.pdf');
  const duration = await page.locator('.inspector').evaluate(
    (element) => getComputedStyle(element).transitionDuration,
  );
  expect(['0s', '0.00001s']).toContain(duration);
});

test('keeps narrow controls usable', async ({ page }, testInfo) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await openFixture(page, '01-simple-tj.pdf');
  const top = await page.getByRole('banner').boundingBox();
  const inspector = await page.getByRole('complementary').boundingBox();
  expect(top).not.toBeNull();
  expect(inspector).not.toBeNull();
  expect(inspector!.y).toBeGreaterThanOrEqual(top!.y + top!.height);
  for (const name of ['Select text', 'Pan document', 'Show editable text']) {
    expect((await page.getByRole('button', { name }).boundingBox())!.height)
      .toBeGreaterThanOrEqual(44);
  }
  const overflow = await page.getByRole('main', { name: 'PDF page' }).evaluate(
    (element) => getComputedStyle(element).overflow,
  );
  expect(['auto', 'scroll']).toContain(overflow);
  await activateByKeyboard(page, /Target 01 — Editable/);
  await page.screenshot({
    path: testInfo.outputPath('pdf-scrubber-narrow.png'),
    fullPage: true,
  });
});

test('explains read-only text without relying on colour', async ({ page }) => {
  await openFixture(page, '18-shared-form-xobject.pdf');
  await activateByKeyboard(page, /Read-only/);
  await expect(page.getByText(
    'This text is reused elsewhere in the PDF and cannot be changed independently.',
  )).toBeVisible();
  await expect(page.getByRole('status')).not.toBeEmpty();
});

test('exposes mixed whole-selection formatting and keyboard toggle state', async ({ page }) => {
  await openFixture(page, '30-wkhtmltopdf-rich-line.pdf');
  await activateByKeyboard(page, /this is a bold text — Editable/);

  const bold = page.getByRole('button', { name: 'Bold', exact: true });
  await expect(bold).toHaveAttribute('aria-pressed', 'mixed');
  await expect(page.getByRole('button', { name: 'Italic' }))
    .toHaveAttribute('aria-pressed', 'false');
  await expect(page.getByRole('button', { name: 'Underline' }))
    .toHaveAttribute('aria-pressed', 'false');
  await expect(page.getByRole('button', { name: 'Strikethrough' }))
    .toHaveAttribute('aria-pressed', 'false');

  await bold.focus();
  await page.keyboard.press('Space');
  await expect(bold).toHaveAttribute('aria-pressed', 'true');
});
