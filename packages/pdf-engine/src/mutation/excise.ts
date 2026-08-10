import { analysePage } from '../analysis/analyse-page';
import { decodeTextOperand, rewriteTextOperand } from '../content/operands';
import { parseControlledRedraw } from '../content/controlled-redraw';
import { type ContentOperation, type PdfOperand, tokeniseContentStream } from '../content/tokeniser';
import type { EngineErrorCode, EngineErrorDescriptor } from '../errors';
import { fingerprint } from '../fingerprint';
import { groupPageText } from '../layout/group-lines';
import { buildTextSelection } from '../layout/selection';
import {
  decorationGraphicAddressKey,
  spanAddressKey,
  type AnalysedSpan,
  type MatchedSourceDecoration,
  type SpanAddress,
  type TextSelection,
} from '../model';
import {
  OBJECT_STORE_ANALYSIS_ACCESS,
  type ObjectStore,
} from '../pdf/object-store';
import {
  applyStreamPatches,
  StreamPatchError,
  type StreamPatch,
} from './stream-patches';

export type MutationPreconditions = Readonly<{
  expectedOperatorDigest: string;
  expectedGlyphText: string;
}>;

export type ExcisionInput = Readonly<{
  pageIndex: number;
  span: AnalysedSpan;
  currentRevision: number;
  expectedRevision: number;
  preconditions: MutationPreconditions;
}>;

export type ExcisionPreview = Readonly<{
  replacementStreamBytes: Uint8Array;
  removedSourceBytes: Uint8Array;
  operatorDigest: string;
}>;

export type ExcisionResult = Readonly<{
  removedSourceBytes: Uint8Array;
  operatorDigest: string;
}>;

export type SelectionSlicePrecondition = MutationPreconditions & Readonly<{
  addressKey: string;
}>;

export type SelectionMutationPreconditions = Readonly<{
  slices: readonly SelectionSlicePrecondition[];
  decorations: readonly Readonly<{
    addressKey: string;
    expectedOperatorDigest: string;
  }>[];
}>;

export type SelectionExcisionInput = Readonly<{
  pageIndex: number;
  selection: TextSelection;
  currentRevision: number;
  expectedRevision: number;
  preconditions: SelectionMutationPreconditions;
}>;

export type SelectionExcisionPreview = Readonly<{
  streamReplacements: readonly Readonly<{
    streamPath: SpanAddress['streamPath'];
    replacementStreamBytes: Uint8Array;
  }>[];
  removedSourceBytes: Uint8Array;
  operatorDigests: readonly string[];
  decorationDigests: readonly string[];
}>;

export type SelectionExcisionResult = Readonly<{
  removedSourceBytes: Uint8Array;
  operatorDigests: readonly string[];
  decorationDigests: readonly string[];
}>;

export class MutationError extends Error implements EngineErrorDescriptor {
  readonly code: EngineErrorCode;
  readonly details?: Readonly<Record<string, string | number | boolean | null>>;

  constructor(
    code: EngineErrorCode,
    message: string,
    details?: Readonly<Record<string, string | number | boolean | null>>,
  ) {
    super(message);
    this.name = 'MutationError';
    this.code = code;
    if (details !== undefined) this.details = details;
  }
}

const encoder = new TextEncoder();

function concatenate(parts: readonly Uint8Array[]): Uint8Array {
  const output = new Uint8Array(parts.reduce((total, part) => total + part.length, 0));
  let offset = 0;
  for (const part of parts) {
    output.set(part, offset);
    offset += part.length;
  }
  return output;
}

function textOperand(operation: ContentOperation): PdfOperand {
  const index = operation.operator === '"' ? 2 : 0;
  const operand = operation.operands[index];
  if (operand === undefined) {
    throw new MutationError('READ_ONLY_SPAN', 'Text operation has no rewritable operand');
  }
  return operand;
}

