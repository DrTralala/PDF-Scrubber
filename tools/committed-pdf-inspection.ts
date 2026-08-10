import { createHash } from 'node:crypto';

import {
  PDFArray,
  PDFBool,
  PDFDict,
  PDFDocument,
  PDFName,
  PDFNumber,
  PDFObject,
  PDFRawStream,
  PDFRef,
} from 'pdf-lib';

import {
  analysePage,
  canonicalPageSize,
  inspectEncryptionEvidence,
  ObjectStore,
  PROVISIONAL_LIMITS,
  tokeniseContentStream,
  type AnalysedPage,
  type AnalysedSpan,
  type CanonicalBounds,
  type ContentOperation,
  type PdfOperand,
  type StreamPathSegment,
} from '../packages/pdf-engine/src';
import { decodeStreamBytes } from '../packages/pdf-engine/src/pdf/stream-codecs';

export type ReferencedImageInspection = Readonly<{
  width: number;
  height: number;
  bitsPerComponent: number;
  colourSpace: string;
  decodedPayloadBytes: number;
  decodedStreamBytes: number;
  decodedContentSha256: string;
  uniqueByteCount: number;
  entropyBitsPerByte: number;
  isUseful: boolean;
  auxiliaryImages: readonly AuxiliaryImageInspection[];
  referenceCount: number;
}>;

export type AuxiliaryImageInspection = Readonly<{
  role: 'SMask' | 'Mask';
  width: number;
  height: number;
  bitsPerComponent: number;
  colourSpace: string;
  decodedPayloadBytes: number;
  decodedStreamBytes: number;
  decodedContentSha256: string;
  uniqueByteCount: number;
  entropyBitsPerByte: number;
}>;

export type VisibleTextMarkInspection = Readonly<{
  text: 'PDF-Scrubber QA';
  pageIndex: number;
  bounds: CanonicalBounds;
  renderingMode: number;
  fillOpacity: number;
  strokeOpacity: number;
}>;

export type CommittedPdfSemanticInspection = Readonly<{
  pageTexts: readonly string[];
  editableTextSizes: readonly number[];
  referencedImages: readonly ReferencedImageInspection[];
  visibleTextMarks: readonly VisibleTextMarkInspection[];
  prohibitedFeatures: readonly string[];
}>;

type MutableImageInspection = {
  width: number;
  height: number;
  bitsPerComponent: number;
  colourSpace: string;
  decodedPayloadBytes: number;
  decodedStreamBytes: number;
  decodedContentSha256: string;
  uniqueByteCount: number;
  entropyBitsPerByte: number;
  isUseful: boolean;
  auxiliaryImages: readonly AuxiliaryImageInspection[];
  referenceCount: number;
};

const MAX_IMAGE_PAYLOAD_BYTES = 4 * 1024 * 1024;
const MIN_USEFUL_IMAGE_UNIQUE_BYTES = 16;
const MIN_USEFUL_IMAGE_ENTROPY_BITS = 1;
const ACTION_NAMES = new Set([
  '/GoTo',
  '/GoToR',
  '/GoToE',
  '/Launch',
  '/Thread',
  '/URI',
  '/Sound',
  '/Movie',
  '/Hide',
  '/Named',
  '/SubmitForm',
  '/ResetForm',
  '/ImportData',
  '/JavaScript',
  '/SetOCGState',
  '/Rendition',
  '/Trans',
  '/GoTo3DView',
]);

function resolveObject(document: PDFDocument, value: PDFObject): PDFObject {
  if (!(value instanceof PDFRef)) return value;
  const resolved = document.context.lookup(value);
  if (resolved === undefined) throw new Error(`PDF reference ${value.toString()} is unresolved`);
  return resolved;
}

function requiredNumber(dictionary: PDFDict, key: string): number {
  const value = dictionary.lookupMaybe(PDFName.of(key), PDFNumber)?.asNumber();
  if (value === undefined || !Number.isSafeInteger(value) || value <= 0) {
    throw new Error(`Referenced image ${key} must be a positive integer`);
  }
  return value;
}

