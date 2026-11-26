import { readFile } from 'node:fs/promises';

import { createCanvas } from '@napi-rs/canvas';
import {
  PDFBool,
  PDFDict,
  PDFDocument,
  PDFHexString,
  PDFName,
  PDFNumber,
  PDFPage,
  PDFRawStream,
  PDFStream,
  StandardFonts,
  concatTransformationMatrix,
  degrees,
} from 'pdf-lib';
import { getDocument } from 'pdfjs-dist/legacy/build/pdf.mjs';
import { PNG } from 'pngjs';
import { describe, expect, test, vi } from 'vitest';

import { PdfEngineSessions } from '../../src/engine';
import { PROVISIONAL_LIMITS } from '../../src/limits';
import { spanAddressKey } from '../../src/model';
import { ObjectStore } from '../../src/pdf/object-store';
import { detectDocumentPolicy } from '../../src/pdf/policy';
import type { RuntimeValidationEvidence } from '../../src/validation/pdfjs-validator';

const FONT_PATH = 'node_modules/@fontsource/noto-sans/files/noto-sans-latin-400-normal.woff';
const XMP_PACKET = new TextEncoder().encode(
  '<?xpacket begin="\uFEFF"?><x:xmpmeta xmlns:x="adobe:ns:meta/"><rdf:Description xmlns:pdfaid="http://www.aiim.org/pdfa/ns/id/" pdfaid:part="2" pdfaid:conformance="B"/></x:xmpmeta><?xpacket end="w"?>',
);

type TestPlacement = Readonly<{
  pageIndex: number;
  bounds: Readonly<{ x: number; y: number; width: number; height: number }>;
  format: 'png' | 'jpeg';
  bytes: Uint8Array;
}>;

type RenderedPage = Readonly<{
  width: number;
  height: number;
  pageWidth: number;
  pageHeight: number;
  rgba: Uint8Array;
  text: string;
}>;

function validation(valid: boolean): RuntimeValidationEvidence {
  return Object.freeze({
    consumer: 'pdfjs',
    valid,
    checks: Object.freeze(valid ? ['accepted'] : ['rejected']),
    extraction: Object.freeze({
      items: Object.freeze([]),
      targetText: '',
      oldTextAbsentAtTarget: valid,
      newTextPresentAtTarget: valid,
      oldTextOutsideTargetCount: 0,
      outsideTextPreserved: true,
    }),
    render: Object.freeze({
      dpi: 144,
      width: 1,
      height: 1,
      pageWidth: 1,
      pageHeight: 1,
      rgba: new Uint8Array(4),
    }),
  });
}

async function createEngine(
  valid = true,
  limits = PROVISIONAL_LIMITS,
  imageExportValid = true,
): Promise<PdfEngineSessions> {
  const fontBytes = new Uint8Array(await readFile(FONT_PATH));
  return new PdfEngineSessions({
    limits,
    substituteFont: Object.freeze({
      bytes: fontBytes,
      family: 'Noto Sans',
      version: '5.3.0',
      licence: 'OFL-1.1',
      source: '@fontsource/noto-sans',
    }),
    validator: async (_source, _candidate, expectation) => validation(
      expectation.oldText === '' && expectation.newText === ''
        ? imageExportValid
        : valid,
    ),
  });
}

function quadrantPng(red = 255): Uint8Array {
  const png = new PNG({ width: 32, height: 32 });
  for (let y = 0; y < png.height; y += 1) {
    for (let x = 0; x < png.width; x += 1) {
      const offset = (y * png.width + x) * 4;
      const colour = y < 16
        ? x < 16 ? [red, 0, 0] : [0, 255, 0]
        : x < 16 ? [0, 0, 255] : [red, 255, 0];
      png.data[offset] = colour[0]!;
      png.data[offset + 1] = colour[1]!;
      png.data[offset + 2] = colour[2]!;
      png.data[offset + 3] = 255;
    }
  }
  return new Uint8Array(PNG.sync.write(png));
}

