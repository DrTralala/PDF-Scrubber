import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';

import { expect, test, type Dialog, type Page } from '@playwright/test';

import { installNoNetworkGuard } from '../../../tools/check-no-network';
import {
  acceptRichFontSubstitutions,
  activateByKeyboard,
  expandAllowedWidth,
} from './editor-interactions';

type OpenChoice = 'source' | 'copy';

function fixture(name: string): string {
  return resolve(process.cwd(), 'fixtures/generated', name);
}

async function installOriginPrivatePickers(page: Page, originalBytes: Uint8Array): Promise<void> {
  await page.addInitScript((sourceBytes: readonly number[]) => {
    type TestFileHandle = Readonly<{
      name: string;
      getFile(): Promise<File>;
      requestPermission?(options: Readonly<{ mode: 'readwrite' }>): Promise<PermissionState>;
      createWritable(): Promise<Readonly<{
        write(data: ArrayBuffer | Blob | string): Promise<void>;
        close(): Promise<void>;
        abort?(): Promise<void>;
      }>>;
    }>;
    type PickerControls = {
      openChoice: OpenChoice;
      cancelSave: boolean;
      sourceHandle: TestFileHandle | null;
      copyHandle: TestFileHandle | null;
      sourceWrites: number;
      copyWrites: number;
      ready: Promise<void>;
    };
    type TestWindow = Window & { __pdfScrubberSaveTest?: PickerControls };
    const controls: PickerControls = {
      openChoice: 'source',
      cancelSave: false,
      sourceHandle: null,
      copyHandle: null,
      sourceWrites: 0,
      copyWrites: 0,
      ready: Promise.resolve(),
    };
    const testWindow = window as TestWindow;
    testWindow.__pdfScrubberSaveTest = controls;

    const wrapHandle = (
      handle: FileSystemFileHandle,
      target: 'source' | 'copy',
    ): TestFileHandle => {
      const requestPermission = Reflect.get(handle, 'requestPermission') as
        | ((options: Readonly<{ mode: 'readwrite' }>) => Promise<PermissionState>)
        | undefined;
      return Object.freeze({
        name: handle.name,
        getFile: () => handle.getFile(),
        ...(requestPermission === undefined ? {} : {
          requestPermission: (options: Readonly<{ mode: 'readwrite' }>) =>
            requestPermission.call(handle, options),
        }),
        createWritable: async () => {
          if (target === 'source') controls.sourceWrites += 1;
          else controls.copyWrites += 1;
          const writable = await handle.createWritable();
          return Object.freeze({
            write: (data: ArrayBuffer | Blob | string) => writable.write(data),
            close: () => writable.close(),
            abort: () => writable.abort(),
          });
        },
      });
    };

    controls.ready = (async () => {
      const directory = await navigator.storage.getDirectory();
      const sourceFile = await directory.getFileHandle('source.pdf', { create: true });
      if ((await sourceFile.getFile()).size === 0) {
        const writable = await sourceFile.createWritable();
        await writable.write(Uint8Array.from(sourceBytes));
        await writable.close();
      }
      const copyFile = await directory.getFileHandle('copy.pdf', { create: true });
      controls.sourceHandle = wrapHandle(sourceFile, 'source');
      controls.copyHandle = wrapHandle(copyFile, 'copy');
    })();

    Object.defineProperty(window, 'showOpenFilePicker', {
      configurable: true,
      value: async () => {
        await controls.ready;
        const handle = controls.openChoice === 'source'
          ? controls.sourceHandle
          : controls.copyHandle;
        if (handle === null) throw new Error('The origin-private PDF handle is unavailable');
        return [handle];
      },
    });
    Object.defineProperty(window, 'showSaveFilePicker', {
      configurable: true,
      value: async () => {
        await controls.ready;
        if (controls.cancelSave) throw new DOMException('Picker cancelled', 'AbortError');
        if (controls.copyHandle === null) throw new Error('The copy handle is unavailable');
        return controls.copyHandle;
      },
    });
  }, Array.from(originalBytes));
}

async function applyEdit(page: Page, sourceText: string, replacement: string): Promise<void> {
  await activateByKeyboard(
    page,
    page.getByRole('button', { name: `${sourceText} — Editable` }),
  );
  await page.getByLabel('Edit selected text').fill(replacement);
  await expandAllowedWidth(page);
  await acceptRichFontSubstitutions(page);
  await page.getByRole('button', { name: 'Apply', exact: true }).click();
  await expect(page.getByRole('button', { name: `${replacement} — Editable` })).toBeVisible();
}

async function dismissUnsavedClose(page: Page): Promise<void> {
  const currentUrl = page.url();
  const destination = new URL(currentUrl);
  destination.searchParams.set('unsaved-close-check', '1');
  const navigation = page.goto(destination.toString()).catch(() => undefined);
  const dialog = await page.waitForEvent('dialog');
  const type = dialog.type();
  await dialog.dismiss();
  await navigation;
  expect(type).toBe('beforeunload');
  expect(page.url()).toBe(currentUrl);
}

