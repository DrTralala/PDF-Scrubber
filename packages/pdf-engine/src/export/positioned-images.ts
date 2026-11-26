import {
  PDFArray,
  PDFDict,
  PDFImage,
  PDFName,
  PDFNumber,
  PDFDocument,
  PDFRawStream,
  PDFRef,
  PDFStream,
  concatTransformationMatrix,
  drawObject,
  popGraphicsState,
  pushGraphicsState,
} from 'pdf-lib';

import { tokeniseContentStream, type ContentOperation } from '../content/tokeniser';
import type { EngineLimits } from '../limits';
import {
  AmbiguousTransformError,
  multiply,
  type Matrix,
} from '../geometry/matrix';
import { canonicalToPdf, type PageSpace } from '../geometry/page-space';
import type { CanonicalBounds } from '../model';
import {
  detectDocumentPolicy,
  permitsUnstructuredImageInsertion,
  type DocumentPolicyEvidence,
} from '../pdf/policy';
import {
  OBJECT_STORE_ANALYSIS_ACCESS,
  ObjectStore,
} from '../pdf/object-store';
import { PdfEngineError } from '../pdf/stream-codecs';
import type {
  MutationExpectation,
  RuntimeValidationEvidence,
} from '../validation/pdfjs-validator';

export type PositionedImage = Readonly<{
  pageIndex: number;
  bounds: CanonicalBounds;
  format: 'png' | 'jpeg';
  bytes: Uint8Array;
}>;

export type PositionedImageDimensions = Readonly<{
  width: number;
  height: number;
  pixels: number;
  orientation: number;
}>;

type PreparedImage = Readonly<{
  placement: PositionedImage;
  key: string;
}>;

type EmbeddedImage = Readonly<{
  format: PositionedImage['format'];
  bytes: Uint8Array;
  image: PDFImage;
}>;

type PdfImageKey = Readonly<{
  format: PositionedImage['format'];
  bytes: Uint8Array;
}>;

type PositionedImageValidator = (
  sourceBytes: Uint8Array,
  candidateBytes: Uint8Array,
  expectation: MutationExpectation,
) => Promise<RuntimeValidationEvidence>;

function malformed(message: string): never {
  throw new PdfEngineError('MALFORMED_INPUT', message);
}

function resourceLimit(
  message: string,
  resource: 'fileBytes' | 'imagePixels' | 'operations' | 'indirectObjects',
  limit: number,
  observed: number,
): never {
  throw new PdfEngineError('RESOURCE_LIMIT', message, {
    resource,
    limit,
    ...(resource === 'fileBytes' ? { observedBytes: observed } :
      resource === 'imagePixels' ? { observedPixels: observed } :
        resource === 'operations' ? { observedOperations: observed } :
          { observedObjects: observed }),
  });
}

function uint32(bytes: Uint8Array, offset: number): number {
  return bytes[offset]! * 0x1000000
    + bytes[offset + 1]! * 0x10000
    + bytes[offset + 2]! * 0x100
    + bytes[offset + 3]!;
}

function pngDimensions(bytes: Uint8Array): PositionedImageDimensions {
  const signature = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
  if (
    bytes.byteLength < 24 ||
    signature.some((value, index) => bytes[index] !== value) ||
    uint32(bytes, 8) !== 13 ||
    bytes[12] !== 0x49 || bytes[13] !== 0x48 || bytes[14] !== 0x44 || bytes[15] !== 0x52
  ) return malformed('Positioned image is not a supported PNG');
  const width = uint32(bytes, 16);
  const height = uint32(bytes, 20);
  const pixels = width * height;
  if (width === 0 || height === 0 || !Number.isSafeInteger(pixels)) {
    return malformed('PNG dimensions are invalid');
  }
  return Object.freeze({ width, height, pixels, orientation: 1 });
}

function isJpegStartOfFrame(marker: number): boolean {
  return marker >= 0xc0 && marker <= 0xc3
    || marker >= 0xc5 && marker <= 0xc7
    || marker >= 0xc9 && marker <= 0xcb
    || marker >= 0xcd && marker <= 0xcf;
}

