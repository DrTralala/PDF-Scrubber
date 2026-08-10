import {
  getDocument,
  GlobalWorkerOptions,
  Util,
} from 'pdfjs-dist/legacy/build/pdf.mjs';
import type {
  PDFDocumentLoadingTask,
  PDFDocumentProxy,
  PDFPageProxy,
} from 'pdfjs-dist';
import type { TextItem } from 'pdfjs-dist/types/src/display/api.d.ts';

import type { EngineErrorDescriptor } from '../errors';
import { invert, transformPoint } from '../geometry/matrix';
import { canonicalToViewport, type PageSpace } from '../geometry/page-space';
import { PROVISIONAL_LIMITS, type EngineLimits } from '../limits';
import type { CanonicalBounds } from '../model';
import { PdfEngineError } from '../pdf/stream-codecs';
import {
  validateCandidateStructure,
  type CandidateStructureEvidence,
  type StructuralMutationExpectation,
} from './candidate-structure';

const pdfWorkerUrl = new URL(
  '../../../../node_modules/pdfjs-dist/legacy/build/pdf.worker.mjs',
  import.meta.url,
).href;

export type MutationExpectation = Readonly<{
  pageIndex: number;
  targetBounds: CanonicalBounds;
  authorisedBounds?: CanonicalBounds;
  oldText: string;
  newText: string;
  expectedOldTextOutsideTarget: number;
  structure?: StructuralMutationExpectation;
}>;

export type RuntimeTextItem = Readonly<{
  text: string;
  pageIndex: number;
  bounds: CanonicalBounds;
}>;

export type RuntimeExtractionEvidence = Readonly<{
  items: readonly RuntimeTextItem[];
  targetText: string;
  oldTextAbsentAtTarget: boolean;
  newTextPresentAtTarget: boolean;
  oldTextOutsideTargetCount: number;
  outsideTextPreserved: boolean;
}>;

export type RuntimeRenderEvidence = Readonly<{
  dpi: 144;
  width: number;
  height: number;
  pageWidth: number;
  pageHeight: number;
  rgba: Uint8Array;
}>;

export type RuntimeSourceComparisonEvidence = Readonly<{
  pageGeometryPreserved: boolean;
  outsideTextPreserved: boolean;
  outsidePixelsPreserved: boolean;
  outsideMismatchedPixels: number;
  sourceOutsideText: string;
  candidateOutsideText: string;
}>;

export type RuntimeValidationEvidence = Readonly<{
  consumer: 'pdfjs';
  valid: boolean;
  checks: readonly string[];
  extraction: RuntimeExtractionEvidence;
  render: RuntimeRenderEvidence;
  sourceComparison?: RuntimeSourceComparisonEvidence;
  structure?: CandidateStructureEvidence;
  error?: EngineErrorDescriptor;
}>;

export type ValidationCanvasSurface = Readonly<{
  canvas: unknown;
  context: unknown;
  readRgba(): Uint8Array;
}>;

export type ValidationCanvasFactory = (
  width: number,
  height: number,
) => ValidationCanvasSurface;

type PdfJsCanvasAndContext = {
  canvas: (ValidationCanvasSurface['canvas'] & { width: number; height: number }) | null;
  context: ValidationCanvasSurface['context'] | null;
};

function pdfJsCanvasFactory(
  surfaceFactory: ValidationCanvasFactory,
): new () => Readonly<{
  create(width: number, height: number): PdfJsCanvasAndContext;
  reset(target: PdfJsCanvasAndContext, width: number, height: number): void;
  destroy(target: PdfJsCanvasAndContext): void;
}> {
  return class {
    create(width: number, height: number): PdfJsCanvasAndContext {
      const surface = surfaceFactory(width, height);
      return {
        canvas: surface.canvas as PdfJsCanvasAndContext['canvas'],
        context: surface.context,
      };
    }

    reset(target: PdfJsCanvasAndContext, width: number, height: number): void {
      if (target.canvas === null) throw new Error('Canvas is unavailable');
      target.canvas.width = width;
      target.canvas.height = height;
    }

    destroy(target: PdfJsCanvasAndContext): void {
      if (target.canvas !== null) target.canvas.width = target.canvas.height = 0;
      target.canvas = null;
      target.context = null;
    }
  };
}

function defaultCanvasFactory(width: number, height: number): ValidationCanvasSurface {
  if (typeof OffscreenCanvas === 'undefined') {
    throw new Error('OffscreenCanvas is unavailable in this runtime');
  }
  const canvas = new OffscreenCanvas(width, height);
  const context = canvas.getContext('2d', { alpha: false });
  if (context === null) throw new Error('A 2D OffscreenCanvas context is unavailable');
  return {
    canvas,
    context,
    readRgba: () => new Uint8Array(context.getImageData(0, 0, width, height).data),
  };
}

