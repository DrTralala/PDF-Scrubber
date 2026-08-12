import { expect, type Locator, type Page } from '@playwright/test';

export async function activateByKeyboard(page: Page, overlay: Locator): Promise<void> {
  await overlay.focus();
  await page.keyboard.press('Enter');
}

export async function acceptRichFontSubstitutions(page: Page): Promise<void> {
  const consents = page.locator('.font-requirements input[type="checkbox"]');
  await expect(consents.first()).toBeVisible();
  for (let index = 0; index < await consents.count(); index += 1) {
    await consents.nth(index).check();
  }
}

export async function expandAllowedWidth(page: Page): Promise<void> {
  const slider = page.getByLabel('Allowed width');
  const maximum = await slider.getAttribute('max');
  if (maximum === null) throw new Error('Allowed width range has no maximum');
  await slider.evaluate((element, value) => {
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set;
    if (setter === undefined) throw new Error('HTMLInputElement value setter is unavailable');
    setter.call(element, value);
    element.dispatchEvent(new Event('input', { bubbles: true }));
    element.dispatchEvent(new Event('change', { bubbles: true }));
  }, maximum);
}
