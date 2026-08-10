import { PDFDict, PDFName, PDFNumber } from 'pdf-lib';

import { parseControlledRedraw, type ControlledRedraw } from '../content/controlled-redraw';
import {
  isPageIsolationPrefix,
  isPageIsolationSuffix,
} from '../content/brand-markers';
import { tokeniseContentStream } from '../content/tokeniser';
import type { EngineLimits } from '../limits';
import type { StreamPathSegment } from '../model';
import {
  OBJECT_STORE_ANALYSIS_ACCESS,
  ObjectStore,
  type ContentStreamRecord,
} from '../pdf/object-store';

export type MutatedSourceStream = Readonly<{
  pageIndex: number;
  streamPath: readonly StreamPathSegment[];
}>;

export type StructuralMutationExpectation = Readonly<{
  commandHash: string | null;
  fontResourceNames: readonly string[];
  mutatedSourceStreams: readonly MutatedSourceStream[];
}>;

export type CandidateStructureEvidence = Readonly<{
  valid: boolean;
  checks: readonly string[];
  controlledText: string;
  pageGeometryPreserved: boolean;
  sourceStreamsPreserved: boolean;
  fontResourcesPresent: boolean;
}>;

const decoder = new TextDecoder();

function streamPathKey(pageIndex: number, path: readonly StreamPathSegment[]): string {
  return `${pageIndex}|${path.map(({ kind, ref, resourceName }) =>
    `${kind}:${ref.objectNumber}:${ref.generationNumber}:${resourceName ?? '-'}`).join('/')}`;
}

function sameBytes(left: Uint8Array, right: Uint8Array): boolean {
  return left.byteLength === right.byteLength && left.every((byte, index) => byte === right[index]);
}

function sameStrings(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}

function sameNumbers(left: readonly number[] | null, right: readonly number[] | null): boolean {
  if (left === null || right === null) return left === right;
  return left.length === right.length && left.every((value, index) => value === right[index]);
}

function sameDecorations(
  left: ControlledRedraw['runDecorations'],
  right: ControlledRedraw['runDecorations'],
): boolean {
  if (left === null || right === null) return left === right;
  return left.length === right.length && left.every((value, index) => {
    const candidate = right[index];
    return candidate !== undefined && value.underline === candidate.underline &&
      value.strikethrough === candidate.strikethrough;
  });
}

function pageGeometry(store: ObjectStore): readonly string[] {
  const { document } = store[OBJECT_STORE_ANALYSIS_ACCESS]();
  return Object.freeze(document.getPages().map((page) => {
    const media = page.getMediaBox();
    const crop = page.getCropBox();
    const userUnit = page.node.lookupMaybe(PDFName.of('UserUnit'), PDFNumber)?.asNumber() ?? 1;
    return JSON.stringify({
      media: [media.x, media.y, media.width, media.height],
      crop: [crop.x, crop.y, crop.width, crop.height],
      rotate: page.getRotation().angle,
      userUnit,
    });
  }));
}

function rootStreams(store: ObjectStore, pageIndex: number): readonly ContentStreamRecord[] {
  return store.listPageStreams(pageIndex).filter(({ path }) => path.length === 1);
}

function controlledRedraw(
  stream: ContentStreamRecord,
  limits: EngineLimits,
): ControlledRedraw | null {
  try {
    return parseControlledRedraw(tokeniseContentStream(stream.decodedBytes, limits));
  } catch {
    return null;
  }
}

function matchesControlled(
  controlled: ControlledRedraw,
  expectation: StructuralMutationExpectation,
  expectedText: string,
): boolean {
  const commandMatches = controlled.version === 1
    ? expectation.commandHash === null || controlled.fontResourceNames[0]
      === `M0R_${expectation.commandHash.slice(0, 16)}`
    : controlled.commandHash === expectation.commandHash;
  return commandMatches
    && controlled.actualText.normalize('NFC') === expectedText.normalize('NFC')
    && sameStrings(controlled.fontResourceNames, expectation.fontResourceNames);
}

function sameControlled(left: ControlledRedraw, right: ControlledRedraw): boolean {
  return left.version === right.version
    && left.actualText === right.actualText
    && left.commandHash === right.commandHash
    && sameStrings(left.fontResourceNames, right.fontResourceNames)
    && sameStrings(left.textFontResourceNames, right.textFontResourceNames)
    && sameNumbers(left.runGlyphCounts, right.runGlyphCounts)
    && sameDecorations(left.runDecorations, right.runDecorations)
    && sameNumbers(left.textRunIndexes, right.textRunIndexes)
    && sameNumbers(left.decorationOperationIndexes, right.decorationOperationIndexes);
}

function pageFontsPresent(
  store: ObjectStore,
  pageIndex: number,
  expected: readonly string[],
): boolean {
  const { document } = store[OBJECT_STORE_ANALYSIS_ACCESS]();
  const fonts = document.getPage(pageIndex).node.Resources()
    ?.lookupMaybe(PDFName.of('Font'), PDFDict);
  return fonts !== undefined && expected.every((name) => fonts.has(PDFName.of(name)));
}

