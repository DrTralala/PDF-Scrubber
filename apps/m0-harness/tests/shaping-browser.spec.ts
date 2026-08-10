import { expect, test } from '@playwright/test';

import { installNoNetworkGuard } from '../../../tools/check-no-network';

test('shapes replacement text in a Chromium worker without remote requests', async ({
  page,
}) => {
  const remoteRequests = await installNoNetworkGuard(page);
  const pageErrors: string[] = [];
  const failedRequests: string[] = [];
  page.on('pageerror', (error) => pageErrors.push(error.message));
  page.on('requestfailed', (request) =>
    failedRequests.push(`${request.url()}: ${request.failure()?.errorText}`),
  );

  await page.goto('/?shape=1');

  await expect
    .poll(async () => ({
      text: await page.getByTestId('shape-result').textContent(),
      pageErrors,
    }))
    .toEqual({
      text: 'office:4:ltr',
      pageErrors: [],
    });
  expect(await page.evaluate(() => window.__m0ShapingObserved)).toBe(true);
  expect(failedRequests).toEqual([]);
  expect(remoteRequests).toEqual([]);
});