function selectedGlyphs(span: AnalysedSpan) {
  const { start, end } = span.address.glyphRange;
  if (
    !Number.isSafeInteger(start) || !Number.isSafeInteger(end) ||
    start < 0 || end > span.glyphs.length || start >= end
  ) {
    throw new MutationError('STALE_REVISION', 'Glyph range no longer resolves');
  }
  return span.glyphs.slice(start, end);
}

export function glyphPreconditionText(span: AnalysedSpan): string {
  const glyphs = selectedGlyphs(span);
  if (glyphs.every(({ unicode }) => unicode !== null)) {
    return glyphs.map(({ unicode }) => unicode).join('');
  }
  return `source:${glyphs.map(({ sourceCode }) => sourceCode.toString(16)).join('-')}`;
}

type SpanTarget = Readonly<{
  stream: ReturnType<ObjectStore['resolveStreamPath']>;
  operation: ContentOperation | null;
  operations: readonly ContentOperation[];
  controlled: boolean;
}>;

function operationForSpan(store: ObjectStore, pageIndex: number, span: AnalysedSpan): SpanTarget {
  const stream = store.resolveStreamPath(pageIndex, span.address.streamPath);
  const { limits, document } = store[OBJECT_STORE_ANALYSIS_ACCESS]();
  const page = document.getPage(pageIndex);
  if (
    page.ref.objectNumber !== span.address.pageRef.objectNumber ||
    page.ref.generationNumber !== span.address.pageRef.generationNumber
  ) {
    throw new MutationError('STALE_REVISION', 'Page identity no longer matches the span');
  }
  const { start, end } = span.address.operatorRange;
  const operations = tokeniseContentStream(stream.decodedBytes, limits);
  const controlled = start === 0 && end === operations.length && parseControlledRedraw(operations) !== null;
  if (!Number.isSafeInteger(start) || (!controlled && end !== start + 1)) {
    throw new MutationError('READ_ONLY_SPAN', 'Only one text-showing operation can be excised');
  }
  if (controlled) return { stream, operation: null, operations, controlled: true };
  const operation = operations[start];
  if (operation === undefined || !['Tj', 'TJ', "'", '"'].includes(operation.operator)) {
    throw new MutationError('STALE_REVISION', 'Text operation no longer resolves');
  }
  return { stream, operation, operations, controlled: false };
}

function targetDigestBytes(target: SpanTarget): Uint8Array {
  return target.controlled ? target.stream.decodedBytes : target.operation!.rawBytes;
}

function controlledSourceBytes(target: SpanTarget): Uint8Array {
  return concatenate(target.operations
    .filter(({ operator }) => operator === 'Tj')
    .map((operation) => decodeTextOperand(textOperand(operation))));
}

function sameOperationAddress(left: SpanAddress, right: SpanAddress): boolean {
  if (
    left.pageRef.objectNumber !== right.pageRef.objectNumber ||
    left.pageRef.generationNumber !== right.pageRef.generationNumber ||
    left.operatorRange.start !== right.operatorRange.start ||
    left.operatorRange.end !== right.operatorRange.end ||
    left.streamPath.length !== right.streamPath.length
  ) return false;
  return left.streamPath.every((segment, index) => {
    const candidate = right.streamPath[index];
    return candidate !== undefined &&
      segment.kind === candidate.kind &&
      segment.resourceName === candidate.resourceName &&
      segment.ref.objectNumber === candidate.ref.objectNumber &&
      segment.ref.generationNumber === candidate.ref.generationNumber;
  });
}

function sameOperationTarget(left: AnalysedSpan, right: AnalysedSpan): boolean {
  return sameOperationAddress(left.address, right.address);
}

function spanWithAddress(current: AnalysedSpan, requested: SpanAddress): AnalysedSpan {
  return Object.freeze({
    ...current,
    address: Object.freeze({ ...current.address, glyphRange: requested.glyphRange }),
  });
}

