import { expect, test } from '@playwright/test';

import { installNoNetworkGuard } from '../../../tools/check-no-network';

test('executes PDF work in a dedicated module worker', async ({ page }) => {
  await page.goto('/');
  await expect(page.getByTestId('worker-result')).toHaveText('worker:ready');
  expect(await page.evaluate(() => window.__m0WorkerObserved)).toBe(true);
});

test('M0 replacement runs the complete validated worker flow without mutating input', async ({
  page,
}) => {
  const remoteRequests = await installNoNetworkGuard(page);

  await page.goto('/?scenario=success');
  await expect(page.getByTestId('session-result')).not.toBeEmpty({
    timeout: 30_000,
  });
  const result = JSON.parse((await page.getByTestId('session-result').textContent())!);

  expect(result, JSON.stringify(result)).toMatchObject({
    ok: true,
    revision: 1,
    valid: true,
    sourceUnchanged: true,
    inputTransferred: true,
    secondExportCode: 'VALIDATION_FAILURE',
  });
  expect(result.exportBytes).toBeGreaterThan(0);
  expect(remoteRequests).toEqual([]);
});
