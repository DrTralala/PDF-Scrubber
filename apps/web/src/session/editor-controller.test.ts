import {
  ENGINE_ERROR_CODES,
  type DocumentEditingFont,
  type FontDescriptor,
  type HalfOpenRange,
} from '@pdf-editor/pdf-engine';
import { PNG } from 'pngjs';
import type {
  AnalysePageResult,
  ReplacementPreviewResult,
} from '@pdf-editor/worker-protocol';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { ValidationRejectedError } from '../engine/product-engine-client';
import { WorkerClientError } from '../engine/worker-client';
import type { WritablePdfHandle } from '../file-access';
import { editorError } from '../model/editor-state';
import {
  analysisFixture,
  createControllerHarness,
  deferred,
  FakeDisplayDocument,
  fakeFontDescriptor,
  pdfFile,
  richPreviewResult,
  textLineAnalysisFixture,
  validatedResult,
} from '../test/fakes';
import type { EditorController } from './editor-controller';

function applicationTarget(
  controller: EditorController,
  range: HalfOpenRange,
) {
  const snapshot = controller.getSnapshot();
  if (snapshot.selection?.kind !== 'text') throw new Error('Expected a text selection');
  return Object.freeze({
    generation: snapshot.generation,
    pageIndex: snapshot.pageIndex,
    selectionKey: snapshot.selection.textSelection.key,
    range,
  });
}

function applicationFont(
  inspection: Partial<FontDescriptor['inspection']> = {},
): FontDescriptor {
  const base = fakeFontDescriptor('upload', 'Selected.ttf', '4-5-6');
  return Object.freeze({
    ...base,
    inspection: Object.freeze({
      ...base.inspection,
      weight: 700,
      italic: true,
      italicAngle: -10,
      codePoints: Object.freeze([65, 66, 67]),
      ...inspection,
    }),
  });
}

async function prepareReplacement(
  controller: EditorController,
  text: string,
): Promise<void> {
  controller.selectSpan('span-1');
  controller.setReplacement(text);
  controller.setAcceptSubstitution(true);
  await controller.previewSelection();
}

type ImageInsert = (
  file: File,
  context: Readonly<{
    generation: number;
    pageIndex: number;
    center: Readonly<{ x: number; y: number }>;
  }>,
) => Promise<void>;

type CurrentDownload = () => Promise<Readonly<{
  sourceFileName: string;
  bytes: Uint8Array;
}> | null>;

function imageFile(name = 'stamp.png'): File {
  const png = new PNG({ width: 160, height: 80 });
  png.data.fill(220);
  return new File([Uint8Array.from(PNG.sync.write(png))], name, { type: 'image/png' });
}

function jpegFile(): File {
  return new File([Uint8Array.from(jpegBytes())], 'stamp.jpg', {
    type: 'image/jpeg',
  });
}

function jpegBytes(width = 160, height = 80): Uint8Array {
  return Uint8Array.of(
    0xff, 0xd8,
    0xff, 0xc0, 0x00, 0x11, 0x08,
    (height >>> 8) & 0xff, height & 0xff,
    (width >>> 8) & 0xff, width & 0xff,
    0x03,
    0x01, 0x11, 0x00,
    0x02, 0x11, 0x00,
    0x03, 0x11, 0x00,
    0xff, 0xd9,
  );
}

function overLimitPngFile(): File {
  const bytes = Uint8Array.from(PNG.sync.write(new PNG({ width: 1, height: 1 })));
  const header = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  header.setUint32(16, 4_000, false);
  header.setUint32(20, 4_000, false);
  return new File([bytes], 'large.png', { type: 'image/png' });
}

function overLimitJpegFile(): File {
  return new File([Uint8Array.from(jpegBytes(4_000, 4_000))], 'large.jpg', { type: 'image/jpeg' });
}

async function insertImage(
  controller: EditorController,
  file: File,
  center = { x: 306, y: 396 },
): Promise<void> {
  const operation = Reflect.get(controller, 'insertImage');
  expect(operation).toBeTypeOf('function');
  const snapshot = controller.getSnapshot();
  await (operation as ImageInsert).call(controller, file, {
    generation: snapshot.generation,
    pageIndex: snapshot.pageIndex,
    center,
  });
}

function downloadCurrent(controller: EditorController): Promise<{
  sourceFileName: string;
  bytes: Uint8Array;
} | null> {
  const operation = Reflect.get(controller, 'downloadCurrent');
  expect(operation).toBeTypeOf('function');
  return (operation as CurrentDownload).call(controller);
}