test('overwrites, cancels and retargets Save as with dirty-close protection', async ({ page }) => {
  test.setTimeout(60_000);
  const originalBytes = await readFile(fixture('01-simple-tj.pdf'));
  const externalRequests = await installNoNetworkGuard(page);
  await installOriginPrivatePickers(page, originalBytes);
  await page.goto('/');
  await page.getByRole('button', { name: 'Open PDF' }).click();
  await expect(page.getByTestId('pdf-canvas')).toBeVisible();

  await applyEdit(page, 'Target 01', 'Saved original 01');
  await page.getByRole('button', { name: 'Save', exact: true }).click();
  await expect(page).toHaveTitle('PDF-Scrubber');

  await applyEdit(page, 'Saved original 01', 'Save as copy 02');
  await page.evaluate(() => {
    const controls = (window as Window & {
      __pdfScrubberSaveTest?: { cancelSave: boolean };
    }).__pdfScrubberSaveTest;
    if (controls === undefined) throw new Error('Save test controls are unavailable');
    controls.cancelSave = true;
  });
  await page.getByRole('button', { name: 'Save as...', exact: true }).click();
  await expect(page.locator('.file-name')).toHaveText('source.pdf');
  await expect(page).toHaveTitle('source.pdf — Unsaved changes | PDF-Scrubber');
  await expect(page.getByRole('button', { name: 'Save', exact: true })).toBeEnabled();

  await dismissUnsavedClose(page);
  await expect(page).toHaveTitle('source.pdf — Unsaved changes | PDF-Scrubber');

  await page.evaluate(() => {
    const controls = (window as Window & {
      __pdfScrubberSaveTest?: { cancelSave: boolean };
    }).__pdfScrubberSaveTest;
    if (controls === undefined) throw new Error('Save test controls are unavailable');
    controls.cancelSave = false;
  });
  await page.getByRole('button', { name: 'Save as...', exact: true }).click();
  await expect(page.locator('.file-name')).toHaveText('copy.pdf');
  await expect(page).toHaveTitle('PDF-Scrubber');

  await applyEdit(page, 'Save as copy 02', 'Retargeted copy 03');
  await page.getByRole('button', { name: 'Save', exact: true }).click();
  await expect(page).toHaveTitle('PDF-Scrubber');

  const stored = await page.evaluate(async () => {
    const controls = (window as Window & {
      __pdfScrubberSaveTest?: {
        sourceHandle: { getFile(): Promise<File> } | null;
        copyHandle: { getFile(): Promise<File> } | null;
        sourceWrites: number;
        copyWrites: number;
      };
    }).__pdfScrubberSaveTest;
    if (controls?.sourceHandle === null || controls?.copyHandle === null || controls === undefined) {
      throw new Error('Origin-private save handles are unavailable');
    }
    const [sourceFile, copyFile] = await Promise.all([
      controls.sourceHandle.getFile(),
      controls.copyHandle.getFile(),
    ]);
    return {
      sourceBytes: Array.from(new Uint8Array(await sourceFile.arrayBuffer())),
      copyBytes: Array.from(new Uint8Array(await copyFile.arrayBuffer())),
      sourceWrites: controls.sourceWrites,
      copyWrites: controls.copyWrites,
    };
  });
  expect(stored.sourceBytes).not.toEqual(Array.from(originalBytes));
  expect(stored.copyBytes).not.toEqual(stored.sourceBytes);
  expect(stored.sourceWrites).toBe(1);
  expect(stored.copyWrites).toBe(2);

  const unexpectedDialogs: string[] = [];
  const onDialog = async (dialog: Dialog) => {
    unexpectedDialogs.push(dialog.type());
    await dialog.dismiss();
  };
  page.on('dialog', onDialog);
  await page.reload();
  page.off('dialog', onDialog);
  expect(unexpectedDialogs).toEqual([]);

  await page.getByRole('button', { name: 'Open PDF' }).click();
  await expect(page.getByRole('button', { name: 'Saved original 01 — Editable' })).toBeVisible();
  await page.reload();
  await page.evaluate(() => {
    const controls = (window as Window & {
      __pdfScrubberSaveTest?: { openChoice: OpenChoice };
    }).__pdfScrubberSaveTest;
    if (controls === undefined) throw new Error('Save test controls are unavailable');
    controls.openChoice = 'copy';
  });
  await page.getByRole('button', { name: 'Open PDF' }).click();
  await expect(page.getByRole('button', { name: 'Retargeted copy 03 — Editable' })).toBeVisible();
  expect(externalRequests).toEqual([]);
});