async function resolveCurrentSpan(
  store: ObjectStore,
  pageIndex: number,
  requested: AnalysedSpan,
): Promise<AnalysedSpan> {
  const matches = (await analysePage(store, pageIndex)).spans.filter((span) =>
    sameOperationTarget(span, requested));
  if (matches.length !== 1) {
    throw new MutationError(
      matches.length === 0 ? 'STALE_REVISION' : 'READ_ONLY_SPAN',
      matches.length === 0
        ? 'Span no longer resolves in the current analysis'
        : 'Span address resolves to more than one executed target',
    );
  }
  return spanWithAddress(matches[0]!, requested.address);
}

async function resolveCurrentSelectionSpans(
  store: ObjectStore,
  pageIndex: number,
  selection: TextSelection,
): Promise<readonly AnalysedSpan[]> {
  if (selection.pageIndex !== pageIndex || selection.sourceSlices.length === 0) {
    throw new MutationError('STALE_REVISION', 'Selection no longer resolves on this page');
  }
  const analysed = await analysePage(store, pageIndex);
  return Object.freeze(selection.sourceSlices.map((slice) => {
    const matches = analysed.spans.filter((span) => sameOperationAddress(span.address, slice));
    if (matches.length !== 1) {
      throw new MutationError(
        matches.length === 0 ? 'STALE_REVISION' : 'READ_ONLY_SPAN',
        matches.length === 0
          ? 'Selection source no longer resolves in the current analysis'
          : 'Selection source resolves to more than one executed target',
      );
    }
    return spanWithAddress(matches[0]!, slice);
  }));
}

async function resolveCurrentSelection(
  store: ObjectStore,
  selection: TextSelection,
): Promise<TextSelection> {
  const layout = groupPageText(await analysePage(store, selection.pageIndex));
  const line = layout.lines.find(({ key }) => key === selection.lineKey);
  if (line === undefined || selection.glyphRange.end > line.glyphs.length) {
    throw new MutationError('STALE_REVISION', 'Selection line no longer resolves');
  }
  const current = buildTextSelection(
    line,
    selection.glyphRange.start,
    selection.glyphRange.end - 1,
  );
  if (current.key !== selection.key) {
    throw new MutationError('STALE_REVISION', 'Selection identity no longer matches');
  }
  return current;
}

type ResolvedDecorationPatch = Readonly<{
  graphic: MatchedSourceDecoration;
  streamPath: SpanAddress['streamPath'];
  startOffset: number;
  endOffset: number;
  bytes: Uint8Array;
  digest: string;
}>;

function decorationSource(
  store: ObjectStore,
  pageIndex: number,
  graphic: MatchedSourceDecoration,
): Omit<ResolvedDecorationPatch, 'digest'> {
  const stream = store.resolveStreamPath(pageIndex, graphic.graphic.address.streamPath);
  if (stream.referenceCount !== 1 || graphic.graphic.referenceCount !== 1) {
    throw new MutationError('READ_ONLY_SPAN', 'Shared decoration content cannot be mutated safely');
  }
  const { document, limits } = store[OBJECT_STORE_ANALYSIS_ACCESS]();
  const page = document.getPage(pageIndex);
  const pageRef = graphic.graphic.address.pageRef;
  if (
    page.ref.objectNumber !== pageRef.objectNumber ||
    page.ref.generationNumber !== pageRef.generationNumber
  ) {
    throw new MutationError('STALE_REVISION', 'Decoration page identity no longer matches');
  }
  const operations = tokeniseContentStream(stream.decodedBytes, limits);
  const { start, end } = graphic.graphic.address.operatorRange;
  const first = operations[start];
  const last = operations[end - 1];
  if (
    !Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start < 0 || end <= start ||
    first === undefined || last === undefined
  ) {
    throw new MutationError('STALE_REVISION', 'Decoration source range no longer resolves');
  }
  const bytes = stream.decodedBytes.slice(first.startOffset, last.endOffset);
  return Object.freeze({
    graphic,
    streamPath: graphic.graphic.address.streamPath,
    startOffset: first.startOffset,
    endOffset: last.endOffset,
    bytes,
  });
}