function dictionaryHas(dictionary: PDFDict, key: string): boolean {
  return dictionary.get(PDFName.of(key)) !== undefined;
}

function inspectProhibitedFeatures(
  document: PDFDocument,
  bytes: Uint8Array,
): readonly string[] {
  const prohibited = new Set<string>();
  if (inspectEncryptionEvidence(bytes).observed) prohibited.add('encryption');
  const visited = new Set<PDFObject>();

  const visit = (value: PDFObject): void => {
    const object = resolveObject(document, value);
    if (visited.has(object)) return;
    visited.add(object);

    if (object instanceof PDFArray) {
      for (const child of object.asArray()) visit(child);
      return;
    }

    const dictionary = object instanceof PDFRawStream
      ? object.dict
      : object instanceof PDFDict
        ? object
        : null;
    if (dictionary === null) return;

    const type = dictionary.lookupMaybe(PDFName.of('Type'), PDFName)?.asString();
    const subtype = dictionary.lookupMaybe(PDFName.of('Subtype'), PDFName)?.asString();
    const action = dictionary.lookupMaybe(PDFName.of('S'), PDFName)?.asString();
    if (subtype === '/Link' || dictionaryHas(dictionary, 'URI')) prohibited.add('links');
    if (
      type === '/Action'
      || action !== undefined && ACTION_NAMES.has(action)
      || dictionaryHas(dictionary, 'A')
      || dictionaryHas(dictionary, 'AA')
      || dictionaryHas(dictionary, 'OpenAction')
      || dictionaryHas(dictionary, 'Dest')
    ) {
      prohibited.add('actions');
    }
    if (
      subtype === '/Widget'
      || dictionaryHas(dictionary, 'AcroForm')
      || dictionaryHas(dictionary, 'FT')
    ) {
      prohibited.add('forms');
    }
    if (
      action === '/JavaScript'
      || dictionaryHas(dictionary, 'JS')
      || dictionaryHas(dictionary, 'JavaScript')
    ) {
      prohibited.add('JavaScript');
    }
    if (
      type === '/Filespec'
      || subtype === '/FileAttachment'
      || dictionaryHas(dictionary, 'EmbeddedFiles')
      || dictionaryHas(dictionary, 'EF')
      || dictionaryHas(dictionary, 'AF')
      || dictionaryHas(dictionary, 'FS')
    ) {
      prohibited.add('attachments');
    }

    for (const [, child] of dictionary.entries()) visit(child);
  };

  visit(document.catalog);
  for (const [, object] of document.context.enumerateIndirectObjects()) visit(object);
  return Object.freeze([...prohibited].sort());
}

type DecodedImageEvidence = Readonly<{
  width: number;
  height: number;
  bitsPerComponent: number;
  colourSpace: string;
  decodedPayloadBytes: number;
  decodedStreamBytes: number;
  decodedContentSha256: string;
  uniqueByteCount: number;
  entropyBitsPerByte: number;
}>;

function imageComponentCount(dictionary: PDFDict): Readonly<{
  count: number;
  name: string;
}> {
  const imageMask = dictionary.lookupMaybe(PDFName.of('ImageMask'), PDFBool)?.asBoolean() === true;
  if (imageMask) return Object.freeze({ count: 1, name: '/ImageMask' });
  const colourSpace = dictionary.lookupMaybe(PDFName.of('ColorSpace'), PDFName)?.asString();
  switch (colourSpace) {
    case '/DeviceGray':
      return Object.freeze({ count: 1, name: colourSpace });
    case '/DeviceRGB':
      return Object.freeze({ count: 3, name: colourSpace });
    case '/DeviceCMYK':
      return Object.freeze({ count: 4, name: colourSpace });
    default:
      throw new Error('Referenced image ColorSpace must be DeviceGray, DeviceRGB, or DeviceCMYK');
  }
}