function jpegExifOrientation(
  bytes: Uint8Array,
  segmentOffset: number,
  segmentLength: number,
): number | null {
  const payload = segmentOffset + 2;
  const segmentEnd = segmentOffset + segmentLength;
  if (
    payload + 14 > segmentEnd
    || bytes[payload] !== 0x45
    || bytes[payload + 1] !== 0x78
    || bytes[payload + 2] !== 0x69
    || bytes[payload + 3] !== 0x66
    || bytes[payload + 4] !== 0
    || bytes[payload + 5] !== 0
  ) return null;

  const tiff = payload + 6;
  const littleEndian = bytes[tiff] === 0x49 && bytes[tiff + 1] === 0x49;
  const bigEndian = bytes[tiff] === 0x4d && bytes[tiff + 1] === 0x4d;
  if (!littleEndian && !bigEndian) return null;
  const read16 = (offset: number): number | null => {
    if (offset < tiff || offset + 2 > segmentEnd) return null;
    return littleEndian
      ? bytes[offset]! | bytes[offset + 1]! << 8
      : bytes[offset]! << 8 | bytes[offset + 1]!;
  };
  const read32 = (offset: number): number | null => {
    if (offset < tiff || offset + 4 > segmentEnd) return null;
    return littleEndian
      ? (bytes[offset]! | bytes[offset + 1]! << 8 | bytes[offset + 2]! << 16 | bytes[offset + 3]! << 24) >>> 0
      : bytes[offset]! * 0x1000000
        + bytes[offset + 1]! * 0x10000
        + bytes[offset + 2]! * 0x100
        + bytes[offset + 3]!;
  };
  const directoryOffset = read32(tiff + 4);
  if (directoryOffset === null) return null;
  const directory = tiff + directoryOffset;
  const entryCount = read16(directory);
  if (entryCount === null) return null;
  for (let index = 0; index < entryCount; index += 1) {
    const entry = directory + 2 + index * 12;
    if (entry + 12 > segmentEnd) return null;
    const tag = read16(entry);
    if (tag !== 0x0112) continue;
    const type = read16(entry + 2);
    const count = read32(entry + 4);
    if (type !== 3 || count !== 1) return null;
    const orientation = read16(entry + 8);
    return orientation !== null && orientation >= 1 && orientation <= 8
      ? orientation
      : null;
  }
  return null;
}

function jpegDimensions(bytes: Uint8Array): PositionedImageDimensions {
  if (bytes.byteLength < 4 || bytes[0] !== 0xff || bytes[1] !== 0xd8) {
    return malformed('Positioned image is not a supported JPEG');
  }
  let offset = 2;
  let orientation = 1;
  while (offset < bytes.byteLength) {
    if (bytes[offset] !== 0xff) return malformed('JPEG marker sequence is malformed');
    while (bytes[offset] === 0xff) offset += 1;
    const marker = bytes[offset++];
    if (marker === undefined || marker === 0x00 || marker === 0xd8 || marker === 0xd9) {
      return malformed('JPEG marker sequence is malformed');
    }
    if (marker === 0x01 || marker >= 0xd0 && marker <= 0xd7) continue;
    if (offset + 2 > bytes.byteLength) return malformed('JPEG segment is truncated');
    const length = bytes[offset]! * 256 + bytes[offset + 1]!;
    if (length < 2 || offset + length > bytes.byteLength) {
      return malformed('JPEG segment is truncated');
    }
    if (marker === 0xe1) {
      orientation = jpegExifOrientation(bytes, offset, length) ?? orientation;
    }
    if (isJpegStartOfFrame(marker)) {
      if (length < 7) return malformed('JPEG frame header is truncated');
      const height = bytes[offset + 3]! * 256 + bytes[offset + 4]!;
      const width = bytes[offset + 5]! * 256 + bytes[offset + 6]!;
      const pixels = width * height;
      if (width === 0 || height === 0 || !Number.isSafeInteger(pixels)) {
        return malformed('JPEG dimensions are invalid');
      }
      return Object.freeze({ width, height, pixels, orientation });
    }
    offset += length;
  }
  return malformed('JPEG does not contain a supported frame');
}