async function resolveDecorationPatch(
  store: ObjectStore,
  pageIndex: number,
  graphic: MatchedSourceDecoration,
  expectedDigest: string,
): Promise<ResolvedDecorationPatch> {
  const source = decorationSource(store, pageIndex, graphic);
  const digest = await fingerprint(source.bytes);
  if (digest !== expectedDigest) {
    throw new MutationError('STALE_REVISION', 'Decoration mutation preconditions no longer match');
  }
  return Object.freeze({
    ...source,
    digest,
  });
}

function arrayItems(operandBytes: Uint8Array | null): Uint8Array | null {
  if (operandBytes === null) return null;
  if (operandBytes[0] === 0x5b && operandBytes.at(-1) === 0x5d) {
    return operandBytes.slice(1, -1);
  }
  return operandBytes;
}

function replacementFor(
  operation: ContentOperation,
  prefix: Uint8Array | null,
  suffix: Uint8Array | null,
  compensation: number,
  fontSize: number,
  horizontalScaling: number,
): Uint8Array {
  const retained: Uint8Array[] = [];
  if (operation.operator === "'") {
    retained.push(encoder.encode('T*'));
  } else if (operation.operator === '"') {
    const wordSpacing = operation.operands[0];
    const characterSpacing = operation.operands[1];
    if (wordSpacing?.kind !== 'number' || characterSpacing?.kind !== 'number') {
      throw new MutationError('READ_ONLY_SPAN', 'Double-quote operands cannot be preserved');
    }
    retained.push(
      wordSpacing.rawBytes,
      encoder.encode(' Tw\n'),
      characterSpacing.rawBytes,
      encoder.encode(' Tc\nT*'),
    );
  }

  if (!(fontSize > 0) || !(horizontalScaling > 0)) {
    throw new MutationError('READ_ONLY_SPAN', 'Text advance cannot be preserved safely');
  }
  const adjustment = -compensation * 1000 / (fontSize * horizontalScaling);
  const items = [
    arrayItems(prefix),
    Math.abs(adjustment) < 1e-10
      ? null
      : encoder.encode(String(Number(adjustment.toFixed(9)))),
    arrayItems(suffix),
  ].filter((item): item is Uint8Array => item !== null && item.byteLength > 0);
  if (items.length > 0) {
    if (retained.length > 0) retained.push(encoder.encode('\n'));
    retained.push(
      encoder.encode('['),
      ...items.flatMap((item, index) => index === 0 ? [item] : [encoder.encode(' '), item]),
      encoder.encode('] TJ'),
    );
  }
  return concatenate(retained);
}

function interiorAdjustment(
  operand: PdfOperand,
  selectedCodeStart: number,
  selectedCodeEnd: number,
  fontSize: number,
  horizontalScaling: number,
): number {
  if (operand.kind !== 'array') return 0;
  let codeOffset = 0;
  let advance = 0;
  for (const item of operand.items) {
    if (item.kind === 'number') {
      if (codeOffset > selectedCodeStart && codeOffset < selectedCodeEnd) {
        advance -= item.value / 1000 * fontSize * horizontalScaling;
      }
    } else if (item.kind === 'literalString' || item.kind === 'hexString') {
      codeOffset += item.value.length;
    }
  }
  return advance;
}

function removedCodes(operand: PdfOperand, span: AnalysedSpan): Uint8Array {
  const decoded = decodeTextOperand(operand);
  const selected = selectedGlyphs(span);
  const start = selected[0]!.sourceCodeStart;
  const end = selected.at(-1)!.sourceCodeEnd;
  if (start < 0 || end > decoded.length || start >= end) {
    throw new MutationError('STALE_REVISION', 'Selected source-code range no longer resolves');
  }
  return decoded.slice(start, end);
}

