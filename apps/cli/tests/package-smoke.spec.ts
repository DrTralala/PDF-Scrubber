import { stat } from 'node:fs/promises';
import { resolve } from 'node:path';

import { expect, test } from '@playwright/test';

import { installNoNetworkGuard } from '../../../tools/check-no-network';
import {
  acceptRichFontSubstitutions,
  activateByKeyboard,
  expandAllowedWidth,
} from '../../web/tests/editor-interactions';

test('edits and downloads a fixture through the installed production package', async ({ page }) => {
  const fixtureRoot = process.env.PDF_SCRUBBER_FIXTURE_ROOT;
  if (fixtureRoot === undefined) throw new Error('PDF_SCRUBBER_FIXTURE_ROOT is required');

  const remoteRequests = await installNoNetworkGuard(page);
  await page.goto('/');
  await page.getByLabel('Open PDF').setInputFiles(resolve(fixtureRoot, '01-simple-tj.pdf'));
  await expect(page.getByTestId('pdf-canvas')).toBeVisible();

  const overlay = page.getByRole('button', { name: /Target 01 — Editable/ });
  await activateByKeyboard(page, overlay);
  await page.getByLabel('Edit selected text').fill('Packaged edit');
  await expandAllowedWidth(page);
  await acceptRichFontSubstitutions(page);

  const apply = page.getByRole('button', { name: 'Apply replacement' });
  await expect(apply).toBeEnabled();
  await apply.click();
  await expect(page.getByRole('button', { name: /Packaged edit — Editable/ })).toBeVisible();

  const downloadEvent = page.waitForEvent('download');
  await page.getByRole('button', { name: 'Download copy' }).click();
  const download = await downloadEvent;
  expect(download.suggestedFilename()).toBe('01-simple-tj-edited.pdf');
  const downloadedPath = await download.path();
  expect(downloadedPath).not.toBeNull();
  expect((await stat(downloadedPath!)).size).toBeGreaterThan(0);
  expect(remoteRequests).toEqual([]);
});