/** Reads PNG/JPEG dimensions without decoding raster pixels. */
export function parsePositionedImageDimensions(
  bytes: Uint8Array,
  format: PositionedImage['format'],
): PositionedImageDimensions {
  if (!(bytes instanceof Uint8Array) || bytes.byteLength === 0) {
    return malformed('Positioned image bytes must be a non-empty byte array');
  }
  return format === 'png' ? pngDimensions(bytes) : jpegDimensions(bytes);
}

function sameBytes(left: Uint8Array, right: Uint8Array): boolean {
  if (left.byteLength !== right.byteLength) return false;
  return left.every((value, index) => value === right[index]);
}

function imageKey(format: PositionedImage['format'], bytes: Uint8Array): string {
  let first = 0x811c9dc5;
  let second = 0x9e3779b9;
  for (const byte of bytes) {
    first = Math.imul(first ^ byte, 0x01000193);
    second = Math.imul(second ^ byte, 0x85ebca6b);
  }
  return `${format}:${bytes.byteLength}:${first >>> 0}:${second >>> 0}`;
}

function validateBounds(bounds: unknown): asserts bounds is CanonicalBounds {
  if (bounds === null || typeof bounds !== 'object') {
    malformed('Positioned image bounds must be an object');
  }
  const candidate = bounds as Partial<CanonicalBounds>;
  if (
    ![candidate.x, candidate.y, candidate.width, candidate.height].every(Number.isFinite) ||
    candidate.width! <= 0 || candidate.height! <= 0
  ) malformed('Positioned image bounds must be finite and have positive dimensions');
  if (
    !Number.isFinite(candidate.x! + candidate.width!) ||
    !Number.isFinite(candidate.y! + candidate.height!)
  ) malformed('Positioned image edges must be finite');
}

function pageSpace(page: ReturnType<PDFDocument['getPage']>): PageSpace {
  const media = page.getMediaBox();
  const crop = page.getCropBox();
  const userUnit = page.node.lookupMaybe(PDFName.of('UserUnit'), PDFNumber)?.asNumber() ?? 1;
  return Object.freeze({
    mediaBox: Object.freeze([
      media.x,
      media.y,
      media.x + media.width,
      media.y + media.height,
    ]) as PageSpace['mediaBox'],
    cropBox: Object.freeze([
      crop.x,
      crop.y,
      crop.x + crop.width,
      crop.y + crop.height,
    ]) as PageSpace['mediaBox'],
    rotate: page.getRotation().angle,
    userUnit,
  });
}

function assertSameMetadata(
  source: PDFDocument,
  output: PDFDocument,
): void {
  const sourceInfoRef = source.context.trailerInfo.Info;
  const outputInfoRef = output.context.trailerInfo.Info;
  if ((sourceInfoRef === undefined) !== (outputInfoRef === undefined)) {
    throw new PdfEngineError('VALIDATION_FAILURE', 'Image export changed Info dictionary presence');
  }
  if (sourceInfoRef !== undefined && outputInfoRef !== undefined) {
    const sourceInfo = source.context.lookup(sourceInfoRef);
    const outputInfo = output.context.lookup(outputInfoRef);
    if (!(sourceInfo instanceof PDFDict) || !(outputInfo instanceof PDFDict)) {
      throw new PdfEngineError('VALIDATION_FAILURE', 'Image export produced an invalid Info dictionary');
    }
    const left = sourceInfo.entries();
    const right = outputInfo.entries();
    if (
      left.length !== right.length ||
      left.some(([name, value]) => outputInfo.get(name)?.toString() !== value.toString())
    ) {
      throw new PdfEngineError('VALIDATION_FAILURE', 'Image export changed Info dictionary values');
    }
  }

  const sourceMetadata = source.catalog.get(PDFName.of('Metadata'));
  const outputMetadata = output.catalog.get(PDFName.of('Metadata'));
  if ((sourceMetadata === undefined) !== (outputMetadata === undefined)) {
    throw new PdfEngineError('VALIDATION_FAILURE', 'Image export changed catalog Metadata presence');
  }
  if (sourceMetadata !== undefined && outputMetadata !== undefined) {
    const sourceStream = source.context.lookup(sourceMetadata);
    const outputStream = output.context.lookup(outputMetadata);
    if (
      !(sourceStream instanceof PDFRawStream) ||
      !(outputStream instanceof PDFRawStream) ||
      !sameBytes(sourceStream.contents, outputStream.contents)
    ) {
      throw new PdfEngineError('VALIDATION_FAILURE', 'Image export changed raw XMP metadata bytes');
    }
  }
}