function assertIdentityImageDecode(dictionary: PDFDict, componentCount: number): void {
  const decode = dictionary.lookupMaybe(PDFName.of('Decode'), PDFArray);
  if (decode === undefined) return;
  if (decode.size() !== componentCount * 2) {
    throw new Error('Referenced image Decode must be absent or identity');
  }
  for (let component = 0; component < componentCount; component += 1) {
    const minimum = decode.lookupMaybe(component * 2, PDFNumber)?.asNumber();
    const maximum = decode.lookupMaybe(component * 2 + 1, PDFNumber)?.asNumber();
    if (minimum !== 0 || maximum !== 1) {
      throw new Error('Referenced image Decode must be absent or identity');
    }
  }
}

function byteDistribution(bytes: Uint8Array): Readonly<{
  uniqueByteCount: number;
  entropyBitsPerByte: number;
}> {
  const counts = new Uint32Array(256);
  for (const value of bytes) counts[value] = (counts[value] ?? 0) + 1;
  let uniqueByteCount = 0;
  let entropyBitsPerByte = 0;
  for (const count of counts) {
    if (count === 0) continue;
    uniqueByteCount += 1;
    const probability = count / bytes.byteLength;
    entropyBitsPerByte -= probability * Math.log2(probability);
  }
  return Object.freeze({ uniqueByteCount, entropyBitsPerByte });
}

async function decodeImageEvidence(
  stream: PDFRawStream,
  role: 'primary' | 'SMask' | 'Mask',
): Promise<DecodedImageEvidence> {
  const width = requiredNumber(stream.dict, 'Width');
  const height = requiredNumber(stream.dict, 'Height');
  const { count: componentCount, name: colourSpace } = imageComponentCount(stream.dict);
  assertIdentityImageDecode(stream.dict, componentCount);
  const imageMask = colourSpace === '/ImageMask';
  const bitsPerComponent = imageMask
    ? stream.dict.lookupMaybe(PDFName.of('BitsPerComponent'), PDFNumber)?.asNumber() ?? 1
    : requiredNumber(stream.dict, 'BitsPerComponent');
  if (!Number.isSafeInteger(bitsPerComponent) || bitsPerComponent <= 0 || bitsPerComponent > 16) {
    throw new Error('Referenced image BitsPerComponent must be an integer from 1 through 16');
  }
  const decodeParameters = stream.dict.lookupMaybe(PDFName.of('DecodeParms'), PDFDict);
  const predictor = decodeParameters?.lookupMaybe(PDFName.of('Predictor'), PDFNumber)?.asNumber() ?? 1;
  if (predictor !== 1) {
    throw new Error('Referenced image predictor is unsupported by semantic pixel inspection');
  }
  const bitsPerRow = width * componentCount * bitsPerComponent;
  const decodedPayloadBytes = Math.ceil(bitsPerRow / 8) * height;
  const label = role === 'primary' ? 'Primary' : `Auxiliary ${role}`;
  if (!Number.isSafeInteger(decodedPayloadBytes) || decodedPayloadBytes > MAX_IMAGE_PAYLOAD_BYTES) {
    throw new Error(`${label} image payload exceeds 4 MiB`);
  }
  const decodedStream = await decodeStreamBytes(stream, MAX_IMAGE_PAYLOAD_BYTES);
  if (decodedStream.byteLength !== decodedPayloadBytes) {
    throw new Error(`${label} decoded image stream length does not match its pixel payload`);
  }
  const { uniqueByteCount, entropyBitsPerByte } = byteDistribution(decodedStream);
  return Object.freeze({
    width,
    height,
    bitsPerComponent,
    colourSpace,
    decodedPayloadBytes,
    decodedStreamBytes: decodedStream.byteLength,
    decodedContentSha256: createHash('sha256').update(decodedStream).digest('hex'),
    uniqueByteCount,
    entropyBitsPerByte,
  });
}