function intersects(left: CanonicalBounds, right: CanonicalBounds): boolean {
  return left.x < right.x + right.width
    && left.x + left.width > right.x
    && left.y < right.y + right.height
    && left.y + left.height > right.y;
}

function searchable(value: string): string {
  return value.normalize('NFC').replace(/\s+/gu, '');
}

function outsideText(
  items: readonly RuntimeTextItem[],
  bounds: CanonicalBounds,
): string {
  return searchable(items
    .filter((item) => !intersects(item.bounds, bounds))
    .map(({ text }) => text)
    .join(' '));
}

function countOccurrences(haystack: string, needle: string): number {
  if (needle.length === 0) return 0;
  let count = 0;
  let offset = 0;
  while ((offset = haystack.indexOf(needle, offset)) !== -1) {
    count += 1;
    offset += needle.length;
  }
  return count;
}

async function extractItems(page: PDFPageProxy, pageIndex: number): Promise<readonly RuntimeTextItem[]> {
  const viewport = page.getViewport({ scale: 1 });
  if (page.view.length !== 4) throw new Error('PDF.js returned an invalid page view');
  const pageSpace: PageSpace = {
    mediaBox: [page.view[0]!, page.view[1]!, page.view[2]!, page.view[3]!],
    rotate: page.rotate,
    userUnit: page.userUnit,
  };
  const viewportToCanonical = invert(canonicalToViewport(pageSpace, 1));
  const content = await page.getTextContent();
  const items: RuntimeTextItem[] = [];
  for (const entry of content.items) {
    if (!('str' in entry)) continue;
    const item = entry as TextItem;
    const transformed = Util.transform(viewport.transform, item.transform);
    const widthMagnitude = Math.hypot(transformed[0], transformed[1]);
    const heightMagnitude = Math.hypot(transformed[2], transformed[3]);
    const widthScale = widthMagnitude === 0 ? 0 : Math.abs(item.width) / widthMagnitude;
    const heightScale = heightMagnitude === 0 ? 0 : Math.abs(item.height) / heightMagnitude;
    const widthVector = [transformed[0] * widthScale, transformed[1] * widthScale] as const;
    const heightVector = [transformed[2] * heightScale, transformed[3] * heightScale] as const;
    const viewportCorners = [
      [transformed[4], transformed[5]],
      [transformed[4] + widthVector[0], transformed[5] + widthVector[1]],
      [transformed[4] + heightVector[0], transformed[5] + heightVector[1]],
      [
        transformed[4] + widthVector[0] + heightVector[0],
        transformed[5] + widthVector[1] + heightVector[1],
      ],
    ] as const;
    const canonicalCorners = viewportCorners.map(([x, y]) =>
      transformPoint(viewportToCanonical, x, y));
    const xMinimum = Math.min(...canonicalCorners.map(([x]) => x));
    const xMaximum = Math.max(...canonicalCorners.map(([x]) => x));
    const yMinimum = Math.min(...canonicalCorners.map(([, y]) => y));
    const yMaximum = Math.max(...canonicalCorners.map(([, y]) => y));
    const bounds = Object.freeze({
      x: xMinimum,
      y: yMinimum,
      width: xMaximum - xMinimum,
      height: yMaximum - yMinimum,
    });
    if ([bounds.x, bounds.y, bounds.width, bounds.height].every(Number.isFinite)) {
      items.push(Object.freeze({ text: item.str, pageIndex, bounds }));
    }
  }
  return Object.freeze(items);
}

function pageSpaceFor(page: PDFPageProxy): PageSpace {
  if (page.view.length !== 4) throw new Error('PDF.js returned an invalid page view');
  const mediaBox: PageSpace['mediaBox'] = Object.freeze([
    page.view[0]!,
    page.view[1]!,
    page.view[2]!,
    page.view[3]!,
  ]);
  return Object.freeze({
    mediaBox,
    rotate: page.rotate,
    userUnit: page.userUnit,
  });
}