function assertSamePolicy(
  source: DocumentPolicyEvidence,
  output: DocumentPolicyEvidence,
): void {
  if (JSON.stringify(source) !== JSON.stringify(output)) {
    throw new PdfEngineError('VALIDATION_FAILURE', 'Image export changed detected document policy evidence');
  }
}

function outputValidationFailure(message: string): never {
  throw new PdfEngineError('VALIDATION_FAILURE', message);
}

function pdfObjectMismatch(
  leftDocument: PDFDocument,
  leftValue: unknown,
  rightDocument: PDFDocument,
  rightValue: unknown,
  visitedReferences: ReadonlySet<string> = new Set(),
  path = 'root',
): string | null {
  let visited = visitedReferences;
  if (leftValue instanceof PDFRef && rightValue instanceof PDFRef) {
    const pair = `${leftValue.objectNumber}:${leftValue.generationNumber}|${rightValue.objectNumber}:${rightValue.generationNumber}`;
    if (visited.has(pair)) return null;
    visited = new Set([...visited, pair]);
  }
  const left = leftValue instanceof PDFRef
    ? leftDocument.context.lookup(leftValue)
    : leftValue;
  const right = rightValue instanceof PDFRef
    ? rightDocument.context.lookup(rightValue)
    : rightValue;
  if (left instanceof PDFRawStream || right instanceof PDFRawStream) {
    if (!(left instanceof PDFRawStream) || !(right instanceof PDFRawStream)) return path;
    if (!sameBytes(left.contents, right.contents)) return `${path} stream bytes`;
    return pdfObjectMismatch(leftDocument, left.dict, rightDocument, right.dict, visited, `${path} dictionary`);
  }
  if (left instanceof PDFDict || right instanceof PDFDict) {
    if (!(left instanceof PDFDict) || !(right instanceof PDFDict)) return path;
    const leftEntries = left.entries().filter(([key]) => key.asString() !== '/Length').sort(([first], [second]) =>
      first.asString().localeCompare(second.asString()));
    const rightEntries = right.entries().filter(([key]) => key.asString() !== '/Length').sort(([first], [second]) =>
      first.asString().localeCompare(second.asString()));
    if (leftEntries.length !== rightEntries.length) {
      const leftKeys = leftEntries.map(([key]) => key.asString()).join(',');
      const rightKeys = rightEntries.map(([key]) => key.asString()).join(',');
      return `${path} dictionary entries (${leftKeys} vs ${rightKeys})`;
    }
    for (let index = 0; index < leftEntries.length; index += 1) {
      const [key, value] = leftEntries[index]!;
      const rightEntry = rightEntries[index];
      if (rightEntry === undefined || key.asString() !== rightEntry[0].asString()) {
        return `${path} dictionary keys`;
      }
      const mismatch = pdfObjectMismatch(
        leftDocument,
        value,
        rightDocument,
        rightEntry[1],
        visited,
        `${path}/${key.asString()}`,
      );
      if (mismatch !== null) return mismatch;
    }
    return null;
  }
  if (left instanceof PDFArray || right instanceof PDFArray) {
    if (!(left instanceof PDFArray) || !(right instanceof PDFArray)) return path;
    if (left.size() !== right.size()) return `${path} array length`;
    for (let index = 0; index < left.size(); index += 1) {
      const mismatch = pdfObjectMismatch(
          leftDocument,
          left.get(index),
          rightDocument,
          right.get(index),
          visited,
          `${path}[${index}]`,
        );
      if (mismatch !== null) return mismatch;
    }
    return null;
  }
  return String(left) === String(right) ? null : path;
}