function sourceStreamEvidence(
  source: ObjectStore,
  candidate: ObjectStore,
  expectation: StructuralMutationExpectation,
): Readonly<{ preserved: boolean; sourceKeys: ReadonlySet<string> }> {
  const sourceDocument = source[OBJECT_STORE_ANALYSIS_ACCESS]().document;
  const expectedMutations = new Set(expectation.mutatedSourceStreams.map(({ pageIndex, streamPath }) =>
    streamPathKey(pageIndex, streamPath)));
  const observedMutations = new Set<string>();
  const sourceKeys = new Set<string>();
  let preserved = true;

  for (let pageIndex = 0; pageIndex < sourceDocument.getPageCount(); pageIndex += 1) {
    for (const stream of source.listPageStreams(pageIndex)) {
      const key = streamPathKey(pageIndex, stream.path);
      sourceKeys.add(key);
      let candidateStream: ContentStreamRecord;
      try {
        candidateStream = candidate.resolveStreamPath(pageIndex, stream.path);
      } catch {
        preserved = false;
        continue;
      }
      const changed = !sameBytes(stream.decodedBytes, candidateStream.decodedBytes);
      if (expectedMutations.has(key)) {
        if (changed) observedMutations.add(key);
        else preserved = false;
      } else if (changed) {
        preserved = false;
      }
    }
  }
  if (
    expectedMutations.size !== observedMutations.size ||
    [...expectedMutations].some((key) => !observedMutations.has(key))
  ) preserved = false;
  return Object.freeze({ preserved, sourceKeys });
}

function generatedContentValid(
  source: ObjectStore,
  candidate: ObjectStore,
  pageIndex: number,
  sourceKeys: ReadonlySet<string>,
  matched: ControlledRedraw | undefined,
): boolean {
  const sourceRoots = rootStreams(source, pageIndex);
  const sourceIsolated = sourceRoots.some(({ decodedBytes }) =>
    isPageIsolationPrefix(decoder.decode(decodedBytes)));
  let prefixCount = 0;
  let suffixCount = 0;
  let controlledCount = 0;

  for (const stream of candidate.listPageStreams(pageIndex)) {
    if (sourceKeys.has(streamPathKey(pageIndex, stream.path))) continue;
    if (stream.path.length !== 1) return false;
    const decoded = decoder.decode(stream.decodedBytes);
    if (isPageIsolationPrefix(decoded)) {
      prefixCount += 1;
      continue;
    }
    if (isPageIsolationSuffix(decoded)) {
      suffixCount += 1;
      continue;
    }
    const controlled = controlledRedraw(stream, candidate[OBJECT_STORE_ANALYSIS_ACCESS]().limits);
    if (controlled !== null && matched !== undefined && sameControlled(controlled, matched)) {
      controlledCount += 1;
      continue;
    }
    return false;
  }
  return controlledCount === 1
    && (sourceIsolated
      ? prefixCount === 0 && suffixCount === 0
      : prefixCount === 1 && suffixCount === 1);
}

export async function validateCandidateStructure(
  sourceBytes: Uint8Array,
  candidateBytes: Uint8Array,
  pageIndex: number,
  expectedText: string,
  expectation: StructuralMutationExpectation,
  limits: EngineLimits,
): Promise<CandidateStructureEvidence> {
  try {
    const source = await ObjectStore.open(sourceBytes, limits);
    const candidate = await ObjectStore.open(candidateBytes, limits);
    const sourceGeometry = pageGeometry(source);
    const candidateGeometry = pageGeometry(candidate);
    const pageGeometryPreserved = sameStrings(sourceGeometry, candidateGeometry);
    const streamEvidence = sourceStreamEvidence(source, candidate, expectation);
    const controls = rootStreams(candidate, pageIndex)
      .map((stream) => controlledRedraw(stream, limits))
      .filter((value): value is ControlledRedraw => value !== null);
    const matched = controls.find((controlled) =>
      matchesControlled(controlled, expectation, expectedText));
    const controlledMatched = matched !== undefined;
    const fontResourcesPresent = controlledMatched
      && pageFontsPresent(candidate, pageIndex, expectation.fontResourceNames);
    const generatedValid = controlledMatched && generatedContentValid(
      source,
      candidate,
      pageIndex,
      streamEvidence.sourceKeys,
      matched,
    );
    const valid = pageGeometryPreserved
      && streamEvidence.preserved
      && controlledMatched
      && fontResourcesPresent
      && generatedValid;
    return Object.freeze({
      valid,
      checks: Object.freeze([
        pageGeometryPreserved ? 'page-geometry-preserved' : 'page-geometry-changed',
        streamEvidence.preserved ? 'source-streams-preserved' : 'source-streams-changed',
        controlledMatched ? 'controlled-redraw-matched' : 'controlled-redraw-mismatch',
        fontResourcesPresent ? 'font-resources-present' : 'font-resources-missing',
        generatedValid ? 'generated-content-valid' : 'unexpected-content-stream',
      ]),
      controlledText: matched?.actualText ?? '',
      pageGeometryPreserved,
      sourceStreamsPreserved: streamEvidence.preserved,
      fontResourcesPresent,
    });
  } catch {
    return Object.freeze({
      valid: false,
      checks: Object.freeze(['structure-validation-failed']),
      controlledText: '',
      pageGeometryPreserved: false,
      sourceStreamsPreserved: false,
      fontResourcesPresent: false,
    });
  }
}