type ResolvedExcisionPreview = ExcisionPreview & Readonly<{
  streamPath: SpanAddress['streamPath'];
  startOffset: number;
  endOffset: number;
}>;

async function previewResolvedExcision(
  store: ObjectStore,
  pageIndex: number,
  currentSpan: AnalysedSpan,
  preconditions: MutationPreconditions,
): Promise<ResolvedExcisionPreview> {
  const target = operationForSpan(store, pageIndex, currentSpan);
  const { stream, operation } = target;
  const digest = await fingerprint(targetDigestBytes(target));
  if (
    digest !== preconditions.expectedOperatorDigest ||
    glyphPreconditionText(currentSpan) !== preconditions.expectedGlyphText
  ) {
    throw new MutationError('STALE_REVISION', 'Mutation preconditions no longer match');
  }
  if (stream.referenceCount !== 1 || currentSpan.resource.referenceCount !== 1) {
    throw new MutationError('READ_ONLY_SPAN', 'Shared content cannot be mutated safely');
  }

  if (target.controlled) {
    if (
      currentSpan.address.glyphRange.start !== 0 ||
      currentSpan.address.glyphRange.end !== currentSpan.glyphs.length
    ) {
      throw new MutationError('READ_ONLY_SPAN', 'Controlled redraw must be replaced as one span');
    }
    return Object.freeze({
      replacementStreamBytes: encoder.encode('q\nQ\n'),
      removedSourceBytes: controlledSourceBytes(target),
      operatorDigest: digest,
      streamPath: currentSpan.address.streamPath,
      startOffset: 0,
      endOffset: stream.decodedBytes.length,
    });
  }

  const singleOperation = operation!;
  const operand = textOperand(singleOperation);
  const rewrite = rewriteTextOperand(
    operand,
    currentSpan.glyphs,
    currentSpan.address.glyphRange,
  );
  if (rewrite.kind !== 'preserved') {
    throw new MutationError(
      'READ_ONLY_SPAN',
      rewrite.kind === 'expandRequired'
        ? 'Selection overlaps a glyph cluster without an analyser-provided safe boundary'
        : 'Text operand cannot be reconstructed losslessly',
    );
  }
  const operationReplacement = replacementFor(
    singleOperation,
    rewrite.prefixOperandBytes,
    rewrite.suffixOperandBytes,
    selectedGlyphs(currentSpan).reduce((total, glyph) => total + glyph.advance, 0) +
      interiorAdjustment(
        operand,
        selectedGlyphs(currentSpan)[0]!.sourceCodeStart,
        selectedGlyphs(currentSpan).at(-1)!.sourceCodeEnd,
        currentSpan.fontSize,
        currentSpan.horizontalScaling,
      ),
    currentSpan.fontSize,
    currentSpan.horizontalScaling,
  );
  return Object.freeze({
    replacementStreamBytes: operationReplacement,
    removedSourceBytes: removedCodes(operand, currentSpan),
    operatorDigest: digest,
    streamPath: currentSpan.address.streamPath,
    startOffset: singleOperation.startOffset,
    endOffset: singleOperation.endOffset,
  });
}

export async function buildMutationPreconditions(
  store: ObjectStore,
  pageIndex: number,
  span: AnalysedSpan,
): Promise<MutationPreconditions> {
  const current = await resolveCurrentSpan(store, pageIndex, span);
  const target = operationForSpan(store, pageIndex, current);
  return Object.freeze({
    expectedOperatorDigest: await fingerprint(targetDigestBytes(target)),
    expectedGlyphText: glyphPreconditionText(current),
  });
}