function closeEnough(actual: number, expected: number): boolean {
  return Math.abs(actual - expected) <= 1e-8 * Math.max(1, Math.abs(expected));
}

async function assertPositionedImageContent(
  store: ObjectStore,
  placements: readonly PreparedImage[],
  limits: EngineLimits,
): Promise<void> {
  const { document } = store[OBJECT_STORE_ANALYSIS_ACCESS]();
  const expectedDocument = await PDFDocument.create();
  const expectedImages = new Map<string, EmbeddedImage[]>();
  const expectedImage = async (prepared: PreparedImage): Promise<PDFImage> => {
    const { placement, key } = prepared;
    const bucket = expectedImages.get(key) ?? [];
    const existing = bucket.find(({ format, bytes }) =>
      format === placement.format && sameBytes(bytes, placement.bytes));
    if (existing !== undefined) return existing.image;
    const image = await (placement.format === 'png'
      ? expectedDocument.embedPng(new Uint8Array(placement.bytes))
      : expectedDocument.embedJpg(new Uint8Array(placement.bytes)));
    await image.embed();
    bucket.push(Object.freeze({
      format: placement.format,
      bytes: new Uint8Array(placement.bytes),
      image,
    }));
    expectedImages.set(key, bucket);
    return image;
  };

  for (let pageIndex = 0; pageIndex < document.getPageCount(); pageIndex += 1) {
    const pagePlacements = placements.filter(({ placement }) => placement.pageIndex === pageIndex);
    if (pagePlacements.length === 0) continue;
    const pageStreams = store.listPageStreams(pageIndex).filter(({ path }) =>
      path.length === 1 && path[0]?.kind === 'pageContents');
    const appended = pageStreams[pageStreams.length - 1];
    if (appended === undefined) {
      outputValidationFailure('Positioned image output is missing its appended drawing stream');
    }

    let operations: readonly ContentOperation[];
    try {
      operations = tokeniseContentStream(appended.decodedBytes, limits);
    } catch {
      outputValidationFailure('Positioned image output contains an unreadable drawing stream');
    }
    if (operations.length !== pagePlacements.length * 4) {
      outputValidationFailure('Positioned image output has an unexpected number of drawing operations');
    }

    const page = document.getPage(pageIndex);
    const xObjects = page.node.Resources()?.lookupMaybe(PDFName.of('XObject'), PDFDict);
    for (let index = 0; index < pagePlacements.length; index += 1) {
      const start = index * 4;
      const save = operations[start];
      const transform = operations[start + 1];
      const draw = operations[start + 2];
      const restore = operations[start + 3];
      if (
        save?.operator !== 'q'
        || transform?.operator !== 'cm'
        || draw?.operator !== 'Do'
        || restore?.operator !== 'Q'
        || transform.operands.length !== 6
        || !transform.operands.every((operand) => operand.kind === 'number')
        || draw.operands.length !== 1
        || draw.operands[0]?.kind !== 'name'
      ) {
        outputValidationFailure('Positioned image output drawing operators are missing or malformed');
      }

      const prepared = pagePlacements[index]!;
      const { placement } = prepared;
      const expectedMatrix = multiply(
        canonicalToPdf(pageSpace(page)),
        [
          placement.bounds.width,
          0,
          0,
          placement.bounds.height,
          placement.bounds.x,
          placement.bounds.y,
        ],
      );
      const actualMatrix = transform.operands.map((operand) =>
        operand.kind === 'number' ? operand.value : Number.NaN);
      if (!expectedMatrix.every((value, matrixIndex) =>
        closeEnough(actualMatrix[matrixIndex]!, value))) {
        outputValidationFailure('Positioned image output drawing transform does not match its requested placement');
      }

      const resourceName = draw.operands[0].value;
      const imageEntry = xObjects?.lookupMaybe(PDFName.of(resourceName), PDFStream);
      if (
        !(imageEntry instanceof PDFRawStream)
        || imageEntry.dict.lookupMaybe(PDFName.of('Subtype'), PDFName)?.asString() !== '/Image'
      ) {
        outputValidationFailure('Positioned image output does not reference its image resource');
      }
      const embeddedImage = imageEntry;
      const dimensions = parsePositionedImageDimensions(placement.bytes, placement.format);
      if (
        embeddedImage.dict.lookupMaybe(PDFName.of('Width'), PDFNumber)?.asNumber() !== dimensions.width
        || embeddedImage.dict.lookupMaybe(PDFName.of('Height'), PDFNumber)?.asNumber() !== dimensions.height
      ) {
        outputValidationFailure('Positioned image output image dimensions do not match the requested image');
      }
      const expected = await expectedImage(prepared);
      const imageMismatch = pdfObjectMismatch(
        expectedDocument,
        expected.ref,
        document,
        embeddedImage,
      );
      if (imageMismatch !== null) {
        outputValidationFailure(`Positioned image output embedded content does not match the requested image (${imageMismatch})`);
      }
    }
  }
}