async function inspectImageAndMasks(
  document: PDFDocument,
  stream: PDFRawStream,
  role: 'primary' | 'SMask' | 'Mask',
  ancestors: ReadonlySet<PDFRawStream>,
): Promise<Readonly<{
  evidence: DecodedImageEvidence;
  auxiliaryImages: readonly AuxiliaryImageInspection[];
}>> {
  if (ancestors.has(stream)) throw new Error('Cyclic image mask graph');
  const nextAncestors = new Set(ancestors);
  nextAncestors.add(stream);
  const evidence = await decodeImageEvidence(stream, role);
  const auxiliaryImages: AuxiliaryImageInspection[] = [];

  for (const maskRole of ['SMask', 'Mask'] as const) {
    const value = stream.dict.get(PDFName.of(maskRole));
    if (value === undefined) continue;
    const object = resolveObject(document, value);
    if (object instanceof PDFArray || object instanceof PDFName) continue;
    if (
      !(object instanceof PDFRawStream)
      || object.dict.lookupMaybe(PDFName.of('Subtype'), PDFName)?.asString() !== '/Image'
    ) {
      throw new Error(`Referenced ${maskRole} must be an image stream or colour-key array`);
    }
    const inspected = await inspectImageAndMasks(
      document,
      object,
      maskRole,
      nextAncestors,
    );
    auxiliaryImages.push(Object.freeze({ role: maskRole, ...inspected.evidence }));
    auxiliaryImages.push(...inspected.auxiliaryImages);
  }

  return Object.freeze({
    evidence,
    auxiliaryImages: Object.freeze(auxiliaryImages),
  });
}

async function inspectReferencedImages(
  document: PDFDocument,
): Promise<readonly ReferencedImageInspection[]> {
  const images = new Map<PDFRawStream, MutableImageInspection>();

  const visitContent = async (
    stream: PDFRawStream,
    resources: PDFDict | undefined,
    ancestors: ReadonlySet<PDFRawStream>,
  ): Promise<void> => {
    if (ancestors.has(stream)) throw new Error('Cyclic Form XObject graph');
    const operations = tokeniseContentStream(
      await decodeStreamBytes(stream, PROVISIONAL_LIMITS.maxDecodedStreamBytes),
      PROVISIONAL_LIMITS,
    );
    const nextAncestors = new Set(ancestors);
    nextAncestors.add(stream);

    for (const operation of operations) {
      if (operation.operator !== 'Do') continue;
      const operand = operation.operands[0];
      if (operand?.kind !== 'name') throw new Error('Image/Form Do operation must name an XObject');
      const xObjects = resources?.lookupMaybe(PDFName.of('XObject'), PDFDict);
      const value = xObjects?.get(PDFName.of(operand.value));
      if (value === undefined) throw new Error(`Referenced XObject ${operand.value} is missing`);
      const xObject = resolveObject(document, value);
      if (!(xObject instanceof PDFRawStream)) {
        throw new Error(`Referenced XObject ${operand.value} is not a raw stream`);
      }
      const subtype = xObject.dict.lookupMaybe(PDFName.of('Subtype'), PDFName)?.asString();
      if (subtype === '/Form') {
        const formResources = xObject.dict.lookupMaybe(PDFName.of('Resources'), PDFDict) ?? resources;
        await visitContent(xObject, formResources, nextAncestors);
        continue;
      }
      if (subtype !== '/Image') continue;

      const previous = images.get(xObject);
      if (previous !== undefined) {
        previous.referenceCount += 1;
        continue;
      }
      const inspected = await inspectImageAndMasks(
        document,
        xObject,
        'primary',
        new Set(),
      );
      const isUseful = inspected.evidence.uniqueByteCount >= MIN_USEFUL_IMAGE_UNIQUE_BYTES
        && inspected.evidence.entropyBitsPerByte >= MIN_USEFUL_IMAGE_ENTROPY_BITS;
      images.set(xObject, {
        ...inspected.evidence,
        isUseful,
        auxiliaryImages: inspected.auxiliaryImages,
        referenceCount: 1,
      });
    }
  };

  for (const page of document.getPages()) {
    const contents = page.node.get(PDFName.of('Contents'));
    if (contents === undefined) continue;
    const resolvedContents = resolveObject(document, contents);
    const contentValues = resolvedContents instanceof PDFArray
      ? resolvedContents.asArray()
      : [resolvedContents];
    for (const value of contentValues) {
      const stream = resolveObject(document, value);
      if (!(stream instanceof PDFRawStream)) throw new Error('Page content is not a raw stream');
      await visitContent(stream, page.node.Resources(), new Set());
    }
  }

  return Object.freeze([...images.values()].map((image) => Object.freeze({ ...image })));
}