async function renderPage(
  page: PDFPageProxy,
  canvasFactory: ValidationCanvasFactory,
  limits: EngineLimits,
): Promise<RuntimeRenderEvidence> {
  const scale = 144 / 72;
  const viewport = page.getViewport({ scale });
  const width = Math.ceil(viewport.width);
  const height = Math.ceil(viewport.height);
  if (width * height > limits.maxImagePixels) {
    throw new PdfEngineError('RESOURCE_LIMIT', 'Rendered page exceeds image pixel limit', {
      resource: 'imagePixels',
      limit: limits.maxImagePixels,
      observedPixels: width * height,
    });
  }
  const surface = canvasFactory(width, height);
  await page.render({
    canvas: surface.canvas,
    canvasContext: surface.context,
    viewport,
  } as never).promise;
  const rgba = surface.readRgba();
  if (rgba.length !== width * height * 4) {
    throw new Error('Rendered RGBA byte length does not match page dimensions');
  }
  return Object.freeze({
    dpi: 144,
    width,
    height,
    pageWidth: viewport.width / scale,
    pageHeight: viewport.height / scale,
    rgba: new Uint8Array(rgba),
  });
}

function outsidePixelMismatch(
  source: RuntimeRenderEvidence,
  candidate: RuntimeRenderEvidence,
  authorisedBounds: CanonicalBounds,
): number {
  if (
    source.width !== candidate.width || source.height !== candidate.height ||
    source.rgba.length !== candidate.rgba.length ||
    source.pageWidth !== candidate.pageWidth || source.pageHeight !== candidate.pageHeight
  ) return Math.max(source.width * source.height, candidate.width * candidate.height);
  const xMinimum = Math.max(0, Math.floor(
    authorisedBounds.x * source.width / source.pageWidth,
  ));
  const xMaximum = Math.min(source.width, Math.ceil(
    (authorisedBounds.x + authorisedBounds.width) * source.width / source.pageWidth,
  ));
  const yMinimum = Math.max(0, Math.floor(
    (source.pageHeight - authorisedBounds.y - authorisedBounds.height)
      * source.height / source.pageHeight,
  ));
  const yMaximum = Math.min(source.height, Math.ceil(
    (source.pageHeight - authorisedBounds.y) * source.height / source.pageHeight,
  ));
  let mismatches = 0;
  for (let y = 0; y < source.height; y += 1) {
    for (let x = 0; x < source.width; x += 1) {
      if (x >= xMinimum && x < xMaximum && y >= yMinimum && y < yMaximum) continue;
      const offset = (y * source.width + x) * 4;
      if (
        source.rgba[offset] !== candidate.rgba[offset] ||
        source.rgba[offset + 1] !== candidate.rgba[offset + 1] ||
        source.rgba[offset + 2] !== candidate.rgba[offset + 2] ||
        source.rgba[offset + 3] !== candidate.rgba[offset + 3]
      ) {
        mismatches += 1;
      }
    }
  }
  return mismatches;
}

function rasterAuthorisedBounds(
  logicalBounds: CanonicalBounds,
  targetBounds: CanonicalBounds,
  sourceItems: readonly RuntimeTextItem[],
  pageWidth: number,
  pageHeight: number,
): CanonicalBounds {
  const targetItems = sourceItems.filter(({ bounds }) => intersects(bounds, targetBounds));
  const xMinimum = Math.min(logicalBounds.x, ...targetItems.map(({ bounds }) => bounds.x));
  const yMinimum = Math.min(logicalBounds.y, ...targetItems.map(({ bounds }) => bounds.y));
  const xMaximum = Math.max(
    logicalBounds.x + logicalBounds.width,
    ...targetItems.map(({ bounds }) => bounds.x + bounds.width),
  );
  const yMaximum = Math.max(
    logicalBounds.y + logicalBounds.height,
    ...targetItems.map(({ bounds }) => bounds.y + bounds.height),
  );
  // Text extraction reports advance bounds, while raster ink may overhang them.
  // Keep the fringe proportional to the source text height and bounded to the page.
  const fringe = Math.max(1, ...targetItems.map(({ bounds }) => bounds.height * 0.25));
  const left = Math.max(0, xMinimum - fringe);
  const bottom = Math.max(0, yMinimum - fringe);
  const right = Math.min(pageWidth, xMaximum + fringe);
  const top = Math.min(pageHeight, yMaximum + fringe);
  return Object.freeze({ x: left, y: bottom, width: right - left, height: top - bottom });
}

