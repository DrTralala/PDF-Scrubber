import { expect, test } from '@playwright/test';
import type { Page } from '@playwright/test';
import { readFile } from 'node:fs/promises';

import { installNoNetworkGuard } from '../../../tools/check-no-network';

async function scenario(page: Page, name: string) {
  const downloads: string[] = [];
  const remoteRequests = await installNoNetworkGuard(page);
  page.on('download', (download) => downloads.push(download.suggestedFilename()));
  await page.goto(`/?scenario=${name}`);
  await expect(page.getByTestId('session-result')).not.toBeEmpty({ timeout: 30_000 });
  return {
    result: JSON.parse((await page.getByTestId('session-result').textContent())!),
    downloads,
    remoteRequests,
  };
}

test('atomic failures reject stale and read-only mutations without export bytes', async ({ page }) => {
  const stale = await scenario(page, 'stale');
  expect(stale.result).toMatchObject({ ok: false, code: 'STALE_REVISION', hasBytes: false });
  expect(stale.downloads).toEqual([]);
  expect(stale.remoteRequests).toEqual([]);

  const readOnly = await scenario(page, 'shared');
  expect(readOnly.result).toMatchObject({ ok: false, code: 'READ_ONLY_SPAN', hasBytes: false });
  expect(readOnly.downloads).toEqual([]);
  expect(readOnly.remoteRequests).toEqual([]);
});

test('hostile malformed and over-limit documents fail closed without export bytes', async ({ page }) => {
  const malformed = await scenario(page, 'malformed');
  expect(malformed.result.ok).toBe(false);
  expect(['MALFORMED_INPUT', 'UNSUPPORTED_DOCUMENT']).toContain(malformed.result.code);
  expect(malformed.result.hasBytes).toBe(false);
  expect(malformed.remoteRequests).toEqual([]);

  const overLimit = await scenario(page, 'over-limit');
  expect(overLimit.result).toMatchObject({ ok: false, code: 'RESOURCE_LIMIT', hasBytes: false });
  expect(overLimit.remoteRequests).toEqual([]);
});

test('atomic export refuses unvalidated candidates and transfers no bytes', async ({ page }) => {
  const validation = await scenario(page, 'validation-failure');
  expect(validation.result).toMatchObject({
    ok: false,
    code: 'VALIDATION_FAILURE',
    hasBytes: false,
  });
  expect(validation.remoteRequests).toEqual([]);
});

test('hostile worker timeout destroys its session and only a new open creates a worker', async ({
  page,
}) => {
  const timeout = await scenario(page, 'timeout');
  expect(timeout.result).toMatchObject({
    ok: false,
    code: 'RESOURCE_LIMIT',
    hasBytes: false,
    sessionRequestRejected: true,
    newDocumentOpened: true,
  });
  expect(timeout.result.workerGenerationAfter).toBeGreaterThan(
    timeout.result.workerGenerationBefore,
  );
  expect(timeout.remoteRequests).toEqual([]);
});

test('resource probe enforces an exact file cap in three browser worker runs', async ({ page }) => {
  const source = await readFile('fixtures/generated/01-simple-tj.pdf');
  const base64 = source.toString('base64');
  await page.goto('/');
  await page.waitForFunction(() => window.__m0WorkerObserved === true);

  const results = await page.evaluate(async ({ encoded, byteLength }) => {
    const decode = (): ArrayBuffer => {
      const binary = atob(encoded);
      return Uint8Array.from(binary, (character) => character.charCodeAt(0)).buffer;
    };
    const limits = {
      maxFileBytes: byteLength,
      maxObjects: 250_000,
      maxNestingDepth: 64,
      maxDecodedStreamBytes: 128 * 1024 * 1024,
      maxOperationsPerStream: 1_000_000,
      maxImagePixels: 100_000_000,
      maxProcessingMs: 30_000,
    };
    const output = [];
    for (let run = 0; run < 3; run += 1) {
      const passing = await window.__m0ResourceProbe!(decode(), limits, false);
      let rejected: string | null = null;
      try {
        await window.__m0ResourceProbe!(decode(), {
          ...limits,
          maxFileBytes: byteLength - 1,
        }, false);
      } catch (error) {
        rejected = error instanceof Error && 'code' in error
          ? String(error.code)
          : 'UNKNOWN';
      }
      let imageRejected: string | null = null;
      try {
        await window.__m0ResourceProbe!(decode(), {
          ...limits,
          maxImagePixels: 1,
        }, false, true);
      } catch (error) {
        imageRejected = error instanceof Error && 'code' in error
          ? String(error.code)
          : 'UNKNOWN';
      }
      output.push({ passing: passing.fileBytes, rejected, imageRejected });
    }
    return output;
  }, { encoded: base64, byteLength: source.byteLength });

  expect(results).toEqual(Array.from({ length: 3 }, () => ({
    passing: source.byteLength,
    rejected: 'RESOURCE_LIMIT',
    imageRejected: 'RESOURCE_LIMIT',
  })));
});
