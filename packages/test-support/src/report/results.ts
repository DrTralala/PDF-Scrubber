import type {
  CapabilityKind,
  CapabilityReason,
  EngineErrorCode,
  EngineLimits,
} from '@pdf-editor/pdf-engine';

import type { DisclosureCode, ExpectedBaseline } from '../corpus/types';

export type ConsumerEvidence = Readonly<{
  extractionValid: boolean;
  renderHash: string;
  uneditedMismatchRatio: number;
  uneditedSsim: number;
}>;

export type M0CaseEvidence = Readonly<{
  trueRemoval: boolean;
  extractableRedraw: boolean;
  uneditedRegionFidelity: boolean;
  independentRendering: boolean;
  deterministicOutput: boolean;
  atomicFailure: boolean;
  failureClosed: boolean;
  pdfjs: ConsumerEvidence | null;
  poppler: ConsumerEvidence | null;
}>;

export type ObservedOutcome =
  | Readonly<{
      kind: 'capability';
      capability: CapabilityKind;
      reasons: readonly CapabilityReason[];
    }>
  | Readonly<{ kind: 'rejected'; error: EngineErrorCode }>
  | Readonly<{ kind: 'crossConsumerControl' }>;

export type M0CaseResult = Readonly<{
  id: string;
  fixtureSha256: string;
  expected: ExpectedBaseline;
  observed: ObservedOutcome;
  disclosures: readonly DisclosureCode[];
  evidence: M0CaseEvidence;
  durationBucketMs: number;
  peakDecodedBytes: number;
  candidateSha256: string | null;
  status: 'pass' | 'fail';
}>;

export type GateReason =
  | 'missing-independent-validation'
  | 'missing-true-removal'
  | 'missing-extractable-redraw'
  | 'unedited-region-fidelity-failed'
  | 'determinism-failed'
  | `unexpected-outcome:${string}`
  | `non-atomic-failure:${string}`
  | `failure-not-closed:${string}`
  | `case-failed:${string}`
  | `missing-case:${string}`
  | `missing-resource-sweep:${keyof EngineLimits}`
  | `visual-threshold-not-separated:${RendererName}`;

export type GateDecision = Readonly<{
  decision: 'GO' | 'NO_GO';
  reasons: readonly GateReason[];
}>;

export type RendererName = 'pdfjs' | 'poppler';

export type VisualSample = Readonly<{
  renderer: RendererName;
  accepted: boolean;
  mismatchRatio: number;
  ssim: number;
}>;

export type RendererThreshold = Readonly<{
  acceptedMaximumMismatchRatio: number | null;
  acceptedP99MismatchRatio: number | null;
  acceptedMedianMismatchRatio: number | null;
  mismatchRatioThreshold: number | null;
  acceptedMinimumSsim: number | null;
  acceptedP01Ssim: number | null;
  acceptedMedianSsim: number | null;
  ssimThreshold: number | null;
  mismatchMargin: number;
  ssimMargin: number;
  separatesPerturbation: boolean;
}>;

export type VisualThresholds = Readonly<Record<RendererName, RendererThreshold>>;

export type ResourceSweepResult = Readonly<{
  limit: keyof EngineLimits;
  unit: 'bytes' | 'objects' | 'levels' | 'operations' | 'pixels' | 'milliseconds';
  testedValues: readonly number[];
  largestPassing: number;
  smallestRejected: number;
  repeatedChromiumRuns: 3;
  safetyMargin: number;
}>;

export type M0Report = Readonly<{
  schemaVersion: 1;
  decision: GateDecision;
  environment: Readonly<{
    node: string;
    chromium: string;
    poppler: string;
  }>;
  dependencies: Readonly<Record<string, string>>;
  cases: readonly M0CaseResult[];
  resourceLimits: EngineLimits;
  resourceSweeps: readonly ResourceSweepResult[];
  visualThresholds: VisualThresholds;
  licences: readonly string[];
  excludedDependencies: readonly string[];
}>;

function outcomeMatches(expected: ExpectedBaseline, observed: ObservedOutcome): boolean {
  if (expected.kind !== observed.kind) return false;
  if (expected.kind === 'crossConsumerControl') return true;
  if (expected.kind === 'rejected') {
    return observed.kind === 'rejected' && observed.error === expected.error;
  }
  return observed.kind === 'capability'
    && observed.capability === expected.capability
    && (expected.reason === undefined || observed.reasons.includes(expected.reason));
}

function addUnique(reasons: GateReason[], reason: GateReason): void {
  if (!reasons.includes(reason)) reasons.push(reason);
}