function isolatePageXObjectResources(document: PDFDocument, pageIndex: number): void {
  const page = document.getPage(pageIndex);
  const resourceEntry = page.node.getInheritableAttribute(PDFName.of('Resources'));
  const inheritedResources = document.context.lookupMaybe(resourceEntry, PDFDict);
  if (resourceEntry !== undefined && inheritedResources === undefined) {
    malformed('Page resources are not a PDF dictionary');
  }
  const resources = inheritedResources?.clone(document.context) ?? PDFDict.withContext(document.context);
  const xObjectEntry = resources.get(PDFName.of('XObject'));
  const inheritedXObjects = resources.lookupMaybe(PDFName.of('XObject'), PDFDict);
  if (xObjectEntry !== undefined && inheritedXObjects === undefined) {
    malformed('Page XObject resources are not a PDF dictionary');
  }
  resources.set(
    PDFName.of('XObject'),
    inheritedXObjects?.clone(document.context) ?? PDFDict.withContext(document.context),
  );
  page.node.set(PDFName.of('Resources'), resources);
}

function authorisedBoundsByPage(
  images: readonly PreparedImage[],
): ReadonlyMap<number, CanonicalBounds> {
  const edges = new Map<number, { left: number; bottom: number; right: number; top: number }>();
  for (const { placement } of images) {
    const { x, y, width, height } = placement.bounds;
    const right = x + width;
    const top = y + height;
    const bounds = edges.get(placement.pageIndex);
    edges.set(placement.pageIndex, bounds === undefined
      ? { left: x, bottom: y, right, top }
      : {
          left: Math.min(bounds.left, x),
          bottom: Math.min(bounds.bottom, y),
          right: Math.max(bounds.right, right),
          top: Math.max(bounds.top, top),
        });
  }
  return new Map([...edges].map(([pageIndex, bounds]) => {
    const width = bounds.right - bounds.left;
    const height = bounds.top - bounds.bottom;
    if (!Number.isFinite(width) || !Number.isFinite(height)) {
      malformed('Positioned image group bounds must be finite');
    }
    return [pageIndex, Object.freeze({
      x: bounds.left,
      y: bounds.bottom,
      width,
      height,
    })];
  }));
}