function quadrantJpeg(): Uint8Array {
  const canvas = createCanvas(32, 32);
  const context = canvas.getContext('2d');
  context.fillStyle = 'red';
  context.fillRect(0, 0, 16, 16);
  context.fillStyle = 'lime';
  context.fillRect(16, 0, 16, 16);
  context.fillStyle = 'blue';
  context.fillRect(0, 16, 16, 16);
  context.fillStyle = 'yellow';
  context.fillRect(16, 16, 16, 16);
  return new Uint8Array(canvas.toBuffer('image/jpeg'));
}

function transparentPng(): Uint8Array {
  return new Uint8Array(PNG.sync.write(new PNG({ width: 32, height: 32 })));
}

async function createSourcePdf(options: Readonly<{
  rotatedCropped?: boolean;
  text?: boolean;
  info?: boolean;
  invalidRotation?: boolean;
  tagged?: boolean;
  pdfUa?: boolean;
}> = {}): Promise<Uint8Array> {
  const document = await PDFDocument.create();
  const page = document.addPage([200, 200]);
  if (options.rotatedCropped) {
    page.setMediaBox(20, 30, 100, 80);
    page.setCropBox(30, 40, 80, 60);
    page.setRotation(degrees(90));
    page.node.set(PDFName.of('UserUnit'), PDFNumber.of(2));
  }
  if (options.invalidRotation) page.node.set(PDFName.of('Rotate'), PDFNumber.of(45));
  if (options.text) {
    const font = await document.embedFont(StandardFonts.Helvetica);
    page.drawText('Keep this text', { x: 35, y: 60, size: 12, font });
  }
  if (options.tagged) {
    const markInfo = PDFDict.withContext(document.context);
    markInfo.set(PDFName.of('Marked'), PDFBool.True);
    document.catalog.set(PDFName.of('MarkInfo'), markInfo);
    document.catalog.set(
      PDFName.of('StructTreeRoot'),
      document.context.register(PDFDict.withContext(document.context)),
    );
  }
  if (options.info) {
    const info = PDFDict.withContext(document.context);
    info.set(PDFName.of('Creator'), PDFHexString.fromText('Original creator'));
    info.set(PDFName.of('CustomKey'), PDFHexString.fromText('Original custom value'));
    document.context.trailerInfo.Info = document.context.register(info);
  } else {
    delete document.context.trailerInfo.Info;
  }
  const metadata = options.pdfUa
    ? new TextEncoder().encode(
        '<?xpacket begin="\uFEFF"?><x:xmpmeta xmlns:x="adobe:ns:meta/"><rdf:Description xmlns:pdfaid="http://www.aiim.org/pdfa/ns/id/" pdfaid:part="2" pdfaid:conformance="B" xmlns:pdfuaid="http://www.aiim.org/pdfua/ns/id/" pdfuaid:part="1"/></x:xmpmeta><?xpacket end="w"?>',
      )
    : XMP_PACKET;
  document.catalog.set(
    PDFName.of('Metadata'),
    document.context.register(document.context.stream(metadata, {
      Type: 'Metadata',
      Subtype: 'XML',
    })),
  );
  return document.save({
    useObjectStreams: false,
    addDefaultPage: false,
    updateFieldAppearances: false,
  });
}

async function createPdfWithSharedPageResources(): Promise<Uint8Array> {
  const document = await PDFDocument.create();
  const first = document.addPage([200, 200]);
  const second = document.addPage([200, 200]);
  const sharedResources = document.context.register(PDFDict.withContext(document.context));
  first.node.set(PDFName.of('Resources'), sharedResources);
  second.node.set(PDFName.of('Resources'), sharedResources);
  return document.save({ useObjectStreams: false, addDefaultPage: false });
}