type PaintState = Readonly<{
  fillOpacity: number;
  strokeOpacity: number;
  softMaskActive: boolean;
  defaultClippingPath: boolean;
  textRenderingMode: number;
}>;

type TextClipState = Readonly<{
  inTextObject: boolean;
  clippingTextShown: boolean;
}>;

type PaintTraversal = Readonly<{
  state: PaintState;
  stack: readonly PaintState[];
  pendingClip: boolean;
  textClip: TextClipState;
  target: PaintState | null;
}>;

const DEFAULT_PAINT_STATE: PaintState = Object.freeze({
  fillOpacity: 1,
  strokeOpacity: 1,
  softMaskActive: false,
  defaultClippingPath: true,
  textRenderingMode: 0,
});

const DEFAULT_TEXT_CLIP_STATE: TextClipState = Object.freeze({
  inTextObject: false,
  clippingTextShown: false,
});

const PATH_ENDING_OPERATORS = new Set([
  'S',
  's',
  'f',
  'F',
  'f*',
  'B',
  'B*',
  'b',
  'b*',
  'n',
]);
const TEXT_SHOWING_OPERATORS = new Set(['Tj', 'TJ', "'", '"']);

function requireOperandCount(operation: ContentOperation, count: number): void {
  if (operation.operands.length !== count) {
    throw new Error(`${operation.operator} requires ${count} operands`);
  }
}

function requireActiveTextObject(textClip: TextClipState, operator: string): void {
  if (!textClip.inTextObject) throw new Error(`${operator} is not valid outside a text object`);
}

function textStringHasContent(operand: PdfOperand | undefined, operator: string): boolean {
  if (operand?.kind !== 'literalString' && operand?.kind !== 'hexString') {
    throw new Error(`${operator} requires a string operand`);
  }
  return operand.value.byteLength > 0;
}

function textShowingHasContent(operation: ContentOperation): boolean {
  switch (operation.operator) {
    case 'Tj':
    case "'":
      requireOperandCount(operation, 1);
      return textStringHasContent(operation.operands[0], operation.operator);
    case 'TJ': {
      requireOperandCount(operation, 1);
      const array = operation.operands[0];
      if (array?.kind !== 'array') throw new Error('TJ requires an array operand');
      let hasContent = false;
      for (const item of array.items) {
        if (item.kind === 'number') {
          if (!Number.isFinite(item.value)) throw new Error('TJ requires finite numeric adjustments');
          continue;
        }
        hasContent = textStringHasContent(item, operation.operator) || hasContent;
      }
      return hasContent;
    }
    case '"': {
      requireOperandCount(operation, 3);
      for (const operand of operation.operands.slice(0, 2)) {
        if (operand.kind !== 'number' || !Number.isFinite(operand.value)) {
          throw new Error('" requires two finite numeric operands and a string');
        }
      }
      return textStringHasContent(operation.operands[2], operation.operator);
    }
    default:
      throw new Error(`Unsupported text-showing operator ${operation.operator}`);
  }
}

function streamReference(
  document: PDFDocument,
  value: PDFObject,
  label: string,
): Readonly<{ reference: PDFRef; stream: PDFRawStream }> {
  if (!(value instanceof PDFRef)) throw new Error(`${label} must be an indirect stream`);
  const stream = resolveObject(document, value);
  if (!(stream instanceof PDFRawStream)) throw new Error(`${label} is not a raw stream`);
  return Object.freeze({ reference: value, stream });
}

function pageContentReferences(document: PDFDocument, pageIndex: number): readonly PDFRef[] {
  const contents = document.getPage(pageIndex).node.get(PDFName.of('Contents'));
  if (contents === undefined) return Object.freeze([]);
  const resolved = resolveObject(document, contents);
  const values = resolved instanceof PDFArray ? resolved.asArray() : [contents];
  return Object.freeze(values.map((value) => streamReference(
    document,
    value,
    'Page content',
  ).reference));
}