function prepareImages(
  placements: readonly PositionedImage[],
  document: PDFDocument,
  limits: EngineLimits,
): readonly PreparedImage[] {
  if (!Array.isArray(placements) || placements.length === 0) {
    malformed('At least one positioned image is required');
  }
  const operationCount = placements.length * 4;
  if (!Number.isSafeInteger(operationCount) || operationCount > limits.maxOperationsPerStream) {
    resourceLimit(
      'Positioned image export exceeds the PDF operation limit',
      'operations',
      limits.maxOperationsPerStream,
      operationCount,
    );
  }

  let totalEncodedBytes = 0;
  let totalPixels = 0;
  const prepared: PreparedImage[] = [];
  const uniqueImages = new Map<string, PdfImageKey[]>();
  for (const placement of placements) {
    if (
      placement === null || typeof placement !== 'object' ||
      !Number.isSafeInteger(placement.pageIndex) ||
      placement.pageIndex < 0 || placement.pageIndex >= document.getPageCount()
    ) malformed('Positioned image page index is outside the open document');
    if (placement.format !== 'png' && placement.format !== 'jpeg') {
      malformed('Positioned image format must be PNG or JPEG');
    }
    if (!(placement.bytes instanceof Uint8Array) || placement.bytes.byteLength === 0) {
      malformed('Positioned image bytes must be a non-empty byte array');
    }
    validateBounds(placement.bounds);
    if (placement.bytes.byteLength > limits.maxFileBytes) {
      resourceLimit(
        'Positioned image exceeds the encoded byte limit',
        'fileBytes',
        limits.maxFileBytes,
        placement.bytes.byteLength,
      );
    }
    const dimensions = parsePositionedImageDimensions(placement.bytes, placement.format);
    if (dimensions.pixels > limits.maxImagePixels) {
      resourceLimit(
        'Positioned image exceeds the pixel limit',
        'imagePixels',
        limits.maxImagePixels,
        dimensions.pixels,
      );
    }
    const key = imageKey(placement.format, placement.bytes);
    const bucket = uniqueImages.get(key) ?? [];
    const isNewImage = !bucket.some(({ format, bytes }) =>
      format === placement.format && sameBytes(bytes, placement.bytes));
    if (isNewImage) {
      bucket.push({ format: placement.format, bytes: placement.bytes });
      uniqueImages.set(key, bucket);
      totalEncodedBytes += placement.bytes.byteLength;
      if (!Number.isSafeInteger(totalEncodedBytes) || totalEncodedBytes > limits.maxFileBytes) {
        resourceLimit(
          'Positioned images exceed the aggregate encoded byte limit',
          'fileBytes',
          limits.maxFileBytes,
          totalEncodedBytes,
        );
      }
      totalPixels += dimensions.pixels;
      if (!Number.isSafeInteger(totalPixels) || totalPixels > limits.maxImagePixels) {
        resourceLimit(
          'Positioned images exceed the aggregate pixel limit',
          'imagePixels',
          limits.maxImagePixels,
          totalPixels,
        );
      }
    }
    prepared.push(Object.freeze({
      placement,
      key,
    }));
  }
  return Object.freeze(prepared);
}

function placementMatrix(page: ReturnType<PDFDocument['getPage']>, bounds: CanonicalBounds): Matrix {
  try {
    const matrix = multiply(canonicalToPdf(pageSpace(page)), [
      bounds.width,
      0,
      0,
      bounds.height,
      bounds.x,
      bounds.y,
    ]);
    if (matrix.some((value) => !Number.isFinite(value))) {
      malformed('Positioned image transform is not finite');
    }
    return matrix;
  } catch (error) {
    if (error instanceof AmbiguousTransformError) {
      throw new PdfEngineError(
        'UNSUPPORTED_DOCUMENT',
        'Page geometry cannot be used for positioned image export',
        { reason: error.message },
      );
    }
    throw error;
  }
}

/**
 * Composes placed images on a fresh copy of the currently validated document bytes.
 * The supplied bytes and placements are never mutated or retained.
 */