async function renderPage(bytes: Uint8Array, pageIndex = 0): Promise<RenderedPage> {
  const ownedBytes = new Uint8Array(bytes.byteLength);
  ownedBytes.set(bytes);
  const loadingTask = getDocument({
    data: ownedBytes,
    useWasm: true,
    verbosity: 0,
    disableFontFace: true,
  });
  try {
    const document = await loadingTask.promise;
    const page = await document.getPage(pageIndex + 1);
    const content = await page.getTextContent();
    const text = content.items
      .filter((item): item is typeof item & Readonly<{ str: string }> => 'str' in item)
      .map(({ str }) => str)
      .join(' ');
    const scale = 2;
    const viewport = page.getViewport({ scale });
    const width = Math.ceil(viewport.width);
    const height = Math.ceil(viewport.height);
    const canvas = createCanvas(width, height);
    const context = canvas.getContext('2d');
    await page.render({
      canvas,
      canvasContext: context,
      viewport,
    } as never).promise;
    return Object.freeze({
      width,
      height,
      pageWidth: viewport.width / scale,
      pageHeight: viewport.height / scale,
      rgba: new Uint8Array(context.getImageData(0, 0, width, height).data),
      text,
    });
  } finally {
    await loadingTask.destroy();
  }
}

function pixel(page: RenderedPage, x: number, y: number): readonly number[] {
  const offset = (y * page.width + x) * 4;
  return [page.rgba[offset]!, page.rgba[offset + 1]!, page.rgba[offset + 2]!];
}

function expectImageCorners(page: RenderedPage, bounds: TestPlacement['bounds']): void {
  const scaleX = page.width / page.pageWidth;
  const scaleY = page.height / page.pageHeight;
  const left = Math.round(bounds.x * scaleX);
  const right = Math.round((bounds.x + bounds.width) * scaleX);
  const top = Math.round((page.pageHeight - bounds.y - bounds.height) * scaleY);
  const bottom = Math.round((page.pageHeight - bounds.y) * scaleY);
  const insetX = Math.floor((right - left) / 4);
  const insetY = Math.floor((bottom - top) / 4);
  const samples = [
    [left + insetX, top + insetY, [255, 0, 0]],
    [right - insetX - 1, top + insetY, [0, 255, 0]],
    [left + insetX, bottom - insetY - 1, [0, 0, 255]],
    [right - insetX - 1, bottom - insetY - 1, [255, 255, 0]],
  ] as const;
  for (const [x, y, colour] of samples) {
    const actual = pixel(page, x, y);
    expect(actual[0]).toBeGreaterThanOrEqual(colour[0] - 2);
    expect(actual[0]).toBeLessThanOrEqual(colour[0] + 2);
    expect(actual[1]).toBeGreaterThanOrEqual(colour[1] - 2);
    expect(actual[1]).toBeLessThanOrEqual(colour[1] + 2);
    expect(actual[2]).toBeGreaterThanOrEqual(colour[2] - 2);
    expect(actual[2]).toBeLessThanOrEqual(colour[2] + 2);
  }
}

function expectPixelsOutsidePlacementsPreserved(
  source: RenderedPage,
  candidate: RenderedPage,
  placements: readonly TestPlacement[],
): void {
  expect(candidate.width).toBe(source.width);
  expect(candidate.height).toBe(source.height);
  const regions = placements.map(({ bounds }) => ({
    left: Math.floor(bounds.x * source.width / source.pageWidth),
    right: Math.ceil((bounds.x + bounds.width) * source.width / source.pageWidth),
    top: Math.floor((source.pageHeight - bounds.y - bounds.height)
      * source.height / source.pageHeight),
    bottom: Math.ceil((source.pageHeight - bounds.y)
      * source.height / source.pageHeight),
  }));
  for (let y = 0; y < source.height; y += 1) {
    for (let x = 0; x < source.width; x += 1) {
      if (regions.some(({ left, right, top, bottom }) =>
        x >= left && x < right && y >= top && y < bottom)) continue;
      expect(pixel(candidate, x, y), `pixel outside image placements at ${x},${y}`)
        .toEqual(pixel(source, x, y));
    }
  }
}

