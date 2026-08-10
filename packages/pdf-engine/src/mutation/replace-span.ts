import type { ReplacementClassification } from '../classification/classify';
import { deterministicSave } from '../export/deterministic-save';
import type { SubstituteFontAsset } from '../fonts/font-embedding';
import type { ShapedRun } from '../fonts/harfbuzz-shaper';
import { fingerprint } from '../fingerprint';
import type { AnalysedSpan } from '../model';
import {
  OBJECT_STORE_ANALYSIS_ACCESS,
  ObjectStore,
} from '../pdf/object-store';
import {
  exciseSpan,
  MutationError,
  previewExcision,
  type ExcisionInput,
} from './excise';
import { appendControlledRedraw } from './redraw';

export type ReplacementMutationInput = ExcisionInput & Readonly<{
  replacement: string;
  classification: ReplacementClassification;
  shapedRun: ShapedRun;
  fontAsset: SubstituteFontAsset;
}>;

export type ReplacementPreview = Readonly<{
  commandHash: string;
  nextRevision: number;
  capability: ReplacementClassification;
}>;

export type MutationResult = Readonly<{
  revision: number;
  commandHash: string;
  candidateBytes: Uint8Array;
  candidateHash: string;
  fontResourceName: string;
}>;

function stableAddress(span: AnalysedSpan): object {
  return {
    pageRef: span.address.pageRef,
    streamPath: span.address.streamPath,
    operatorRange: span.address.operatorRange,
    glyphRange: span.address.glyphRange,
  };
}

async function commandHash(input: ReplacementMutationInput): Promise<string> {
  const descriptor = new TextEncoder().encode(JSON.stringify({
    schemaVersion: 1,
    expectedRevision: input.expectedRevision,
    pageIndex: input.pageIndex,
    address: stableAddress(input.span),
    replacement: input.classification.normalisedReplacement,
    operatorDigest: input.preconditions.expectedOperatorDigest,
    font: {
      family: input.fontAsset.family,
      version: input.fontAsset.version,
      licence: input.fontAsset.licence,
      source: input.fontAsset.source,
      bytesHash: await fingerprint(input.fontAsset.bytes),
    },
  }));
  return fingerprint(descriptor);
}

function validateReplacement(input: ReplacementMutationInput): void {
  if (!input.classification.canApply || input.classification.kind === 'readOnly') {
    const code = input.classification.reasons.includes('replacementOverflow')
      ? 'REPLACEMENT_OVERFLOW'
      : input.classification.reasons.includes('fontEmbeddingProhibited')
        ? 'FONT_EMBEDDING_PROHIBITED'
        : 'READ_ONLY_SPAN';
    throw new MutationError(code, 'Replacement classification does not permit mutation');
  }
  if (input.replacement.normalize('NFC') !== input.classification.normalisedReplacement) {
    throw new MutationError('STALE_REVISION', 'Replacement classification is stale');
  }
  if (input.shapedRun.glyphs.length === 0 || input.shapedRun.unitsPerEm <= 0) {
    throw new MutationError('FONT_UNAVAILABLE', 'Replacement has no usable shaped run');
  }
}

export async function previewReplacement(
  store: ObjectStore,
  input: ReplacementMutationInput,
): Promise<ReplacementPreview> {
  validateReplacement(input);
  await previewExcision(store, input);
  return Object.freeze({
    commandHash: await commandHash(input),
    nextRevision: input.currentRevision + 1,
    capability: input.classification,
  });
}

export async function applyReplacement(
  store: ObjectStore,
  input: ReplacementMutationInput,
): Promise<MutationResult> {
  const preview = await previewReplacement(store, input);
  const { limits } = store[OBJECT_STORE_ANALYSIS_ACCESS]();
  const candidate = await ObjectStore.open(await store.serialiseCandidate(), limits);
  await exciseSpan(candidate, input);
  const redraw = await appendControlledRedraw(
    candidate,
    input.pageIndex,
    input.span,
    input.classification.normalisedReplacement,
    input.shapedRun,
    input.fontAsset,
    preview.commandHash,
  );
  const saved = await deterministicSave(candidate);
  return Object.freeze({
    revision: preview.nextRevision,
    commandHash: preview.commandHash,
    candidateBytes: saved.bytes,
    candidateHash: saved.hash,
    fontResourceName: redraw.fontResourceName,
  });
}