function sameStreamPath(
  left: readonly StreamPathSegment[],
  right: readonly StreamPathSegment[],
): boolean {
  return left.length === right.length && left.every((segment, index) => {
    const candidate = right[index];
    return candidate !== undefined
      && segment.kind === candidate.kind
      && segment.ref.objectNumber === candidate.ref.objectNumber
      && segment.ref.generationNumber === candidate.ref.generationNumber
      && segment.resourceName === candidate.resourceName;
  });
}

function opacity(value: PDFNumber | undefined, fallback: number, label: string): number {
  const result = value?.asNumber() ?? fallback;
  if (!Number.isFinite(result) || result < 0 || result > 1) {
    throw new Error(`${label} opacity must be between zero and one`);
  }
  return result;
}

function applyExtendedGraphicsState(
  document: PDFDocument,
  resources: PDFDict | undefined,
  resourceName: string,
  state: PaintState,
): PaintState {
  const states = resources?.lookupMaybe(PDFName.of('ExtGState'), PDFDict);
  const value = states?.get(PDFName.of(resourceName));
  if (value === undefined) throw new Error(`Referenced ExtGState ${resourceName} is missing`);
  const object = resolveObject(document, value);
  if (!(object instanceof PDFDict)) throw new Error(`Referenced ExtGState ${resourceName} is invalid`);
  const softMask = object.get(PDFName.of('SMask'));
  const softMaskActive = softMask === undefined
    ? state.softMaskActive
    : softMask instanceof PDFName && softMask.asString() === '/None'
      ? false
      : true;
  return Object.freeze({
    fillOpacity: opacity(
      object.lookupMaybe(PDFName.of('ca'), PDFNumber),
      state.fillOpacity,
      'Fill',
    ),
    strokeOpacity: opacity(
      object.lookupMaybe(PDFName.of('CA'), PDFNumber),
      state.strokeOpacity,
      'Stroke',
    ),
    softMaskActive,
    defaultClippingPath: state.defaultClippingPath,
    textRenderingMode: state.textRenderingMode,
  });
}

function assertTraversalComplete(
  scope: 'Form' | 'Page',
  stack: readonly PaintState[],
  pendingClip: boolean,
  textClip: TextClipState,
): void {
  if (stack.length !== 0) throw new Error(`${scope} graphics-state stack is not balanced`);
  if (pendingClip) throw new Error(`${scope} clipping path is not terminated`);
  if (textClip.inTextObject) throw new Error(`${scope} text object is not terminated`);
}