export async function composePositionedImages(
  sourceBytes: Uint8Array,
  placements: readonly PositionedImage[],
  limits: EngineLimits,
  validator: PositionedImageValidator,
): Promise<Uint8Array> {
  const store = await ObjectStore.open(sourceBytes, limits);
  const { document } = store[OBJECT_STORE_ANALYSIS_ACCESS]();
  const sourcePolicy = await detectDocumentPolicy(store);
  if (!permitsUnstructuredImageInsertion(sourcePolicy)) {
    throw new PdfEngineError(
      'UNSUPPORTED_DOCUMENT',
      'Cannot add untagged images to tagged or PDF/UA PDFs without updating their accessibility structure',
      { reason: 'untaggedImageInTaggedDocument' },
    );
  }
  const prepared = prepareImages(placements, document, limits);
  const uniqueImageKeys = new Map<string, PdfImageKey[]>();
  let uniqueImageCount = 0;
  for (const { placement, key } of prepared) {
    const bucket = uniqueImageKeys.get(key) ?? [];
    if (!bucket.some(({ format, bytes }) =>
      format === placement.format && sameBytes(bytes, placement.bytes))) {
      bucket.push({ format: placement.format, bytes: placement.bytes });
      uniqueImageCount += 1;
      uniqueImageKeys.set(key, bucket);
    }
  }
  const existingObjectCount = document.context.enumerateIndirectObjects().length;
  if (existingObjectCount + uniqueImageCount > limits.maxObjects) {
    resourceLimit(
      'Positioned image export would exceed the PDF object limit',
      'indirectObjects',
      limits.maxObjects,
      existingObjectCount + uniqueImageCount,
    );
  }
  const embedded = new Map<string, EmbeddedImage[]>();
  const resourceNames = new Map<number, Map<PDFImage, string>>();

  for (const { placement, key } of prepared) {
    const cached = embedded.get(key)?.find(({ format, bytes }) =>
      format === placement.format && sameBytes(bytes, placement.bytes));
    let image = cached?.image;
    if (image === undefined) {
      try {
        image = await (placement.format === 'png'
          ? document.embedPng(new Uint8Array(placement.bytes))
          : document.embedJpg(new Uint8Array(placement.bytes)));
      } catch {
        malformed(`Positioned ${placement.format.toUpperCase()} image could not be decoded`);
      }
    }
    if (cached === undefined) {
      const copies = embedded.get(key) ?? [];
      copies.push(Object.freeze({
        format: placement.format,
        bytes: new Uint8Array(placement.bytes),
        image,
      }));
      embedded.set(key, copies);
    }
    let pageResources = resourceNames.get(placement.pageIndex);
    if (pageResources === undefined) {
      pageResources = new Map();
      resourceNames.set(placement.pageIndex, pageResources);
    }
    let resourceName = pageResources.get(image);
    if (resourceName === undefined) {
      const page = document.getPage(placement.pageIndex);
      isolatePageXObjectResources(document, placement.pageIndex);
      resourceName = page.node.newXObject('M0Image', image.ref).decodeText();
      pageResources.set(image, resourceName);
    }
    const matrix = placementMatrix(document.getPage(placement.pageIndex), placement.bounds);
    document.getPage(placement.pageIndex).pushOperators(
      pushGraphicsState(),
      concatTransformationMatrix(...matrix),
      drawObject(resourceName),
      popGraphicsState(),
    );
  }

  const bytes = await store.serialiseCandidate();
  if (bytes.byteLength > limits.maxFileBytes) {
    resourceLimit(
      'Positioned image export exceeds the PDF byte limit',
      'fileBytes',
      limits.maxFileBytes,
      bytes.byteLength,
    );
  }
  const reopened = await ObjectStore.open(bytes, limits);
  const reopenedDocument = reopened[OBJECT_STORE_ANALYSIS_ACCESS]().document;
  if (reopenedDocument.getPageCount() !== document.getPageCount()) {
    throw new PdfEngineError('VALIDATION_FAILURE', 'Image export changed the page count');
  }
  assertSameMetadata(document, reopenedDocument);
  assertSamePolicy(sourcePolicy, await detectDocumentPolicy(reopened));
  await assertPositionedImageContent(reopened, prepared, limits);
  for (const [pageIndex, bounds] of authorisedBoundsByPage(prepared)) {
    const expectation: MutationExpectation = Object.freeze({
      pageIndex,
      targetBounds: bounds,
      authorisedBounds: bounds,
      oldText: '',
      newText: '',
      expectedOldTextOutsideTarget: 0,
    });
    let evidence: RuntimeValidationEvidence;
    try {
      evidence = await validator(sourceBytes, bytes, expectation);
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Unknown runtime validation failure';
      throw new PdfEngineError('VALIDATION_FAILURE', 'Positioned image output could not be validated', {
        cause: message.slice(0, 256),
      });
    }
    if (!evidence.valid) {
      const cause = evidence.error?.details?.cause;
      throw new PdfEngineError('VALIDATION_FAILURE', 'Positioned image output failed runtime validation', {
        cause: typeof cause === 'string' ? cause : evidence.checks.join(','),
      });
    }
  }
  return bytes;
}