export async function previewExcision(
  store: ObjectStore,
  input: ExcisionInput,
): Promise<ExcisionPreview> {
  if (input.currentRevision !== input.expectedRevision) {
    throw new MutationError('STALE_REVISION', 'Document revision has changed');
  }
  const currentSpan = await resolveCurrentSpan(store, input.pageIndex, input.span);
  const resolved = await previewResolvedExcision(
    store,
    input.pageIndex,
    currentSpan,
    input.preconditions,
  );
  const stream = store.resolveStreamPath(input.pageIndex, resolved.streamPath);
  return Object.freeze({
    replacementStreamBytes: concatenate([
      stream.decodedBytes.slice(0, resolved.startOffset),
      resolved.replacementStreamBytes,
      stream.decodedBytes.slice(resolved.endOffset),
    ]),
    removedSourceBytes: resolved.removedSourceBytes,
    operatorDigest: resolved.operatorDigest,
  });
}

function streamPathKey(path: SpanAddress['streamPath']): string {
  return path.map(({ kind, ref, resourceName }) =>
    `${kind}:${ref.objectNumber}:${ref.generationNumber}:${resourceName ?? '-'}`).join('/');
}

export async function buildSelectionMutationPreconditions(
  store: ObjectStore,
  selection: TextSelection,
): Promise<SelectionMutationPreconditions> {
  const spans = await resolveCurrentSelectionSpans(store, selection.pageIndex, selection);
  const slices = await Promise.all(spans.map(async (span) => {
    const target = operationForSpan(store, selection.pageIndex, span);
    return Object.freeze({
      addressKey: spanAddressKey(span.address),
      expectedOperatorDigest: await fingerprint(targetDigestBytes(target)),
      expectedGlyphText: glyphPreconditionText(span),
    });
  }));
  const currentSelection = await resolveCurrentSelection(store, selection);
  const decorations = await Promise.all(currentSelection.sourceDecorations.map(async (graphic) => {
    const source = decorationSource(store, selection.pageIndex, graphic);
    return Object.freeze({
      addressKey: decorationGraphicAddressKey(graphic.graphic.address),
      expectedOperatorDigest: await fingerprint(source.bytes),
    });
  }));
  return Object.freeze({
    slices: Object.freeze(slices),
    decorations: Object.freeze(decorations),
  });
}