async function traversePaintState(
  document: PDFDocument,
  stream: PDFRawStream,
  resources: PDFDict | undefined,
  path: readonly StreamPathSegment[],
  initialState: PaintState,
  initialStack: readonly PaintState[],
  initialPendingClip: boolean,
  initialTextClip: TextClipState,
  target: AnalysedSpan,
  ancestors: ReadonlySet<PDFRawStream>,
): Promise<PaintTraversal> {
  if (ancestors.has(stream)) throw new Error('Cyclic Form XObject graph');
  const nextAncestors = new Set(ancestors);
  nextAncestors.add(stream);
  let state = initialState;
  const stack = [...initialStack];
  let pendingClip = initialPendingClip;
  let textClip = initialTextClip;
  let capturedTarget: PaintState | null = null;
  const operations = tokeniseContentStream(
    await decodeStreamBytes(stream, PROVISIONAL_LIMITS.maxDecodedStreamBytes),
    PROVISIONAL_LIMITS,
  );

  for (const operation of operations) {
    if (
      operation.index === target.address.operatorRange.start
      && sameStreamPath(path, target.address.streamPath)
      && capturedTarget === null
    ) {
      capturedTarget = state;
    }
    if (operation.operator === 'q') {
      stack.push(state);
      continue;
    }
    if (operation.operator === 'Q') {
      const restored = stack.pop();
      if (restored === undefined) throw new Error('Graphics-state stack underflow');
      state = restored;
      continue;
    }
    if (operation.operator === 'gs') {
      const operand = operation.operands[0];
      if (operand?.kind !== 'name') throw new Error('gs must name an ExtGState resource');
      state = applyExtendedGraphicsState(document, resources, operand.value, state);
      continue;
    }
    if (operation.operator === 'BT') {
      requireOperandCount(operation, 0);
      if (textClip.inTextObject) throw new Error('Nested text objects are unsupported');
      textClip = Object.freeze({ inTextObject: true, clippingTextShown: false });
      continue;
    }
    if (operation.operator === 'Tr') {
      requireActiveTextObject(textClip, operation.operator);
      requireOperandCount(operation, 1);
      const operand = operation.operands[0];
      if (
        operand?.kind !== 'number'
        || !Number.isSafeInteger(operand.value)
        || operand.value < 0
        || operand.value > 7
      ) {
        throw new Error('Tr requires an integer from zero through seven');
      }
      state = Object.freeze({ ...state, textRenderingMode: operand.value });
      continue;
    }
    if (TEXT_SHOWING_OPERATORS.has(operation.operator)) {
      requireActiveTextObject(textClip, operation.operator);
      const hasContent = textShowingHasContent(operation);
      if (state.textRenderingMode >= 4 && hasContent && !textClip.clippingTextShown) {
        textClip = Object.freeze({ ...textClip, clippingTextShown: true });
      }
      continue;
    }
    if (operation.operator === 'ET') {
      requireActiveTextObject(textClip, operation.operator);
      requireOperandCount(operation, 0);
      if (textClip.clippingTextShown) {
        state = Object.freeze({ ...state, defaultClippingPath: false });
      }
      textClip = DEFAULT_TEXT_CLIP_STATE;
      continue;
    }
    if (operation.operator === 'W' || operation.operator === 'W*') {
      pendingClip = true;
      continue;
    }
    if (PATH_ENDING_OPERATORS.has(operation.operator)) {
      if (pendingClip) {
        state = Object.freeze({ ...state, defaultClippingPath: false });
        pendingClip = false;
      }
      continue;
    }
    if (operation.operator !== 'Do') continue;
    const operand = operation.operands[0];
    if (operand?.kind !== 'name') throw new Error('Do must name an XObject resource');
    const xObjects = resources?.lookupMaybe(PDFName.of('XObject'), PDFDict);
    const value = xObjects?.get(PDFName.of(operand.value));
    if (value === undefined) throw new Error(`Referenced XObject ${operand.value} is missing`);
    const { reference, stream: xObject } = streamReference(document, value, 'Form XObject');
    if (xObject.dict.lookupMaybe(PDFName.of('Subtype'), PDFName)?.asString() !== '/Form') continue;
    const child = await traversePaintState(
      document,
      xObject,
      xObject.dict.lookupMaybe(PDFName.of('Resources'), PDFDict) ?? resources,
      [
        ...path,
        Object.freeze({
          kind: 'formXObject' as const,
          ref: Object.freeze({
            objectNumber: reference.objectNumber,
            generationNumber: reference.generationNumber,
          }),
          resourceName: operand.value,
        }),
      ],
      state,
      Object.freeze([]),
      false,
      DEFAULT_TEXT_CLIP_STATE,
      target,
      nextAncestors,
    );
    assertTraversalComplete('Form', child.stack, child.pendingClip, child.textClip);
    if (capturedTarget === null && child.target !== null) capturedTarget = child.target;
  }

  return Object.freeze({
    state,
    stack: Object.freeze(stack),
    pendingClip,
    textClip,
    target: capturedTarget,
  });
}