export function evaluateGate(results: readonly M0CaseResult[]): GateDecision {
  const reasons: GateReason[] = [];
  for (const result of results) {
    if (!outcomeMatches(result.expected, result.observed)) {
      addUnique(reasons, `unexpected-outcome:${result.id}`);
    }
    if (!result.evidence.atomicFailure) {
      addUnique(reasons, `non-atomic-failure:${result.id}`);
    }

    const editable = result.expected.kind === 'capability'
      && result.expected.capability !== 'readOnly';
    const control = result.expected.kind === 'crossConsumerControl';
    if (editable || control) {
      if (result.evidence.pdfjs === null || result.evidence.poppler === null) {
        addUnique(reasons, 'missing-independent-validation');
      }
      if (editable && !result.evidence.trueRemoval) {
        addUnique(reasons, 'missing-true-removal');
      }
      if (editable && !result.evidence.extractableRedraw) {
        addUnique(reasons, 'missing-extractable-redraw');
      }
      if (!result.evidence.uneditedRegionFidelity || !result.evidence.independentRendering) {
        addUnique(reasons, 'unedited-region-fidelity-failed');
      }
      if (!result.evidence.deterministicOutput) addUnique(reasons, 'determinism-failed');
    } else if (!result.evidence.failureClosed) {
      addUnique(reasons, `failure-not-closed:${result.id}`);
    }
    if (result.status !== 'pass') addUnique(reasons, `case-failed:${result.id}`);
  }
  return Object.freeze({
    decision: reasons.length === 0 ? 'GO' : 'NO_GO',
    reasons: Object.freeze(reasons),
  });
}

function percentile(values: readonly number[], quantile: number): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((left, right) => left - right);
  const index = Math.max(0, Math.ceil(quantile * sorted.length) - 1);
  return sorted[index] ?? null;
}

function rendererThreshold(
  samples: readonly VisualSample[],
  mismatchMargin: number,
  ssimMargin: number,
): RendererThreshold {
  const accepted = samples.filter(({ accepted }) => accepted);
  const perturbed = samples.filter(({ accepted }) => !accepted);
  const mismatches = accepted.map(({ mismatchRatio }) => mismatchRatio);
  const structuralScores = accepted.map(({ ssim }) => ssim);
  const maximumMismatch = mismatches.length === 0 ? null : Math.max(...mismatches);
  const minimumSsim = structuralScores.length === 0 ? null : Math.min(...structuralScores);
  const mismatchThreshold = maximumMismatch === null ? null : maximumMismatch + mismatchMargin;
  const ssimThreshold = minimumSsim === null ? null : minimumSsim - ssimMargin;
  const separatesPerturbation = mismatchThreshold !== null
    && ssimThreshold !== null
    && perturbed.length > 0
    && perturbed.every(({ mismatchRatio, ssim }) =>
      mismatchRatio > mismatchThreshold && ssim < ssimThreshold);
  return Object.freeze({
    acceptedMaximumMismatchRatio: maximumMismatch,
    acceptedP99MismatchRatio: percentile(mismatches, 0.99),
    acceptedMedianMismatchRatio: percentile(mismatches, 0.5),
    mismatchRatioThreshold: mismatchThreshold,
    acceptedMinimumSsim: minimumSsim,
    acceptedP01Ssim: percentile(structuralScores, 0.01),
    acceptedMedianSsim: percentile(structuralScores, 0.5),
    ssimThreshold,
    mismatchMargin,
    ssimMargin,
    separatesPerturbation,
  });
}

export function deriveVisualThresholds(
  samples: readonly VisualSample[],
  mismatchMargin = 0.000001,
  ssimMargin = 0.000001,
): VisualThresholds {
  if (mismatchMargin <= 0 || ssimMargin <= 0) {
    throw new RangeError('Visual threshold margins must be positive');
  }
  return Object.freeze({
    pdfjs: rendererThreshold(
      samples.filter(({ renderer }) => renderer === 'pdfjs'),
      mismatchMargin,
      ssimMargin,
    ),
    poppler: rendererThreshold(
      samples.filter(({ renderer }) => renderer === 'poppler'),
      mismatchMargin,
      ssimMargin,
    ),
  });
}

export function evaluateM0Gate(
  results: readonly M0CaseResult[],
  requiredCaseIds: readonly string[],
  thresholds: VisualThresholds,
  resourceSweeps?: readonly ResourceSweepResult[],
): GateDecision {
  const base = evaluateGate(results);
  const reasons: GateReason[] = [...base.reasons];
  const observedIds = new Set(results.map(({ id }) => id));
  for (const id of requiredCaseIds) {
    if (!observedIds.has(id)) addUnique(reasons, `missing-case:${id}`);
  }
  for (const renderer of ['pdfjs', 'poppler'] as const) {
    if (!thresholds[renderer].separatesPerturbation) {
      addUnique(reasons, `visual-threshold-not-separated:${renderer}`);
    }
  }
  if (resourceSweeps !== undefined) {
    const measuredLimits: readonly (keyof EngineLimits)[] = [
      'maxFileBytes',
      'maxObjects',
      'maxNestingDepth',
      'maxDecodedStreamBytes',
      'maxOperationsPerStream',
      'maxImagePixels',
    ];
    const swept = new Set(resourceSweeps.map(({ limit }) => limit));
    for (const limit of measuredLimits) {
      if (!swept.has(limit)) addUnique(reasons, `missing-resource-sweep:${limit}`);
    }
  }
  return Object.freeze({
    decision: reasons.length === 0 ? 'GO' : 'NO_GO',
    reasons: Object.freeze(reasons),
  });
}
