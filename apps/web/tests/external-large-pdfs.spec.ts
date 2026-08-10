import { join } from 'node:path';

import { expect, test } from '@playwright/test';

import { EXTERNAL_PDF_FIXTURES } from '../../../tools/validate-large-pdfs';

const externalPdfDirectory = process.env.PDF_SCRUBBER_EXTERNAL_PDF_DIR;
const namedLimitPattern = /^(?:This PDF exceeds the 2,000 indirect-object limit\.|This PDF exceeds the nesting-depth limit of 12\.|This PDF contains a decoded stream larger than 4 MiB\.|This PDF contains more than 50,000 operations in one content stream\.|This PDF requires rendering more than 12 megapixels on one page\.|PDF processing exceeded the 30-second limit\.)$/;

test.describe('verified external large PDFs', () => {
  test.skip(externalPdfDirectory === undefined, 'Run through npm run validate:large-pdfs');

  for (const fixture of EXTERNAL_PDF_FIXTURES) {
    test(`${fixture.id}: ${fixture.expectation}`, async ({ page }) => {
      test.setTimeout(60_000);
      await page.goto('/');
      await page.getByLabel('Open PDF').setInputFiles(
        join(externalPdfDirectory!, fixture.fileName),
      );

      const canvas = page.getByTestId('pdf-canvas');
      if (fixture.expectation === 'must-render') {
        await expect(canvas).toBeVisible({ timeout: 45_000 });
        await expect(page.getByRole('alert')).toHaveCount(0);
        return;
      }

      const namedLimit = page.getByRole('alert').filter({ hasText: namedLimitPattern });
      await expect(canvas.or(namedLimit)).toBeVisible({ timeout: 45_000 });
      if (await page.getByRole('alert').isVisible()) {
        await expect(page.getByRole('alert')).toHaveText(namedLimitPattern);
      }
    });
  }
});
