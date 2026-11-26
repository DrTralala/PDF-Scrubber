import { resolve } from 'node:path';

import { expect, test, type Page } from '@playwright/test';

function projectFile(name: string): string {
  return resolve(process.cwd(), name);
}

function fixture(name: string): string {
  return projectFile(`fixtures/generated/${name}`);
}

async function openFixture(page: Page, name: string): Promise<void> {
  await page.goto('/');
  await page.getByLabel('Open PDF').setInputFiles(fixture(name));
  await expect(page.getByTestId('pdf-canvas')).toBeVisible();
}

async function selectEditableText(page: Page, name: RegExp): Promise<void> {
  const overlay = page.getByRole('button', { name }).first();
  await overlay.focus();
  await page.keyboard.press('Enter');
  await expect(page.getByLabel('Edit selected text')).toBeVisible();
}

test('Auto reports an unresolvable overflow truthfully while manual width remains available', async ({ page }) => {
  await openFixture(page, '01-simple-tj.pdf');
  await selectEditableText(page, /Target 01 — Editable/);
  await page.getByLabel('Edit selected text').fill(
    'This deliberately long replacement cannot fit before the protected page edge.',
  );

  const auto = page.getByRole('checkbox', { name: 'Auto' });
  await expect(auto).toBeChecked();
  const fitStatus = page.locator('.fit-status');
  await expect(fitStatus).toContainText('pt short');

  await auto.uncheck();
  const slider = page.getByLabel('Allowed width');
  const maximum = Number(await slider.getAttribute('max'));
  await slider.focus();
  await slider.press('End');
  await expect(slider).toHaveValue(String(maximum));
  await expect(fitStatus).toContainText('pt short');
  await expect(page.getByText(/This text overflows the allowed region/)).toBeVisible();
  await expect(page.getByRole('button', { name: 'Apply', exact: true })).toBeDisabled();
});

test('Text Colour stays unobscured at desktop and narrow widths', async ({ page }) => {
  for (const viewport of [
    { width: 1440, height: 900 },
    { width: 390, height: 844 },
  ]) {
    await page.setViewportSize(viewport);
    await openFixture(page, '30-wkhtmltopdf-rich-line.pdf');
    await selectEditableText(page, /this is a bold text — Editable/);

    const geometry = await page.locator('.text-colour-control').evaluate((label) => {
      const text = label.firstChild;
      const input = label.querySelector('input[type="color"]');
      if (text === null || input === null) {
        throw new Error('Text Colour structure is incomplete');
      }
      const range = document.createRange();
      range.selectNodeContents(text);
      const textBox = range.getBoundingClientRect();
      const inputBox = input.getBoundingClientRect();
      return { textRight: textBox.right, inputLeft: inputBox.left };
    });
    expect(geometry.inputLeft).toBeGreaterThan(geometry.textRight);
    await expect(page.getByLabel('Text Colour')).toBeVisible();
  }
});