async function paintStateForSpan(
  document: PDFDocument,
  pageIndex: number,
  span: AnalysedSpan,
): Promise<PaintState | null> {
  const page = document.getPage(pageIndex);
  let state = DEFAULT_PAINT_STATE;
  let stack: readonly PaintState[] = Object.freeze([]);
  let pendingClip = false;
  let textClip = DEFAULT_TEXT_CLIP_STATE;
  let capturedTarget: PaintState | null = null;
  for (const reference of pageContentReferences(document, pageIndex)) {
    const stream = resolveObject(document, reference);
    if (!(stream instanceof PDFRawStream)) throw new Error('Page content is not a raw stream');
    const result = await traversePaintState(
      document,
      stream,
      page.node.Resources(),
      [Object.freeze({
        kind: 'pageContents' as const,
        ref: Object.freeze({
          objectNumber: reference.objectNumber,
          generationNumber: reference.generationNumber,
        }),
        resourceName: null,
      })],
      state,
      stack,
      pendingClip,
      textClip,
      span,
      new Set(),
    );
    if (capturedTarget === null && result.target !== null) capturedTarget = result.target;
    state = result.state;
    stack = result.stack;
    pendingClip = result.pendingClip;
    textClip = result.textClip;
  }
  assertTraversalComplete('Page', stack, pendingClip, textClip);
  return capturedTarget;
}

function boundsIntersectPage(bounds: CanonicalBounds, page: AnalysedPage): boolean {
  const [pageWidth, pageHeight] = canonicalPageSize(page.pageSpace);
  return [bounds.x, bounds.y, bounds.width, bounds.height].every(Number.isFinite)
    && bounds.width > 0
    && bounds.height > 0
    && bounds.x < pageWidth
    && bounds.y < pageHeight
    && bounds.x + bounds.width > 0
    && bounds.y + bounds.height > 0;
}

function renderingModePaints(mode: number, state: PaintState): boolean {
  if (!state.defaultClippingPath || state.softMaskActive || mode === 3 || mode === 7) return false;
  const fills = mode === 0 || mode === 2 || mode === 4 || mode === 6;
  const strokes = mode === 1 || mode === 2 || mode === 5 || mode === 6;
  return fills && state.fillOpacity > 0 || strokes && state.strokeOpacity > 0;
}

async function inspectVisibleTextMarks(
  document: PDFDocument,
  pages: readonly AnalysedPage[],
): Promise<readonly VisibleTextMarkInspection[]> {
  const marks: VisibleTextMarkInspection[] = [];
  for (const page of pages) {
    for (const span of page.spans) {
      if (span.unicode !== 'PDF-Scrubber QA' || !boundsIntersectPage(span.bounds, page)) continue;
      const paintState = await paintStateForSpan(document, page.pageIndex, span);
      if (paintState === null || !renderingModePaints(span.style.renderingMode, paintState)) continue;
      marks.push(Object.freeze({
        text: 'PDF-Scrubber QA',
        pageIndex: page.pageIndex,
        bounds: Object.freeze({ ...span.bounds }),
        renderingMode: span.style.renderingMode,
        fillOpacity: paintState.fillOpacity,
        strokeOpacity: paintState.strokeOpacity,
      }));
    }
  }
  return Object.freeze(marks);
}

export async function inspectCommittedPdfSemantics(
  bytes: Uint8Array,
): Promise<CommittedPdfSemanticInspection> {
  const store = await ObjectStore.open(bytes, PROVISIONAL_LIMITS);
  const analysedPages = await Promise.all(
    Array.from({ length: store.pageCount() }, (_value, pageIndex) => analysePage(store, pageIndex)),
  );
  const pageTexts = analysedPages.map((page) =>
    page.spans.map(({ unicode }) => unicode ?? '').join(''));
  const editableTextSizes = [...new Set(analysedPages.flatMap((page) =>
    page.spans
      .filter(({ capability, unicode }) => capability.kind !== 'readOnly' && unicode !== null)
      .map(({ fontSize }) => fontSize)))]
    .sort((left, right) => left - right);
  const document = await PDFDocument.load(bytes, {
    updateMetadata: false,
    throwOnInvalidObject: true,
  });

  return Object.freeze({
    pageTexts: Object.freeze(pageTexts),
    editableTextSizes: Object.freeze(editableTextSizes),
    referencedImages: await inspectReferencedImages(document),
    visibleTextMarks: await inspectVisibleTextMarks(document, analysedPages),
    prohibitedFeatures: inspectProhibitedFeatures(document, bytes),
  });
}
