import { expect, test } from 'vitest';

import { chromium, type Browser } from '@playwright/test';

import { connectElectronBrowser, drainDiagnosticReaders } from './desktop-portable-smoke';

test('keeps Electron’s browser-managed download policy when attaching over CDP', async () => {
  const calls: Array<Readonly<{ endpoint: string; noDefaults: boolean | undefined }>> = [];
  const browser = {} as Browser;
  const connector = {
    async connectOverCDP(endpoint: string, options?: { noDefaults?: boolean }) {
      calls.push({ endpoint, noDefaults: options?.noDefaults });
      return browser;
    },
  } as unknown as typeof chromium;

  await expect(connectElectronBrowser('http://127.0.0.1:9222', connector)).resolves.toBe(browser);
  expect(calls).toEqual([{ endpoint: 'http://127.0.0.1:9222', noDefaults: true }]);
});

test('closes diagnostic streams and bounds waiting for a stalled reader', async () => {
  let streamsClosed = false;
  const stalledReader = new Promise<void>(() => {});

  await expect(drainDiagnosticReaders([stalledReader], () => {
    streamsClosed = true;
  }, 5)).resolves.toBeUndefined();
  expect(streamsClosed).toBe(true);
});