async function assertMetadataPreserved(
  sourceBytes: Uint8Array,
  outputBytes: Uint8Array,
  hasInfo: boolean,
): Promise<void> {
  const source = await PDFDocument.load(sourceBytes, { updateMetadata: false });
  const output = await PDFDocument.load(outputBytes, { updateMetadata: false });
  const sourceInfoRef = source.context.trailerInfo.Info;
  const outputInfoRef = output.context.trailerInfo.Info;
  expect(sourceInfoRef !== undefined).toBe(hasInfo);
  expect(outputInfoRef !== undefined).toBe(hasInfo);
  if (hasInfo && sourceInfoRef !== undefined && outputInfoRef !== undefined) {
    const sourceInfo = source.context.lookup(sourceInfoRef, PDFDict);
    const outputInfo = output.context.lookup(outputInfoRef, PDFDict);
    expect(outputInfo.lookupMaybe(PDFName.of('Creator'), PDFHexString)?.decodeText())
      .toBe(sourceInfo.lookupMaybe(PDFName.of('Creator'), PDFHexString)?.decodeText());
    expect(outputInfo.lookupMaybe(PDFName.of('Producer'), PDFHexString)?.decodeText())
      .toBeUndefined();
    expect(outputInfo.lookupMaybe(PDFName.of('CustomKey'), PDFHexString)?.decodeText())
      .toBe(sourceInfo.lookupMaybe(PDFName.of('CustomKey'), PDFHexString)?.decodeText());
  }
  const sourceXmp = source.catalog.lookup(PDFName.of('Metadata'), PDFStream);
  const outputXmp = output.catalog.lookup(PDFName.of('Metadata'), PDFStream);
  expect(sourceXmp).toBeInstanceOf(PDFRawStream);
  expect(outputXmp).toBeInstanceOf(PDFRawStream);
  expect((outputXmp as PDFRawStream).contents).toEqual((sourceXmp as PDFRawStream).contents);
  expect((outputXmp as PDFRawStream).contents).toEqual(XMP_PACKET);
}