function memoryFileHandle(name: string): Readonly<{
  handle: WritablePdfHandle;
  written: Uint8Array[];
}> {
  const written: Uint8Array[] = [];
  const handle = {
    name,
    getFile: vi.fn(),
    requestPermission: vi.fn().mockResolvedValue('granted'),
    createWritable: vi.fn().mockImplementation(async () => {
      let pending = new Uint8Array();
      return {
        write: vi.fn().mockImplementation(async (bytes: ArrayBuffer) => {
          pending = new Uint8Array(bytes.slice(0));
        }),
        close: vi.fn().mockImplementation(async () => {
          written.push(pending.slice());
        }),
        abort: vi.fn().mockResolvedValue(undefined),
      };
    }),
  };
  return { handle: handle as unknown as WritablePdfHandle, written };
}

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe('EditorController', () => {
  it('tracks a live span replacement draft as unsaved without changing validated bytes', async () => {
    const h = createControllerHarness({ analyses: [analysisFixture()] });
    const source = memoryFileHandle('report.pdf');
    await h.controller.open(pdfFile('report.pdf', Uint8Array.of(1)), source.handle);

    expect(h.controller.getSnapshot().hasUnsavedChanges).toBe(false);
    h.controller.selectSpan('span-1');
    h.controller.setReplacement('Unapplied draft');

    expect(h.controller.getSnapshot()).toMatchObject({
      replacement: 'Unapplied draft',
      hasUnsavedChanges: true,
    });
    await h.controller.save();

    expect(source.written).toEqual([Uint8Array.of(1)]);
    expect(h.controller.getSnapshot().hasUnsavedChanges).toBe(true);
    expect(h.engines[0]!.applyRevisions).toEqual([]);
  });

  it('does not silently turn Save into a download when the opened file has no write handle', async () => {
    const h = createControllerHarness({ analyses: [analysisFixture()] });
    await h.controller.open(pdfFile('report.pdf', Uint8Array.of(1)));
    h.controller.selectSpan('span-1');
    h.controller.setReplacement('Unapplied draft');

    await h.controller.save();

    expect(h.controller.getSnapshot()).toMatchObject({
      hasUnsavedChanges: true,
      hasWritableFileHandle: false,
      status: expect.stringContaining('cannot overwrite'),
    });
    expect(h.engines[0]!.applyRevisions).toEqual([]);
  });

  it('warns for a still-live replacement draft and clears it when selection is discarded', async () => {
    const h = createControllerHarness({ analyses: [analysisFixture()] });
    await h.controller.open(pdfFile('report.pdf', Uint8Array.of(1)));
    h.controller.selectSpan('span-1');
    h.controller.setReplacement('Live draft');

    expect(h.controller.getSnapshot()).toMatchObject({
      replacement: 'Live draft',
      hasUnsavedChanges: true,
    });
    h.controller.clearSelection();
    expect(h.controller.getSnapshot()).toMatchObject({
      selection: null,
      replacement: '',
      hasUnsavedChanges: false,
    });
  });

  it('tracks rich-text drafts and does not apply them during Save', async () => {
    const h = createControllerHarness({ analyses: [textLineAnalysisFixture('ABC')] });
    const source = memoryFileHandle('report.pdf');
    await h.controller.open(pdfFile('report.pdf', Uint8Array.of(1)), source.handle);
    h.controller.selectTextRange('line-1', 0, 2, 'group-1');
    h.controller.replaceRichText({ start: 1, end: 2 }, 'X');

    expect(h.controller.getSnapshot()).toMatchObject({
      replacement: 'AXC',
      hasUnsavedChanges: true,
    });
    await h.controller.save();

    expect(source.written).toEqual([Uint8Array.of(1)]);
    expect(h.controller.getSnapshot()).toMatchObject({
      hasUnsavedChanges: true,
      replacement: 'AXC',
      phase: 'ready',
    });
    expect(h.engines[0]!.richApplyInputs).toHaveLength(0);
  });

  it('prepares a download-only copy from the opened bytes without marking a live draft saved', async () => {
    const h = createControllerHarness({ analyses: [analysisFixture()] });
    await h.controller.open(pdfFile('report.pdf', Uint8Array.of(1)));
    h.controller.selectSpan('span-1');
    h.controller.setReplacement('Unapplied draft');

    await expect(h.controller.downloadCurrentDocument()).resolves.toEqual({
      sourceFileName: 'report.pdf',
      bytes: Uint8Array.of(1),
    });
    expect(h.controller.getSnapshot().hasUnsavedChanges).toBe(true);
  });

  it('checkpoints image geometry on Save and marks later movement dirty', async () => {
    const h = createControllerHarness({
      analyses: [analysisFixture()],
      imageExportResults: [
        { revision: 0, bytes: Uint8Array.of(9, 8, 7) },
        { revision: 0, bytes: Uint8Array.of(6, 5, 4) },
      ],
    });
    const source = memoryFileHandle('report.pdf');
    vi.stubGlobal('createImageBitmap', vi.fn().mockResolvedValue({
      width: 160,
      height: 80,
      close: vi.fn(),
    }));
    vi.spyOn(URL, 'createObjectURL').mockReturnValue('blob:save-image');
    await h.controller.open(pdfFile('report.pdf', Uint8Array.of(1)), source.handle);
    await insertImage(h.controller, imageFile());
    const imageId = h.controller.getSnapshot().images[0]!.id;
    expect(h.controller.getSnapshot().hasUnsavedChanges).toBe(true);

    await h.controller.save();
    expect(h.controller.getSnapshot().hasUnsavedChanges).toBe(false);
    h.controller.setImageBounds(imageId, { x: 100, y: 110, width: 160, height: 80 });
    expect(h.controller.getSnapshot().hasUnsavedChanges).toBe(true);
    await h.controller.save();

    expect(source.written).toEqual([Uint8Array.of(9, 8, 7), Uint8Array.of(6, 5, 4)]);
    expect(h.controller.getSnapshot().hasUnsavedChanges).toBe(false);
  });

  it('saves validated bytes and retargets future Save writes only after Save as succeeds', async () => {
    const h = createControllerHarness({
      analyses: [
        analysisFixture(),
        analysisFixture('First edit'),
        analysisFixture('Second edit'),
        analysisFixture('Third edit'),
      ],
      applyResults: [
        validatedResult(1, Uint8Array.of(2)),
        validatedResult(2, Uint8Array.of(3)),
        validatedResult(3, Uint8Array.of(4)),
      ],
    });
    const original = memoryFileHandle('original.pdf');
    const copy = memoryFileHandle('copy.pdf');
    await h.controller.open(pdfFile('original.pdf', Uint8Array.of(1)), original.handle);
    await prepareReplacement(h.controller, 'First edit');
    await h.controller.applySelection();
    await h.controller.save();

    await prepareReplacement(h.controller, 'Second edit');
    await h.controller.applySelection();
    await h.controller.saveAs(copy.handle);
    expect(h.controller.getSnapshot()).toMatchObject({
      fileName: 'copy.pdf',
      hasUnsavedChanges: false,
    });

    await prepareReplacement(h.controller, 'Third edit');
    await h.controller.applySelection();
    await h.controller.save();

    expect(original.written).toEqual([Uint8Array.of(2)]);
    expect(copy.written).toEqual([Uint8Array.of(3), Uint8Array.of(4)]);
    expect(h.controller.getSnapshot().hasUnsavedChanges).toBe(false);
  });

  it('keeps edits dirty when another validated edit lands during a save', async () => {
    const started = deferred<void>();
    const close = deferred<void>();
    const written: Uint8Array[] = [];
    let pending = new Uint8Array();
    const source = {
      name: 'report.pdf',
      getFile: vi.fn(),
      requestPermission: vi.fn().mockResolvedValue('granted'),
      createWritable: vi.fn().mockResolvedValue({
        write: vi.fn().mockImplementation(async (bytes: ArrayBuffer) => {
          pending = new Uint8Array(bytes.slice(0));
          started.resolve();
        }),
        close: vi.fn().mockImplementation(async () => {
          await close.promise;
          written.push(pending.slice());
        }),
        abort: vi.fn(),
      }),
    } as unknown as WritablePdfHandle;
    const h = createControllerHarness({
      analyses: [analysisFixture(), analysisFixture('First edit'), analysisFixture('Second edit')],
      applyResults: [
        validatedResult(1, Uint8Array.of(2)),
        validatedResult(2, Uint8Array.of(3)),
      ],
    });
    await h.controller.open(pdfFile('report.pdf', Uint8Array.of(1)), source);
    await prepareReplacement(h.controller, 'First edit');
    await h.controller.applySelection();

    const saving = h.controller.save();
    await started.promise;
    await prepareReplacement(h.controller, 'Second edit');
    await h.controller.applySelection();
    close.resolve();
    await saving;

    expect(written).toEqual([Uint8Array.of(2)]);
    expect(h.controller.getSnapshot()).toMatchObject({
      hasUnsavedChanges: true,
      downloadAvailable: true,
    });
  });

  it('waits for an active Save to commit before resetting the editor baseline', async () => {
    const started = deferred<void>();
    const close = deferred<void>();
    const written: Uint8Array[] = [];
    let pending = new Uint8Array();
    const source = {
      name: 'report.pdf',
      getFile: vi.fn(),
      requestPermission: vi.fn().mockResolvedValue('granted'),
      createWritable: vi.fn().mockImplementation(async () => ({
        write: vi.fn().mockImplementation(async (bytes: ArrayBuffer) => {
          pending = new Uint8Array(bytes.slice(0));
          started.resolve();
        }),
        close: vi.fn().mockImplementation(async () => {
          await close.promise;
          written.push(pending.slice());
        }),
        abort: vi.fn(),
      })),
    } as unknown as WritablePdfHandle;
    const h = createControllerHarness({
      analyses: [analysisFixture(), analysisFixture('Edited'), analysisFixture()],
      applyResults: [validatedResult(1, Uint8Array.of(2))],
    });
    await h.controller.open(pdfFile('report.pdf', Uint8Array.of(1)), source);
    await prepareReplacement(h.controller, 'Edited');
    await h.controller.applySelection();

    const saving = h.controller.save();
    await started.promise;
    const generationBeforeReset = h.controller.getSnapshot().generation;
    const resetting = h.controller.reset();
    expect(h.controller.getSnapshot().generation).toBe(generationBeforeReset);
    expect(h.controller.getSnapshot().phase).toBe('ready');

    close.resolve();
    await Promise.all([saving, resetting]);

    expect(written).toEqual([Uint8Array.of(2)]);
    expect(h.engines[1]!.openInputs[0]).toEqual(Uint8Array.of(1));
    expect(h.controller.getSnapshot()).toMatchObject({
      phase: 'ready',
      hasEdits: false,
      hasUnsavedChanges: true,
    });
    await h.controller.save();
    expect(written).toEqual([Uint8Array.of(2), Uint8Array.of(1)]);
    expect(h.controller.getSnapshot().hasUnsavedChanges).toBe(false);
  });

  it('saves reset-to-original bytes relative to the last confirmed save', async () => {
    const h = createControllerHarness({
      analyses: [analysisFixture(), analysisFixture('Edited'), analysisFixture()],
      applyResults: [validatedResult(1, Uint8Array.of(2))],
    });
    const source = memoryFileHandle('report.pdf');
    await h.controller.open(pdfFile('report.pdf', Uint8Array.of(1)), source.handle);
    await prepareReplacement(h.controller, 'Edited');
    await h.controller.applySelection();
    await h.controller.save();

    await h.controller.reset();

    expect(h.controller.getSnapshot()).toMatchObject({
      hasEdits: false,
      hasUnsavedChanges: true,
    });
    await h.controller.save();

    expect(source.written).toEqual([Uint8Array.of(2), Uint8Array.of(1)]);
    expect(h.controller.getSnapshot().hasUnsavedChanges).toBe(false);
  });

  it('retains the current file and dirty state after an overwrite fails', async () => {
    const h = createControllerHarness({
      analyses: [analysisFixture(), analysisFixture('Edited')],
      applyResults: [validatedResult(1, Uint8Array.of(2))],
    });
    const source = memoryFileHandle('report.pdf');
    const failingTarget = {
      name: 'copy.pdf',
      getFile: vi.fn(),
      createWritable: vi.fn().mockRejectedValue(new Error('private path detail')),
    } as unknown as WritablePdfHandle;
    await h.controller.open(pdfFile('report.pdf', Uint8Array.of(1)), source.handle);
    await prepareReplacement(h.controller, 'Edited');
    await h.controller.applySelection();

    await h.controller.saveAs(failingTarget);

    expect(h.controller.getSnapshot()).toMatchObject({
      fileName: 'report.pdf',
      hasUnsavedChanges: true,
      status: expect.not.stringContaining('private path detail'),
    });
    await h.controller.save();
    expect(source.written).toEqual([Uint8Array.of(2)]);
    expect(h.controller.getSnapshot().fileName).toBe('report.pdf');
  });

  it('inserts an owned, intrinsically sized image and exports image-only edits repeatedly', async () => {
    const h = createControllerHarness({
      analyses: [analysisFixture()],
      imageExportResults: [
        { revision: 0, bytes: Uint8Array.of(9, 8, 7) },
        { revision: 0, bytes: Uint8Array.of(9, 8, 7) },
      ],
    });
    const close = vi.fn();
    vi.stubGlobal('createImageBitmap', vi.fn().mockResolvedValue({
      width: 160,
      height: 80,
      close,
    }));
    vi.spyOn(URL, 'createObjectURL').mockReturnValue('blob:stamp-preview');
    const source = imageFile();

    await h.controller.open(pdfFile('report.pdf', Uint8Array.of(1, 2, 3)));
    h.controller.setZoom(2);
    await insertImage(h.controller, source);

    expect(h.controller.getSnapshot()).toMatchObject({
      hasEdits: true,
      downloadAvailable: true,
      selectedImageId: expect.any(String),
      images: [{
        pageIndex: 0,
        bounds: { x: 226, y: 356, width: 160, height: 80 },
        format: 'png',
        previewUrl: 'blob:stamp-preview',
      }],
    });
    expect(close).toHaveBeenCalledTimes(1);

    const first = await downloadCurrent(h.controller);
    const second = await downloadCurrent(h.controller);

    expect(first).toEqual({ sourceFileName: 'report.pdf', bytes: Uint8Array.of(9, 8, 7) });
    expect(second).toEqual(first);
    expect(h.engines[0]!.positionedImageInputs).toHaveLength(2);
    expect(h.engines[0]!.positionedImageInputs[0]).toEqual([{
      pageIndex: 0,
      bounds: { x: 226, y: 356, width: 160, height: 80 },
      format: 'png',
      bytes: new Uint8Array(await source.arrayBuffer()),
    }]);
    expect(h.engines[0]!.revision).toBe(0);
  });

  it('retains decoded intrinsic dimensions when releasing the ImageBitmap', async () => {
    let width = 160;
    let height = 80;
    vi.stubGlobal('createImageBitmap', vi.fn().mockResolvedValue({
      get width() { return width; },
      get height() { return height; },
      close() {
        width = 0;
        height = 0;
      },
    }));
    const h = createControllerHarness({ analyses: [analysisFixture()] });

    await h.controller.open(pdfFile('report.pdf', Uint8Array.of(1)));
    await insertImage(h.controller, imageFile());

    expect(h.controller.getSnapshot().images[0]?.bounds).toEqual({
      x: 226,
      y: 356,
      width: 160,
      height: 80,
    });
  });

  it('blocks untagged image insertion in tagged documents with an actionable message', async () => {
    const h = createControllerHarness({
      analyses: [analysisFixture()],
      openResults: [{
        documentId: 'fake-document',
        fingerprint: 'fake',
        revision: 0,
        fonts: [],
        imageInsertionAllowed: false,
      }],
    });
    const decode = vi.fn();
    vi.stubGlobal('createImageBitmap', decode);

    await h.controller.open(pdfFile('tagged.pdf', Uint8Array.of(1)));
    await insertImage(h.controller, imageFile());

    expect(h.controller.getSnapshot().imageError)
      .toContain('tagged or PDF/UA');
    expect(decode).not.toHaveBeenCalled();
    expect(h.controller.getSnapshot().images).toEqual([]);
  });

  it('recognises JPEG image bytes for the local preview and export payload', async () => {
    const h = createControllerHarness({ analyses: [analysisFixture()] });
    vi.stubGlobal('createImageBitmap', vi.fn().mockResolvedValue({
      width: 160,
      height: 80,
      close: vi.fn(),
    }));

    await h.controller.open(pdfFile('report.pdf', Uint8Array.of(1)));
    await insertImage(h.controller, jpegFile());

    expect(h.controller.getSnapshot().images[0]).toMatchObject({
      format: 'jpeg',
      bounds: { width: 160, height: 80 },
    });
  });

  it.each([
    ['PNG', overLimitPngFile],
    ['JPEG', overLimitJpegFile],
  ] as const)('rejects an over-limit %s from its header before decoding', async (_format, file) => {
    const h = createControllerHarness({ analyses: [analysisFixture()] });
    const decode = vi.fn();
    vi.stubGlobal('createImageBitmap', decode);

    await h.controller.open(pdfFile('report.pdf', Uint8Array.of(1)));
    await insertImage(h.controller, file());

    expect(h.controller.getSnapshot()).toMatchObject({
      images: [],
      imageError: expect.stringContaining('12-megapixel'),
    });
    expect(decode).not.toHaveBeenCalled();
  });

  it('keeps placements across page navigation and releases them on reset', async () => {
    const h = createControllerHarness({
      analyses: [analysisFixture(), analysisFixture('Page two'), analysisFixture()],
      pageCount: 2,
      imageExportResults: [{ revision: 0, bytes: Uint8Array.of(2) }],
    });
    vi.stubGlobal('createImageBitmap', vi.fn().mockResolvedValue({
      width: 160,
      height: 80,
      close: vi.fn(),
    }));
    vi.spyOn(URL, 'createObjectURL').mockReturnValue('blob:stamp-preview');
    const revoke = vi.spyOn(URL, 'revokeObjectURL').mockImplementation(() => undefined);

    await h.controller.open(pdfFile('report.pdf', Uint8Array.of(1)));
    await insertImage(h.controller, imageFile());
    const imageId = h.controller.getSnapshot().selectedImageId;
    await h.controller.setPage(1);

    expect(h.controller.getSnapshot()).toMatchObject({
      pageIndex: 1,
      selectedImageId: null,
      images: [{ id: imageId, pageIndex: 0 }],
      downloadAvailable: true,
    });
    h.controller.clearSelection();
    expect(h.controller.getSnapshot()).toMatchObject({
      selectedImageId: null,
      images: [{ id: imageId }],
      downloadAvailable: true,
    });
    await h.controller.setPage(0);
    await downloadCurrent(h.controller);
    expect(h.engines[0]!.positionedImageInputs[0]![0]!.pageIndex).toBe(0);

    await h.controller.reset();

    expect(h.controller.getSnapshot()).toMatchObject({
      pageIndex: 0,
      images: [],
      selectedImageId: null,
      hasEdits: false,
      downloadAvailable: false,
    });
    expect(revoke).toHaveBeenCalledWith('blob:stamp-preview');
    expect(() => h.controller.download()).toThrow(/validated edit/);
  });

  it('releases preview URLs when opening another document and when disposing', async () => {
    const h = createControllerHarness({
      analyses: [analysisFixture('First'), analysisFixture('Second')],
    });
    vi.stubGlobal('createImageBitmap', vi.fn().mockResolvedValue({
      width: 160,
      height: 80,
      close: vi.fn(),
    }));
    const create = vi.spyOn(URL, 'createObjectURL')
      .mockReturnValueOnce('blob:first-image')
      .mockReturnValueOnce('blob:second-image');
    const revoke = vi.spyOn(URL, 'revokeObjectURL').mockImplementation(() => undefined);

    await h.controller.open(pdfFile('first.pdf', Uint8Array.of(1)));
    await insertImage(h.controller, imageFile());
    await h.controller.open(pdfFile('second.pdf', Uint8Array.of(2)));

    expect(revoke).toHaveBeenCalledWith('blob:first-image');
    expect(h.controller.getSnapshot()).toMatchObject({
      fileName: 'second.pdf',
      images: [],
      selectedImageId: null,
      downloadAvailable: false,
    });
    await insertImage(h.controller, imageFile('second.png'));
    await h.controller.close();

    expect(create).toHaveBeenCalledTimes(2);
    expect(revoke).toHaveBeenCalledWith('blob:second-image');
    expect(h.controller.getSnapshot()).toMatchObject({
      fileName: null,
      images: [],
      selectedImageId: null,
    });
  });

  it.each(['page navigation', 'document replacement'] as const)(
    'ignores a decode that resolves after %s',
    async (change) => {
      const decoding = deferred<ImageBitmap>();
      const h = createControllerHarness({
        analyses: [analysisFixture('Page one'), analysisFixture('Page two'), analysisFixture('New document')],
        pageCount: 2,
      });
      const close = vi.fn();
      const decode = vi.fn(() => decoding.promise);
      vi.stubGlobal('createImageBitmap', decode);
      const create = vi.spyOn(URL, 'createObjectURL');

      await h.controller.open(pdfFile('first.pdf', Uint8Array.of(1)));
      const insertion = insertImage(h.controller, imageFile());
      await vi.waitFor(() => expect(decode).toHaveBeenCalledTimes(1));
      if (change === 'page navigation') {
        await h.controller.setPage(1);
      } else {
        await h.controller.open(pdfFile('second.pdf', Uint8Array.of(2)));
      }
      decoding.resolve({ width: 160, height: 80, close } as ImageBitmap);
      await insertion;

      expect(close).toHaveBeenCalledTimes(1);
      expect(create).not.toHaveBeenCalled();
      expect(h.controller.getSnapshot().images).toEqual([]);
    },
  );

  it('retains the validated text-only download path when there are no images', async () => {
    const h = createControllerHarness({
      analyses: [analysisFixture(), analysisFixture('Edited')],
      applyResults: [validatedResult(1, Uint8Array.of(4, 5, 6))],
    });
    await h.controller.open(pdfFile('report.pdf', Uint8Array.of(1)));
    await prepareReplacement(h.controller, 'Edited');
    await h.controller.applySelection();

    const asset = await downloadCurrent(h.controller);

    expect(asset).toEqual({ sourceFileName: 'report.pdf', bytes: Uint8Array.of(4, 5, 6) });
    expect(h.engines[0]!.positionedImageInputs).toHaveLength(0);
    expect(h.controller.download()).toEqual(asset);
  });

  it('does not download an image export after its captured placements become stale', async () => {
    const pending = deferred<{ revision: number; bytes: Uint8Array }>();
    const h = createControllerHarness({
      analyses: [analysisFixture()],
      imageExportResults: [pending.promise],
    });
    vi.stubGlobal('createImageBitmap', vi.fn().mockResolvedValue({
      width: 160,
      height: 80,
      close: vi.fn(),
    }));
    await h.controller.open(pdfFile('report.pdf', Uint8Array.of(1)));
    await insertImage(h.controller, imageFile());
    const imageId = h.controller.getSnapshot().selectedImageId!;

    const exporting = downloadCurrent(h.controller);
    expect(h.controller.getSnapshot().isDownloading).toBe(true);
    h.controller.setImageBounds(imageId, { x: 200, y: 200, width: 120, height: 60 });
    pending.resolve({ revision: 0, bytes: Uint8Array.of(7, 7, 7) });

    await expect(exporting).resolves.toBeNull();
    expect(h.controller.getSnapshot().isDownloading).toBe(false);
  });

  it('allows retry after positioned-image export fails', async () => {
    const h = createControllerHarness({
      analyses: [analysisFixture()],
      imageExportResults: [
        new Error('engine export failed'),
        { revision: 0, bytes: Uint8Array.of(6, 5, 4) },
      ],
    });
    vi.stubGlobal('createImageBitmap', vi.fn().mockResolvedValue({
      width: 160,
      height: 80,
      close: vi.fn(),
    }));
    await h.controller.open(pdfFile('report.pdf', Uint8Array.of(1)));
    await insertImage(h.controller, imageFile());

    await expect(downloadCurrent(h.controller)).resolves.toBeNull();
    expect(h.controller.getSnapshot()).toMatchObject({
      isDownloading: false,
      imageError: expect.stringContaining('try again'),
      downloadAvailable: true,
    });
    await expect(downloadCurrent(h.controller)).resolves.toEqual({
      sourceFileName: 'report.pdf',
      bytes: Uint8Array.of(6, 5, 4),
    });
  });

  it('rejects corrupt images with a visible error before creating a preview', async () => {
    const h = createControllerHarness({ analyses: [analysisFixture()] });
    const decode = vi.fn();
    vi.stubGlobal('createImageBitmap', decode);
    const create = vi.spyOn(URL, 'createObjectURL');

    await h.controller.open(pdfFile('report.pdf', Uint8Array.of(1)));
    await insertImage(h.controller, new File([Uint8Array.of(1, 2, 3)], 'broken.png', {
      type: 'image/png',
    }));

    expect(h.controller.getSnapshot()).toMatchObject({
      images: [],
      downloadAvailable: false,
      imageError: expect.stringContaining('readable PNG or JPEG'),
    });
    expect(decode).not.toHaveBeenCalled();
    expect(create).not.toHaveBeenCalled();
  });

  it('opens independent engine/display copies and analyses page zero', async () => {
    const h = createControllerHarness({ analyses: [analysisFixture()] });
    const source = Uint8Array.of(1, 2, 3);

    await h.controller.open(pdfFile('report.pdf', source));

    expect(h.engines[0]!.openInputs[0]).toEqual(source);
    expect(h.displayInputs[0]).toEqual(source);
    expect(h.engines[0]!.openInputs[0]!.buffer).not.toBe(h.displayInputs[0]!.buffer);
    expect(h.engines[0]!.analyseCalls).toEqual([0]);
    expect(h.controller.getSnapshot()).toMatchObject({
      phase: 'ready',
      pageIndex: 0,
      pageCount: 1,
      downloadAvailable: false,
    });
  });

  it('makes page zero usable while document font inspection is pending', async () => {
    const inventory = deferred<readonly DocumentEditingFont[]>();
    const h = createControllerHarness({
      analyses: [analysisFixture()],
      fontInventoryResults: [inventory.promise],
    });

    await h.controller.open(pdfFile('report.pdf', Uint8Array.of(1)));

    expect(h.controller.getSnapshot()).toMatchObject({
      phase: 'ready',
      fontInventoryState: 'scanning',
      editingFonts: [],
    });
    expect(h.engines[0]!.fontInventoryCalls).toBe(1);

    inventory.resolve([{ name: 'DejaVuSans', reason: 'not-embedded' }]);
    await vi.waitFor(() => expect(h.controller.getSnapshot()).toMatchObject({
      fontInventoryState: 'ready',
      editingFonts: [{ name: 'DejaVuSans', reason: 'not-embedded' }],
    }));
  });

  it('contains font inspection failure without disabling the document', async () => {
    const h = createControllerHarness({
      analyses: [analysisFixture()],
      fontInventoryResults: [new Error('private parser detail')],
    });
    await h.controller.open(pdfFile('report.pdf', Uint8Array.of(1)));
    await vi.waitFor(() => expect(h.controller.getSnapshot().fontInventoryState).toBe('failed'));

    expect(h.controller.getSnapshot()).toMatchObject({
      phase: 'ready',
      error: null,
      editingFonts: [],
    });
    expect(h.controller.getSnapshot().status).toBe('Ready');
  });

  it('ignores a font inventory result from an older document generation', async () => {
    const stale = deferred<readonly DocumentEditingFont[]>();
    const h = createControllerHarness({
      analyses: [analysisFixture('Document A'), analysisFixture('Document B')],
      fontInventoryResults: [
        stale.promise,
        [{ name: 'Current Font', reason: 'embedded-not-reusable' }],
      ],
    });
    await h.controller.open(pdfFile('a.pdf', Uint8Array.of(1)));
    await h.controller.open(pdfFile('b.pdf', Uint8Array.of(2)));
    await vi.waitFor(() => expect(h.controller.getSnapshot().editingFonts).toEqual([
      { name: 'Current Font', reason: 'embedded-not-reusable' },
    ]));

    stale.resolve([{ name: 'Stale Font', reason: 'standard-font' }]);
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
    expect(h.controller.getSnapshot().editingFonts).toEqual([{
      name: 'Current Font',
      reason: 'embedded-not-reusable',
    }]);
  });

  it('ignores a font inventory failure from an older document generation', async () => {
    const stale = deferred<readonly DocumentEditingFont[]>();
    const h = createControllerHarness({
      analyses: [analysisFixture('Document A'), analysisFixture('Document B')],
      fontInventoryResults: [
        stale.promise,
        [{ name: 'Current Font', reason: 'embedded-not-reusable' }],
      ],
    });
    await h.controller.open(pdfFile('a.pdf', Uint8Array.of(1)));
    await h.controller.open(pdfFile('b.pdf', Uint8Array.of(2)));
    await vi.waitFor(() => expect(h.controller.getSnapshot().editingFonts).toEqual([
      { name: 'Current Font', reason: 'embedded-not-reusable' },
    ]));

    stale.reject(new Error('stale private parser detail'));
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
    expect(h.controller.getSnapshot()).toMatchObject({
      phase: 'ready',
      error: null,
      status: 'Ready',
      editingFonts: [{ name: 'Current Font', reason: 'embedded-not-reusable' }],
    });
  });

  it('clears old inventory before waiting for the previous display to be destroyed', async () => {
    const destroy = deferred<void>();
    const destroySpy = vi.spyOn(FakeDisplayDocument.prototype, 'destroy')
      .mockImplementation(() => destroy.promise);
    const h = createControllerHarness({
      analyses: [analysisFixture('Document A'), analysisFixture('Document B')],
      fontInventoryResults: [
        [{ name: 'Old Font', reason: 'standard-font' }],
        [{ name: 'Current Font', reason: 'embedded-not-reusable' }],
      ],
    });

    try {
      await h.controller.open(pdfFile('a.pdf', Uint8Array.of(1)));
      await vi.waitFor(() => expect(h.controller.getSnapshot().editingFonts).toEqual([
        { name: 'Old Font', reason: 'standard-font' },
      ]));

      const opening = h.controller.open(pdfFile('b.pdf', Uint8Array.of(2)));
      try {
        expect(h.controller.getSnapshot()).toMatchObject({
          phase: 'opening',
          fileName: null,
          fontInventoryState: 'scanning',
          editingFonts: [],
        });
      } finally {
        destroy.resolve();
        await opening;
      }

      await vi.waitFor(() => expect(h.controller.getSnapshot().editingFonts).toEqual([
        { name: 'Current Font', reason: 'embedded-not-reusable' },
      ]));
    } finally {
      destroy.resolve();
      destroySpy.mockRestore();
    }
  });

  it('normalises a reverse source-backed text range from the analysed line', async () => {
    const h = createControllerHarness({ analyses: [textLineAnalysisFixture('ABC')] });
    await h.controller.open(pdfFile('report.pdf', Uint8Array.of(1)));

    h.controller.selectTextRange('line-1', 2, 0, null);

    expect(h.controller.getSnapshot()).toMatchObject({
      selection: {
        kind: 'text',
        groupKey: null,
        textSelection: {
          lineKey: 'line-1',
          glyphRange: { start: 0, end: 3 },
          text: 'ABC',
        },
      },
      replacement: 'ABC',
      status: 'Custom text selected',
    });
  });

  it('previews and atomically applies rich text with explicit substitution consent', async () => {
    const h = createControllerHarness({
      analyses: [textLineAnalysisFixture('ABC'), textLineAnalysisFixture('AXC')],
      applyResults: [validatedResult(1, Uint8Array.of(2))],
    });
    await h.controller.open(pdfFile('report.pdf', Uint8Array.of(1)));
    h.controller.selectTextRange('line-1', 0, 2, 'group-1');

    h.controller.replaceRichText({ start: 1, end: 2 }, 'X');
    await h.controller.previewSelection();

    const first = h.controller.getSnapshot().richEditor!;
    expect(first.runs.map(({ text }) => text).join('')).toBe('AXC');
    expect(first.preview).toMatchObject({
      fits: true,
      requiredSubstitutionConsents: ['font:bundled-example'],
    });
    expect(h.engines[0]!.richPreviewInputs[0]).toMatchObject({
      selection: { lineKey: 'line-1', anchorGlyphIndex: 0, focusGlyphIndex: 2 },
      runs: [{
        text: 'AXC',
        fontId: 'font:bundled-example',
        sourceRunIndex: 0,
      }],
    });

    h.controller.setRichSubstitutionConsent('font:bundled-example', true);
    await h.controller.previewSelection();
    await h.controller.applySelection();

    expect(h.engines[0]!.richApplyInputs).toHaveLength(1);
    expect(h.controller.getSnapshot()).toMatchObject({
      phase: 'ready',
      hasEdits: true,
      downloadAvailable: true,
      status: 'Replacement applied',
    });
  });

  it('returns to ready and ignores a stale rich-preview success after text changes', async () => {
    const pending = deferred<ReturnType<typeof richPreviewResult>>();
    const h = createControllerHarness({
      analyses: [textLineAnalysisFixture('ABC')],
      richPreviewResults: [pending.promise],
    });
    await h.controller.open(pdfFile('report.pdf', Uint8Array.of(1)));
    h.controller.selectTextRange('line-1', 0, 2, 'group-1');

    const request = h.controller.previewSelection();
    expect(h.controller.getSnapshot().phase).toBe('previewing');
    h.controller.replaceRichText({ start: 1, end: 2 }, 'X');
    expect(h.controller.getSnapshot()).toMatchObject({
      phase: 'ready',
      replacement: 'AXC',
      richEditor: { preview: null },
    });

    pending.resolve(richPreviewResult('ABC'));
    await request;
    expect(h.controller.getSnapshot()).toMatchObject({
      phase: 'ready',
      replacement: 'AXC',
      richEditor: { preview: null },
    });
  });

  it('clears a selection during a pending preview without changing validated download bytes', async () => {
    const pending = deferred<ReturnType<typeof richPreviewResult>>();
    const h = createControllerHarness({
      analyses: [analysisFixture(), textLineAnalysisFixture('ABC')],
      applyResults: [validatedResult(1, Uint8Array.of(9, 8, 7))],
      richPreviewResults: [pending.promise],
    });
    await h.controller.open(pdfFile('report.pdf', Uint8Array.of(1)));
    await prepareReplacement(h.controller, 'Applied');
    await h.controller.applySelection();
    const validatedBytes = h.controller.download().bytes;

    h.controller.selectTextRange('line-1', 0, 2, 'group-1');
    h.controller.replaceRichText({ start: 1, end: 2 }, 'X');
    const request = h.controller.previewSelection();
    expect(h.controller.getSnapshot().phase).toBe('previewing');

    h.controller.clearSelection();
    expect(h.controller.getSnapshot()).toMatchObject({
      phase: 'ready',
      selection: null,
      replacement: '',
      preview: null,
      richEditor: null,
      hasEdits: true,
      downloadAvailable: true,
    });

    pending.resolve(richPreviewResult('AXC'));
    await request;

    expect(h.controller.getSnapshot()).toMatchObject({
      phase: 'ready',
      selection: null,
      replacement: '',
      preview: null,
      richEditor: null,
      hasEdits: true,
      downloadAvailable: true,
    });
    expect(h.controller.download().bytes).toEqual(validatedBytes);
    expect(h.controller.download().bytes).toEqual(Uint8Array.of(9, 8, 7));
    expect(h.engines[0]!.richApplyInputs).toHaveLength(0);
  });

  it('keeps an in-flight Apply selection until its validated result is committed', async () => {
    const pending = deferred<ReturnType<typeof validatedResult>>();
    const h = createControllerHarness({
      analyses: [textLineAnalysisFixture('ABC'), textLineAnalysisFixture('ABC')],
      applyResults: [pending.promise],
    });
    await h.controller.open(pdfFile('report.pdf', Uint8Array.of(1)));
    h.controller.selectTextRange('line-1', 0, 2, 'group-1');
    h.controller.setRichSubstitutionConsent('font:bundled-example', true);
    await h.controller.previewSelection();

    const applying = h.controller.applySelection();
    expect(h.controller.getSnapshot().phase).toBe('applying');
    h.controller.clearSelection();
    expect(h.controller.getSnapshot()).toMatchObject({
      phase: 'applying',
      selection: { kind: 'text' },
      downloadAvailable: false,
    });

    pending.resolve(validatedResult(1, Uint8Array.of(4, 5, 6)));
    await applying;

    expect(h.controller.getSnapshot()).toMatchObject({
      phase: 'ready',
      selection: null,
      hasEdits: true,
      downloadAvailable: true,
    });
    expect(h.controller.download().bytes).toEqual(Uint8Array.of(4, 5, 6));
  });

  it('keeps a text selection intact when image decoding finishes during Apply', async () => {
    const pendingApply = deferred<ReturnType<typeof validatedResult>>();
    const pendingDecode = deferred<ImageBitmap>();
    const h = createControllerHarness({
      analyses: [analysisFixture(), analysisFixture('Applied')],
      applyResults: [pendingApply.promise],
    });
    const close = vi.fn();
    vi.stubGlobal('createImageBitmap', vi.fn(() => pendingDecode.promise));
    vi.spyOn(URL, 'createObjectURL').mockReturnValue('blob:stamp-preview');

    await h.controller.open(pdfFile('report.pdf', Uint8Array.of(1)));
    await prepareReplacement(h.controller, 'Applied');
    const applying = h.controller.applySelection();
    const inserting = insertImage(h.controller, imageFile());
    await vi.waitFor(() => expect(createImageBitmap).toHaveBeenCalledTimes(1));

    pendingDecode.resolve({ width: 160, height: 80, close } as ImageBitmap);
    await vi.waitFor(() => expect(URL.createObjectURL).toHaveBeenCalledTimes(1));
    expect(h.controller.getSnapshot()).toMatchObject({
      phase: 'applying',
      selection: { kind: 'span' },
    });

    pendingApply.resolve(validatedResult(1, Uint8Array.of(4, 5, 6)));
    await Promise.all([applying, inserting]);

    expect(h.controller.getSnapshot()).toMatchObject({
      phase: 'ready',
      selection: null,
      hasEdits: true,
      downloadAvailable: true,
      selectedImageId: expect.any(String),
      images: [{ bounds: { width: 160, height: 80 } }],
    });
    expect(close).toHaveBeenCalledTimes(1);
  });

  it('keeps a rich-text selection intact when image decoding finishes during Apply', async () => {
    const pendingApply = deferred<ReturnType<typeof validatedResult>>();
    const pendingDecode = deferred<ImageBitmap>();
    const h = createControllerHarness({
      analyses: [textLineAnalysisFixture('ABC'), textLineAnalysisFixture('ABC')],
      applyResults: [pendingApply.promise],
    });
    vi.stubGlobal('createImageBitmap', vi.fn(() => pendingDecode.promise));
    vi.spyOn(URL, 'createObjectURL').mockReturnValue('blob:rich-apply-image');

    await h.controller.open(pdfFile('report.pdf', Uint8Array.of(1)));
    h.controller.selectTextRange('line-1', 0, 2, 'group-1');
    h.controller.setRichSubstitutionConsent('font:bundled-example', true);
    await h.controller.previewSelection();
    const applying = h.controller.applySelection();
    const activeSelection = h.controller.getSnapshot().selection;
    expect(activeSelection?.kind).toBe('text');
    const inserting = insertImage(h.controller, imageFile());
    h.controller.selectTextRange('line-1', 1, 2, null);
    h.controller.selectSpan('span-1');
    expect(h.controller.getSnapshot().selection).toBe(activeSelection);
    await vi.waitFor(() => expect(createImageBitmap).toHaveBeenCalledTimes(1));

    pendingDecode.resolve({ width: 160, height: 80, close: vi.fn() } as ImageBitmap);
    await vi.waitFor(() => expect(URL.createObjectURL).toHaveBeenCalledTimes(1));
    expect(h.controller.getSnapshot()).toMatchObject({
      phase: 'applying',
      selection: { kind: 'text' },
    });

    pendingApply.resolve(validatedResult(1, Uint8Array.of(6, 5, 4)));
    await Promise.all([applying, inserting]);

    expect(h.controller.getSnapshot()).toMatchObject({
      phase: 'ready',
      selection: null,
      selectedImageId: expect.any(String),
      images: [{ bounds: { width: 160, height: 80 } }],
      hasEdits: true,
      downloadAvailable: true,
    });
    expect(h.engines[0]!.richApplyInputs).toHaveLength(1);
  });

  it('ignores a stale replacement-preview rejection after clearing its selection', async () => {
    const h = createControllerHarness({ analyses: [analysisFixture()] });
    await h.controller.open(pdfFile('report.pdf', Uint8Array.of(1)));
    h.controller.selectSpan('span-1');
    const pending = deferred<ReplacementPreviewResult>();
    vi.spyOn(h.engines[0]!, 'previewReplacement').mockReturnValue(pending.promise);
    h.controller.setReplacement('Pending');

    const request = h.controller.previewSelection();
    expect(h.controller.getSnapshot().phase).toBe('previewing');
    h.controller.clearSelection();
    pending.reject(new Error('stale preview failure'));
    await request;

    expect(h.controller.getSnapshot()).toMatchObject({
      phase: 'ready',
      selection: null,
      replacement: '',
      preview: null,
      error: null,
      status: 'Ready',
    });
  });

  it('ignores a stale rich-preview rejection after text changes', async () => {
    const pending = deferred<ReturnType<typeof richPreviewResult>>();
    const h = createControllerHarness({
      analyses: [textLineAnalysisFixture('ABC')],
      richPreviewResults: [pending.promise],
    });
    await h.controller.open(pdfFile('report.pdf', Uint8Array.of(1)));
    h.controller.selectTextRange('line-1', 0, 2, 'group-1');

    const request = h.controller.previewSelection();
    h.controller.replaceRichText({ start: 1, end: 2 }, 'X');
    pending.reject(new Error('stale shaping failure'));
    await request;

    expect(h.controller.getSnapshot()).toMatchObject({
      phase: 'ready',
      replacement: 'AXC',
      error: null,
      richEditor: { preview: null },
    });
  });

  it('uses one waiting state when rich-preview inputs change', async () => {
    const h = createControllerHarness({ analyses: [textLineAnalysisFixture('ABC')] });
    await h.controller.open(pdfFile('report.pdf', Uint8Array.of(1)));
    h.controller.selectTextRange('line-1', 0, 2, 'group-1');

    h.controller.formatRichText({ start: 0, end: 1 }, { style: { fontSize: 13 } });
    expect(h.controller.getSnapshot()).toMatchObject({
      phase: 'ready',
      status: 'Waiting to shape the latest text…',
      richEditor: { preview: null },
    });

    h.controller.setRichAllowedWidth(90);
    expect(h.controller.getSnapshot().status).toBe('Waiting to shape the latest text…');
    h.controller.setRichSubstitutionConsent('font:bundled-example', true);
    expect(h.controller.getSnapshot().status).toBe('Waiting to shape the latest text…');
    await h.controller.registerFont('upload', 'face.ttf', Uint8Array.of(1, 2, 3));
    expect(h.controller.getSnapshot()).toMatchObject({
      phase: 'ready',
      status: 'Waiting to shape the latest text…',
      richEditor: { preview: null },
    });
  });

  it('registers then explicitly applies inspected font metadata to the captured range', async () => {
    const descriptor = applicationFont();
    const h = createControllerHarness({
      analyses: [textLineAnalysisFixture('ABC')],
      fontRegistrationResults: [descriptor],
    });
    await h.controller.open(pdfFile('report.pdf', Uint8Array.of(1)));
    h.controller.selectTextRange('line-1', 0, 2, 'group-1');
    const target = applicationTarget(h.controller, { start: 1, end: 2 });
    const bytes = Uint8Array.of(4, 5, 6);

    const result = await h.controller.registerAndApplyFont(
      'upload',
      'Selected.ttf',
      bytes,
      target,
    );
    bytes[0] = 9;

    expect(result).toEqual({ descriptor, outcome: 'applied' });
    expect(h.engines[0]!.fontRegistrations).toEqual([{
      source: 'upload',
      fileName: 'Selected.ttf',
      bytes: Uint8Array.of(4, 5, 6),
    }]);
    expect(h.controller.getSnapshot()).toMatchObject({
      phase: 'ready',
      status: 'Waiting to shape the latest text…',
      richEditor: {
        preview: null,
        runs: [
          { text: 'A', fontIntent: 'preserve-source' },
          {
            text: 'B',
            fontId: descriptor.id,
            fontIntent: 'explicit-choice',
            style: { fontWeight: 700, italicAngle: -10 },
          },
          { text: 'C', fontIntent: 'preserve-source' },
        ],
      },
    });
  });

  it('retains registration but skips application after the source selection changes', async () => {
    const descriptor = applicationFont();
    const pending = deferred<FontDescriptor>();
    const h = createControllerHarness({
      analyses: [textLineAnalysisFixture('ABC')],
      fontRegistrationResults: [pending.promise],
    });
    await h.controller.open(pdfFile('report.pdf', Uint8Array.of(1)));
    h.controller.selectTextRange('line-1', 0, 2, 'group-1');
    const target = applicationTarget(h.controller, { start: 0, end: 3 });

    const applying = h.controller.registerAndApplyFont(
      'upload',
      'Selected.ttf',
      Uint8Array.of(4, 5, 6),
      target,
    );
    h.controller.selectTextRange('line-1', 0, 0, null);
    pending.resolve(descriptor);

    await expect(applying).resolves.toEqual({ descriptor, outcome: 'stale-selection' });
    expect(h.controller.listSessionFonts()).toEqual([descriptor]);
    expect(h.controller.getSnapshot().richEditor?.runs).not.toContainEqual(
      expect.objectContaining({ fontIntent: 'explicit-choice' }),
    );
  });

  it('retains registration but skips application after the document generation changes', async () => {
    const descriptor = applicationFont();
    const pending = deferred<FontDescriptor>();
    const h = createControllerHarness({
      analyses: [textLineAnalysisFixture('ABC'), textLineAnalysisFixture('XYZ')],
      fontRegistrationResults: [pending.promise],
    });
    await h.controller.open(pdfFile('first.pdf', Uint8Array.of(1)));
    h.controller.selectTextRange('line-1', 0, 2, 'group-1');
    const target = applicationTarget(h.controller, { start: 0, end: 3 });

    const applying = h.controller.registerAndApplyFont(
      'local',
      'Selected.ttf',
      Uint8Array.of(4, 5, 6),
      target,
    );
    await h.controller.open(pdfFile('second.pdf', Uint8Array.of(2)));
    pending.resolve(descriptor);

    await expect(applying).resolves.toEqual({ descriptor, outcome: 'stale-selection' });
    expect(h.controller.getSnapshot()).toMatchObject({ fileName: 'second.pdf', selection: null });
    expect(h.controller.listSessionFonts()).toEqual([descriptor]);
  });

  it('registers but does not apply a face missing coverage for the captured text', async () => {
    const descriptor = applicationFont({ codePoints: Object.freeze([65, 67]) });
    const h = createControllerHarness({
      analyses: [textLineAnalysisFixture('ABC')],
      fontRegistrationResults: [descriptor],
    });
    await h.controller.open(pdfFile('report.pdf', Uint8Array.of(1)));
    h.controller.selectTextRange('line-1', 0, 2, 'group-1');

    const result = await h.controller.registerAndApplyFont(
      'upload',
      'Selected.ttf',
      Uint8Array.of(4, 5, 6),
      applicationTarget(h.controller, { start: 1, end: 2 }),
    );

    expect(result).toEqual({ descriptor, outcome: 'missing-coverage' });
    expect(h.controller.listSessionFonts()).toEqual([descriptor]);
    expect(h.controller.getSnapshot().richEditor?.runs).not.toContainEqual(
      expect.objectContaining({ fontIntent: 'explicit-choice' }),
    );
  });

  it('treats an invalid captured editor range as stale instead of formatting another range', async () => {
    const descriptor = applicationFont();
    const h = createControllerHarness({
      analyses: [textLineAnalysisFixture('ABC')],
      fontRegistrationResults: [descriptor],
    });
    await h.controller.open(pdfFile('report.pdf', Uint8Array.of(1)));
    h.controller.selectTextRange('line-1', 0, 2, 'group-1');

    const result = await h.controller.registerAndApplyFont(
      'upload',
      'Selected.ttf',
      Uint8Array.of(4, 5, 6),
      applicationTarget(h.controller, { start: 1, end: 20 }),
    );

    expect(result).toEqual({ descriptor, outcome: 'stale-selection' });
  });

  it('waits for authoritative engine acceptance before opening the display parser', async () => {
    const h = createControllerHarness({
      openResults: [new WorkerClientError({
        code: 'UNSUPPORTED_DOCUMENT',
        message: 'Untrusted worker detail',
      })],
    });

    await h.controller.open(pdfFile('encrypted.pdf', Uint8Array.of(1)));

    expect(h.displayInputs).toHaveLength(0);
    expect(h.controller.getSnapshot().error).toMatchObject({
      code: 'UNSUPPORTED_DOCUMENT',
      message: 'This release cannot open encrypted or unsupported PDFs.',
    });
  });

  it('invalidates preview whenever text or consent changes', async () => {
    const h = createControllerHarness({ analyses: [analysisFixture()] });
    await h.controller.open(pdfFile('report.pdf', Uint8Array.of(1)));
    await prepareReplacement(h.controller, 'Edited');
    expect(h.controller.getSnapshot().preview).not.toBeNull();

    h.controller.setReplacement('Changed');
    expect(h.controller.getSnapshot().preview).toBeNull();
    await h.controller.previewSelection();
    h.controller.setAcceptSubstitution(false);
    expect(h.controller.getSnapshot().preview).toBeNull();
  });

  it('commits two successively validated byte snapshots', async () => {
    const h = createControllerHarness({
      analyses: [
        analysisFixture(),
        analysisFixture('Edited 01'),
        analysisFixture('Edited 02'),
      ],
      applyResults: [
        validatedResult(1, Uint8Array.of(2)),
        validatedResult(2, Uint8Array.of(3)),
      ],
    });
    await h.controller.open(pdfFile('report.pdf', Uint8Array.of(1)));

    await prepareReplacement(h.controller, 'Edited 01');
    await h.controller.applySelection();
    await prepareReplacement(h.controller, 'Edited 02');
    await h.controller.applySelection();

    expect(h.engines).toHaveLength(1);
    expect(h.engines[0]!.applyRevisions).toEqual([0, 1]);
    expect(h.displayInputs.map((bytes) => [...bytes])).toEqual([[1], [2], [3]]);
    expect(h.controller.download()).toEqual({
      sourceFileName: 'report.pdf',
      bytes: Uint8Array.of(3),
    });
  });

  it('rebuilds from pre-Apply display bytes after validation rejection', async () => {
    const h = createControllerHarness({
      analyses: [analysisFixture(), analysisFixture()],
      applyResults: [new ValidationRejectedError(['forced-test-rejection'])],
    });
    await h.controller.open(pdfFile('report.pdf', Uint8Array.of(1)));
    await prepareReplacement(h.controller, 'Rejected');

    await h.controller.applySelection();

    expect(h.engines[0]!.terminated).toBe(true);
    expect(h.engines[1]!.openInputs[0]).toEqual(Uint8Array.of(1));
    expect(h.displayInputs.map((bytes) => [...bytes])).toEqual([[1], [1]]);
    expect(h.controller.getSnapshot()).toMatchObject({
      downloadAvailable: false,
      status: 'Replacement was not applied; the last validated document was restored.',
    });
  });

  it('names a candidate file-byte failure while restoring validated bytes', async () => {
    const h = createControllerHarness({
      analyses: [analysisFixture(), analysisFixture()],
      applyResults: [new WorkerClientError({
        code: 'RESOURCE_LIMIT',
        message: 'Untrusted candidate detail',
        details: {
          resource: 'fileBytes',
          limit: 15_728_640,
          observedBytes: 15_728_641,
        },
      })],
    });
    await h.controller.open(pdfFile('report.pdf', Uint8Array.of(1)));
    await prepareReplacement(h.controller, 'Too large');

    await h.controller.applySelection();

    expect(h.engines[1]!.openInputs[0]).toEqual(Uint8Array.of(1));
    expect(h.controller.getSnapshot()).toMatchObject({
      phase: 'ready',
      downloadAvailable: false,
      status: 'The edited PDF exceeds the 15 MiB file limit. The last validated document was restored.',
    });
  });

  it('resets edited bytes to the untouched original', async () => {
    const resetInventory = deferred<readonly DocumentEditingFont[]>();
    const h = createControllerHarness({
      analyses: [analysisFixture(), analysisFixture('Edited'), analysisFixture()],
      applyResults: [validatedResult(1, Uint8Array.of(2))],
      fontInventoryResults: [[], resetInventory.promise],
    });
    await h.controller.open(pdfFile('report.pdf', Uint8Array.of(1)));
    await prepareReplacement(h.controller, 'Edited');
    await h.controller.applySelection();

    await h.controller.reset();

    expect(h.engines[1]!.openInputs[0]).toEqual(Uint8Array.of(1));
    expect(h.engines[1]!.fontInventoryCalls).toBe(1);
    expect(h.controller.getSnapshot()).toMatchObject({
      phase: 'ready',
      fontInventoryState: 'scanning',
      editingFonts: [],
      hasEdits: false,
      downloadAvailable: false,
    });
    resetInventory.resolve([{ name: 'Reset Font', reason: 'not-embedded' }]);
    await vi.waitFor(() => expect(h.controller.getSnapshot()).toMatchObject({
      fontInventoryState: 'ready',
      editingFonts: [{ name: 'Reset Font', reason: 'not-embedded' }],
    }));
    expect(() => h.controller.download()).toThrow(/validated edit/);
  });

  it('keeps the original editing-font inventory static after registration', async () => {
    const original = Object.freeze({
      name: 'Original Face',
      reason: 'embedded-not-reusable' as const,
    });
    const h = createControllerHarness({
      analyses: [analysisFixture()],
      fontInventoryResults: [[original]],
    });
    await h.controller.open(pdfFile('report.pdf', Uint8Array.of(1)));
    await vi.waitFor(() => expect(h.controller.getSnapshot().editingFonts).toEqual([original]));

    await h.controller.registerFont('upload', 'different-face.ttf', Uint8Array.of(1, 2, 3));

    expect(h.engines[0]!.fontInventoryCalls).toBe(1);
    expect(h.controller.getSnapshot().editingFonts).toEqual([original]);
  });

  it('retains uploaded fonts across documents and reset, then clears them on close', async () => {
    const h = createControllerHarness({
      analyses: [analysisFixture(), analysisFixture(), analysisFixture()],
    });
    await h.controller.open(pdfFile('first.pdf', Uint8Array.of(1)));
    const bytes = Uint8Array.of(4, 5, 6);
    const descriptor = await h.controller.registerFont('upload', 'example.ttf', bytes);
    bytes[0] = 9;

    await h.controller.open(pdfFile('second.pdf', Uint8Array.of(2)));
    await h.controller.reset();

    expect(h.engines[0]!.fontRegistrations).toEqual([{
      source: 'upload',
      fileName: 'example.ttf',
      bytes: Uint8Array.of(4, 5, 6),
    }]);
    expect(h.engines[1]!.fontRegistrations).toEqual(h.engines[0]!.fontRegistrations);
    expect(h.engines[2]!.fontRegistrations).toEqual(h.engines[0]!.fontRegistrations);
    expect(h.controller.listSessionFonts()).toEqual([descriptor]);

    await h.controller.close();
    expect(h.controller.listSessionFonts()).toEqual([]);
  });

  it('ignores analysis from an older document generation', async () => {
    const stale = deferred<AnalysePageResult>();
    const current = analysisFixture('Document B');
    const h = createControllerHarness({ analyses: [stale.promise, current] });
    const openingA = h.controller.open(pdfFile('a.pdf', Uint8Array.of(1)));
    await h.waitForAnalysisCall(0);

    await h.controller.open(pdfFile('b.pdf', Uint8Array.of(2)));
    stale.resolve(analysisFixture('Document A'));
    await openingA;

    expect(h.controller.getSnapshot().fileName).toBe('b.pdf');
    expect(h.controller.getSnapshot().analysis?.spans[0]?.unicode).toBe('Document B');
  });

  it('rejects an oversized file before creating parser resources', async () => {
    const h = createControllerHarness();

    await h.controller.open(pdfFile(
      'large.pdf',
      new Uint8Array(15_728_641),
    ));

    expect(h.controller.getSnapshot().error).toMatchObject({ code: 'RESOURCE_LIMIT' });
    expect(h.engines).toHaveLength(0);
    expect(h.displayInputs).toHaveLength(0);
  });

  it('accepts a file at the exact 15 MiB product boundary', async () => {
    const h = createControllerHarness({ analyses: [analysisFixture()] });

    await h.controller.open(pdfFile(
      'boundary.pdf',
      new Uint8Array(15_728_640),
    ));

    expect(h.controller.getSnapshot()).toMatchObject({
      phase: 'ready',
      fileName: 'boundary.pdf',
    });
    expect(h.engines).toHaveLength(1);
    expect(h.displayInputs).toHaveLength(1);
  });

  it('rejects a non-PDF file before creating parser resources', async () => {
    const h = createControllerHarness();

    await h.controller.open(new File([Uint8Array.of(1)], 'notes.txt', {
      type: 'text/plain',
    }));

    expect(h.controller.getSnapshot().error).toMatchObject({
      code: 'UNSUPPORTED_DOCUMENT',
    });
    expect(h.engines).toHaveLength(0);
    expect(h.displayInputs).toHaveLength(0);
  });

  it.each(ENGINE_ERROR_CODES)(
    'maps %s without exposing the worker message',
    (code) => {
      const mapped = editorError({ code, message: 'PDF secret text' });
      expect(mapped.code).toBe(code);
      expect(mapped.message).not.toContain('PDF secret text');
      expect(['chooseAnother', 'selectAgain', 'reset', 'retry']).toContain(mapped.action);
    },
  );

  it.each([
    ['fileBytes', 15_728_640, 'This PDF exceeds the 15 MiB file limit.'],
    ['indirectObjects', 2_000, 'This PDF exceeds the 2,000 indirect-object limit.'],
    ['nestingDepth', 12, 'This PDF exceeds the nesting-depth limit of 12.'],
    ['decodedStreamBytes', 4_194_304, 'This PDF contains a decoded stream larger than 4 MiB.'],
    ['operations', 50_000, 'This PDF contains more than 50,000 operations in one content stream.'],
    ['imagePixels', 12_000_000, 'This PDF requires rendering more than 12 megapixels on one page.'],
    ['processingTime', 30_000, 'PDF processing exceeded the 30-second limit.'],
  ] as const)('maps the %s resource limit without exposing worker copy', (resource, limit, message) => {
    expect(editorError({
      code: 'RESOURCE_LIMIT',
      message: 'PDF secret text',
      details: { resource, limit },
    })).toEqual({
      code: 'RESOURCE_LIMIT',
      message,
      action: 'chooseAnother',
    });
  });
});