async function observeSource(
  bytes: Uint8Array,
  pageIndex: number,
  canvasFactory: ValidationCanvasFactory,
  limits: EngineLimits,
): Promise<Readonly<{
  items: readonly RuntimeTextItem[];
  render: RuntimeRenderEvidence;
}>> {
  let loadingTask: PDFDocumentLoadingTask | undefined;
  try {
    const ownedBytes: Uint8Array<ArrayBuffer> = new Uint8Array(bytes.byteLength);
    ownedBytes.set(bytes);
    loadingTask = getDocument({
      data: ownedBytes,
      useWasm: true,
      verbosity: 0,
      disableFontFace: true,
      CanvasFactory: pdfJsCanvasFactory(canvasFactory),
    });
    const document = await loadingTask.promise;
    if (!Number.isSafeInteger(pageIndex) || pageIndex < 0 || pageIndex >= document.numPages) {
      throw new Error('Target page is outside the source document');
    }
    const page = await document.getPage(pageIndex + 1);
    void pageSpaceFor(page);
    const items = await extractItems(page, pageIndex);
    const render = await renderPage(page, canvasFactory, limits);
    page.cleanup();
    return Object.freeze({ items, render });
  } finally {
    if (loadingTask !== undefined) await loadingTask.destroy();
  }
}

function extractionEvidence(
  items: readonly RuntimeTextItem[],
  expectation: MutationExpectation,
): RuntimeExtractionEvidence {
  const targetText = searchable(items
    .filter(({ bounds }) => intersects(bounds, expectation.targetBounds))
    .map(({ text }) => text)
    .join(''));
  const outsideText = searchable(items
    .filter(({ bounds }) => !intersects(bounds, expectation.targetBounds))
    .map(({ text }) => text)
    .join(' '));
  const oldText = searchable(expectation.oldText);
  const newText = searchable(expectation.newText);
  const oldTextOutsideTargetCount = countOccurrences(outsideText, oldText);
  return Object.freeze({
    items,
    targetText,
    oldTextAbsentAtTarget: oldText.length === 0 || !targetText.includes(oldText),
    newTextPresentAtTarget: newText.length === 0 || targetText.includes(newText),
    oldTextOutsideTargetCount,
    outsideTextPreserved: oldTextOutsideTargetCount === expectation.expectedOldTextOutsideTarget,
  });
}

function emptyEvidence(error: unknown): RuntimeValidationEvidence {
  const resourceError = error instanceof PdfEngineError && error.code === 'RESOURCE_LIMIT'
    ? Object.freeze({
        code: error.code,
        message: 'PDF.js validation exceeded a resource limit',
        ...(error.details === undefined ? {} : { details: error.details }),
      })
    : null;
  const message = error instanceof Error ? error.message : 'Unknown PDF.js validation failure';
  return Object.freeze({
    consumer: 'pdfjs',
    valid: false,
    checks: Object.freeze(['document-load-failed']),
    extraction: Object.freeze({
      items: Object.freeze([]),
      targetText: '',
      oldTextAbsentAtTarget: false,
      newTextPresentAtTarget: false,
      oldTextOutsideTargetCount: 0,
      outsideTextPreserved: false,
    }),
    render: Object.freeze({
      dpi: 144,
      width: 0,
      height: 0,
      pageWidth: 0,
      pageHeight: 0,
      rgba: new Uint8Array(),
    }),
    error: resourceError ?? Object.freeze({
      code: 'VALIDATION_FAILURE',
      message: 'PDF.js could not validate the candidate',
      details: Object.freeze({ cause: message.slice(0, 256) }),
    }),
  });
}

export async function validateCandidate(
  bytes: Uint8Array,
  expectation: MutationExpectation,
  canvasFactory: ValidationCanvasFactory = defaultCanvasFactory,
  limits: EngineLimits = PROVISIONAL_LIMITS,
): Promise<RuntimeValidationEvidence> {
  let document: PDFDocumentProxy | undefined;
  let loadingTask: PDFDocumentLoadingTask | undefined;
  try {
    if (typeof Worker !== 'undefined' && GlobalWorkerOptions.workerSrc.length === 0) {
      GlobalWorkerOptions.workerSrc = pdfWorkerUrl;
    }
    const ownedBytes: Uint8Array<ArrayBuffer> = new Uint8Array(bytes.byteLength);
    ownedBytes.set(bytes);
    loadingTask = getDocument({
      data: ownedBytes,
      useWasm: true,
      verbosity: 0,
      disableFontFace: true,
      CanvasFactory: pdfJsCanvasFactory(canvasFactory),
    });
    document = await loadingTask.promise;
    if (!Number.isSafeInteger(expectation.pageIndex)
        || expectation.pageIndex < 0
        || expectation.pageIndex >= document.numPages) {
      throw new Error('Target page is outside the candidate document');
    }
    const page = await document.getPage(expectation.pageIndex + 1);
    const items = await extractItems(page, expectation.pageIndex);
    const extraction = extractionEvidence(items, expectation);
    const render = await renderPage(page, canvasFactory, limits);
    page.cleanup();
    const valid = extraction.oldTextAbsentAtTarget
      && extraction.newTextPresentAtTarget
      && extraction.outsideTextPreserved;
    return Object.freeze({
      consumer: 'pdfjs',
      valid,
      checks: Object.freeze([
        'document-loaded',
        'page-rendered-144-dpi',
        extraction.oldTextAbsentAtTarget ? 'old-text-absent' : 'old-text-present-at-target',
        extraction.newTextPresentAtTarget ? 'new-text-present' : 'new-text-absent-at-target',
        extraction.outsideTextPreserved ? 'outside-text-preserved' : 'outside-text-changed',
      ]),
      extraction,
      render,
    });
  } catch (error) {
    return emptyEvidence(error);
  } finally {
    if (loadingTask !== undefined) await loadingTask.destroy();
  }
}

