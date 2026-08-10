import { createCanvas } from '@napi-rs/canvas';

import {
  validateCandidate,
  validateCandidateAgainstSource,
  type MutationExpectation,
  type RuntimeValidationEvidence,
  type ValidationCanvasFactory,
} from '@pdf-editor/pdf-engine';

const nodeCanvasFactory: ValidationCanvasFactory = (width, height) => {
  const canvas = createCanvas(width, height);
  const context = canvas.getContext('2d');
  return {
    canvas,
    context,
    readRgba: () => new Uint8Array(context.getImageData(0, 0, width, height).data),
  };
};

export function collectPdfJsEvidence(
  bytes: Uint8Array,
  expectation: MutationExpectation,
): Promise<RuntimeValidationEvidence> {
  return validateCandidate(bytes, expectation, nodeCanvasFactory);
}

export function collectPdfJsSourceEvidence(
  sourceBytes: Uint8Array,
  candidateBytes: Uint8Array,
  expectation: MutationExpectation,
): Promise<RuntimeValidationEvidence> {
  return validateCandidateAgainstSource(
    sourceBytes,
    candidateBytes,
    expectation,
    nodeCanvasFactory,
  );
}