export async function previewSelectionExcision(
  store: ObjectStore,
  input: SelectionExcisionInput,
): Promise<SelectionExcisionPreview> {
  if (input.currentRevision !== input.expectedRevision) {
    throw new MutationError('STALE_REVISION', 'Document revision has changed');
  }
  const currentSelection = await resolveCurrentSelection(store, input.selection);
  const spans = await resolveCurrentSelectionSpans(store, input.pageIndex, input.selection);
  if (input.preconditions.slices.length !== spans.length) {
    throw new MutationError('STALE_REVISION', 'Selection preconditions no longer match');
  }
  const addressKeys = spans.map(({ address }) => spanAddressKey(address));
  if (new Set(addressKeys).size !== addressKeys.length) {
    throw new MutationError('READ_ONLY_SPAN', 'Selection contains duplicate source slices');
  }

  const previews = await Promise.all(spans.map(async (span, index) => {
    const precondition = input.preconditions.slices[index];
    if (precondition === undefined || precondition.addressKey !== spanAddressKey(span.address)) {
      throw new MutationError('STALE_REVISION', 'Selection preconditions no longer match');
    }
    return previewResolvedExcision(store, input.pageIndex, span, precondition);
  }));

  if (input.preconditions.decorations.length !== currentSelection.sourceDecorations.length) {
    throw new MutationError('STALE_REVISION', 'Decoration preconditions no longer match');
  }
  const decorationKeys = currentSelection.sourceDecorations.map(({ graphic }) =>
    decorationGraphicAddressKey(graphic.address));
  if (new Set(decorationKeys).size !== decorationKeys.length) {
    throw new MutationError('READ_ONLY_SPAN', 'Selection contains duplicate decoration sources');
  }
  const decorationPreviews = await Promise.all(currentSelection.sourceDecorations.map(
    async (graphic, index) => {
      const precondition = input.preconditions.decorations[index];
      if (
        precondition === undefined ||
        precondition.addressKey !== decorationGraphicAddressKey(graphic.graphic.address)
      ) {
        throw new MutationError('STALE_REVISION', 'Decoration preconditions no longer match');
      }
      return resolveDecorationPatch(
        store,
        input.pageIndex,
        graphic,
        precondition.expectedOperatorDigest,
      );
    },
  ));

  const grouped = new Map<string, {
    streamPath: SpanAddress['streamPath'];
    patches: StreamPatch[];
  }>();
  for (const preview of previews) {
    const key = streamPathKey(preview.streamPath);
    const group = grouped.get(key) ?? { streamPath: preview.streamPath, patches: [] };
    group.patches.push(Object.freeze({
      startOffset: preview.startOffset,
      endOffset: preview.endOffset,
      bytes: preview.replacementStreamBytes,
    }));
    grouped.set(key, group);
  }
  for (const preview of decorationPreviews) {
    const key = streamPathKey(preview.streamPath);
    const group = grouped.get(key) ?? { streamPath: preview.streamPath, patches: [] };
    group.patches.push(Object.freeze({
      startOffset: preview.startOffset,
      endOffset: preview.endOffset,
      bytes: new Uint8Array(),
    }));
    grouped.set(key, group);
  }

  const { limits } = store[OBJECT_STORE_ANALYSIS_ACCESS]();
  const streamReplacements = [...grouped.values()].map(({ streamPath, patches }) => {
    let replacementStreamBytes: Uint8Array;
    try {
      replacementStreamBytes = applyStreamPatches(
        store.resolveStreamPath(input.pageIndex, streamPath).decodedBytes,
        patches,
      );
    } catch (error) {
      if (error instanceof StreamPatchError) {
        throw new MutationError('READ_ONLY_SPAN', 'Selection source operations overlap');
      }
      throw error;
    }
    if (replacementStreamBytes.byteLength > limits.maxDecodedStreamBytes) {
      throw new MutationError('RESOURCE_LIMIT', 'Selection replacement stream exceeds byte limit', {
        resource: 'decodedStreamBytes',
        limit: limits.maxDecodedStreamBytes,
        observedBytes: replacementStreamBytes.byteLength,
      });
    }
    return Object.freeze({ streamPath, replacementStreamBytes });
  });

  return Object.freeze({
    streamReplacements: Object.freeze(streamReplacements),
    removedSourceBytes: concatenate(previews.map(({ removedSourceBytes }) => removedSourceBytes)),
    operatorDigests: Object.freeze(previews.map(({ operatorDigest }) => operatorDigest)),
    decorationDigests: Object.freeze(decorationPreviews.map(({ digest }) => digest)),
  });
}

export async function exciseSelection(
  store: ObjectStore,
  input: SelectionExcisionInput,
): Promise<SelectionExcisionResult> {
  const preview = await previewSelectionExcision(store, input);
  return applySelectionExcisionPreview(store, input.pageIndex, preview);
}

export function applySelectionExcisionPreview(
  store: ObjectStore,
  pageIndex: number,
  preview: SelectionExcisionPreview,
): SelectionExcisionResult {
  for (const replacement of preview.streamReplacements) {
    store.replaceStreamBytes(
      pageIndex,
      replacement.streamPath,
      replacement.replacementStreamBytes,
    );
  }
  return Object.freeze({
    removedSourceBytes: preview.removedSourceBytes,
    operatorDigests: preview.operatorDigests,
    decorationDigests: preview.decorationDigests,
  });
}

export async function exciseSpan(
  store: ObjectStore,
  input: ExcisionInput,
): Promise<ExcisionResult> {
  const preview = await previewExcision(store, input);
  store.replaceStreamBytes(
    input.pageIndex,
    input.span.address.streamPath,
    preview.replacementStreamBytes,
  );
  return Object.freeze({
    removedSourceBytes: preview.removedSourceBytes,
    operatorDigest: preview.operatorDigest,
  });
}