export async function validateCandidateAgainstSource(
  sourceBytes: Uint8Array,
  candidateBytes: Uint8Array,
  expectation: MutationExpectation,
  canvasFactory: ValidationCanvasFactory = defaultCanvasFactory,
  limits: EngineLimits = PROVISIONAL_LIMITS,
): Promise<RuntimeValidationEvidence> {
  const candidate = await validateCandidate(candidateBytes, expectation, canvasFactory, limits);
  try {
    const source = await observeSource(
      sourceBytes,
      expectation.pageIndex,
      canvasFactory,
      limits,
    );
    const authorisedBounds = expectation.authorisedBounds ?? expectation.targetBounds;
    const sourceOutsideText = outsideText(source.items, authorisedBounds);
    const candidateOutsideText = outsideText(candidate.extraction.items, authorisedBounds);
    const outsideTextPreserved = sourceOutsideText === candidateOutsideText;
    const rasterBounds = rasterAuthorisedBounds(
      authorisedBounds,
      expectation.targetBounds,
      source.items,
      source.render.pageWidth,
      source.render.pageHeight,
    );
    const outsideMismatchedPixels = outsidePixelMismatch(
      source.render,
      candidate.render,
      rasterBounds,
    );
    const outsidePixelsPreserved = outsideMismatchedPixels === 0;
    const renderGeometryPreserved = source.render.width === candidate.render.width
      && source.render.height === candidate.render.height
      && source.render.pageWidth === candidate.render.pageWidth
      && source.render.pageHeight === candidate.render.pageHeight;
    const structure = expectation.structure === undefined
      ? undefined
      : await validateCandidateStructure(
          sourceBytes,
          candidateBytes,
          expectation.pageIndex,
          expectation.newText,
          expectation.structure,
          limits,
        );
    const pageGeometryPreserved = renderGeometryPreserved
      && (structure?.pageGeometryPreserved ?? true);
    const sourceComparison = Object.freeze({
      pageGeometryPreserved,
      outsideTextPreserved,
      outsidePixelsPreserved,
      outsideMismatchedPixels,
      sourceOutsideText,
      candidateOutsideText,
    });
    const candidateTargetValid = candidate.error === undefined
      && candidate.extraction.oldTextAbsentAtTarget
      && candidate.extraction.newTextPresentAtTarget;
    const valid = candidateTargetValid
      && pageGeometryPreserved
      && outsideTextPreserved
      && outsidePixelsPreserved
      && (structure?.valid ?? true);
    const candidateChecks = candidate.checks.filter((check) =>
      check !== 'outside-text-preserved' && check !== 'outside-text-changed');
    return Object.freeze({
      ...candidate,
      valid,
      checks: Object.freeze([
        ...candidateChecks,
        pageGeometryPreserved ? 'page-geometry-preserved' : 'page-geometry-changed',
        outsideTextPreserved ? 'outside-text-identical' : 'outside-text-changed-from-source',
        outsidePixelsPreserved ? 'outside-pixels-preserved' : 'outside-pixels-changed',
        ...(structure?.checks ?? []),
      ]),
      sourceComparison,
      ...(structure === undefined ? {} : { structure }),
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Unknown source comparison failure';
    return Object.freeze({
      ...candidate,
      valid: false,
      checks: Object.freeze([...candidate.checks, 'source-comparison-failed']),
      error: Object.freeze({
        code: 'VALIDATION_FAILURE',
        message: 'PDF.js could not compare the candidate with its source',
        details: Object.freeze({ cause: message.slice(0, 256) }),
      }),
    });
  }
}