describe('positioned image PDF export', () => {
  test('exports an image-only document without creating Info metadata', async () => {
    const sourceBytes = await createSourcePdf({ info: false });
    const sourceCopy = sourceBytes.slice();
    const image = quadrantPng();
    const placement: TestPlacement = {
      pageIndex: 0,
      bounds: { x: 20, y: 30, width: 40, height: 30 },
      format: 'png',
      bytes: image,
    };
    const engine = await createEngine();
    const opened = await engine.openDocument(sourceBytes);
    expect(opened.imageInsertionAllowed).toBe(true);

    const exported = new Uint8Array(await engine.exportPositionedImages(
      opened.documentId,
      opened.revision,
      [placement],
    ));

    expect(sourceBytes).toEqual(sourceCopy);
    await assertMetadataPreserved(sourceCopy, exported, false);
    const reopened = await PDFDocument.load(exported, { updateMetadata: false });
    expect(reopened.getPageCount()).toBe(1);
    expect(reopened.getPage(0).node.Resources()?.lookupMaybe(PDFName.of('XObject'), PDFDict)?.entries().length)
      .toBe(1);
  }, 15_000);

  test('maps asymmetric images through offset crop, rotation and UserUnit, preserving text and outside pixels', async () => {
    const sourceBytes = await createSourcePdf({ rotatedCropped: true, text: true, info: true });
    const image = quadrantPng();
    const placements: readonly TestPlacement[] = [
      { pageIndex: 0, bounds: { x: 10, y: 20, width: 40, height: 30 }, format: 'png', bytes: image },
      { pageIndex: 0, bounds: { x: 70, y: 95, width: 24, height: 18 }, format: 'png', bytes: image },
    ];
    const engine = await createEngine();
    const opened = await engine.openDocument(sourceBytes);
    const first = new Uint8Array(await engine.exportPositionedImages(
      opened.documentId,
      opened.revision,
      placements,
    ));
    const second = new Uint8Array(await engine.exportPositionedImages(
      opened.documentId,
      opened.revision,
      placements,
    ));

    expect(second).toEqual(first);
    await assertMetadataPreserved(sourceBytes, first, true);
    const [sourcePolicy, outputPolicy] = await Promise.all([
      ObjectStore.open(sourceBytes, PROVISIONAL_LIMITS).then(detectDocumentPolicy),
      ObjectStore.open(first, PROVISIONAL_LIMITS).then(detectDocumentPolicy),
    ]);
    expect(sourcePolicy.pdfA).toEqual({
      observed: true,
      confidence: 'metadata',
      identifier: 'PDF/A-2B',
    });
    expect(outputPolicy).toEqual(sourcePolicy);
    const reopened = await PDFDocument.load(first, { updateMetadata: false });
    expect(reopened.getPage(0).node.Resources()?.lookupMaybe(PDFName.of('XObject'), PDFDict)?.entries().length)
      .toBe(1);
    const [sourceRender, outputRender] = await Promise.all([
      renderPage(sourceBytes),
      renderPage(first),
    ]);
    expect(outputRender.text).toBe(sourceRender.text);
    expect(outputRender.text).toContain('Keep this text');
    for (const placement of placements) expectImageCorners(outputRender, placement.bounds);
    expectPixelsOutsidePlacementsPreserved(sourceRender, outputRender, placements);
  }, 20_000);

  test('embeds JPEG bytes as PDF content', async () => {
    const sourceBytes = await createSourcePdf();
    const engine = await createEngine();
    const opened = await engine.openDocument(sourceBytes);
    const jpeg: TestPlacement = {
      pageIndex: 0,
      bounds: { x: 15, y: 25, width: 64, height: 64 },
      format: 'jpeg',
      bytes: quadrantJpeg(),
    };

    const exported = new Uint8Array(await engine.exportPositionedImages(
      opened.documentId,
      opened.revision,
      [jpeg],
    ));
    const reopened = await PDFDocument.load(exported, { updateMetadata: false });

    expect(reopened.getPage(0).node.Resources()?.lookupMaybe(PDFName.of('XObject'), PDFDict)?.entries().length)
      .toBe(1);
    expect((await renderPage(exported)).width).toBeGreaterThan(0);
  }, 15_000);

  test('keeps a fully transparent image valid when it has no raster-visible pixels', async () => {
    const sourceBytes = await createSourcePdf();
    const engine = await createEngine();
    const opened = await engine.openDocument(sourceBytes);
    const exported = new Uint8Array(await engine.exportPositionedImages(
      opened.documentId,
      opened.revision,
      [{
        pageIndex: 0,
        bounds: { x: 20, y: 30, width: 40, height: 30 },
        format: 'png',
        bytes: transparentPng(),
      }],
    ));

    expect(exported.byteLength).toBeGreaterThan(sourceBytes.byteLength);
    expect((await renderPage(exported)).rgba).toEqual((await renderPage(sourceBytes)).rgba);
  }, 15_000);

  test.each([
    ['a marked structure tree', { tagged: true }],
    ['PDF/UA metadata', { pdfUa: true }],
  ] as const)('rejects untagged image content in %s documents', async (_label, options) => {
    const sourceBytes = await createSourcePdf(options);
    const engine = await createEngine();
    const opened = await engine.openDocument(sourceBytes);
    expect(opened.imageInsertionAllowed).toBe(false);

    const failure = await engine.exportPositionedImages(
      opened.documentId,
      opened.revision,
      [{
        pageIndex: 0,
        bounds: { x: 20, y: 30, width: 40, height: 30 },
        format: 'png',
        bytes: quadrantPng(),
      }],
    ).then(() => null, (error: unknown) => error);
    expect(failure).toMatchObject({
      code: 'UNSUPPORTED_DOCUMENT',
      message: expect.stringContaining('tagged or PDF/UA'),
    });
  }, 15_000);

  test('continues to allow text replacement in tagged documents', async () => {
    const sourceBytes = await createSourcePdf({ tagged: true, text: true });
    const engine = await createEngine();
    const opened = await engine.openDocument(sourceBytes);
    const span = (await engine.analysePage(opened.documentId, opened.revision, 0))
      .spans.find(({ unicode }) => unicode?.includes('Keep this text'));
    expect(span).toBeDefined();
    const key = spanAddressKey(span!.address);
    const preview = await engine.previewReplacement(
      opened.documentId,
      opened.revision,
      key,
      'Keep edited text',
      true,
    );
    expect(preview.canApply).toBe(true);
    const applied = await engine.applyReplacement(
      opened.documentId,
      opened.revision,
      key,
      'Keep edited text',
      true,
      preview.preconditions,
    );
    const validated = await engine.validateCandidate(
      opened.documentId,
      opened.revision,
      applied.candidateId,
    );

    expect(validated.valid).toBe(true);
    expect(engine.exportDocument(
      opened.documentId,
      validated.revision,
      applied.candidateHash,
    )).toBeInstanceOf(ArrayBuffer);
  }, 20_000);

  test.each(['omitted', 'misplaced'] as const)(
    'rejects %s drawing operations even when pixel validation accepts the target',
    async (tampering) => {
      const sourceBytes = await createSourcePdf();
      const engine = await createEngine();
      const opened = await engine.openDocument(sourceBytes);
      const originalPushOperators = PDFPage.prototype.pushOperators;
      const sabotage = vi.spyOn(PDFPage.prototype, 'pushOperators');
      sabotage.mockImplementation(function (
        this: PDFPage,
        ...operators: Parameters<PDFPage['pushOperators']>
      ) {
        const altered = tampering === 'omitted'
          ? operators.filter((_operator, index) => index !== 2)
          : operators.map((operator) => operator.toString().trim().endsWith(' cm')
            ? concatTransformationMatrix(1, 0, 0, 1, 999, 999)
            : operator);
        return originalPushOperators.apply(this, altered);
      });

      try {
        const failure = await engine.exportPositionedImages(
          opened.documentId,
          opened.revision,
          [{
            pageIndex: 0,
            bounds: { x: 20, y: 30, width: 40, height: 30 },
            format: 'png',
            bytes: quadrantPng(),
          }],
        ).then(() => null, (error: unknown) => error);
        expect(failure).toMatchObject({ code: 'VALIDATION_FAILURE' });
      } finally {
        sabotage.mockRestore();
      }
    },
  );

  test('isolates added XObject resources from untouched pages sharing inherited resources', async () => {
    const sourceBytes = await createPdfWithSharedPageResources();
    const engine = await createEngine();
    const opened = await engine.openDocument(sourceBytes);
    const output = new Uint8Array(await engine.exportPositionedImages(
      opened.documentId,
      opened.revision,
      [{
        pageIndex: 0,
        bounds: { x: 20, y: 20, width: 40, height: 30 },
        format: 'png',
        bytes: quadrantPng(),
      }],
    ));
    const reopened = await PDFDocument.load(output, { updateMetadata: false });
    const firstXObjects = reopened.getPage(0).node.Resources()
      ?.lookupMaybe(PDFName.of('XObject'), PDFDict)?.entries().length ?? 0;
    const secondXObjects = reopened.getPage(1).node.Resources()
      ?.lookupMaybe(PDFName.of('XObject'), PDFDict)?.entries().length ?? 0;

    expect(firstXObjects).toBe(1);
    expect(secondXObjects).toBe(0);
  }, 15_000);

  test('exports the latest validated text revision with its image placement', async () => {
    const sourceBytes = new Uint8Array(await readFile('fixtures/generated/01-simple-tj.pdf'));
    const engine = await createEngine();
    const opened = await engine.openDocument(sourceBytes);
    const page = await engine.analysePage(opened.documentId, opened.revision, 0);
    const span = page.spans.find(({ unicode }) => unicode === 'Target 01')!;
    const spanKey = spanAddressKey(span.address);
    const preview = await engine.previewReplacement(
      opened.documentId,
      opened.revision,
      spanKey,
      'Edited 01',
      true,
    );
    const applied = await engine.applyReplacement(
      opened.documentId,
      opened.revision,
      spanKey,
      'Edited 01',
      true,
      preview.preconditions,
    );
    const checked = await engine.validateCandidate(opened.documentId, opened.revision, applied.candidateId);
    const output = new Uint8Array(await engine.exportPositionedImages(
      opened.documentId,
      checked.revision,
      [{
        pageIndex: 0,
        bounds: { x: 300, y: 300, width: 20, height: 20 },
        format: 'png',
        bytes: quadrantPng(),
      }],
    ));
    const reopened = await PDFDocument.load(output, { updateMetadata: false });

    expect(await (await engine.analysePage(opened.documentId, checked.revision, 0))
      .spans.map(({ unicode }) => unicode)).toContain('Edited 01');
    expect(reopened.getPageCount()).toBe(1);
    expect(output).not.toEqual(sourceBytes);
  }, 20_000);

  test('rejects malformed image bytes and invalid placement geometry', async () => {
    const sourceBytes = await createSourcePdf();
    const engine = await createEngine();
    const opened = await engine.openDocument(sourceBytes);
    const invalidImage: TestPlacement = {
      pageIndex: 0,
      bounds: { x: 1, y: 2, width: 30, height: 20 },
      format: 'png',
      bytes: Uint8Array.of(1, 2, 3),
    };
    await expect(engine.exportPositionedImages(
      opened.documentId,
      opened.revision,
      [invalidImage],
    )).rejects.toMatchObject({ code: 'MALFORMED_INPUT' });
    await expect(engine.exportPositionedImages(
      opened.documentId,
      opened.revision,
      [{
        ...invalidImage,
        bytes: quadrantPng().slice(0, 24),
      }],
    )).rejects.toMatchObject({ code: 'MALFORMED_INPUT' });

    await expect(engine.exportPositionedImages(
      opened.documentId,
      opened.revision,
      [{ ...invalidImage, bytes: quadrantPng(), bounds: { ...invalidImage.bounds, width: 0 } }],
    )).rejects.toMatchObject({ code: 'MALFORMED_INPUT' });
    await expect(engine.exportPositionedImages(
      opened.documentId,
      opened.revision,
      [{
        ...invalidImage,
        bytes: quadrantPng(),
        bounds: null as unknown as TestPlacement['bounds'],
      }],
    )).rejects.toMatchObject({ code: 'MALFORMED_INPUT' });
    await expect(engine.exportPositionedImages(
      opened.documentId,
      opened.revision,
      [{ ...invalidImage, bytes: quadrantPng(), pageIndex: 1 }],
    )).rejects.toMatchObject({ code: 'MALFORMED_INPUT' });

    const invalidPageEngine = await createEngine();
    const invalidPage = await invalidPageEngine.openDocument(
      await createSourcePdf({ invalidRotation: true }),
    );
    await expect(invalidPageEngine.exportPositionedImages(
      invalidPage.documentId,
      invalidPage.revision,
      [{ ...invalidImage, bytes: quadrantPng() }],
    )).rejects.toMatchObject({ code: 'UNSUPPORTED_DOCUMENT' });
  }, 15_000);

  test('checks per-image and aggregate pixel limits before embedding', async () => {
    const sourceBytes = await createSourcePdf();
    const imageBytes = quadrantPng();
    const perImageLimitedEngine = await createEngine(true, {
      ...PROVISIONAL_LIMITS,
      maxImagePixels: 500,
    });
    const perImageSession = await perImageLimitedEngine.openDocument(sourceBytes);
    const placement: TestPlacement = {
      pageIndex: 0,
      bounds: { x: 10, y: 20, width: 30, height: 20 },
      format: 'png',
      bytes: imageBytes,
    };
    await expect(perImageLimitedEngine.exportPositionedImages(
      perImageSession.documentId,
      perImageSession.revision,
      [placement],
    )).rejects.toMatchObject({
      code: 'RESOURCE_LIMIT',
      details: { resource: 'imagePixels', limit: 500, observedPixels: 1024 },
    });

    const aggregateLimitedEngine = await createEngine(true, {
      ...PROVISIONAL_LIMITS,
      maxImagePixels: 1500,
    });
    const aggregateSession = await aggregateLimitedEngine.openDocument(sourceBytes);
    await expect(aggregateLimitedEngine.exportPositionedImages(
      aggregateSession.documentId,
      aggregateSession.revision,
      [placement, { ...placement, bounds: { ...placement.bounds, x: 50 } }],
    )).resolves.toBeInstanceOf(ArrayBuffer);
    await expect(aggregateLimitedEngine.exportPositionedImages(
      aggregateSession.documentId,
      aggregateSession.revision,
      [
        placement,
        { ...placement, bounds: { ...placement.bounds, x: 50 }, bytes: quadrantPng(200) },
      ],
    )).rejects.toMatchObject({
      code: 'RESOURCE_LIMIT',
      details: { resource: 'imagePixels', limit: 1500, observedPixels: 2048 },
    });
  }, 15_000);

  test('rejects image bytes when runtime PDF.js validation fails', async () => {
    const sourceBytes = await createSourcePdf();
    const engine = await createEngine(true, PROVISIONAL_LIMITS, false);
    const opened = await engine.openDocument(sourceBytes);

    await expect(engine.exportPositionedImages(
      opened.documentId,
      opened.revision,
      [{
        pageIndex: 0,
        bounds: { x: 10, y: 20, width: 30, height: 20 },
        format: 'png',
        bytes: quadrantPng(),
      }],
    )).rejects.toMatchObject({ code: 'VALIDATION_FAILURE' });
  }, 15_000);

  test('does not include an unvalidated pending text candidate in image export', async () => {
    const sourceBytes = new Uint8Array(await readFile('fixtures/generated/01-simple-tj.pdf'));
    const engine = await createEngine(false);
    const opened = await engine.openDocument(sourceBytes);
    const span = (await engine.analysePage(opened.documentId, opened.revision, 0)).spans
      .find(({ unicode }) => unicode === 'Target 01')!;
    const spanKey = spanAddressKey(span.address);
    const preview = await engine.previewReplacement(
      opened.documentId,
      opened.revision,
      spanKey,
      'Rejected edit',
      true,
    );
    const applied = await engine.applyReplacement(
      opened.documentId,
      opened.revision,
      spanKey,
      'Rejected edit',
      true,
      preview.preconditions,
    );
    const rejected = await engine.validateCandidate(opened.documentId, opened.revision, applied.candidateId);
    expect(rejected.valid).toBe(false);
    const exported = new Uint8Array(await engine.exportPositionedImages(
      opened.documentId,
      opened.revision,
      [{
        pageIndex: 0,
        bounds: { x: 300, y: 300, width: 20, height: 20 },
        format: 'png',
        bytes: quadrantPng(),
      }],
    ));
    const reopened = await PDFDocument.load(exported, { updateMetadata: false });

    expect(reopened.getPageCount()).toBe(1);
    expect((await engine.analysePage(opened.documentId, opened.revision, 0)).spans
      .map(({ unicode }) => unicode)).toContain('Target 01');
    const text = (await renderPage(exported)).text;
    expect(text).toContain('Target 01');
    expect(text).not.toContain('Rejected edit');
  }, 20_000);
});
