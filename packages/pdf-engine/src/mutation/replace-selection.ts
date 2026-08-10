import { deterministicSave } from '../export/deterministic-save';
import { fingerprint } from '../fingerprint';
import type { CanonicalBounds, TextSelection } from '../model';
import {
  OBJECT_STORE_ANALYSIS_ACCESS,
  ObjectStore,
} from '../pdf/object-store';
import {
  applySelectionExcisionPreview,
  MutationError,
  previewSelectionExcision,
  type SelectionExcisionInput,
} from './excise';
import {
  appendControlledRichRedraw,
  measureControlledRichRedraw,
  type ResolvedRichTextRun,
} from './redraw';

export type RichReplacementMutationInput = SelectionExcisionInput & Readonly<{
  runs: readonly ResolvedRichTextRun[];
  allowedRegion: CanonicalBounds;
  substitutionConsents: readonly string[];
}>;

export type RichReplacementPreview = Readonly<{
  commandHash: string;
  nextRevision: number;
  selection: TextSelection;
  replacement: string;
  replacementBounds: CanonicalBounds;
  allowedRegion: CanonicalBounds;
  fits: boolean;
  requiredSubstitutionConsents: readonly string[];
}>;

export type RichMutationResult = Readonly<{
  revision: number;
  commandHash: string;
  candidateBytes: Uint8Array;
  candidateHash: string;
  fontResourceNames: readonly string[];
  replacementBounds: CanonicalBounds;
}>;

function validBounds(bounds: CanonicalBounds): boolean {
  return Number.isFinite(bounds.x) && Number.isFinite(bounds.y) &&
    Number.isFinite(bounds.width) && Number.isFinite(bounds.height) &&
    bounds.width > 0 && bounds.height > 0;
}

function validateInput(input: RichReplacementMutationInput): Readonly<{
  replacement: string;
  requiredSubstitutionConsents: readonly string[];
}> {
  if (input.selection.capability.kind === 'readOnly') {
    throw new MutationError('READ_ONLY_SPAN', 'Replacement selection is read-only');
  }
  if (input.runs.length === 0 || !validBounds(input.allowedRegion)) {
    throw new MutationError('MALFORMED_INPUT', 'Rich replacement runs and allowed region are required');
  }
  const replacement = input.runs.map(({ text }) => text).join('').normalize('NFC');
  if (
    replacement.length === 0 ||
    input.runs.some(({ text, shapedRun }) =>
      text.normalize('NFC') !== text ||
      shapedRun.glyphs.length === 0 ||
      !(shapedRun.unitsPerEm > 0))
  ) {
    throw new MutationError('FONT_UNAVAILABLE', 'Rich replacement runs are not usable');
  }
  const consent = new Set(input.substitutionConsents);
  const requiredSubstitutionConsents = [...new Set(input.runs
    .filter(({ fontAsset }) => fontAsset.matchKind !== 'exact')
    .map(({ fontAsset }) => fontAsset.descriptor.id))]
    .filter((fontId) => !consent.has(fontId));
  return Object.freeze({
    replacement,
    requiredSubstitutionConsents: Object.freeze(requiredSubstitutionConsents),
  });
}

async function richCommandHash(input: RichReplacementMutationInput): Promise<string> {
  const descriptor = new TextEncoder().encode(JSON.stringify({
    schemaVersion: 2,
    expectedRevision: input.expectedRevision,
    pageIndex: input.pageIndex,
    selectionKey: input.selection.key,
    sourceSlices: input.selection.sourceSlices,
    sourceDecorations: input.selection.sourceDecorations.map(({ kind, graphic }) => ({
      kind,
      address: graphic.address,
    })),
    runs: input.runs.map(({ text, style, shapedRun, fontAsset, decorations }) => ({
      text,
      style,
      decorations,
      direction: shapedRun.direction,
      glyphs: shapedRun.glyphs,
      font: {
        id: fontAsset.descriptor.id,
        hash: fontAsset.descriptor.hash,
        matchKind: fontAsset.matchKind,
      },
    })),
    allowedRegion: input.allowedRegion,
    substitutionConsents: [...input.substitutionConsents].sort(),
    operatorDigests: input.preconditions.slices.map(({ expectedOperatorDigest }) =>
      expectedOperatorDigest),
    decorationDigests: input.preconditions.decorations.map(({ expectedOperatorDigest }) =>
      expectedOperatorDigest),
  }));
  return fingerprint(descriptor);
}

function withinBounds(candidate: CanonicalBounds, allowed: CanonicalBounds): boolean {
  const tolerance = 1e-6;
  return candidate.x >= allowed.x - tolerance &&
    candidate.y >= allowed.y - tolerance &&
    candidate.x + candidate.width <= allowed.x + allowed.width + tolerance &&
    candidate.y + candidate.height <= allowed.y + allowed.height + tolerance;
}

export async function previewRichReplacement(
  store: ObjectStore,
  input: RichReplacementMutationInput,
): Promise<RichReplacementPreview> {
  const { replacement, requiredSubstitutionConsents } = validateInput(input);
  await previewSelectionExcision(store, input);
  const measured = await measureControlledRichRedraw(
    store,
    input.pageIndex,
    input.selection,
    input.runs,
  );
  return Object.freeze({
    commandHash: await richCommandHash(input),
    nextRevision: input.currentRevision + 1,
    selection: input.selection,
    replacement,
    replacementBounds: measured.bounds,
    allowedRegion: input.allowedRegion,
    fits: withinBounds(measured.bounds, input.allowedRegion),
    requiredSubstitutionConsents,
  });
}

export async function applyRichReplacement(
  store: ObjectStore,
  input: RichReplacementMutationInput,
): Promise<RichMutationResult> {
  const preview = await previewRichReplacement(store, input);
  if (preview.requiredSubstitutionConsents.length > 0) {
    throw new MutationError(
      'READ_ONLY_SPAN',
      'Font substitution requires explicit consent',
      { fontId: preview.requiredSubstitutionConsents[0]! },
    );
  }
  if (!preview.fits) {
    throw new MutationError('REPLACEMENT_OVERFLOW', 'Rich replacement exceeds its allowed region', {
      replacementWidth: preview.replacementBounds.width,
      replacementHeight: preview.replacementBounds.height,
      allowedWidth: input.allowedRegion.width,
      allowedHeight: input.allowedRegion.height,
    });
  }
  const { limits } = store[OBJECT_STORE_ANALYSIS_ACCESS]();
  const candidate = await ObjectStore.open(await store.serialiseCandidate(), limits);
  const excision = await previewSelectionExcision(candidate, input);
  const redraw = await appendControlledRichRedraw(
    candidate,
    input.pageIndex,
    input.selection,
    input.runs,
    preview.commandHash,
  );
  applySelectionExcisionPreview(candidate, input.pageIndex, excision);
  if (!withinBounds(redraw.bounds, input.allowedRegion)) {
    throw new MutationError('REPLACEMENT_OVERFLOW', 'Rich replacement exceeds its allowed region', {
      replacementWidth: redraw.bounds.width,
      replacementHeight: redraw.bounds.height,
      allowedWidth: input.allowedRegion.width,
      allowedHeight: input.allowedRegion.height,
    });
  }
  const saved = await deterministicSave(candidate);
  return Object.freeze({
    revision: preview.nextRevision,
    commandHash: preview.commandHash,
    candidateBytes: saved.bytes,
    candidateHash: saved.hash,
    fontResourceNames: redraw.fontResourceNames,
    replacementBounds: redraw.bounds,
  });
}
